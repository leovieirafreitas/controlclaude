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

// Limites por IP (memória do processo): pedidos de código e conferências de código
const hitMaps = { issue: new Map(), verify: new Map() };
function limited(kind, ip, max) {
  const map = hitMaps[kind];
  const now = Date.now();
  const list = (map.get(ip) || []).filter((t) => now - t < 3600_000);
  list.push(now);
  map.set(ip, list);
  if (map.size > 5000) for (const [k, v] of map) if (!v.some((t) => now - t < 3600_000)) map.delete(k); // limpeza
  return list.length > max;
}
const MAX_VERIFY_PER_IP_HOUR = 60;
const MAX_CODES_PER_EMAIL_HOUR = 30; // teto geral por e-mail (somando todos os IPs): contém enxurrada de e-mails

/**
 * Erro de limite que depende de o e-mail existir. Nas telas de "pedir código" (admin e esqueci a senha)
 * ele vira a mesma resposta genérica, para ninguém descobrir quais e-mails têm conta.
 */
export class OtpSilentError extends OtpError {}

// Cada código fica amarrado ao navegador que pediu: um valor aleatório vai num cookie (httpOnly, só para /api)
// e só esse navegador consegue conferir o código. Quem não tem o cookie não consegue nem tentar adivinhar
// o código de outra pessoa, nem gastar as tentativas dela.
const nonceCookie = (scope) => `otp_${scope}`;
function readCookie(req, name) {
  const header = req?.headers?.cookie || '';
  const match = header.split(/;\s*/).find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : '';
}
function setNonce(req, res, scope) {
  const nonce = crypto.randomBytes(18).toString('base64url');
  res?.cookie(nonceCookie(scope), nonce, {
    httpOnly: true, sameSite: 'strict', secure: Boolean(req?.secure) || process.env.NODE_ENV === 'production',
    maxAge: CODE_TTL_MS, path: '/api',
  });
  return nonce;
}
const nonceHash = (nonce) => hmac(`otp-nonce:${nonce}`);

/**
 * Gera e envia um código. Se `allowed` for falso, não envia nada (mas a resposta é a mesma).
 * `req`/`res` são obrigatórios: o código fica amarrado ao navegador por cookie.
 */
