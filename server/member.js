// Área do assinante: /api/member/*
//
// 1. O cliente cria a conta (nome, e-mail, nascimento, WhatsApp, senha) e confirma o e-mail com um código.
// 2. Logado, escolhe um plano → cria/atualiza a assinatura e vai para o checkout.
// 3. Na área dele: vê e edita dados, troca senha, vê pagamentos, paga e cancela.
// Login em duas etapas: e-mail + senha, depois código de 6 dígitos enviado ao e-mail.
// Esqueci a senha: código por e-mail (Resend) + nova senha.
import { Router } from 'express';
import { all, get, run } from './db.js';
import { ApiError, h, str, todayISO, getSettings, SOLD_OUT_SQL, planSoldOut } from './routes.js';
import { EMAIL_RE, checkCode, issueCode, makeSession, normEmail } from './otp.js';
import { checkPasswordRules, hashPassword, verifyPassword } from './password.js';
import { notifyCancel, notifyKeep, notifySignup, notifyCardRejected } from './whatsapp.js';
import { mpConfigured, MP_PUBLIC_KEY, payWithCard, payWithPix, syncOrderId, syncSubscriber, startAutopay, changeAutopayCard, setAutopayStatus, setAutopayAmount, syncAutopay, createAutopayLink, checkPendingAutopay } from './mp.js';

// Assinaturas nesses status já ocupam uma licença do plano: podem pagar mesmo com o plano esgotado.
const HOLDS_LICENSE = ['ativo', 'pausado'];
const SOLD_OUT_MSG = 'Este plano está esgotado no momento. Escolha outro plano ou fale com o suporte.';

export const memberApi = Router();
// Versão dos Termos de uso / Política de privacidade (mude junto com a data nas páginas termos.html e privacidade.html)
const TERMS_VERSION = '2026-11-09';
// Pix como alternativa ao cartão com renovação automática (pago mês a mês). Desligar: PIX_ENABLED=off no .env
export const PIX_ENABLED = !/^(off|0|false|nao|não)$/i.test(process.env.PIX_ENABLED || 'on');
// Depois de uma renovação automática recusada, espera 7 dias antes de tentar de novo (tentativas seguidas pioram o antifraude)
const AUTOPAY_RETRY_MS = 7 * 24 * 3600_000;
export const memberSession = makeSession({ cookie: 'msid', maxAgeMs: 30 * 24 * 3600_000, sameSite: 'lax' });

// ------------------------------------------------------------------ helpers

