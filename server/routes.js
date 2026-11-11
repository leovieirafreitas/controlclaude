import { Router } from 'express';
import { all, get, run } from './db.js';
import { notifyAdmin, pacingStatus, savePacing, whatsappLogout, whatsappQr, whatsappStatus } from './whatsapp.js';
import { mpConfigured, payWithPix, setAutopayStatus, setAutopayAmount, syncOrderId } from './mp.js';
import { currentAdmin } from './auth.js';
import { pushDevices, pushPublicKey, removePushSubscription, savePushSubscription, sendPush } from './push.js';
import { fill, listTemplates, resetTemplate, sampleVars, saveTemplate, templateInfo } from './templates.js';

export const api = Router();

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const STATUSES = ['aguardando', 'ativo', 'pausado', 'cancelado'];
export const SETTING_KEYS = ['brand_name', 'headline', 'subheadline', 'pix_key', 'whatsapp'];

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.expose = true; // mensagem pode ir para o usuário
  }
}

// ---------------------------------------------------------------- helpers

export const todayISO = () => new Date().toLocaleDateString('sv-SE'); // AAAA-MM-DD no fuso local

function toCents(value) {
  const n = Number(String(value ?? '').replace(',', '.'));
  if (!Number.isFinite(n) || String(value ?? '').trim() === '') throw new ApiError(400, 'Valor inválido');
  if (n < 0) throw new ApiError(400, 'Valor não pode ser negativo');
  return Math.round(n * 100);
}

function required(body, ...fields) {
  for (const f of fields) {
    if (body[f] === undefined || body[f] === null || body[f] === '') throw new ApiError(400, `Campo obrigatório: ${f}`);
  }
}

function checkMonth(m) {
  if (!MONTH_RE.test(m || '')) throw new ApiError(400, 'Mês inválido (use AAAA-MM)');
  return m;
}

function checkDate(d) {
  if (!DATE_RE.test(d || '') || Number.isNaN(Date.parse(d))) throw new ApiError(400, 'Data inválida (use AAAA-MM-DD)');
  return d;
}

function checkDueDay(v) {
  const d = Number(v);
  if (!Number.isInteger(d) || d < 1 || d > 28) throw new ApiError(400, 'Dia de vencimento deve ser entre 1 e 28');
  return d;
}

export const str = (v) => (v == null ? '' : String(v).trim());

