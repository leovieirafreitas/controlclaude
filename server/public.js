// Rotas públicas (sem login) usadas pela página de vendas /assinar.
// O cadastro e a compra acontecem na área do assinante (/api/member), com conta e senha.
import { Router } from 'express';
import { all } from './db.js';
import { h, getSettings } from './routes.js';
import { mpConfigured, syncOrderId } from './mp.js';

export const publicApi = Router();

publicApi.get('/info', h(async () => {
  const [{ pix_key, ...settings }, plans] = await Promise.all([ // a chave Pix não vai para a página
    getSettings(),
    all(`SELECT id, name, price_cents, description, features, featured FROM plans WHERE active ORDER BY price_cents ASC`),
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
});
