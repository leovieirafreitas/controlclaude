// E-mail institucional no Google Workspace (Admin SDK / Directory API) para cada novo assinante.
// Quando a assinatura é ativada pelo primeiro pagamento aprovado, cria a conta nome@controlclaude.com.br
// e manda os dados (e-mail + senha temporária) para o WhatsApp do admin repassar ao cliente.
//
// Configuração (.env):
//   GOOGLE_SERVICE_ACCOUNT_JSON  conteúdo do JSON da conta de serviço (numa linha só, ou em base64)
//   GOOGLE_SERVICE_ACCOUNT_FILE  ou o caminho do arquivo JSON (padrão: ./google-service-account.json, se existir)
//   GOOGLE_ADMIN_SUBJECT         super administrador do Workspace em nome de quem a conta de serviço age
//   WORKSPACE_DOMAIN             domínio dos e-mails dos membros (padrão: controlclaude.com.br)
//   WORKSPACE_AUTO_CREATE        off para desligar a criação automática (padrão: ligada quando configurado)
//   WORKSPACE_GROUP              e-mail do grupo em que cada membro novo entra (ex.: o grupo "claudecode")
// No Google Admin: Segurança → Controles de API → Delegação em todo o domínio → client_id da conta de serviço
// com os escopos https://www.googleapis.com/auth/admin.directory.user
//                e https://www.googleapis.com/auth/admin.directory.group.member (para colocar no grupo)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { get, run } from './db.js';

const SCOPE = 'https://www.googleapis.com/auth/admin.directory.user';
const GROUP_SCOPE = 'https://www.googleapis.com/auth/admin.directory.group.member';
export const WORKSPACE_GROUP = (process.env.WORKSPACE_GROUP || '').trim().toLowerCase();
const API = 'https://admin.googleapis.com/admin/directory/v1';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORKSPACE_DOMAIN = (process.env.WORKSPACE_DOMAIN || 'controlclaude.com.br').toLowerCase();
const SUBJECT = process.env.GOOGLE_ADMIN_SUBJECT || '';
const AUTO = !/^(off|0|false|nao|não)$/i.test(process.env.WORKSPACE_AUTO_CREATE || 'on');

function loadServiceAccount() {
  try {
    let raw = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
    if (raw && !raw.startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8');
    if (!raw) {
      const file = process.env.GOOGLE_SERVICE_ACCOUNT_FILE || path.join(ROOT, 'google-service-account.json');
      if (fs.existsSync(file)) raw = fs.readFileSync(file, 'utf8');
    }
    if (!raw) return null;
    const sa = JSON.parse(raw);
    return sa.client_email && sa.private_key ? sa : null;
  } catch (err) {
    console.error('Google Workspace: credencial inválida:', err.message);
    return null;
  }
}
const SA = loadServiceAccount();
export const workspaceConfigured = Boolean(SA && SUBJECT);
export const workspaceAuto = workspaceConfigured && AUTO;

// ------------------------------------------------------------------ acesso (token OAuth da conta de serviço)

const cachedByScope = new Map();
async function accessToken(scope = SCOPE) {
  const cached = cachedByScope.get(scope) || { token: '', exp: 0 };
  if (cached.token && Date.now() < cached.exp - 60_000) return cached.token;
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: SA.client_email, sub: SUBJECT, scope, aud: SA.token_uri || 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(SA.private_key).toString('base64url');
  const res = await fetch(SA.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`Google (acesso): ${j.error_description || j.error || res.status}`);
  cachedByScope.set(scope, { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 });
  return j.access_token;
}

async function google(pathname, { method = 'GET', body, scope = SCOPE } = {}) {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${await accessToken(scope)}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data: j };
}

// ------------------------------------------------------------------ nome do e-mail

const CONNECTORS = new Set(['de', 'da', 'do', 'dos', 'das', 'e', 'di', 'du', 'del', 'van', 'von']);
const clean = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Partes do nome sem acento: ["leonardo", "freitas"] (ignora "de", "da"...). */
function nameParts(fullName) {
  return String(fullName || '').trim().split(/\s+/).map(clean).filter((p) => p && !CONNECTORS.has(p));
}

/** Ordem de tentativa: primeiro nome → nome.último sobrenome → nome.primeiro sobrenome → nome.último2, 3... */
export function emailCandidates(fullName) {
  const parts = nameParts(fullName);
  if (!parts.length) return [];
  const first = parts[0].slice(0, 40);
  const last = parts.length > 1 ? parts[parts.length - 1].slice(0, 40) : '';
  const second = parts.length > 2 ? parts[1].slice(0, 40) : '';
  const list = [first];
  if (last) list.push(`${first}.${last}`);
  if (second && second !== last) list.push(`${first}.${second}`);
  const base = last ? `${first}.${last}` : first;
  for (let n = 2; n <= 20; n++) list.push(`${base}${n}`);
  return [...new Set(list)].map((local) => `${local}@${WORKSPACE_DOMAIN}`);
}

