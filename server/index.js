import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { api } from './routes.js';
import { publicApi } from './public.js';
import { memberApi } from './member.js';
import { authProblems, logout, me, requestCode, requireAuth, verifyCode } from './auth.js';
import { startNoticeScheduler, whatsappConfigured } from './whatsapp.js';

// Rede de segurança: um erro inesperado é registrado no log em vez de derrubar o servidor.
process.on('unhandledRejection', (err) => console.error('Erro não tratado:', err?.message || err));
process.on('uncaughtException', (err) => console.error('Exceção não tratada:', err?.stack || err));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '20kb' }));

app.use('/api/public', publicApi);
app.use('/api/member', memberApi);
app.post('/api/login/code', requestCode);
app.post('/api/login/verify', verifyCode);
app.post('/api/logout', logout);
app.get('/api/me', me);
app.use('/api', requireAuth, api);
app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada' }));

// Em produção, o mesmo servidor entrega o front já compilado (npm run build)
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST));
  app.get('/assinar', (req, res) => res.sendFile(path.join(DIST, 'assinar.html')));
  app.get('/conta', (req, res) => res.sendFile(path.join(DIST, 'conta.html')));
  app.get('/termos', (req, res) => res.sendFile(path.join(DIST, 'termos.html')));
  app.get('/privacidade', (req, res) => res.sendFile(path.join(DIST, 'privacidade.html')));
  app.get('/{*path}', (req, res) => res.sendFile(path.join(DIST, 'index.html')));
}

app.listen(PORT, HOST, () => {
  if (authProblems.length) console.warn(`AVISO: login do painel desativado (${authProblems.join(', ')}). Configure o arquivo .env.`);
  console.log(`API rodando em http://${HOST}:${PORT}`);
  startNoticeScheduler();
  console.log(whatsappConfigured ? 'Avisos no WhatsApp: ligados' : 'Avisos no WhatsApp: desligados (configure EVOLUTION_* no .env)');
});