export async function issueCode({ scope, email, ip, allowed, phone, req, res }) {
  if (!EMAIL_RE.test(email)) throw new OtpError(400, 'Informe um e-mail válido.');
  if (limited('issue', ip, MAX_REQUESTS_PER_IP_HOUR)) throw new OtpError(429, 'Muitas tentativas. Tente de novo mais tarde.');
  if (!allowed) { setNonce(req, res, scope); return; } // mesmo comportamento visível de quando existe

  const now = Date.now();
  const ipHash = hmac(`otp-ip:${ip}`);
  await run('DELETE FROM login_codes WHERE created_at < ?', [now - 24 * 3600_000]);

  // Espera de 60 s e teto de 5/hora contam por e-mail + IP: um estranho pedindo códigos não bloqueia o dono
  const last = await get('SELECT created_at FROM login_codes WHERE scope = ? AND email = ? AND ip_hash = ? ORDER BY id DESC LIMIT 1', [scope, email, ipHash]);
  if (last && now - last.created_at < RESEND_WAIT_MS) {
    throw new OtpSilentError(429, `Aguarde ${Math.ceil((RESEND_WAIT_MS - (now - last.created_at)) / 1000)}s para pedir outro código.`);
  }
  const counts = await get(`
    SELECT COUNT(*) FILTER (WHERE ip_hash = ?) AS mine, COUNT(*) AS total
    FROM login_codes WHERE scope = ? AND email = ? AND created_at > ?`, [ipHash, scope, email, now - 3600_000]);
  if (Number(counts.mine) >= MAX_CODES_PER_HOUR || Number(counts.total) >= MAX_CODES_PER_EMAIL_HOUR) {
    throw new OtpSilentError(429, 'Muitos códigos pedidos. Tente de novo em 1 hora.');
  }

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const nonce = crypto.randomBytes(18).toString('base64url');
  const r = await run(`INSERT INTO login_codes (scope, email, code_hash, expires_at, created_at, req_hash, ip_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  [scope, email, hmac(`${scope}:${email}:${code}`), now + CODE_TTL_MS, now, nonceHash(nonce), ipHash]);

  // Envia por e-mail (e pelo WhatsApp, se um telefone for passado). Basta um funcionar.
  const phones = Array.isArray(phone) ? phone : phone ? [phone] : [];
  const channels = [sendLoginCode(email, code, scope), ...phones.map((p) => sendCodeWhatsapp(p, code, scope))];
  const results = await Promise.allSettled(channels);
  results.filter((x) => x.status === 'rejected').forEach((x) => console.error('Falha ao enviar código:', x.reason?.message));
  if (!results.some((x) => x.status === 'fulfilled')) {
    await run('DELETE FROM login_codes WHERE id = ?', [r.rows[0].id]);
    throw new OtpSilentError(502, 'Não foi possível enviar o código agora. Tente de novo ou fale com o suporte.');
  }
  // Só agora o navegador passa a apontar para o código novo (se o pedido foi recusado acima, o anterior continua valendo)
  res?.cookie(nonceCookie(scope), nonce, {
    httpOnly: true, sameSite: 'strict', secure: Boolean(req?.secure) || process.env.NODE_ENV === 'production',
    maxAge: CODE_TTL_MS, path: '/api',
  });
}

/** Confere o código. Lança OtpError se estiver errado/expirado. */
export async function checkCode({ scope, email, code, allowed, req, res }) {
  const digits = String(code || '').replace(/\D/g, '');
  const invalid = new OtpError(401, 'Código inválido ou expirado. Peça um novo código neste aparelho.');
  if (limited('verify', req?.ip || '', MAX_VERIFY_PER_IP_HOUR)) throw new OtpError(429, 'Muitas tentativas. Tente de novo mais tarde.');
  const nonce = readCookie(req, nonceCookie(scope));
  if (digits.length !== 6 || !allowed || !nonce) throw invalid;

  // Conta a tentativa ANTES de comparar, num único comando: mesmo com muitas requisições ao mesmo tempo,
  // no máximo MAX_ATTEMPTS comparações acontecem por código (o Postgres trava a linha a cada UPDATE).
  const r = await run(`
    UPDATE login_codes SET attempts = attempts + 1
    WHERE id = (SELECT id FROM login_codes WHERE scope = ? AND email = ? AND req_hash = ? AND used = false ORDER BY id DESC LIMIT 1)
      AND attempts < ? AND expires_at > ?
    RETURNING id, code_hash, attempts`, [scope, email, nonceHash(nonce), MAX_ATTEMPTS, Date.now()]);
  const row = r.rows[0];
  if (!row) throw invalid;

  if (!safeEqual(row.code_hash, hmac(`${scope}:${email}:${digits}`))) {
    const left = MAX_ATTEMPTS - row.attempts;
    throw new OtpError(401, left > 0
      ? `Código incorreto. Restam ${left} tentativa(s).`
      : 'Código bloqueado por excesso de tentativas. Peça um novo código.');
  }
  // Uso único, também atômico: dois envios do mesmo código certo ao mesmo tempo → só um passa
  const used = await run('UPDATE login_codes SET used = true WHERE id = ? AND used = false', [row.id]);
  if (used.rowCount !== 1) throw invalid;
  res?.clearCookie(nonceCookie(scope), { path: '/api' });
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
        // Em produção o cookie só trafega por HTTPS, mesmo que o proxy não informe o protocolo
        httpOnly: true, sameSite, secure: req.secure || process.env.NODE_ENV === 'production', maxAge: maxAgeMs, path: '/',
      });
    },
    clear(res) {
      res.clearCookie(cookie, { path: '/' });
    },
  };
}
