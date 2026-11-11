// Notificações push do painel (app instalado no celular / navegador do admin).
// No iPhone funciona a partir do iOS 16.4, com o painel adicionado à Tela de Início.
// As chaves VAPID vêm do .env (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY) ou são geradas uma vez e
// guardadas na tabela app_secrets (só o servidor acessa). Nunca bloqueia o fluxo principal.
import webpush from 'web-push';
import { all, get, run } from './db.js';

const SUBJECT = process.env.VAPID_SUBJECT || `mailto:${(process.env.RESEND_FROM || 'contato@controlclaude.com.br').replace(/^.*<|>.*$/g, '')}`;

let keysPromise = null;
/** Par de chaves VAPID: do .env, do banco ou gerado agora (e salvo). */
function vapidKeys() {
  if (!keysPromise) {
    keysPromise = (async () => {
      if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
        return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
      }
      const row = await get("SELECT value FROM app_secrets WHERE key = 'vapid'");
      if (row) return JSON.parse(row.value);
      const fresh = webpush.generateVAPIDKeys();
      // ON CONFLICT: se dois processos gerarem ao mesmo tempo, vale o primeiro que salvou
      await run("INSERT INTO app_secrets (key, value) VALUES ('vapid', ?) ON CONFLICT (key) DO NOTHING", [JSON.stringify(fresh)]);
      return JSON.parse((await get("SELECT value FROM app_secrets WHERE key = 'vapid'")).value);
    })().catch((err) => { keysPromise = null; throw err; });
  }
  return keysPromise;
}

export async function pushPublicKey() {
  return (await vapidKeys()).publicKey;
}

const ALLOWED_HOSTS = /(^|\.)(push\.apple\.com|googleapis\.com|mozilla\.com|mozaws\.net|windows\.com|notify\.windows\.com)$/i;

/** Salva o aparelho do admin. Só aceita endereços dos serviços de push conhecidos. */
export async function savePushSubscription(sub, adminEmail, userAgent = '') {
  const endpoint = String(sub?.endpoint || '');
  const p256dh = String(sub?.keys?.p256dh || '');
  const auth = String(sub?.keys?.auth || '');
  let host = '';
  try { const u = new URL(endpoint); if (u.protocol === 'https:') host = u.hostname; } catch { /* inválido */ }
  if (!host || !ALLOWED_HOSTS.test(host) || endpoint.length > 1000 || !p256dh || !auth || p256dh.length > 200 || auth.length > 100) {
    const err = new Error('Inscrição de notificação inválida.');
    err.status = 400; err.expose = true;
    throw err;
  }
  await run(`
    INSERT INTO push_subscriptions (endpoint, p256dh, auth, admin_email, user_agent) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth,
      admin_email = excluded.admin_email, user_agent = excluded.user_agent`,
  [endpoint, p256dh, auth, adminEmail, String(userAgent).slice(0, 300)]);
}

export async function removePushSubscription(endpoint) {
  await run('DELETE FROM push_subscriptions WHERE endpoint = ?', [String(endpoint || '')]);
}

export async function pushDevices(adminEmail) {
  return all('SELECT endpoint, user_agent, created_at, last_ok_at FROM push_subscriptions WHERE admin_email = ? ORDER BY created_at DESC', [adminEmail]);
}

/**
 * Envia a notificação para todos os aparelhos cadastrados (ou só os de um admin).
 * payload: { title, body, url, tag }. Aparelhos que não existem mais (404/410) são removidos.
 */
export async function sendPush(payload, { adminEmail = null } = {}) {
  let keys;
  try { keys = await vapidKeys(); } catch (err) { console.error('Push (chaves):', err.message); return { sent: 0, failed: 0 }; }
  const subs = adminEmail
    ? await all('SELECT * FROM push_subscriptions WHERE admin_email = ?', [adminEmail])
    : await all('SELECT * FROM push_subscriptions');
  const body = JSON.stringify({ url: '/admin', ...payload });
  let sent = 0, failed = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, {
        vapidDetails: { subject: SUBJECT, publicKey: keys.publicKey, privateKey: keys.privateKey },
        TTL: 24 * 3600,
        urgency: 'high',
        timeout: 15_000,
      });
      sent++;
      run('UPDATE push_subscriptions SET last_ok_at = now() WHERE endpoint = ?', [s.endpoint]).catch(() => {});
    } catch (err) {
      failed++;
      if (err.statusCode === 404 || err.statusCode === 410) {
        await removePushSubscription(s.endpoint).catch(() => {});
      } else {
        console.error(`Push: envio falhou (${err.statusCode || err.message})`);
      }
    }
  }));
  return { sent, failed };
}

/** Versão "dispara e esquece" para os eventos (pagamento, cadastro). */
export function firePush(payload) {
  sendPush(payload).catch((err) => console.error('Push:', err.message));
}