// Encapsula handlers (podem ser async): converte ApiError em resposta JSON
export const h = (fn) => async (req, res) => {
  try {
    res.json(await fn(req, res));
  } catch (err) {
    if (err.expose) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
};

// ---------------------------------------------------------------- planos

// Licenças usadas = assinaturas "ativo" ou "pausado" (o pausado guarda a vaga até regularizar).
// Use em consultas com a tabela plans apelidada de "p".
export const LICENSES_USED_SQL = `(SELECT COUNT(*) FROM subscribers s WHERE s.plan_id = p.id AND s.status IN ('ativo', 'pausado'))`;
export const SOLD_OUT_SQL = `(p.max_licenses IS NOT NULL AND ${LICENSES_USED_SQL} >= p.max_licenses)`;
// Vagas que sobram (null = sem limite)
export const LICENSES_LEFT_SQL = `(CASE WHEN p.max_licenses IS NULL THEN NULL ELSE GREATEST(p.max_licenses - ${LICENSES_USED_SQL}, 0) END)`;

/** O plano está sem vagas para uma nova licença? */
export async function planSoldOut(planId) {
  const r = await get(`SELECT ${SOLD_OUT_SQL} AS sold_out FROM plans p WHERE p.id = ?`, [planId]);
  return Boolean(r?.sold_out);
}

api.get('/plans', h(() => all(`
  SELECT p.*, (SELECT COUNT(*) FROM subscribers s WHERE s.plan_id = p.id AND s.status = 'ativo') AS active_subscribers,
         ${LICENSES_USED_SQL} AS licenses_used
  FROM plans p ORDER BY p.price_cents DESC`)));

function checkMaxLicenses(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null; // sem limite
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new ApiError(400, 'Limite de licenças deve ser um número inteiro maior que zero (ou vazio para sem limite)');
  return n;
}

function planValues(body) {
  required(body, 'name', 'price');
  return [
    str(body.name), toCents(body.price), str(body.description), body.active !== false,
    str(body.features), body.featured === true, checkMaxLicenses(body.max_licenses),
  ];
}

api.post('/plans', h(async ({ body }) => {
  const r = await run('INSERT INTO plans (name, price_cents, description, active, features, featured, max_licenses) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id', planValues(body));
  return { id: r.rows[0].id };
}));

api.put('/plans/:id', h(async ({ body, params }) => {
  await run('UPDATE plans SET name = ?, price_cents = ?, description = ?, active = ?, features = ?, featured = ?, max_licenses = ? WHERE id = ?', [...planValues(body), Number(params.id)]);
  return { ok: true };
}));

api.delete('/plans/:id', h(async ({ params }) => {
  if (await get('SELECT 1 FROM subscribers WHERE plan_id = ? LIMIT 1', [Number(params.id)])) {
    throw new ApiError(409, 'Há assinantes neste plano. Desative o plano ou mova os assinantes antes.');
  }
  await run('DELETE FROM plans WHERE id = ?', [Number(params.id)]);
  return { ok: true };
}));

// ---------------------------------------------------------------- configurações da página de vendas

export async function getSettings() {
  const rows = await all('SELECT key, value FROM settings');
  const out = Object.fromEntries(SETTING_KEYS.map((k) => [k, '']));
  for (const r of rows) if (SETTING_KEYS.includes(r.key)) out[r.key] = r.value;
  return out;
}

api.get('/settings', h(() => getSettings()));

api.put('/settings', h(async ({ body }) => {
  for (const k of SETTING_KEYS) {
    if (body[k] !== undefined) {
      await run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [k, str(body[k])]);
    }
  }
  return getSettings();
}));

// ---------------------------------------------------------------- assinantes

async function subscriberValues(body) {
  required(body, 'name', 'plan_id', 'start_date');
  const planId = Number(body.plan_id);
  if (!(await get('SELECT 1 FROM plans WHERE id = ?', [planId]))) throw new ApiError(400, 'Plano não encontrado');
  const status = body.status || 'ativo';
  if (!STATUSES.includes(status)) throw new ApiError(400, 'Status inválido');
  return [
    str(body.name), str(body.email).toLowerCase(), str(body.phone), planId,
    checkDate(body.start_date), checkDueDay(body.due_day ?? 10), status, str(body.notes),
    body.birth_date ? checkDate(body.birth_date) : null,
  ];
}

api.get('/subscribers', h(() => all(`
  SELECT s.*, p.name AS plan_name, p.price_cents
  FROM subscribers s JOIN plans p ON p.id = s.plan_id
  ORDER BY s.status = 'aguardando' DESC, lower(s.name)`)));

// Contas criadas na área do assinante (/conta): cadastro, e-mail confirmado e situação do plano
api.get('/customers', h(() => all(`
  SELECT c.id, c.name, c.email, c.phone, c.birth_date, c.created_at, c.email_verified_at,
         s.id AS subscriber_id, s.status, s.cancel_at, s.autopay_status, s.card_last4, s.next_charge_date, p.name AS plan_name, p.price_cents,
         (SELECT MAX(paid_at) FROM payments pay WHERE pay.subscriber_id = s.id) AS last_paid_at
  FROM customers c
  LEFT JOIN LATERAL (SELECT * FROM subscribers WHERE customer_id = c.id ORDER BY id DESC LIMIT 1) s ON true
  LEFT JOIN plans p ON p.id = s.plan_id
  ORDER BY c.created_at DESC`)));

