// Rotas públicas (sem login) usadas pela página de vendas /assinar.
// O cadastro e a compra acontecem na área do assinante (/api/member), com conta e senha.
import { Router } from 'express';
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
publicApi.post('/mp-webhook', async (req, res) => {
  const type = req.body?.type || req.query.type || req.query.topic;
  const id = String(req.body?.data?.id || req.query['data.id'] || req.query.id || '');
  res.sendStatus(200);
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
