// Rotas públicas (sem login) usadas pela página de vendas /assinar.
// O cadastro e a compra acontecem na área do assinante (/api/member), com conta e senha.
import { Router } from 'express';
import crypto from 'node:crypto';
import { hmac } from './otp.js';
import { handleIncomingMessage } from './whatsapp.js';
import { all } from './db.js';
import { h, getSettings, SOLD_OUT_SQL, LICENSES_LEFT_SQL } from './routes.js';
import { mpConfigured, syncOrderId, syncAutopayNotification } from './mp.js';

export const publicApi = Router();

publicApi.get('/info', h(async () => {
  const [{ pix_key, ...settings }, plans] = await Promise.all([ // a chave Pix não vai para a página
    getSettings(),
    all(`SELECT p.id, p.name, p.price_cents, p.description, p.features, p.featured, ${SOLD_OUT_SQL} AS sold_out, ${LICENSES_LEFT_SQL} AS licenses_left
         FROM plans p WHERE p.active ORDER BY p.price_cents ASC`),
  ]);
  return { settings, plans, online_payment: mpConfigured };
}));

// Notificações do Mercado Pago (só chegam quando o site está publicado com HTTPS).
// Configure o webhook no painel do Mercado Pago com o tópico "Order" apontando para /api/public/mp-webhook.
// O corpo não é confiável: buscamos o pedido direto na API antes de registrar.
// Assinatura secreta do webhook (painel do Mercado Pago → Webhooks → "Assinatura secreta"), no .env como
// MP_WEBHOOK_SECRET. Com ela, avisos falsos são recusados sem nem consultar o Mercado Pago.
const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET || '';
if (!MP_WEBHOOK_SECRET) console.warn('Aviso: MP_WEBHOOK_SECRET não definida; o webhook do Mercado Pago aceita avisos sem assinatura (cada aviso ainda é conferido na API do MP).');

function validMpSignature(req, id) {
  const parts = Object.fromEntries(String(req.get('x-signature') || '').split(',').map((p) => p.trim().split('=')));
  const ts = parts.ts, v1 = parts.v1;
  if (!ts || !v1 || !/^[0-9a-f]{64}$/i.test(v1)) return false;
  const tsMs = Number(ts) < 1e12 ? Number(ts) * 1000 : Number(ts);
  if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > 15 * 60_000) return false; // aviso velho = reenvio suspeito
  const rid = req.get('x-request-id');
  const manifest = `id:${/^[a-z0-9]+$/i.test(id) ? id.toLowerCase() : id};${rid ? `request-id:${rid};` : ''}ts:${ts};`;
  const expected = crypto.createHmac('sha256', MP_WEBHOOK_SECRET).update(manifest).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1.toLowerCase()));
}

// O mesmo aviso repetido em poucos segundos só é processado uma vez (evita enxurrada de consultas ao MP)
const recentHooks = new Map();
function seenRecently(key) {
  const now = Date.now();
  if (recentHooks.size > 2000) for (const [k, t] of recentHooks) if (now - t > 60_000) recentHooks.delete(k);
  const last = recentHooks.get(key);
  recentHooks.set(key, now);
  return last && now - last < 30_000;
}

publicApi.post('/mp-webhook', async (req, res) => {
  const type = req.body?.type || req.query.type || req.query.topic;
  const id = String(req.query['data.id'] || req.body?.data?.id || req.query.id || '');
  if (MP_WEBHOOK_SECRET && !validMpSignature(req, id)) return res.sendStatus(401);
  res.sendStatus(200);
  if (seenRecently(`${type}:${id}`)) return;
  if (type === 'order' && /^ORD[A-Z0-9]+$/.test(id)) {
    syncOrderId(id).catch((e) => console.error('Webhook MP:', e.message));
  }
  // Renovação automática (ative "Planos e assinaturas" no webhook do Mercado Pago)
  if ((type === 'subscription_preapproval' || type === 'subscription_authorized_payment') && /^[A-Za-z0-9-]{1,64}$/.test(id)) {
    syncAutopayNotification(type, id).catch((e) => console.error('Webhook MP (assinatura):', e.message));
  }
});

// Mensagens recebidas no WhatsApp (webhook da Evolution API) — usadas para ler as respostas SIM / NÃO
// do cliente que cancelou. O caminho tem um segredo derivado do SESSION_SECRET.
export const WA_WEBHOOK_PATH = `/wa-webhook/${hmac('evolution-webhook').slice(0, 32)}`;

function incomingFrom(body) {
  const d = body?.data || {};
  const key = d.key || {};
  if (key.fromMe) return null;
  const jids = [key.remoteJid, key.remoteJidAlt, key.senderPn, d.sender, key.participant].filter(Boolean).map(String);
  if (jids.some((j) => j.endsWith('@g.us'))) return null; // grupos
  const jid = jids.find((j) => j.endsWith('@s.whatsapp.net'));
  const text = d.message?.conversation || d.message?.extendedTextMessage?.text
    || d.message?.buttonsResponseMessage?.selectedDisplayText || d.message?.listResponseMessage?.title || '';
  return jid && text ? { number: jid.split('@')[0], text } : null;
}

publicApi.post(WA_WEBHOOK_PATH, async (req, res) => {
  res.sendStatus(200);
  const ev = String(req.body?.event || '').toLowerCase().replace(/_/g, '.');
  if (ev !== 'messages.upsert') return;
  const msg = incomingFrom(req.body);
  if (!msg) return;
  try {
    const r = await handleIncomingMessage(msg.number, msg.text);
    if (r !== 'ignorado') console.log(`WhatsApp: resposta de ${msg.number} → ${r}`);
  } catch (err) {
    console.error('WhatsApp (resposta):', err.message);
  }
});