// ---------------------------------------------------------------- Pix gerado pelo admin (cliente que não conseguiu pagar no cartão)

const MP_ORDER_RE = /^ORD[A-Z0-9]+$/;

// Gera um Pix da mensalidade em aberto do assinante, para o admin copiar e mandar. O pagamento é
// reconhecido sozinho (webhook do Mercado Pago, conferência a cada 5 min ou pela tela do Pix aberta).
api.post('/subscribers/:id/pix', h(async ({ params }) => {
  if (!mpConfigured) throw new ApiError(503, 'Mercado Pago não configurado no servidor.');
  const sub = await get('SELECT * FROM subscribers WHERE id = ?', [Number(params.id)]);
  if (!sub) throw new ApiError(404, 'Assinante não encontrado.');
  const plan = await get('SELECT * FROM plans WHERE id = ?', [sub.plan_id]);
  if (!plan || plan.price_cents <= 0) throw new ApiError(400, 'O plano deste assinante não tem valor para cobrar.');
  if (!sub.email) throw new ApiError(400, 'Cadastre o e-mail deste assinante (Editar) para gerar o Pix: o Mercado Pago exige.');
  const { billingMonth } = await import('./member.js');
  const month = await billingMonth(sub, plan.price_cents);
  let pix;
  try {
    pix = await payWithPix(sub, plan, month);
  } catch (err) {
    console.error('Pix pelo painel:', err.message);
    throw new ApiError(502, 'Não foi possível gerar o Pix no Mercado Pago. Tente de novo.');
  }
  if (!pix.qr_code) throw new ApiError(502, 'O Mercado Pago não devolveu o código Pix. Tente de novo.');
  return { ...pix, month, amount_cents: plan.price_cents, plan_name: plan.name, name: sub.name, phone: sub.phone };
}));

// A tela do Pix aberta no painel pergunta de tempos em tempos se já foi pago
api.get('/subscribers/:id/pix/:order', h(async ({ params }) => {
  const id = Number(params.id);
  const orderId = String(params.order || '');
  if (!MP_ORDER_RE.test(orderId)) throw new ApiError(400, 'Pedido inválido.');
  const order = await syncOrderId(orderId, id).catch((e) => { console.error('Conferir Pix:', e.message); return null; });
  const paid = Boolean(await get('SELECT 1 AS x FROM payments WHERE subscriber_id = ? AND notes = ?', [id, `Mercado Pago ${orderId}`]));
  const sub = await get('SELECT status FROM subscribers WHERE id = ?', [id]);
  return { paid, status: sub?.status || null, order_status: order?.status || null };
}));

api.post('/subscribers', h(async ({ body }) => {
  const r = await run(`
    INSERT INTO subscribers (name, email, phone, plan_id, start_date, due_day, status, notes, birth_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`, await subscriberValues(body));
  return { id: r.rows[0].id };
}));

api.put('/subscribers/:id', h(async ({ body, params }) => {
  const before = await get('SELECT s.*, p.price_cents FROM subscribers s JOIN plans p ON p.id = s.plan_id WHERE s.id = ?', [Number(params.id)]);
  await run(`
    UPDATE subscribers SET name = ?, email = ?, phone = ?, plan_id = ?, start_date = ?, due_day = ?, status = ?, notes = ?, birth_date = ?
    WHERE id = ?`, [...(await subscriberValues(body)), Number(params.id)]);
  // Admin mudou o status na mão: um cancelamento agendado antigo deixa de valer
  await run(`UPDATE subscribers SET cancel_at = NULL, cancel_requested_at = NULL, retention_answer = NULL
             WHERE id = ? AND cancel_at IS NOT NULL AND (status <> 'ativo' OR cancel_at <= current_date)`, [Number(params.id)]);
  await syncAutopayWithStatus(before, Number(params.id));
  return { ok: true };
}));

