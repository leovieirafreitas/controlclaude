// Login do painel admin por código enviado por e-mail (sem senha).
//   POST /api/login/code   { email }       → envia código se o e-mail estiver em ADMIN_EMAILS
//   POST /api/login/verify { email, code } → cria a sessão do admin
import { mailConfigured } from './mail.js';
import { SECRET, OtpError, checkCode, issueCode, makeSession, normEmail, safeEqual } from './otp.js';

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

export const authProblems = [
  !SECRET && 'SESSION_SECRET não definida',
  !ADMIN_EMAILS.length && 'ADMIN_EMAILS não definida',
  !mailConfigured && 'RESEND_API_KEY não definida',
].filter(Boolean);

const isAdminEmail = (email) => ADMIN_EMAILS.some((a) => safeEqual(a, email));
const session = makeSession({ cookie: 'sid', maxAgeMs: 7 * 24 * 3600_000, sameSite: 'strict' });

function adminEmail(req) {
  const email = session.get(req);
  return email && isAdminEmail(email) ? email : null; // tirar o e-mail de ADMIN_EMAILS derruba a sessão
}

export const isAuthenticated = (req) => Boolean(adminEmail(req));

export function me(req, res) {
  const email = adminEmail(req);
  res.json({ authenticated: Boolean(email), email });
}

export function requireAuth(req, res, next) {
  if (isAuthenticated(req)) return next();
  res.status(401).json({ error: 'Não autenticado' });
}

const notConfigured = (res) => res.status(503).json({ error: 'Login por e-mail não configurado no servidor.' });
const sendError = (res, err) => {
  if (err instanceof OtpError) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Erro interno' });
};

export async function requestCode(req, res) {
  if (authProblems.length) return notConfigured(res);
  const email = normEmail(req.body?.email);
  try {
    await issueCode({ scope: 'admin', email, ip: req.ip, allowed: isAdminEmail(email) }); // só por e-mail
    res.json({ ok: true, message: 'Se este e-mail tiver acesso ao painel, enviamos um código para ele. Confira também o spam.' });
  } catch (err) {
    sendError(res, err);
  }
}

export async function verifyCode(req, res) {
  if (authProblems.length) return notConfigured(res);
  const email = normEmail(req.body?.email);
  try {
    await checkCode({ scope: 'admin', email, code: req.body?.code, allowed: isAdminEmail(email) });
    session.set(req, res, email);
    res.json({ ok: true, email });
  } catch (err) {
    sendError(res, err);
  }
}

export function logout(req, res) {
  session.clear(res);
  res.json({ ok: true });
}