export function checkBirthDate(v) {
  const s = str(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw new ApiError(400, 'Informe sua data de nascimento.');
  const age = (Date.now() - Date.parse(s)) / (365.25 * 86400_000);
  if (age < 0 || age > 120) throw new ApiError(400, 'Data de nascimento inválida.');
  return s;
}

function checkName(v) {
  const s = str(v);
  if (s.length < 2 || s.length > 120) throw new ApiError(400, 'Informe seu nome completo.');
  return s;
}

function checkPhone(v) {
  const s = str(v);
  if (!s) throw new ApiError(400, 'Informe seu WhatsApp com DDD. É por ele que avisamos o vencimento.');
  if (s.replace(/\D/g, '').length < 10 || s.length > 30) throw new ApiError(400, 'WhatsApp inválido. Use DDD + número.');
  return s;
}

function checkNewPassword(pw) {
  const problem = checkPasswordRules(pw);
  if (problem) throw new ApiError(400, problem);
  return String(pw);
}

const customerByEmail = (email) => get('SELECT * FROM customers WHERE email = ?', [email]);
const subscriptionOf = (customerId) => get('SELECT * FROM subscribers WHERE customer_id = ? ORDER BY id DESC LIMIT 1', [customerId]);

/** Mês que o assinante deve pagar agora: o atual, ou o próximo se o atual já está quitado. */
export async function billingMonth(sub, priceCents) {
  const month = todayISO().slice(0, 7);
  const { t: paid } = await get('SELECT COALESCE(SUM(amount_cents), 0) AS t FROM payments WHERE subscriber_id = ? AND ref_month = ?', [sub.id, month]);
  if (paid < priceCents) return month;
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function currentCustomer(req) {
  const email = memberSession.get(req);
  const c = email && (await customerByEmail(email));
  if (!c) throw new ApiError(401, 'Não autenticado');
  return c;
}

async function requireSubscription(customer) {
  const sub = await subscriptionOf(customer.id);
  if (!sub) throw new ApiError(400, 'Você ainda não tem um plano. Escolha um plano para assinar.');
  return sub;
}

// Limite de tentativas de login: 5 erros por e-mail e 20 por IP a cada 15 min
const failures = new Map();
function tooManyFailures(key, max) {
  const now = Date.now();
  const list = (failures.get(key) || []).filter((t) => now - t < 15 * 60_000);
  failures.set(key, list);
  return list.length >= max;
}
const addFailure = (key) => failures.set(key, [...(failures.get(key) || []), Date.now()]);

// Limite de criação de contas: 5 por IP a cada 10 min
const signups = new Map();
function signupLimited(ip) {
  const now = Date.now();
  const list = (signups.get(ip) || []).filter((t) => now - t < 10 * 60_000);
  if (list.length >= 5) return true;
  list.push(now);
  signups.set(ip, list);
  return false;
}

// Erros do Mercado Pago viram uma mensagem amigável
const mpSafe = (fn) => async (...args) => {
  try {
    return await fn(...args);
  } catch (err) {
    if (String(err.message).startsWith('Mercado Pago')) {
      console.error(err.message);
      throw new ApiError(502, 'Não foi possível falar com o Mercado Pago. Tente de novo.');
    }
    throw err;
  }
};

// ------------------------------------------------------------------ conta e login

memberApi.post('/register', h(async (req, res) => {
  const b = req.body || {};
  if (str(b.website)) return { ok: true }; // campo-isca contra robôs
  const name = checkName(b.name);
  const email = normEmail(b.email);
  if (!EMAIL_RE.test(email) || email.length > 160) throw new ApiError(400, 'Informe um e-mail válido.');
  const birth = checkBirthDate(b.birth_date);
  const phone = checkPhone(b.phone);
  const password = checkNewPassword(b.password);
  if (b.accept_terms !== true) throw new ApiError(400, 'Para criar a conta, aceite os Termos de uso e a Política de privacidade.');
  if (signupLimited(req.ip)) throw new ApiError(429, 'Muitas tentativas. Tente de novo em alguns minutos.');

  // A conta nasce "não confirmada" e só vale depois do código enviado ao e-mail.
  // Se o e-mail já tem cadastro NÃO confirmado (ex.: alguém digitou o e-mail errado ou desistiu),
  // os dados são substituídos — assim ninguém "segura" o e-mail de outra pessoa.
  const r = await run(`
    INSERT INTO customers (name, email, phone, birth_date, password_hash, terms_accepted_at, terms_version)
    VALUES (?, ?, ?, ?, ?, now(), ?)
    ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone, birth_date = EXCLUDED.birth_date,
      password_hash = EXCLUDED.password_hash, terms_accepted_at = now(), terms_version = EXCLUDED.terms_version
      WHERE customers.email_verified_at IS NULL
    RETURNING id`,
  [name, email, phone, birth, await hashPassword(password), TERMS_VERSION]);
  if (!r.rowCount) throw new ApiError(409, 'Este e-mail já tem conta. Entre com sua senha ou use "Esqueci minha senha".');
  return sendAccessCode(req, email, 'Para confirmar seu e-mail, enviamos um código de 6 dígitos para');
}));

/** Envia o código de acesso (scope login) e devolve a resposta para a tela pedir o código. */
async function sendAccessCode(req, email, intro = 'Enviamos um código de 6 dígitos para') {
  try {
    await issueCode({ scope: 'login', email, ip: req.ip, allowed: true });
  } catch (err) {
    // Pediu de novo antes de 1 minuto: o código enviado há pouco continua valendo
    if (err.status === 429 && /^Aguarde/.test(err.message)) {
      return { need_code: true, message: `Já enviamos um código para ${email} há pouco. Use esse código ou ${err.message.toLowerCase()}` };
    }
    throw err;
  }
  return { need_code: true, message: `${intro} ${email}. Confira também a caixa de spam.` };
}

/** O código chegou ao e-mail: marca o e-mail como confirmado (e avisa o admin do cadastro novo). */
async function confirmEmail(c) {
  if (c.email_verified_at) return;
  const r = await run('UPDATE customers SET email_verified_at = now() WHERE id = ? AND email_verified_at IS NULL', [c.id]);
  if (r.rowCount) notifySignup({ name: c.name, email: c.email, phone: c.phone, birth_date: c.birth_date });
}

memberApi.post('/login', h(async (req, res) => {
  const email = normEmail(req.body?.email);
  const ipKey = `ip:${req.ip}`;
  const emailKey = `email:${email}`;
  if (tooManyFailures(ipKey, 20) || tooManyFailures(emailKey, 5)) {
    throw new ApiError(429, 'Muitas tentativas erradas. Aguarde 15 minutos ou use "Esqueci minha senha".');
  }
  const c = await customerByEmail(email);
  const ok = await verifyPassword(req.body?.password, c?.password_hash);
  if (!c || !ok) {
    addFailure(ipKey);
    addFailure(emailKey);
    throw new ApiError(401, 'E-mail ou senha incorretos.');
  }
  failures.delete(emailKey);
  // Verificação em duas etapas: senha certa → código de 6 dígitos no e-mail. Só entra com o código.
  // (Se o e-mail ainda não foi confirmado no cadastro, este mesmo código confirma.)
  return sendAccessCode(req, email, c.email_verified_at ? undefined : 'Para confirmar seu e-mail, enviamos um código de 6 dígitos para');
}));

// 2ª etapa do login: o código só existe se a senha foi conferida na 1ª etapa
memberApi.post('/login/verify', h(async (req, res) => {
  const email = normEmail(req.body?.email);
  const c = await customerByEmail(email);
  await checkCode({ scope: 'login', email, code: req.body?.code, allowed: Boolean(c) });
  await confirmEmail(c);
  memberSession.set(req, res, email);
  return { ok: true };
}));

memberApi.post('/logout', (req, res) => {
  memberSession.clear(res);
  res.json({ ok: true });
});

// Esqueci a senha: 1) pede código  2) código + nova senha
memberApi.post('/password/forgot', h(async (req) => {
  const email = normEmail(req.body?.email);
  const c = await customerByEmail(email);
  await issueCode({ scope: 'reset', email, ip: req.ip, allowed: Boolean(c) }); // só por e-mail
  return { ok: true, message: 'Se este e-mail tiver conta, enviamos um código de 6 dígitos para o seu e-mail. Confira também a caixa de spam.' };
}));

memberApi.post('/password/reset', h(async (req, res) => {
  const email = normEmail(req.body?.email);
  const password = checkNewPassword(req.body?.password);
  const c = await customerByEmail(email);
  await checkCode({ scope: 'reset', email, code: req.body?.code, allowed: Boolean(c) });
  await run('UPDATE customers SET password_hash = ? WHERE id = ?', [await hashPassword(password), c.id]);
  await confirmEmail(c); // o código chegou ao e-mail: ele existe e é da pessoa
  failures.delete(`email:${email}`);
  memberSession.set(req, res, email);
  return { ok: true };
}));

memberApi.put('/password', h(async (req) => {
  const c = await currentCustomer(req);
  if (!(await verifyPassword(req.body?.current_password, c.password_hash))) throw new ApiError(400, 'Senha atual incorreta.');
  const password = checkNewPassword(req.body?.new_password);
  await run('UPDATE customers SET password_hash = ? WHERE id = ?', [await hashPassword(password), c.id]);
  return { ok: true };
}));

// ------------------------------------------------------------------ dados

/**
 * Monta a tela do assinante com UMA rodada ao banco (4 consultas em paralelo, todas pelo e-mail).
 * Cada ida ao banco custa ~180 ms, então evitar consultas em fila é o que deixa a tela rápida.
 */
async function memberViewByEmail(email) {
  const month = todayISO().slice(0, 7);
  const [customer, sub, plans, payments] = await Promise.all([
    customerByEmail(email),
    get(`
      SELECT s.*, p.name AS plan_name, p.price_cents, p.description AS plan_description, ${SOLD_OUT_SQL} AS plan_sold_out,
             (SELECT COALESCE(SUM(amount_cents), 0) FROM payments WHERE subscriber_id = s.id AND ref_month = ?) AS paid_this_month
      FROM subscribers s
      JOIN plans p ON p.id = s.plan_id
      JOIN customers c ON c.id = s.customer_id
      WHERE c.email = ? ORDER BY s.id DESC LIMIT 1`, [month, email]),
    all(`SELECT p.id, p.name, p.price_cents, p.description, p.features, p.featured, ${SOLD_OUT_SQL} AS sold_out
         FROM plans p WHERE p.active ORDER BY p.price_cents`),
    all(`
      SELECT pay.ref_month, pay.amount_cents, pay.paid_at, pay.method FROM payments pay
      WHERE pay.subscriber_id = (
        SELECT s.id FROM subscribers s JOIN customers c ON c.id = s.customer_id
        WHERE c.email = ? ORDER BY s.id DESC LIMIT 1)
      ORDER BY pay.paid_at DESC, pay.id DESC LIMIT 24`, [email]),
  ]);
  if (!customer) throw new ApiError(401, 'Não autenticado');

  let subscription = null;
  if (sub) {
    let next = month;
    if (sub.paid_this_month >= sub.price_cents) {
      const [y, m] = month.split('-').map(Number);
      const d = new Date(y, m, 1);
      next = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }
    subscription = {
      status: sub.status, start_date: sub.start_date, due_day: sub.due_day, cancel_at: sub.cancel_at || null,
      plan: { id: sub.plan_id, name: sub.plan_name, price_cents: sub.price_cents, description: sub.plan_description,
        sold_out: sub.plan_sold_out && !HOLDS_LICENSE.includes(sub.status) },
      next_charge: { month: next, current_paid: next !== month },
      // renovação automática no cartão (assinatura do Mercado Pago)
      // renovação automática recusada há menos de 7 dias: a tela vai direto para o pagamento avulso do mês
      autopay_blocked: Boolean(sub.autopay_failed_at && Date.now() - new Date(sub.autopay_failed_at).getTime() < AUTOPAY_RETRY_MS
        && !(sub.mp_preapproval_id && sub.autopay_status === 'authorized')),
      autopay: sub.mp_preapproval_id && sub.autopay_status !== 'cancelled'
        ? { status: sub.autopay_status, card_last4: sub.card_last4, card_brand: sub.card_brand, next_charge_date: sub.next_charge_date }
        : null,
    };
  }
  return {
    customer: { name: customer.name, email: customer.email, phone: customer.phone, birth_date: customer.birth_date, created_at: customer.created_at },
    subscription,
    payments: sub ? payments : [],
    plans,
    can_pay: mpConfigured,
    pix_enabled: mpConfigured && PIX_ENABLED,
    mp_public_key: mpConfigured ? MP_PUBLIC_KEY : null,
  };
}

const memberView = (customer) => memberViewByEmail(customer.email);

memberApi.get('/me', h(async (req) => {
  const email = memberSession.get(req);
  if (!email) throw new ApiError(401, 'Não autenticado');
  return memberViewByEmail(email);
}));

memberApi.put('/me', h(async (req) => {
  const c = await currentCustomer(req);
  const name = checkName(req.body?.name);
  const phone = checkPhone(req.body?.phone);
  const birth = checkBirthDate(req.body?.birth_date);
  await Promise.all([
    run('UPDATE customers SET name = ?, phone = ?, birth_date = ? WHERE id = ?', [name, phone, birth, c.id]),
    run('UPDATE subscribers SET name = ?, phone = ?, birth_date = ? WHERE customer_id = ?', [name, phone, birth, c.id]),
  ]);
  return memberView(c);
}));

// ------------------------------------------------------------------ assinatura

/** Escolhe um plano: cria a assinatura (ou troca o plano se ainda não estiver ativa). O pagamento vem depois, em /pay. */
memberApi.post('/subscribe', h(async (req) => {
  const c = await currentCustomer(req);
  const plan = await get('SELECT * FROM plans WHERE id = ? AND active', [Number(req.body?.plan_id) || 0]);
  if (!plan) throw new ApiError(400, 'Plano indisponível. Escolha outro plano.');

  const sub = await subscriptionOf(c.id);
  if (sub && sub.status === 'ativo' && sub.plan_id !== plan.id) {
    throw new ApiError(409, 'Você já tem um plano ativo. Para trocar de plano, fale com o suporte.');
  }
  const holdsLicense = sub && sub.plan_id === plan.id && HOLDS_LICENSE.includes(sub.status);
  if (!holdsLicense && await planSoldOut(plan.id)) throw new ApiError(409, SOLD_OUT_MSG);

  const today = todayISO();
  if (!sub) {
    await run(`
      INSERT INTO subscribers (customer_id, name, email, phone, birth_date, plan_id, start_date, due_day, status, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'aguardando', 'Cadastro pela área do assinante')`,
    [c.id, c.name, c.email, c.phone, c.birth_date, plan.id, today, Math.min(Number(today.slice(8, 10)), 28)]);
  } else if (sub.plan_id !== plan.id) {
    await run("UPDATE subscribers SET plan_id = ?, status = CASE WHEN status = 'cancelado' THEN 'aguardando' ELSE status END WHERE id = ?", [plan.id, sub.id]);
    await setAutopayAmount(sub, plan.price_cents).catch((e) => console.error('Mercado Pago (valor da renovação):', e.message));
  }

  const view = await memberView(c);
  if (!mpConfigured) {
    const { pix_key, whatsapp } = await getSettings();
    return { ...view, manual: { pix_key, whatsapp } };
  }
  return view;
}));

/**
 * Assina com renovação automática no cartão de crédito (obrigatória): autoriza o cartão no Mercado Pago,
 * que cobra a 1ª mensalidade na hora e as próximas sozinho, todo mês.
 *   { card: { token, payment_method_id, payer } } → { status, message, view }
 */
memberApi.post('/pay', h(mpSafe(async (req) => {
  if (!mpConfigured) throw new ApiError(503, 'Pagamento online indisponível no momento.');
  if (req.body?.method === 'pix' && !PIX_ENABLED) throw new ApiError(400, 'O pagamento é só por cartão de crédito, com renovação automática.');
  const c = await currentCustomer(req);
  const sub = await requireSubscription(c);
  const plan = await get('SELECT * FROM plans WHERE id = ?', [sub.plan_id]);
  if (!plan.active && sub.status !== 'ativo') throw new ApiError(400, 'Este plano não está mais disponível. Escolha outro plano.');
  if (!HOLDS_LICENSE.includes(sub.status) && await planSoldOut(plan.id)) throw new ApiError(409, SOLD_OUT_MSG);
  // Pix: paga a mensalidade em aberto (sem renovação automática; o cliente paga mês a mês)
  if (req.body?.method === 'pix') {
    const month = await billingMonth(sub, plan.price_cents);
    return { pix: await payWithPix({ ...sub, email: c.email }, plan, month), amount_cents: plan.price_cents };
  }
  const card = req.body?.card || {};
  if (!card.token || !card.payment_method_id) throw new ApiError(400, 'Dados do cartão incompletos.');
  if (card.payment_type_id && card.payment_type_id !== 'credit_card') {
    throw new ApiError(400, 'A renovação automática funciona só com cartão de crédito.');
  }
  const deviceId = str(req.body?.device_id).slice(0, 200) || undefined;

  // Plano B: o Mercado Pago recusou a renovação automática → paga este mês de forma avulsa no cartão.
  // No próximo vencimento o cliente é convidado de novo a ligar a renovação automática.
  const blocked = sub.autopay_failed_at && Date.now() - new Date(sub.autopay_failed_at).getTime() < AUTOPAY_RETRY_MS;
  if (req.body?.mode === 'once' || blocked) {
    if (sub.mp_preapproval_id && sub.autopay_status === 'authorized') throw new ApiError(400, 'Você já tem renovação automática ativa.');
    const month = await billingMonth(sub, plan.price_cents);
    const result = await payWithCard({ ...sub, email: c.email }, plan, month, card, deviceId);
    if (result.status === 'rejected') notifyCardRejected(sub.id, { once: true, message: result.message });
    return { ...result, view: await memberView(c) };
  }

  const result = await startAutopay({ ...sub, email: c.email }, plan, card, deviceId);
  if (result.status === 'rejected') {
    await run('UPDATE subscribers SET autopay_failed_at = now() WHERE id = ?', [sub.id]);
    notifyCardRejected(sub.id, { once: false, message: result.reason || result.message });
  } else {
    await run('UPDATE subscribers SET autopay_failed_at = NULL WHERE id = ?', [sub.id]);
  }
  return { ...result, view: await memberView(c) };
})));

/**
 * Assinar com renovação automática pelo Mercado Pago: devolve o link da página do Mercado Pago,
 * onde o cliente entra na conta dele (ou paga sem conta), autoriza o cartão e paga o 1º mês.
 */
memberApi.post('/autopay-link', h(mpSafe(async (req) => {
  if (!mpConfigured) throw new ApiError(503, 'Pagamento online indisponível no momento.');
  const c = await currentCustomer(req);
  const sub = await requireSubscription(c);
  const plan = await get('SELECT * FROM plans WHERE id = ?', [sub.plan_id]);
  if (!plan.active && sub.status !== 'ativo') throw new ApiError(400, 'Este plano não está mais disponível. Escolha outro plano.');
  if (!HOLDS_LICENSE.includes(sub.status) && await planSoldOut(plan.id)) throw new ApiError(409, SOLD_OUT_MSG);
  if (sub.mp_preapproval_id && sub.autopay_status === 'authorized' && !sub.cancel_at) {
    throw new ApiError(400, 'Sua renovação automática já está ativa.');
  }
  return { url: await createAutopayLink({ ...sub, email: c.email }, plan) };
})));

/** Troca o cartão da renovação automática (sem cobrar agora). */
memberApi.post('/card', h(mpSafe(async (req) => {
  const c = await currentCustomer(req);
  const sub = await requireSubscription(c);
  if (!sub.mp_preapproval_id || !['authorized', 'paused'].includes(sub.autopay_status)) {
    throw new ApiError(400, 'Você ainda não tem renovação automática. Use "Pagar" para cadastrar o cartão.');
  }
  const card = req.body?.card || {};
  if (!card.token) throw new ApiError(400, 'Dados do cartão incompletos.');
  if (card.payment_type_id && card.payment_type_id !== 'credit_card') throw new ApiError(400, 'Use um cartão de crédito.');
  const result = await changeAutopayCard(sub, card);
  return { ...result, view: await memberView(c) };
})));

memberApi.post('/sync', h(async (req) => {
  const c = await currentCustomer(req);
  const sub = await subscriptionOf(c.id);
  if (sub && mpConfigured) {
    const orderId = str(req.body?.order_id);
    if (/^ORD[A-Z0-9]+$/.test(orderId)) await syncOrderId(orderId, sub.id).catch((e) => console.error(e.message));
    await syncSubscriber(sub.id).catch((e) => console.error(e.message));
    await syncAutopay(sub).catch((e) => console.error(e.message));
    await checkPendingAutopay(sub).catch((e) => console.error(e.message));
  }
  return memberView(c);
}));

/**
 * Último dia de acesso já pago: o próximo vencimento depois do último mês quitado.
 * Ex.: pagou 11/2026 com vencimento dia 8 → acesso até 08/12/2026. Retorna null se não há período pago à frente.
 */
async function paidAccessUntil(sub) {
  const row = await get(`
    SELECT MAX(ref_month) AS m FROM (
      SELECT pay.ref_month FROM payments pay JOIN subscribers s ON s.id = pay.subscriber_id JOIN plans p ON p.id = s.plan_id
      WHERE pay.subscriber_id = ? GROUP BY pay.ref_month, p.price_cents HAVING SUM(pay.amount_cents) >= p.price_cents
    ) t`, [sub.id]);
  if (!row?.m) return null;
  const [y, m] = row.m.split('-').map(Number);
  const next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
  const until = `${next}-${String(sub.due_day).padStart(2, '0')}`;
  return until > todayISO() ? until : null;
}

/** Cancelar: se há período pago, o cliente continua usando até o fim dele (cancelamento agendado). */
memberApi.post('/cancel', h(async (req) => {
  const c = await currentCustomer(req);
  const sub = await requireSubscription(c);
  if (sub.status === 'cancelado') throw new ApiError(400, 'Seu plano já está cancelado.');
  if (sub.cancel_at) throw new ApiError(400, 'O cancelamento do seu plano já está agendado.');
  const today = todayISO().split('-').reverse().join('/');
  const until = sub.status === 'ativo' ? await paidAccessUntil(sub) : null;
  if (until) {
    await run(`UPDATE subscribers SET cancel_at = ?, cancel_requested_at = now(), retention_answer = NULL,
               notes = trim(notes || ' · Pediu cancelamento em ' || ?::text || ' (acesso até ' || ?::text || ')') WHERE id = ?`,
    [until, today, until.split('-').reverse().join('/'), sub.id]);
  } else {
    await run("UPDATE subscribers SET status = 'cancelado', notes = trim(notes || ' · Cancelado pelo assinante em ' || ?::text) WHERE id = ?",
      [today, sub.id]);
  }
  // a cobrança automática para agora (sem estorno): pausada enquanto há acesso pago, cancelada se acabou
  await setAutopayStatus(sub, until ? 'paused' : 'cancelled').catch((e) => console.error('Mercado Pago (cancelar renovação):', e.message));
  notifyCancel(sub.id, until).catch((e) => console.error('WhatsApp:', e.message));
  return memberView(c);
}));

/** Desistir do cancelamento agendado (antes do fim do acesso): o plano continua, sem pagar nada agora. */
memberApi.post('/keep', h(async (req) => {
  const c = await currentCustomer(req);
  const sub = await requireSubscription(c);
  if (!sub.cancel_at || sub.status !== 'ativo') throw new ApiError(400, 'Não há cancelamento agendado.');
  await run(`UPDATE subscribers SET cancel_at = NULL, cancel_requested_at = NULL, retention_answer = NULL,
             notes = trim(notes || ' · Desistiu do cancelamento em ' || ?::text) WHERE id = ?`,
  [todayISO().split('-').reverse().join('/'), sub.id]);
  await setAutopayStatus(sub, 'authorized').catch((e) => console.error('Mercado Pago (retomar renovação):', e.message));
  notifyKeep(sub.id).catch((e) => console.error('WhatsApp:', e.message));
  return memberView(c);
}));