/**
 * O admin mudou o assinante na mão: a cobrança automática no cartão acompanha.
 * Cancelado → cancela a cobrança · Pausado → pausa · Ativo (sem cancelamento agendado) → volta a cobrar.
 * Trocou o plano → a cobrança passa a ter o valor do plano novo.
 */
async function syncAutopayWithStatus(before, id) {
  if (!before?.mp_preapproval_id || before.autopay_status === 'cancelled') return;
  const sub = await get('SELECT s.*, p.price_cents FROM subscribers s JOIN plans p ON p.id = s.plan_id WHERE s.id = ?', [id]);
  const want = sub.status === 'cancelado' ? 'cancelled'
    : sub.status === 'pausado' ? 'paused'
    : sub.status === 'ativo' && !sub.cancel_at ? 'authorized' : null;
  try {
    if (want) await setAutopayStatus(sub, want);
    if (sub.price_cents !== before.price_cents && want !== 'cancelled') await setAutopayAmount(sub, sub.price_cents);
  } catch (err) {
    console.error('Mercado Pago (renovação automática):', err.message);
    throw new ApiError(502, 'Assinante salvo, mas não foi possível atualizar a cobrança automática no Mercado Pago. Tente salvar de novo.');
  }
}

api.delete('/subscribers/:id', h(async ({ params }) => {
  // excluir também desliga a cobrança automática no cartão (senão o Mercado Pago continuaria cobrando)
  const sub = await get('SELECT * FROM subscribers WHERE id = ?', [Number(params.id)]);
  if (sub?.mp_preapproval_id && sub.autopay_status !== 'cancelled') {
    await setAutopayStatus(sub, 'cancelled').catch((err) => {
      console.error('Mercado Pago (renovação automática):', err.message);
      throw new ApiError(502, 'Não foi possível cancelar a cobrança automática no Mercado Pago. Tente de novo.');
    });
  }
  await run('DELETE FROM subscribers WHERE id = ?', [Number(params.id)]);
  return { ok: true };
}));

// ---------------------------------------------------------------- pagamentos

api.get('/payments', h(({ query }) => {
  const where = [];
  const args = [];
  if (query.month) { where.push('pay.ref_month = ?'); args.push(checkMonth(query.month)); }
  if (query.subscriber_id) { where.push('pay.subscriber_id = ?'); args.push(Number(query.subscriber_id)); }
  if (query.method) { where.push('pay.method = ?'); args.push(str(query.method)); }
  return all(`
    SELECT pay.*, s.name AS subscriber_name, p.name AS plan_name
    FROM payments pay
    JOIN subscribers s ON s.id = pay.subscriber_id
    JOIN plans p ON p.id = s.plan_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY pay.paid_at DESC, pay.id DESC`, args);
}));

api.post('/payments', h(async ({ body }) => {
  required(body, 'subscriber_id', 'ref_month');
  const sub = await get(`
    SELECT s.id, p.price_cents FROM subscribers s JOIN plans p ON p.id = s.plan_id WHERE s.id = ?`, [Number(body.subscriber_id)]);
  if (!sub) throw new ApiError(400, 'Assinante não encontrado');
  const amount = body.amount === undefined || body.amount === '' ? sub.price_cents : toCents(body.amount);
  const r = await run(`
    INSERT INTO payments (subscriber_id, ref_month, amount_cents, paid_at, method, notes)
    VALUES (?, ?, ?, ?, ?, ?) RETURNING id`, [
    sub.id, checkMonth(body.ref_month), amount, checkDate(body.paid_at || todayISO()), str(body.method) || 'pix', str(body.notes)]);
  return { id: r.rows[0].id };
}));

api.delete('/payments/:id', h(async ({ params }) => {
  await run('DELETE FROM payments WHERE id = ?', [Number(params.id)]);
  return { ok: true };
}));

// ---------------------------------------------------------------- dashboard

function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

