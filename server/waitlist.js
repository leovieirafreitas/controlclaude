// Lista de espera: a pessoa deixa nome, e-mail e WhatsApp em /espera e recebe no WhatsApp o link do grupo.
//   POST   /api/public/waitlist        cadastro (público)
//   GET    /api/waitlist               lista para o painel
//   PUT    /api/waitlist/settings      link do grupo
//   POST   /api/waitlist/:id/resend    reenvia a mensagem
//   DELETE /api/waitlist/:id           remove da lista
// Quem assina (plano ativo) sai da lista sozinho: ver pruneWaitlist().
import { Router } from 'express';
import { all, get, run } from './db.js';
import { ApiError, h, str } from './routes.js';
import { EMAIL_RE, normEmail } from './otp.js';
import { checkName, checkPhone } from './member.js';
import { notifyWaitlist } from './whatsapp.js';

export const DEFAULT_GROUP_URL = 'https://chat.whatsapp.com/G1mvjtnV5KZ9wQk5HS44Jv';
const GROUP_KEY = 'waitlist_group_url';

// A tabela é criada sozinha (o mesmo SQL está em supabase/schema.sql, v18). Se o banco falhar nessa hora,
// tenta de novo no próximo uso em vez de deixar a lista quebrada até reiniciar o servidor.
let readyPromise = null;
function ready() {
  readyPromise ||= createTable().catch((e) => { readyPromise = null; throw e; });
  return readyPromise;
}
ready().catch((e) => console.error('Lista de espera (criar tabela):', e.message));

async function createTable() {
  await run(`create table if not exists public.waitlist (
    id bigserial primary key,
    name text not null,
    email text not null unique,
    phone text not null,
    created_at timestamptz not null default now(),
    whatsapp_sent_at timestamptz,
    whatsapp_error text
  )`);
  await run('alter table public.waitlist enable row level security');
}

export async function groupUrl() {
  const r = await get('SELECT value FROM settings WHERE key = ?', [GROUP_KEY]);
  return str(r?.value) || DEFAULT_GROUP_URL;
}

/** Manda a mensagem e guarda o resultado na linha. */
async function sendTo(row) {
  const r = await notifyWaitlist(row, await groupUrl());
  await run('UPDATE waitlist SET whatsapp_sent_at = CASE WHEN ? THEN now() ELSE whatsapp_sent_at END, whatsapp_error = ? WHERE id = ?',
    [r.sent, r.sent ? null : r.error, row.id]);
  return r;
}

// Limite por IP: 5 cadastros a cada 10 min (evita robô enchendo a lista e disparando WhatsApp)
const hits = new Map();
function tooMany(ip) {
  const now = Date.now();
  if (hits.size > 5000) hits.clear();
  const list = (hits.get(ip) || []).filter((t) => now - t < 10 * 60_000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 5;
}

/** Cadastro público. Campo "website" escondido: se vier preenchido, é robô (responde ok e ignora). */
export const joinWaitlist = h(async (req) => {
  await ready();
  const b = req.body || {};
  if (str(b.website)) return { ok: true, sent: true };
  if (tooMany(req.ip)) throw new ApiError(429, 'Muitos cadastros seguidos. Aguarde alguns minutos e tente de novo.');
  const name = checkName(b.name);
  if (name.split(' ').length < 2) throw new ApiError(400, 'Informe seu nome completo (nome e sobrenome).');
  const email = normEmail(b.email);
  if (!EMAIL_RE.test(email) || email.length > 160) throw new ApiError(400, 'E-mail inválido.');
  const phone = checkPhone(b.phone);

  const old = await get('SELECT * FROM waitlist WHERE email = ?', [email]);
  let row;
  if (old) {
    row = (await run('UPDATE waitlist SET name = ?, phone = ? WHERE id = ? RETURNING *', [name, phone, old.id])).rows[0];
    // já estava na lista e a mensagem já saiu para este número: não manda de novo
    if (old.whatsapp_sent_at && old.phone === phone) return { ok: true, already: true, sent: true };
  } else {
    row = (await run('INSERT INTO waitlist (name, email, phone) VALUES (?, ?, ?) RETURNING *', [name, email, phone])).rows[0];
  }
  const r = await sendTo(row);
  // WhatsApp não saiu: a página mostra o link do grupo direto
  return { ok: true, already: Boolean(old), sent: r.sent, group_url: r.sent ? undefined : await groupUrl() };
});

/**
 * Quem já assinou sai da lista de espera: plano ativo (ou desativado por atraso) com o mesmo e-mail ou o mesmo WhatsApp.
 * O telefone é comparado pelos 8 últimos dígitos, para valer com ou sem 55, DDD e o 9 na frente.
 * Roda ao abrir a lista no painel, então cobre qualquer jeito de ativar (site, Pix do painel, ativação à mão).
 */
export async function pruneWaitlist() {
  const digits = (col) => `regexp_replace(coalesce(${col}, ''), '\\D', '', 'g')`;
  const r = await run(`
    DELETE FROM waitlist w
    WHERE EXISTS (
      SELECT 1 FROM subscribers s LEFT JOIN customers c ON c.id = s.customer_id
      WHERE s.status IN ('ativo', 'pausado') AND (
        lower(s.email) = w.email OR lower(c.email) = w.email
        OR (length(${digits('w.phone')}) >= 8 AND right(${digits('w.phone')}, 8) IN (right(${digits('s.phone')}, 8), right(${digits('c.phone')}, 8)))))
    RETURNING w.name`);
  if (r.rowCount) console.log(`Lista de espera: ${r.rowCount} saíram porque já assinaram (${r.rows.map((x) => x.name).join(', ')})`);
  return r.rows.map((x) => x.name);
}

// ------------------------------------------------------------------ painel (montado atrás do login do admin)

export const waitlistApi = Router();

waitlistApi.get('/', h(async () => {
  await ready();
  const removed = await pruneWaitlist(); // quem assinou sai da lista
  const [rows, group] = await Promise.all([all(`
    SELECT w.*, c.id AS customer_id, s.status AS sub_status
    FROM waitlist w
    LEFT JOIN customers c ON lower(c.email) = w.email
    LEFT JOIN LATERAL (SELECT status FROM subscribers WHERE customer_id = c.id ORDER BY id DESC LIMIT 1) s ON true
    ORDER BY w.created_at DESC`), groupUrl()]);
  return { group_url: group, rows, removed };
}));

waitlistApi.put('/settings', h(async (req) => {
  const url = str(req.body?.group_url);
  if (url && !/^https:\/\/\S+$/.test(url)) throw new ApiError(400, 'O link do grupo precisa começar com https://');
  await run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [GROUP_KEY, url]);
  return { group_url: await groupUrl() };
}));

waitlistApi.post('/:id/resend', h(async (req) => {
  const row = await get('SELECT * FROM waitlist WHERE id = ?', [Number(req.params.id) || 0]);
  if (!row) throw new ApiError(404, 'Cadastro não encontrado.');
  const r = await sendTo(row);
  if (!r.sent) throw new ApiError(502, `Não foi possível enviar: ${r.error}.`);
  return { ok: true };
}));

waitlistApi.delete('/:id', h(async (req) => {
  await run('DELETE FROM waitlist WHERE id = ?', [Number(req.params.id) || 0]);
  return { ok: true };
}));
