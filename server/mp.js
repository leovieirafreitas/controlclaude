// Integração com o Mercado Pago pela Orders API (checkout transparente: cartão e Pix no próprio site).
// O pagamento só é registrado depois de conferido direto na API do Mercado Pago —
// nunca confiamos no navegador nem no corpo do webhook.
// Os dados do cartão são tokenizados no navegador pelo SDK do Mercado Pago (Card Payment Brick);
// o servidor só recebe o token.
import { all, get, run } from './db.js';
import { notifyPayment } from './whatsapp.js';

const TOKEN = process.env.MP_ACCESS_TOKEN || '';
export const MP_PUBLIC_KEY = process.env.MP_PUBLIC_KEY || '';
const API = 'https://api.mercadopago.com';

export const mpConfigured = Boolean(TOKEN && MP_PUBLIC_KEY);

// Tabela checkouts: guarda o id do pedido (order) do Mercado Pago na coluna preference_id.

class MpError extends Error {
  constructor(status, data) {
    super(`Mercado Pago ${status}: ${data?.message || JSON.stringify(data?.errors || data).slice(0, 300)}`);
    this.mpStatus = status;
    this.data = data;
  }
}

async function mp(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(method === 'POST' ? { 'X-Idempotency-Key': crypto.randomUUID() } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new MpError(res.status, data);
  return data;
}

// Referência do pedido: sub_<id do assinante>_<AAAAMM> (a Orders API só aceita letras, números, _ e -)
const extRef = (subscriberId, month) => `sub_${subscriberId}_${month.replace('-', '')}`;
const REF_RE = /^sub_(\d+)_(\d{4})(0[1-9]|1[0-2])$/;
const money = (cents) => (cents / 100).toFixed(2);
const METHOD = { credit_card: 'credito', debit_card: 'debito', prepaid_card: 'credito', bank_transfer: 'pix', ticket: 'boleto' };

// Mensagens para recusas de cartão (status_detail da Orders API / Payments)
const REJECT_MSG = {
  insufficient_amount: 'Saldo ou limite insuficiente.',
  cc_rejected_insufficient_amount: 'Saldo ou limite insuficiente.',
  invalid_security_code: 'Código de segurança inválido.',
  cc_rejected_bad_filled_security_code: 'Código de segurança inválido.',
  invalid_expiration_date: 'Data de validade inválida.',
  cc_rejected_bad_filled_date: 'Data de validade inválida.',
  call_for_authorize: 'O banco pediu autorização. Ligue para o seu banco e tente de novo.',
  cc_rejected_call_for_authorize: 'O banco pediu autorização. Ligue para o seu banco e tente de novo.',
  rejected_high_risk: 'Pagamento recusado pela análise de segurança. Tente outro cartão ou o Pix.',
  cc_rejected_high_risk: 'Pagamento recusado pela análise de segurança. Tente outro cartão ou o Pix.',
};
const rejectMessage = (detail) => REJECT_MSG[detail] || 'O pagamento foi recusado. Confira os dados ou tente outro cartão ou o Pix.';

function firstPayment(order) {
  return (order?.transactions?.payments || [])[0] || {};
}

/**
 * Registra o pagamento de um pedido aprovado (idempotente).
 * Retorna true se registrou agora.
 */
async function recordOrder(order) {
  const pay = firstPayment(order);
  const approved = order.status === 'processed' || pay.status === 'processed' || pay.status_detail === 'accredited';
  if (!approved) return false;
  const m = REF_RE.exec(order.external_reference || '');
  if (!m) return false;
  const [, subId, year, mm] = m;
  const month = `${year}-${mm}`;
  const sub = await get('SELECT id, status FROM subscribers WHERE id = ?', [Number(subId)]);
  if (!sub) return false;

  const r = await run(`
    INSERT INTO payments (subscriber_id, ref_month, amount_cents, paid_at, method, notes, mp_payment_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (mp_payment_id) WHERE mp_payment_id IS NOT NULL DO NOTHING`, [
    sub.id, month, Math.round(Number(pay.amount || order.total_amount) * 100),
    new Date().toLocaleDateString('sv-SE'),
    METHOD[pay.payment_method?.type] || 'credito', `Mercado Pago ${order.id}`, String(pay.id || order.id)]);

  if (r.rowCount && sub.status !== 'ativo') {
    await run("UPDATE subscribers SET status = 'ativo' WHERE id = ?", [sub.id]);
  }
  if (r.rowCount) {
    // Aviso no WhatsApp do admin (não espera nem quebra o pagamento se falhar)
    notifyPayment({
      subscriberId: sub.id, month, orderId: order.id,
      amountCents: Math.round(Number(pay.amount || order.total_amount) * 100),
      method: METHOD[pay.payment_method?.type] || 'credito',
    }).catch((e) => console.error('WhatsApp:', e.message));
  }
  return Boolean(r.rowCount);
}

async function saveCheckout(sub, month, order, amountCents) {
  await run(`
    INSERT INTO checkouts (subscriber_id, ref_month, external_reference, preference_id, amount_cents)
    VALUES (?, ?, ?, ?, ?)`, [sub.id, month, extRef(sub.id, month), order.id, amountCents]);
}

/**
 * Paga com cartão. `card` vem do Card Payment Brick:
 * { token, payment_method_id, payment_type_id?, installments, payer: { email, identification } }
 * Retorna { status: 'approved' | 'pending' | 'rejected', message }
 */
export async function payWithCard(sub, plan, month, card) {
  const type = card.payment_type_id || (String(card.payment_method_id).startsWith('deb') ? 'debit_card' : 'credit_card');
  const identification = card.payer?.identification?.number
    ? { type: card.payer.identification.type || 'CPF', number: String(card.payer.identification.number).replace(/\D/g, '') }
    : undefined;
  let order;
  try {
    order = await mp('/v1/orders', {
      method: 'POST',
      body: {
        type: 'online',
        processing_mode: 'automatic',
        total_amount: money(plan.price_cents),
        external_reference: extRef(sub.id, month),
        description: `${plan.name} — mensalidade ${month.slice(5)}-${month.slice(0, 4)}`,
        payer: { email: card.payer?.email || sub.email, ...(identification ? { identification } : {}) },
        transactions: {
          payments: [{
            amount: money(plan.price_cents),
            payment_method: { id: card.payment_method_id, type, token: card.token, installments: Number(card.installments) || 1 },
          }],
        },
      },
    });
  } catch (err) {
    // Recusa do cartão: a Orders API devolve erro HTTP com o pedido (e o motivo) no corpo.
    // Outros erros (formato, credencial) não são recusa: sobem como erro do sistema.
    const failedPay = err.data?.data?.transactions?.payments?.[0];
    if (failedPay?.status_detail) {
      if (err.data.data.id) await saveCheckout(sub, month, err.data.data, plan.price_cents);
      return { status: 'rejected', message: rejectMessage(failedPay.status_detail) };
    }
    console.error(err.message);
    throw err;
  }
  await saveCheckout(sub, month, order, plan.price_cents);

  if (await recordOrder(order) || order.status === 'processed') return { status: 'approved', message: 'Pagamento aprovado!' };
  const pay = firstPayment(order);
  if (order.status === 'failed' || pay.status === 'failed') return { status: 'rejected', message: rejectMessage(pay.status_detail || order.status_detail) };
  return { status: 'pending', message: 'Pagamento em análise. Avisaremos assim que for aprovado.' };
}

/** Gera um Pix. Retorna { order_id, qr_code, qr_code_base64, ticket_url } */
export async function payWithPix(sub, plan, month) {
  const order = await mp('/v1/orders', {
    method: 'POST',
    body: {
      type: 'online',
      processing_mode: 'automatic',
      total_amount: money(plan.price_cents),
      external_reference: extRef(sub.id, month),
      description: `${plan.name} — mensalidade ${month.slice(5)}-${month.slice(0, 4)}`,
      payer: { email: sub.email },
      transactions: { payments: [{ amount: money(plan.price_cents), payment_method: { id: 'pix', type: 'bank_transfer' } }] },
    },
  });
  await saveCheckout(sub, month, order, plan.price_cents);
  const pm = firstPayment(order).payment_method || {};
  return { order_id: order.id, qr_code: pm.qr_code, qr_code_base64: pm.qr_code_base64, ticket_url: pm.ticket_url };
}

/** Confere um pedido pelo id (webhook ou "já paguei"). */
export async function syncOrderId(orderId, onlySubscriberId) {
  const order = await mp(`/v1/orders/${encodeURIComponent(orderId)}`);
  if (onlySubscriberId && !String(order.external_reference || '').startsWith(`sub_${onlySubscriberId}_`)) return null;
  await recordOrder(order);
  return order;
}

/** Confere no Mercado Pago os pedidos recentes ainda não registrados do assinante. */
export async function syncSubscriber(subscriberId) {
  const rows = await all(`
    SELECT DISTINCT c.preference_id AS order_id FROM checkouts c
    WHERE c.subscriber_id = ? AND c.created_at > now() - interval '90 days'
      AND c.preference_id LIKE 'ORD%'
      AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.notes = 'Mercado Pago ' || c.preference_id)`, [subscriberId]);
  let added = 0;
  for (const { order_id } of rows) {
    const order = await mp(`/v1/orders/${encodeURIComponent(order_id)}`).catch(() => null);
    if (order && (await recordOrder(order))) added++;
  }
  return added;
}

/**
 * Rede de segurança (funciona mesmo sem webhook): confere no Mercado Pago os pedidos
 * das últimas 48 h que ainda não viraram pagamento — ex.: cliente pagou o Pix e fechou a página.
 */
export async function syncPendingCheckouts() {
  if (!mpConfigured) return 0;
  const subs = await all(`
    SELECT DISTINCT c.subscriber_id FROM checkouts c
    WHERE c.created_at > now() - interval '48 hours' AND c.preference_id LIKE 'ORD%'
      AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.notes = 'Mercado Pago ' || c.preference_id)`);
  let added = 0;
  for (const { subscriber_id } of subs) added += await syncSubscriber(subscriber_id).catch(() => 0);
  if (added) console.log(`Mercado Pago: ${added} pagamento(s) encontrado(s) na conferência automática`);
  return added;
}