api.get('/dashboard', h(async ({ query }) => {
  const today = todayISO();
  const currentMonth = today.slice(0, 7);
  const todayDay = Number(today.slice(8, 10));
  const month = checkMonth(query.month || currentMonth);
  const isPast = month < currentMonth;
  const isCurrent = month === currentMonth;

  const months = Array.from({ length: 6 }, (_, i) => shiftMonth(month, i - 5));

  // Todas as consultas do painel em paralelo (cada ida ao banco custa ~180 ms)
  const [subs, totals, byMethod, byPlan] = await Promise.all([all(`
    SELECT s.id, s.name, s.email, s.phone, s.due_day, s.status, s.start_date, s.cancel_at, s.retention_answer,
           p.name AS plan_name, p.price_cents,
           COALESCE((SELECT SUM(amount_cents) FROM payments WHERE subscriber_id = s.id AND ref_month = ?), 0) AS paid_cents,
           (SELECT MAX(paid_at) FROM payments WHERE subscriber_id = s.id AND ref_month = ?) AS last_paid_at,
           (SELECT string_agg(DISTINCT method, ',') FROM payments WHERE subscriber_id = s.id AND ref_month = ?) AS paid_methods
    FROM subscribers s JOIN plans p ON p.id = s.plan_id
    WHERE s.status = 'ativo' AND to_char(s.start_date, 'YYYY-MM') <= ?
    ORDER BY lower(s.name)`, [month, month, month, month]),
    all(`
      SELECT ref_month, COALESCE(SUM(amount_cents), 0) AS total FROM payments
      WHERE ref_month = ANY(?) GROUP BY ref_month`, [[...new Set([...months, month])]]),
    all(`
      SELECT method, COUNT(*) AS count, SUM(amount_cents) AS total_cents,
             COUNT(*) FILTER (WHERE mp_payment_id IS NOT NULL) AS online
      FROM payments WHERE ref_month = ? GROUP BY method ORDER BY SUM(amount_cents) DESC`, [month]),
    all(`
      SELECT p.name, p.price_cents, COUNT(s.id) AS subscribers
      FROM plans p LEFT JOIN subscribers s ON s.plan_id = p.id AND s.status = 'ativo'
      GROUP BY p.id ORDER BY p.price_cents DESC`),
  ]);

  let expected = 0, coveredReceived = 0, paidCount = 0, overdueCount = 0;
  for (const s of subs) {
    const duePassed = isPast || (isCurrent && todayDay > s.due_day);
    expected += s.price_cents;
    coveredReceived += Math.min(s.paid_cents, s.price_cents);
    if (s.paid_cents >= s.price_cents) { s.pay_status = 'pago'; paidCount++; }
    else if (s.paid_cents > 0) s.pay_status = 'parcial';
    else s.pay_status = duePassed ? 'atrasado' : 'pendente';
    if (s.pay_status !== 'pago' && duePassed) overdueCount++;
  }

  const totalOf = (m) => totals.find((t) => t.ref_month === m)?.total ?? 0;

  return {
    month,
    kpis: {
      active_subscribers: subs.length,
      expected_cents: expected,
      received_cents: totalOf(month),
      pending_cents: Math.max(expected - coveredReceived, 0),
      paid_count: paidCount,
      overdue_count: overdueCount,
    },
    subscribers: subs,
    by_method: byMethod,
    by_plan: byPlan,
    history: months.map((m) => ({ month: m, received_cents: totalOf(m) })),
  };
}));

// ---------------------------------------------------------------- WhatsApp (Evolution API)

const evoSafe = (fn) => async (...args) => {
  try {
    return await fn(...args);
  } catch (err) {
    if (err.expose) throw err;
    console.error('WhatsApp:', err.message);
    throw new ApiError(502, String(err.message).startsWith('Evolution') || String(err.message).startsWith('WhatsApp')
      ? err.message : 'Não foi possível falar com a Evolution API. Tente de novo.');
  }
};