/** Senha temporária forte e fácil de digitar (sem 0/O, 1/l/I). O Google pede para trocar no 1º acesso. */
function tempPassword() {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789', '@#$%&*!?'];
  const all = sets.join('');
  const chars = sets.map((s) => s[crypto.randomInt(s.length)]);
  while (chars.length < 14) chars.push(all[crypto.randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}

async function emailTaken(email) {
  const r = await google(`/users/${encodeURIComponent(email)}?fields=primaryEmail`);
  if (r.status === 404) return false;
  if (r.ok) return true;
  throw new Error(`Google (consultar ${email}): ${r.data?.error?.message || r.status}`);
}

/**
 * Cria a conta no Workspace com o primeiro e-mail livre. Retorna { email, password }.
 * Lança erro com mensagem clara se não conseguir (licenças esgotadas, permissão, etc.).
 */
export async function createWorkspaceUser({ name }) {
  if (!workspaceConfigured) throw new Error('Google Workspace não configurado (GOOGLE_SERVICE_ACCOUNT_JSON e GOOGLE_ADMIN_SUBJECT).');
  const candidates = emailCandidates(name);
  if (!candidates.length) throw new Error('O nome do cliente não tem letras para montar o e-mail.');
  const parts = String(name || '').trim().split(/\s+/);
  const givenName = (parts[0] || 'Membro').slice(0, 60);
  const familyName = (parts.slice(1).join(' ') || parts[0] || 'Membro').slice(0, 60);
  for (const email of candidates) {
    if (await emailTaken(email)) continue;
    const password = tempPassword();
    const r = await google('/users', {
      method: 'POST',
      body: { primaryEmail: email, name: { givenName, familyName }, password, changePasswordAtNextLogin: true },
    });
    if (r.ok) return { email: r.data.primaryEmail || email, password };
    if (r.status === 409) continue; // alguém pegou o nome entre a consulta e a criação: tenta o próximo
    const msg = r.data?.error?.message || `erro ${r.status}`;
    throw new Error(/license|licen/i.test(msg) ? `sem licença disponível no Google Workspace (${msg})` : `Google: ${msg}`);
  }
  throw new Error('todos os e-mails possíveis para este nome já existem.');
}

/** Coloca o e-mail no grupo configurado (WORKSPACE_GROUP). Já ser membro conta como sucesso. */
export async function addToGroup(email, group = WORKSPACE_GROUP) {
  if (!group) return { skipped: true };
  const r = await google(`/groups/${encodeURIComponent(group)}/members`, {
    method: 'POST', scope: GROUP_SCOPE, body: { email, role: 'MEMBER', delivery_settings: 'ALL_MAIL' },
  });
  if (r.ok || r.status === 409) return { ok: true, group };
  throw new Error(`grupo ${group}: ${r.data?.error?.message || r.status}`);
}

// ------------------------------------------------------------------ quando a assinatura é ativada

/**
 * Cria o e-mail do assinante (uma vez só). Chamado quando o plano é ativado pelo pagamento.
 * `notify` recebe o resultado para avisar o admin (WhatsApp/push). Nunca lança erro.
 */
export async function provisionWorkspace(subscriberId, notify, { force = false } = {}) {
  if (!workspaceConfigured || (!AUTO && !force)) return null;
  // trava: só um processo cria a conta deste assinante
  // automático: só quem nunca teve e-mail · pelo painel (force): também quem está marcado "(manual)" ou travou no meio
  const claim = await run(`UPDATE subscribers SET workspace_email = '(criando)', workspace_error = NULL
    WHERE id = ? AND (workspace_email IS NULL
      OR (? AND (workspace_email = '(manual)' OR (workspace_email = '(criando)' AND workspace_created_at IS NULL))))
    RETURNING id, name, workspace_email`, [subscriberId, force]);
  const sub = claim.rows[0];
  if (!sub) return null;
  try {
    const { email, password } = await createWorkspaceUser({ name: sub.name });
    await run('UPDATE subscribers SET workspace_email = ?, workspace_created_at = now(), workspace_error = NULL WHERE id = ?', [email, sub.id]);
    console.log(`Google Workspace: conta ${email} criada (assinante ${sub.id})`);
    // grupo: logo depois de criar (a conta nova às vezes demora uns segundos para aparecer no Google)
    let group = null;
    if (WORKSPACE_GROUP) {
      for (let attempt = 1; attempt <= 3 && !group?.ok; attempt++) {
        try { group = await addToGroup(email); } catch (err) {
          group = { ok: false, error: err.message };
          if (attempt < 3) await new Promise((r) => setTimeout(r, 3000 * attempt));
        }
      }
      if (!group.ok) console.error(`Google Workspace (grupo, assinante ${sub.id}):`, group.error);
    }
    await Promise.resolve(notify?.({ ok: true, subscriberId: sub.id, email, password, group })).catch((e) => console.error('Aviso da conta Google:', e.message));
    return { email };
  } catch (err) {
    console.error(`Google Workspace (assinante ${sub.id}):`, err.message);
    // falhou: volta ao estado anterior ("(manual)" continua manual; automático pode tentar de novo pelo painel)
    await run("UPDATE subscribers SET workspace_email = CASE WHEN ? THEN '(manual)' ELSE NULL END, workspace_error = ? WHERE id = ?", [force, String(err.message).slice(0, 300), sub.id]);
    await Promise.resolve(notify?.({ ok: false, subscriberId: sub.id, error: err.message })).catch(() => {});
    return null;
  }
}

/** Situação para o painel (sem segredos). */
export async function workspaceStatus() {
  return { configured: workspaceConfigured, auto: workspaceAuto, domain: WORKSPACE_DOMAIN, subject: SUBJECT || null, group: WORKSPACE_GROUP || null };
}

export const subscriberWorkspace = (id) => get('SELECT workspace_email, workspace_created_at, workspace_error FROM subscribers WHERE id = ?', [id]);
