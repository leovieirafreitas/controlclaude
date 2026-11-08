// Hash de senha com scrypt (nativo do Node). Formato: scrypt$N$r$p$salt$hash
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const N = 16384, R = 8, P = 1, KEYLEN = 64;

export const MIN_PASSWORD = 8;

export function checkPasswordRules(pw) {
  const s = String(pw || '');
  if (s.length < MIN_PASSWORD) return `A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.`;
  if (s.length > 200) return 'Senha longa demais.';
  if (!/[A-Za-z]/.test(s) || !/\d/.test(s)) return 'Use letras e números na senha.';
  return null;
}

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(String(pw).normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

// Hash "falso" para gastar o mesmo tempo quando o e-mail não existe (não revela quem tem conta)
const DUMMY = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$' + 'A'.repeat(86);

export async function verifyPassword(pw, stored) {
  const [alg, n, r, p, saltB64, hashB64] = String(stored || DUMMY).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64url');
  const got = await scrypt(String(pw || '').normalize('NFKC'), Buffer.from(saltB64, 'base64url'), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return stored ? crypto.timingSafeEqual(got, expected) : false;
}