api.get('/whatsapp', h(evoSafe(() => whatsappStatus())));
api.post('/whatsapp/qr', h(evoSafe(() => whatsappQr())));
api.post('/whatsapp/logout', h(evoSafe(async () => {
  await whatsappLogout();
  return whatsappStatus();
})));
// ---------------------------------------------------------------- notificações push (app do painel no celular)

api.get('/push', h(async (req) => ({ public_key: await pushPublicKey(), devices: (await pushDevices(currentAdmin(req))).map((d) => ({ ...d, endpoint: undefined, current: d.endpoint === req.query.endpoint })) })));
api.post('/push/subscribe', h(async (req) => {
  await savePushSubscription(req.body?.subscription, currentAdmin(req), req.get('user-agent'));
  return { ok: true };
}));
api.post('/push/unsubscribe', h(async (req) => {
  await removePushSubscription(req.body?.endpoint);
  return { ok: true };
}));
api.post('/push/test', h(async (req) => {
  const r = await sendPush({ title: 'Notificações ativadas', body: 'Você vai ser avisado aqui de novos clientes e pagamentos.', tag: 'teste' }, { adminEmail: currentAdmin(req) });
  if (!r.sent) throw new ApiError(400, 'Nenhum aparelho recebeu. Ative as notificações neste aparelho primeiro.');
  return r;
}));

// ---------------------------------------------------------------- modelos das mensagens (push e WhatsApp)

api.get('/templates', h(async ({ query }) => ({ templates: await listTemplates(query.channel === 'push' || query.channel === 'whatsapp' ? query.channel : undefined) })));
api.put('/templates/:key', h(({ params, body }) => saveTemplate(params.key, body || {})));
api.post('/templates/:key/reset', h(({ params }) => resetTemplate(params.key)));
// Envia um exemplo (com dados fictícios) do texto que está na tela, mesmo antes de salvar
api.post('/templates/:key/test', h(evoSafe(async (req) => {
  const info = templateInfo(req.params.key);
  if (!info) throw new ApiError(404, 'Modelo não encontrado.');
  const all = sampleVars();
  const vars = Object.fromEntries(info.vars.map((k) => [k, all[k]]));
  const body = fill(str(req.body?.body) || info.body, vars).slice(0, 2500);
  if (!body) throw new ApiError(400, 'A mensagem está vazia.');
  if (info.channel === 'push') {
    const title = fill(str(req.body?.title) || info.title, vars).slice(0, 120);
    const r = await sendPush({ title, body, url: info.url, tag: `teste-${info.key}` }, { adminEmail: currentAdmin(req) });
    if (!r.sent) throw new ApiError(400, 'Nenhum aparelho seu recebeu. Ative as notificações neste aparelho primeiro.');
    return { ok: true, sent: r.sent };
  }
  const st = await whatsappStatus();
  if (st.state !== 'open') throw new ApiError(400, 'O WhatsApp está desconectado. Conecte pelo QR Code primeiro.');
  if (!st.admin_numbers?.length) throw new ApiError(400, 'Nenhum número de admin configurado para receber o teste.');
  await notifyAdmin(body);
  return { ok: true, sent_to: st.admin_numbers };
})));

// Intervalo entre os avisos programados para clientes (anti-bloqueio do WhatsApp)
api.get('/whatsapp/pacing', h(() => pacingStatus()));
api.put('/whatsapp/pacing', h(async ({ body }) => {
  await savePacing(body || {});
  return pacingStatus();
}));

api.post('/whatsapp/test', h(evoSafe(async () => {
  const st = await whatsappStatus();
  if (st.state !== 'open') throw new ApiError(400, 'O WhatsApp está desconectado. Conecte pelo QR Code primeiro.');
  await notifyAdmin(`✅ *Teste do Control Claude*\n\nOs avisos no WhatsApp estão funcionando.\n🕒 ${new Date().toLocaleString('pt-BR', { timeZone: process.env.NOTIFY_TIMEZONE || 'America/Sao_Paulo' })}`);
  return { ok: true, sent_to: st.admin_numbers };
})));
