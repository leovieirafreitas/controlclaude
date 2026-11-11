import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { api } from './routes.js';
import { publicApi, WA_WEBHOOK_PATH } from './public.js';
import { memberApi } from './member.js';
import { authProblems, logout, me, requestCode, requireAuth, verifyCode } from './auth.js';
import { ensureIncomingWebhook, startNoticeScheduler, whatsappConfigured } from './whatsapp.js';
import { mpConfigured, syncDueAutopays, syncPendingCheckouts } from './mp.js';

// Rede de segurança: um erro inesperado é registrado no log em vez de derrubar o servidor.
process.on('unhandledRejection', (err) => console.error('Erro não tratado:', err?.message || err));
process.on('uncaughtException', (err) => console.error('Exceção não tratada:', err?.stack || err));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT || 3000);
const PROD = process.env.NODE_ENV === 'production';
// Em produção (VPS/Docker) aceita conexões de fora; no Mac, só do próprio computador
const HOST = process.env.HOST || (PROD ? '0.0.0.0' : '127.0.0.1');

const app = express();
app.disable('x-powered-by');
// Na VPS há um proxy (Easypanel/Traefik) na frente: confia em 1 salto para ler o IP real e o HTTPS
app.set('trust proxy', process.env.TRUST_PROXY ? (Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY) : (PROD ? 1 : 'loopback'));
app.use(express.json({ limit: '20kb' }));

// Cabeçalhos de segurança em todas as respostas
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');            // navegador não "adivinha" o tipo do arquivo
  res.setHeader('X-Frame-Options', 'DENY');                      // ninguém coloca o site dentro de outro (clickjacking)
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'");
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  if (PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains'); // sempre HTTPS
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store'); // dados não ficam em cache
  next();
});

app.use('/api/public', publicApi);
app.use('/api/member', memberApi);
app.post('/api/login/code', requestCode);
app.post('/api/login/verify', verifyCode);
app.post('/api/logout', logout);
app.get('/api/me', me);
app.use('/api', requireAuth, api);
app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada' }));

// Em produção, o mesmo servidor entrega o front já compilado (npm run build)
//   /            → página de vendas
//   /admin       → painel do administrador
//   /conta, /termos, /privacidade
if (fs.existsSync(DIST)) {
  const page = (file) => (req, res) => res.sendFile(path.join(DIST, file));
  app.use(express.static(DIST, { index: false, maxAge: '7d', setHeaders: (res, file) => {
    // Páginas, service worker e manifesto do app: sempre a versão nova
    if (file.endsWith('.html') || file.endsWith('-sw.js') || file.endsWith('.webmanifest')) res.setHeader('Cache-Control', 'no-cache');
  } }));
  app.get('/', page('assinar.html'));
  app.get('/assinar', page('assinar.html'));
  app.get('/conta', page('conta.html'));
  app.get('/termos', page('termos.html'));
  app.get('/privacidade', page('privacidade.html'));
  app.get(['/admin', '/admin/{*path}'], page('index.html'));
  app.get('/{*path}', page('assinar.html'));
}

app.listen(PORT, HOST, () => {
  if (authProblems.length) console.warn(`AVISO: login do painel desativado (${authProblems.join(', ')}). Configure o arquivo .env.`);
  console.log(`API rodando em http://${HOST}:${PORT}`);
  startNoticeScheduler();
  // Em produção (APP_URL com https), a Evolution passa a avisar as mensagens recebidas (respostas SIM/NÃO)
  const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
  if (appUrl.startsWith('https://')) {
    ensureIncomingWebhook(`${appUrl}/api/public${WA_WEBHOOK_PATH}`).catch((e) => console.error('WhatsApp (webhook):', e.message));
  }
  // Confere pedidos em aberto e cobranças automáticas no Mercado Pago a cada 5 min (não depende do webhook)
  if (mpConfigured) {
    const sync = () => {
      syncPendingCheckouts().catch((e) => console.error('Mercado Pago (conferência):', e.message));
      syncDueAutopays().catch((e) => console.error('Mercado Pago (renovação automática):', e.message));
    };
    setTimeout(sync, 30_000).unref();
    setInterval(sync, 5 * 60_000).unref();
  }
  console.log(whatsappConfigured ? 'Avisos no WhatsApp: ligados' : 'Avisos no WhatsApp: desligados (configure EVOLUTION_* no .env)');
});
