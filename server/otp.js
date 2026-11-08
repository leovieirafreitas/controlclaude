// Códigos de acesso por e-mail (usados pelo admin e pela área do assinante).
// O código é guardado só como hash, vale 10 min, uso único, até 5 tentativas.
import crypto from 'node:crypto';
import { get, run } from './db.js';
import { sendLoginCode } from './mail.js';
import { sendCodeWhatsapp } from './whatsapp.js';

export const SECRET = process.env.SESSION_SECRET || '';

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RESEND_WAIT_MS = 60 * 1000;
const MAX_CODES_PER_HOUR = 5;
const MAX_REQUESTS_PER_IP_HOUR = 20;

// Tabela login_codes: criada em supabase/schema.sql

export const hmac = (value) => crypto.createHmac('sha256', SECRET).update(value).digest('base64url');

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export const normEmail = (v) => String(v || '').trim().toLowerCase();
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const GENERIC_SENT = 'Se este e-mail tiver acesso, enviamos um código. Confira sua caixa de entrada e o spam.';

export class OtpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

const ipHits = new Map();
function ipLimited(ip) {
  const now = Date.now();
  const list = (ipHits.get(ip) || []).filter((t) => now - t < 3600_000);
  list.push(now);
  ipHits.set(ip, list);
  return list.length > MAX_REQUESTS_PER_IP_HOUR;
}

/** Gera e envia um código. Se `allowed` for falso, não envia nada (mas a resposta é a mesma). */
export async function issueCode({ scope, email, ip, allowed, phone }) {
  if (!EMAIL_RE.test(email)) throw new OtpError(400, 'Informe um e-mail válido.');
  if (ipLimited(ip)) throw new OtpError(429, 'Muitas tentativas. Tente de novo mais tarde.');
  if (!allowed) return;

  const now = Date.now();
  await run('DELETE FROM login_codes WHERE created_at < ?', [now - 24 * 3600_000]);

  const last = await get('SELECT created_at FROM login_codes WHERE scope = ? AND email = ? ORDER BY id DESC LIMIT 1', [scope, email]);
  if (last && now - last.created_at < RESEND_WAIT_MS) {
    throw new OtpError(429, `Aguarde ${Math.ceil((RESEND_WAIT_MS - (now - last.created_at)) / 1000)}s para pedir outro código.`);
  }
  const lastHour = (await get('SELECT COUNT(*) AS n FROM login_codes WHERE scope = ? AND email = ? AND created_at > ?', [scope, email, now - 3600_000])).n;
  if (lastHour >= MAX_CODES_PER_HOUR) throw new OtpError(429, 'Muitos códigos pedidos. Tente de novo em 1 hora.');

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await run('UPDATE login_codes SET used = true WHERE scope = ? AND email = ? AND used = false', [scope, email]);
  const r = await run('INSERT INTO login_codes (scope, email, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id',
    [scope, email, hmac(`${scope}:${email}:${code}`), now + CODE_TTL_MS, now]);

  // Envia por e-mail e também pelo WhatsApp (do cliente, ou do admin no login do painel). Basta um funcionar.
  const phones = Array.isArray(phone) ? phone : phone ? [phone] : [];
  const channels = [sendLoginCode(email, code, scope), ...phones.map((p) => sendCodeWhatsapp(p, code, scope))];
  const results = await Promise.allSettled(channels);
  results.filter((x) => x.status === 'rejected').forEach((x) => console.error('Falha ao enviar código:', x.reason?.message));
  if (!results.some((x) => x.status === 'fulfilled')) {
    await run('DELETE FROM login_codes WHERE id = ?', [r.rows[0].id]);
    throw new OtpError(502, 'Não foi possível enviar o código agora. Tente de novo ou fale com o suporte.');
  }
}

/** Confere o código. Lança OtpError se estiver errado/expirado. */
export async function checkCode({ scope, email, code, allowed }) {
  const digits = String(code || '').replace(/\D/g, '');
  const invalid = new OtpError(401, 'Código inválido ou expirado. Peça um novo código.');
  if (digits.length !== 6 || !allowed) throw invalid;

  const row = await get(`
    SELECT id, code_hash, expires_at, attempts FROM login_codes
    WHERE scope = ? AND email = ? AND used = false ORDER BY id DESC LIMIT 1`, [scope, email]);
  if (!row || row.expires_at < Date.now() || row.attempts >= MAX_ATTEMPTS) throw invalid;

  if (!safeEqual(row.code_hash, hmac(`${scope}:${email}:${digits}`))) {
    await run('UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?', [row.id]);
    const left = MAX_ATTEMPTS - row.attempts - 1;
    throw new OtpError(401, left > 0
      ? `Código incorreto. Restam ${left} tentativa(s).`
      : 'Código bloqueado por excesso de tentativas. Peça um novo código.');
  }
  await run('UPDATE login_codes SET used = true WHERE id = ?', [row.id]);
}

// ------------------------------------------------------------------ sessões (cookie assinado)

export function makeSession({ cookie, maxAgeMs, sameSite }) {
  const read = (req) => {
    const header = req.headers.cookie || '';
    const match = header.split(/;\s*/).find((c) => c.startsWith(`${cookie}=`));
    return match ? decodeURIComponent(match.slice(cookie.length + 1)) : null;
  };
  return {
    /** Retorna o e-mail da sessão, ou null. */
    get(req) {
      if (!SECRET) return null;
      const token = read(req);
      if (!token) return null;
      const [emailB64, expires, sig] = token.split('.');
      if (!sig || !safeEqual(sig, hmac(`${cookie}.${emailB64}.${expires}`)) || Number(expires) <= Date.now()) return null;
      return Buffer.from(emailB64, 'base64url').toString();
    },
    set(req, res, email) {
      const emailB64 = Buffer.from(email).toString('base64url');
      const expires = String(Date.now() + maxAgeMs);
      res.cookie(cookie, `${emailB64}.${expires}.${hmac(`${cookie}.${emailB64}.${expires}`)}`, {
        httpOnly: true, sameSite, secure: req.secure, maxAge: maxAgeMs, path: '/',
      });
    },
    clear(res) {
      res.clearCookie(cookie, { path: '/' });
    },
  };
}
