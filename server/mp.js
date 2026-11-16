// Integração com o Mercado Pago pela Orders API (checkout transparente: cartão e Pix no próprio site).
// O pagamento só é registrado depois de conferido direto na API do Mercado Pago —
// nunca confiamos no navegador nem no corpo do webhook.
// Os dados do cartão são tokenizados no navegador pelo SDK do Mercado Pago (Card Payment Brick);
// o servidor só recebe o token.
import { todayISO } from './time.js';
import { all, get, run } from './db.js';
import { notifyPayment, notifyUnderpaid, notifyWorkspace, notifyReactivated, notifyPaymentIssue } from './whatsapp.js';
import { provisionWorkspace } from './workspace.js';

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

// deviceId: identificação do aparelho gerada pelo script de segurança do Mercado Pago (security.js)
// na área do assinante. Ajuda o antifraude a aprovar (menos recusas "cc_rejected_high_risk").
async function mp(path, { method = 'GET', body, deviceId } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(method === 'POST' ? { 'X-Idempotency-Key': crypto.randomUUID() } : {}),
      ...(deviceId ? { 'X-meli-session-id': deviceId } : {}),
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
  rejected_high_risk: 'O Mercado Pago recusou o pagamento na análise de segurança. Fale com a gente no WhatsApp que ajudamos você.',
  cc_rejected_high_risk: 'O Mercado Pago recusou o pagamento na análise de segurança. Fale com a gente no WhatsApp que ajudamos você.',
  cc_rejected_3ds_challenge: 'A confirmação com o seu banco não foi concluída. Tente de novo e confirme a compra quando o banco pedir.',
  expired: 'O tempo para confirmar a compra com o banco acabou. Tente de novo.',
};
// Recusas do antifraude: tentar de novo em seguida com os mesmos dados piora (o Mercado Pago bloqueia as próximas)
export const isRiskReject = (detail) => /high_risk|blacklist/.test(String(detail || ''));
const rejectMessage = (detail) => REJECT_MSG[detail] || 'O pagamento foi recusado. Confira os dados do cartão ou tente outro cartão de crédito.';

function firstPayment(order) {
  return (order?.transactions?.payments || [])[0] || {};
}

/**
 * Ativa o plano só se o que foi pago no mês cobre o preço do plano ATUAL do assinante.
 * Impede trocar para um plano mais caro depois de gerar o Pix (ou o link) do plano mais barato.
 * Se faltar, o pagamento fica registrado (o dinheiro entrou), o plano não é ativado e o admin é avisado.
 */
export async function activateIfPaid(subId, month, paidNowCents) {
  const s = await get(`
    SELECT s.id, s.status, COALESCE(s.monthly_cents, p.price_cents) AS price_cents, s.first_month, s.first_cents,
           (SELECT COALESCE(SUM(amount_cents), 0) FROM payments WHERE subscriber_id = s.id AND ref_month = ?) AS paid
    FROM subscribers s JOIN plans p ON p.id = s.plan_id WHERE s.id = ?`, [month, subId]);
  if (!s) return false;
  // 1º pagamento proporcional (cliente novo com vencimento fixo): o valor devido neste mês é o proporcional
  if (s.first_month === month && s.first_cents != null) s.price_cents = s.first_cents;
  if (Number(s.paid) >= Number(s.price_cents)) {
    if (s.status !== 'ativo') {
      await run("UPDATE subscribers SET status = 'ativo' WHERE id = ?", [s.id]);
      // estava desativado por falta de pagamento: avisa o admin para liberar o acesso de novo
      if (s.status === 'pausado') notifyReactivated(s.id).catch((e) => console.error('Aviso de reativação:', e.message));
      // Plano ATIVADO agora pelo pagamento (não é renovação): cria o e-mail institucional, se ainda não tem
      provisionWorkspace(s.id, notifyWorkspace).catch((e) => console.error('Google Workspace:', e.message));
    }
    return true;
  }
  console.warn(`Pagamento menor que o plano (assinante ${s.id}, ${month}): pago ${s.paid}, plano ${s.price_cents}`);
  notifyUnderpaid({ subscriberId: s.id, month, paidCents: Number(s.paid), lastCents: paidNowCents })
    .catch((e) => console.error('Aviso de pagamento menor:', e.message));
  return false;
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
    todayISO(),
    METHOD[pay.payment_method?.type] || 'credito', `Mercado Pago ${order.id}`, String(pay.id || order.id)]);

  if (r.rowCount) await activateIfPaid(sub.id, month, Math.round(Number(pay.amount || order.total_amount) * 100));
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
/** Endereço de cobrança do titular no formato da Orders API. */
function payerAddress(a) {
  if (!a?.zip) return {};
  return { address: {
    zip_code: a.zip, street_name: a.street, street_number: a.number,
    ...(a.district ? { neighborhood: a.district } : {}), city: a.city, state: a.state,
  } };
}

/** Nome e telefone do titular do cartão no formato da Orders API. */
function payerExtra(holder) {
  if (!holder) return {};
  const [first, ...rest] = holder.name.split(' ');
  const d = String(holder.phone || '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
  return {
    first_name: first.slice(0, 60),
    ...(rest.length ? { last_name: rest.join(' ').slice(0, 60) } : {}),
    ...(d.length >= 10 ? { phone: { area_code: d.slice(0, 2), number: d.slice(2) } } : {}),
  };
}

/**
 * Histórico do comprador no nosso site, no formato que o Mercado Pago recomenda para aplicativos e plataformas online
 * (additional_info com chaves "payer.*"): ajuda o antifraude a reconhecer cliente cadastrado e recorrente.
 */
function buyerHistory(h) {
  if (!h) return null;
  const iso = (v) => { const d = v ? new Date(v) : null; return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null; };
  const info = { 'payer.authentication_type': 'WEB', 'payer.is_first_purchase_online': Boolean(h.first) };
  if (iso(h.registered_at)) info['payer.registration_date'] = iso(h.registered_at);
  if (iso(h.last_purchase)) info['payer.last_purchase'] = iso(h.last_purchase);
  return info;
}

export async function payWithCard(sub, plan, month, card, deviceId, holder, history) {
  const type = card.payment_type_id || (String(card.payment_method_id).startsWith('deb') ? 'debit_card' : 'credit_card');
  const identification = card.payer?.identification?.number
    ? { type: card.payer.identification.type || 'CPF', number: String(card.payer.identification.number).replace(/\D/g, '') }
    : undefined;
  const description = `Mensalidade Control Claude ${month.slice(5)}/${month.slice(0, 4)}`;
  const body = {
    type: 'online',
    processing_mode: 'automatic',
    total_amount: money(plan.price_cents),
    external_reference: extRef(sub.id, month),
    description,
    // dados do TITULAR do cartão (checkout): o antifraude compara com o cartão
    payer: { email: card.payer?.email || sub.email, ...(identification ? { identification } : {}), ...payerExtra(holder) },
    transactions: {
      payments: [{
        amount: money(plan.price_cents),
        payment_method: { id: card.payment_method_id, type, token: card.token, installments: Number(card.installments) || 1 },
      }],
    },
  };
  // Recomendações do Mercado Pago para aprovar mais:
  //  - 3DS "on_fraud_risk": quando o antifraude desconfia, em vez de recusar, pede a confirmação do banco do cliente
  //  - dados do produto (items)
  //  - histórico do comprador no site (additional_info)
  const extras = CARD_3DS ? {
    config: { online: { transaction_security: { validation: 'on_fraud_risk', liability_shift: 'required' } } },
    items: [{ title: plan.name, description, quantity: 1, unit_price: money(plan.price_cents), category_id: 'services', external_code: `plano-${plan.id}` }],
  } : {};
  const info = CARD_3DS ? buyerHistory(history) : null;
  // tentativas, da mais completa para a mais simples: se o Mercado Pago não aceitar um campo novo (erro 400), cai para a seguinte
  // endereço de cobrança do titular (recomendado pelo Mercado Pago); fica fora do pedido básico para não travar se for recusado
  const addr = CARD_3DS && holder?.address ? payerAddress(holder.address) : null;
  const withAddr = (b) => (addr ? { ...b, payer: { ...b.payer, ...addr } } : b);
  const bodies = [
    info ? withAddr({ ...body, ...extras, additional_info: info }) : null,
    addr ? withAddr({ ...body, ...extras }) : null,
    CARD_3DS ? { ...body, ...extras } : null,
    body,
  ].filter(Boolean);
  const rejection = async (err) => {
    // Recusa do cartão: a Orders API devolve erro HTTP com o pedido (e o motivo) no corpo.
    const failedPay = err.data?.data?.transactions?.payments?.[0];
    if (!failedPay?.status_detail) return null;
    if (err.data.data.id) await saveCheckout(sub, month, err.data.data, plan.price_cents);
    return { status: 'rejected', detail: failedPay.status_detail, message: rejectMessage(failedPay.status_detail) };
  };
  let order;
  for (const [i, attempt] of bodies.entries()) {
    try {
      order = await mp('/v1/orders', { method: 'POST', deviceId, body: attempt });
      break;
    } catch (err) {
      const rejected = await rejection(err);
      if (rejected) return rejected;
      // Outros erros (formato, credencial) não são recusa. Se foi por causa de um campo novo (400), tenta a versão mais simples.
      console.error(`Pedido no cartão (tentativa ${i + 1} de ${bodies.length}):`, err.message);
      if (err.mpStatus !== 400 || i === bodies.length - 1) throw err;
    }
  }
  await saveCheckout(sub, month, order, plan.price_cents);
  return orderOutcome(order);
}

// 3DS ligado por padrão; CARD_3DS=off no .env desliga
const CARD_3DS = !/^(off|0|false|nao|não)$/i.test(process.env.CARD_3DS || 'on');

/** Resultado de um pedido no cartão: aprovado, recusado, esperando a confirmação do banco (3DS) ou em análise. */
async function orderOutcome(order) {
  if (await recordOrder(order) || order.status === 'processed') return { status: 'approved', message: 'Pagamento aprovado!' };
  const pay = firstPayment(order);
  const detail = pay.status_detail || order.status_detail;
  if (order.status === 'action_required' || pay.status === 'action_required') {
    const url = pay.payment_method?.transaction_security?.url;
    if (url && detail === 'pending_challenge') return { status: 'challenge', challenge_url: url, order_id: order.id, message: 'Confirme a compra com o seu banco.' };
  }
  if (['failed', 'canceled', 'cancelled', 'expired'].includes(order.status) || ['failed', 'canceled', 'cancelled'].includes(pay.status)) {
    return { status: 'rejected', detail, message: rejectMessage(detail) };
  }
  return { status: 'pending', message: 'Pagamento em análise. Avisaremos assim que for aprovado.' };
}

/** Depois da confirmação do banco (3DS): consulta o pedido e registra o pagamento se aprovou. */
export async function cardOrderResult(orderId, subscriberId) {
  const order = await mp(`/v1/orders/${encodeURIComponent(orderId)}`);
  if (!String(order.external_reference || '').startsWith(`sub_${subscriberId}_`)) return null;
  const out = await orderOutcome(order);
  // ainda esperando o banco: não devolve a URL de novo
  return out.status === 'challenge' ? { status: 'waiting', message: 'Aguardando a confirmação do banco…' } : out;
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
  const pay = firstPayment(order);
  const pm = pay.payment_method || {};
  return { order_id: order.id, qr_code: pm.qr_code, qr_code_base64: pm.qr_code_base64, ticket_url: pm.ticket_url,
    expires_at: pay.date_of_expiration || order.expiration_time || null };
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

// ------------------------------------------------------------------ renovação automática (assinatura no cartão)
//
// O cliente autoriza o cartão uma vez (POST /preapproval com o token do Card Payment Brick) e o
// Mercado Pago cobra sozinho todo mês. A 1ª cobrança acontece na hora da autorização.
// Cada cobrança aprovada vira um pagamento no painel (mp_payment_id evita duplicar).
// Cancelar = pausar (para de cobrar, o acesso pago continua); no fim do acesso, cancela de vez.

const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');
const BACK_URL = APP_URL.startsWith('https://') ? `${APP_URL}/conta` : 'https://controlclaude.com.br/conta';

const autopayReject = (err) => {
  const msg = String(err.data?.message || err.message || '');
  if (/CC_VAL_433|rejected|card_token|Invalid_payment_method|Unsupported_credit_card/i.test(msg)) {
    return /Unsupported_credit_card|Invalid_payment_method/i.test(msg)
      ? 'Este cartão não aceita cobrança mensal automática. Tente outro cartão de crédito.'
      : 'O Mercado Pago não aprovou este cartão. Confira se nome, CPF e e-mail são do dono do cartão e se as compras online estão liberadas no app do banco. Se não der, tente outro cartão de crédito ou fale com a gente no WhatsApp.';
  }
  return null;
};

/** Muda o status da assinatura no Mercado Pago: 'paused' | 'authorized' | 'cancelled'. */
export async function setAutopayStatus(sub, status) {
  if (!sub?.mp_preapproval_id || !mpConfigured) return false;
  if (sub.autopay_status === status || sub.autopay_status === 'cancelled') return false;
  const pre = await mp(`/preapproval/${encodeURIComponent(sub.mp_preapproval_id)}`, { method: 'PUT', body: { status } });
  await run('UPDATE subscribers SET autopay_status = ?, next_charge_date = ? WHERE id = ?',
    [pre.status || status, pre.next_payment_date ? String(pre.next_payment_date).slice(0, 10) : null, sub.id]);
  return true;
}

/** Ajusta o valor da cobrança mensal (troca de plano). */
export async function setAutopayAmount(sub, priceCents) {
  if (!sub?.mp_preapproval_id || !mpConfigured || sub.autopay_status === 'cancelled') return;
  await mp(`/preapproval/${encodeURIComponent(sub.mp_preapproval_id)}`, {
    method: 'PUT', body: { auto_recurring: { transaction_amount: Number(money(priceCents)), currency_id: 'BRL' } },
  });
}

/** Registra uma cobrança aprovada da assinatura (idempotente). Retorna true se registrou agora. */
async function recordAutopayCharge(subId, invoice) {
  const pay = invoice.payment || {};
  if (pay.status !== 'approved' || !pay.id) return false;
  const sub = await get(`SELECT s.*, COALESCE(s.monthly_cents, p.price_cents) AS price_cents FROM subscribers s JOIN plans p ON p.id = s.plan_id WHERE s.id = ?`, [subId]);
  if (!sub) return false;
  if (await get('SELECT 1 AS x FROM payments WHERE mp_payment_id = ?', [String(pay.id)])) return false;

  // cobre o primeiro mês ainda não quitado (mesma regra do pagamento avulso)
  const month = await (await import('./member.js')).billingMonth(sub, sub.price_cents);
  const amountCents = Math.round(Number(invoice.transaction_amount || pay.transaction_amount || 0) * 100);
  const ref = invoice.id || pay.id; // logo após a cobrança, a fatura às vezes ainda vem sem número
  const r = await run(`
    INSERT INTO payments (subscriber_id, ref_month, amount_cents, paid_at, method, notes, mp_payment_id)
    VALUES (?, ?, ?, ?, 'credito', ?, ?)
    ON CONFLICT (mp_payment_id) WHERE mp_payment_id IS NOT NULL DO NOTHING`,
  [sub.id, month, amountCents, todayISO(), `Mercado Pago renovação automática ${ref}`, String(pay.id)]);
  if (!r.rowCount) return false;

  await activateIfPaid(sub.id, month, amountCents); // foi cobrado: ativa se cobriu o preço do plano
  // o vencimento passa a ser o dia em que o cartão é cobrado
  const day = Math.min(Number(todayISO().slice(8, 10)), 28);
  if (sub.due_day !== day) await run('UPDATE subscribers SET due_day = ? WHERE id = ?', [day, sub.id]);
  notifyPayment({ subscriberId: sub.id, month, orderId: `renovação automática ${ref}`, amountCents, method: 'credito', autopay: true })
    .catch((e) => console.error('WhatsApp:', e.message));
  return true;
}

/**
 * Confere a assinatura no Mercado Pago: status, próxima cobrança, final do cartão e cobranças aprovadas.
 * Retorna quantas cobranças novas registrou.
 */
export async function syncAutopay(sub) {
  if (!sub?.mp_preapproval_id || !mpConfigured) return 0;
  const id = encodeURIComponent(sub.mp_preapproval_id);
  const [pre, inv] = await Promise.all([mp(`/preapproval/${id}`), mp(`/authorized_payments/search?preapproval_id=${id}`)]);
  await run('UPDATE subscribers SET autopay_status = ?, next_charge_date = ? WHERE id = ?',
    [pre.status || sub.autopay_status, pre.next_payment_date ? String(pre.next_payment_date).slice(0, 10) : null, sub.id]);
  let added = 0;
  for (const invoice of inv.results || []) {
    if (await recordAutopayCharge(sub.id, invoice)) added++;
    if (!sub.card_last4 && invoice.payment?.id && invoice.payment.status === 'approved') {
      const p = await mp(`/v1/payments/${invoice.payment.id}`).catch(() => null);
      if (p?.card?.last_four_digits) {
        await run('UPDATE subscribers SET card_last4 = ?, card_brand = ? WHERE id = ?', [p.card.last_four_digits, p.payment_method_id || null, sub.id]);
        sub.card_last4 = p.card.last_four_digits;
      }
    }
  }
  return added;
}

/**
 * Liga a renovação automática com o cartão do Card Payment Brick e faz a 1ª cobrança.
 * Se já existe uma assinatura no Mercado Pago, ela é substituída (o cartão novo passa a valer).
 * Retorna { status: 'approved' | 'pending' | 'rejected', message }.
 */
export async function startAutopay(sub, plan, card, deviceId) {
  let pre;
  try {
    pre = await mp('/preapproval', {
      method: 'POST',
      deviceId,
      body: {
        reason: `${plan.name} — Control Claude`,
        external_reference: `sub_${sub.id}`,
        // MP_TEST_PAYER_EMAIL: só no .env de teste (o sandbox exige o e-mail do comprador de teste)
        payer_email: process.env.MP_TEST_PAYER_EMAIL || card.payer?.email || sub.email,
        card_token_id: card.token,
        status: 'authorized',
        back_url: BACK_URL,
        auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: Number(money(plan.price_cents)), currency_id: 'BRL' },
      },
    });
  } catch (err) {
    const message = autopayReject(err);
    console.error(`Renovação automática recusada (assinante ${sub.id}):`, err.message);
    // recusada: a tela oferece pagar este mês de forma avulsa (análise do antifraude é mais leve)
    if (message) return { status: 'rejected', message, allow_once: true, reason: String(err.data?.message || err.message).slice(0, 200) };
    throw err;
  }

  // a assinatura antiga (se houver) deixa de cobrar: vale só o cartão novo
  if (sub.mp_preapproval_id && sub.mp_preapproval_id !== pre.id && sub.autopay_status !== 'cancelled') {
    await mp(`/preapproval/${encodeURIComponent(sub.mp_preapproval_id)}`, { method: 'PUT', body: { status: 'cancelled' } })
      .catch((e) => console.error('Mercado Pago (assinatura antiga):', e.message));
  }
  await run(`UPDATE subscribers SET mp_preapproval_id = ?, autopay_status = ?, card_last4 = NULL, card_brand = ?,
             next_charge_date = ?, cancel_at = NULL, cancel_requested_at = NULL, retention_answer = NULL WHERE id = ?`,
  [pre.id, pre.status, card.payment_method_id || null, pre.next_payment_date ? String(pre.next_payment_date).slice(0, 10) : null, sub.id]);
  const fresh = { ...sub, mp_preapproval_id: pre.id, autopay_status: pre.status, card_last4: null };

  // a 1ª cobrança costuma aparecer em poucos segundos
  for (let i = 0; i < 6; i++) {
    await new Promise((s) => setTimeout(s, 2000));
    if (await syncAutopay(fresh)) return { status: 'approved', message: 'Pagamento aprovado! A renovação automática está ligada.' };
  }
  return { status: 'pending', message: 'Cartão autorizado! A primeira cobrança está sendo processada e seu plano é ativado assim que for aprovada.' };
}

/** Troca o cartão da renovação automática sem cobrar agora. */
export async function changeAutopayCard(sub, card) {
  try {
    await mp(`/preapproval/${encodeURIComponent(sub.mp_preapproval_id)}`, { method: 'PUT', body: { card_token_id: card.token } });
  } catch (err) {
    const message = autopayReject(err);
    if (message) return { status: 'rejected', message };
    throw err;
  }
  await run('UPDATE subscribers SET card_last4 = NULL, card_brand = ? WHERE id = ?', [card.payment_method_id || null, sub.id]);
  return { status: 'approved', message: 'Cartão atualizado! As próximas cobranças serão feitas nele.' };
}

// ------------------------------------------------------------------ assinatura pelo link do Mercado Pago
//
// Fluxo recomendado pelo Mercado Pago: o site cria a assinatura "pendente" e manda o cliente para a página
// do Mercado Pago (init_point). Lá ele entra na conta dele (ou paga sem conta), autoriza o cartão e paga o
// 1º mês. O antifraude tem muito mais informação nesse fluxo (conta, histórico, aparelho) e aprova mais.
// Quando a assinatura fica "authorized", ela passa a ser a renovação automática do assinante.

const enc = encodeURIComponent;

/** Cancela um link/assinatura no Mercado Pago (ex.: link gerado para o plano anterior). */
export async function cancelPreapproval(id) {
  if (!id || !mpConfigured) return;
  await mp(`/preapproval/${enc(id)}`, { method: 'PUT', body: { status: 'cancelled' } });
}
const ymd = (v) => (v ? String(v).slice(0, 10) : null);

/** Cria (ou reaproveita) o link de assinatura do Mercado Pago para o assinante. Retorna a URL. */
export async function createAutopayLink(sub, plan) {
  const amount = Number(money(plan.price_cents));
  if (sub.mp_preapproval_pending) {
    const old = await mp(`/preapproval/${enc(sub.mp_preapproval_pending)}`).catch(() => null);
    const fresh = old && Date.now() - new Date(old.date_created).getTime() < 24 * 3600_000;
    if (old?.status === 'pending' && fresh && Number(old.auto_recurring?.transaction_amount) === amount && old.init_point) return old.init_point;
  }
  const pre = await mp('/preapproval', {
    method: 'POST',
    body: {
      reason: `${plan.name} — Control Claude`,
      external_reference: `sub_${sub.id}`,
      // MP_TEST_PAYER_EMAIL: só no .env de teste (o sandbox exige o e-mail do comprador de teste)
      payer_email: process.env.MP_TEST_PAYER_EMAIL || sub.email,
      status: 'pending',
      back_url: `${BACK_URL}?assinatura=retorno`,
      auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: amount, currency_id: 'BRL' },
    },
  });
  await run('UPDATE subscribers SET mp_preapproval_pending = ? WHERE id = ?', [pre.id, sub.id]);
  return pre.init_point;
}

/**
 * Assinatura do Mercado Pago → assinante (pela referência sub_<id>).
 * Se ela foi autorizada e ainda não é a renovação automática dele, passa a ser (a antiga, se houver, é cancelada).
 * Retorna o assinante a conferir, ou null se não há nada a fazer.
 */
async function adoptPreapproval(pre) {
  const m = /^sub_(\d+)$/.exec(pre?.external_reference || '');
  if (!m) return null;
  const sub = await get('SELECT * FROM subscribers WHERE id = ?', [Number(m[1])]);
  if (!sub) return null;
  if (sub.mp_preapproval_id === pre.id) return sub;
  if (pre.status !== 'authorized') return null;

  // O valor do link precisa cobrir o preço do plano atual (o cliente pode ter trocado de plano depois de gerar o link)
  const planRow = await get('SELECT price_cents FROM plans WHERE id = ?', [sub.plan_id]);
  const plan = planRow && { price_cents: sub.monthly_cents ?? planRow.price_cents }; // valor travado do assinante
  const linkCents = Math.round(Number(pre.auto_recurring?.transaction_amount || 0) * 100);
  if (!plan || linkCents < Number(plan.price_cents)) {
    console.warn(`Link de assinatura com valor menor que a mensalidade (assinante ${sub.id}): link ${linkCents}, mensalidade ${plan?.price_cents}`);
    await mp(`/preapproval/${enc(pre.id)}`, { method: 'PUT', body: { status: 'cancelled' } })
      .catch((e) => console.error('Mercado Pago (cancelar link com valor errado):', e.message));
    await run('UPDATE subscribers SET mp_preapproval_pending = NULL WHERE id = ? AND mp_preapproval_pending = ?', [sub.id, pre.id]);
    return null;
  }

  if (sub.mp_preapproval_id && sub.autopay_status !== 'cancelled') {
    await mp(`/preapproval/${enc(sub.mp_preapproval_id)}`, { method: 'PUT', body: { status: 'cancelled' } })
      .catch((e) => console.error('Mercado Pago (assinatura antiga):', e.message));
  }
  await run(`UPDATE subscribers SET mp_preapproval_id = ?, autopay_status = 'authorized', mp_preapproval_pending = NULL,
             card_last4 = NULL, card_brand = ?, next_charge_date = ?, autopay_failed_at = NULL,
             cancel_at = NULL, cancel_requested_at = NULL, retention_answer = NULL WHERE id = ?`,
  [pre.id, pre.payment_method_id || null, ymd(pre.next_payment_date), sub.id]);
  console.log(`Renovação automática ativada pelo link do Mercado Pago (assinante ${sub.id})`);
  return { ...sub, mp_preapproval_id: pre.id, autopay_status: 'authorized', card_last4: null };
}

/** Confere o link de assinatura ainda não concluído do assinante. Retorna quantas cobranças registrou. */
export async function checkPendingAutopay(sub) {
  if (!sub?.mp_preapproval_pending || !mpConfigured) return 0;
  const pre = await mp(`/preapproval/${enc(sub.mp_preapproval_pending)}`);
  const adopted = await adoptPreapproval(pre);
  if (adopted) return syncAutopay(adopted);
  // link abandonado há mais de 3 dias (ou cancelado): esquece
  if (pre.status !== 'pending' || Date.now() - new Date(pre.date_created).getTime() > 3 * 86400_000) {
    await run('UPDATE subscribers SET mp_preapproval_pending = NULL WHERE id = ? AND mp_preapproval_pending = ?', [sub.id, pre.id]);
  }
  return 0;
}

/** Webhook de assinatura: id da assinatura (preapproval) ou de uma cobrança (authorized_payment). */
export async function syncAutopayNotification(type, id) {
  let preapprovalId = id;
  if (type === 'subscription_authorized_payment') {
    const invoice = await mp(`/authorized_payments/${enc(id)}`);
    preapprovalId = invoice.preapproval_id;
  }
  if (!preapprovalId) return 0;
  const pre = await mp(`/preapproval/${enc(preapprovalId)}`);
  const sub = await adoptPreapproval(pre);
  return sub ? syncAutopay(sub) : 0;
}

/** Rede de segurança: links de assinatura em aberto e renovações perto (ou depois) da data de cobrança. */
export async function syncDueAutopays() {
  if (!mpConfigured) return 0;
  let added = 0;
  const pending = await all('SELECT * FROM subscribers WHERE mp_preapproval_pending IS NOT NULL');
  for (const sub of pending) added += await checkPendingAutopay(sub).catch((e) => { console.error('Link de assinatura:', e.message); return 0; });
  const subs = await all(`
    SELECT * FROM subscribers
    WHERE mp_preapproval_id IS NOT NULL AND autopay_status = 'authorized'
      AND (next_charge_date IS NULL OR next_charge_date <= current_date + 1 OR card_last4 IS NULL)`);
  for (const sub of subs) added += await syncAutopay(sub).catch((e) => { console.error('Renovação automática:', e.message); return 0; });
  if (added) console.log(`Mercado Pago: ${added} cobrança(s) automática(s) registrada(s)`);
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

// ------------------------------------------------------------------ reembolso, contestação e reclamação
//
// Um pagamento já aprovado pode ser devolvido (reembolso), contestado no banco do cartão (chargeback) ou entrar em
// reclamação no Mercado Pago. O sistema avisa o admin e, quando o dinheiro saiu, tira o valor do pagamento no painel.

const AUTO_REF_RE = /^sub_(\d+)$/;

/** Recebe um pagamento da API de pagamentos (/v1/payments). Retorna true se havia um problema (devolvido, contestado ou em reclamação). */
export async function handlePaymentIssue(d) {
  if (!d?.id) return false;
  const total = Math.round(Number(d.transaction_amount || 0) * 100);
  const refunded = Math.round(Number(d.transaction_amount_refunded || 0) * 100);
  const kind = d.status === 'charged_back' ? 'contestacao'
    : d.status === 'in_mediation' ? 'mediacao'
    : d.status === 'refunded' || refunded > 0 ? 'reembolso' : null;
  if (!kind || !total) return false;
  const ref = String(d.external_reference || '');
  const m = REF_RE.exec(ref);
  const auto = AUTO_REF_RE.exec(ref);
  const subId = m ? Number(m[1]) : auto ? Number(auto[1]) : null;
  if (!subId || !(await get('SELECT 1 AS x FROM subscribers WHERE id = ?', [subId]))) return false;

  // quanto do pagamento deixou de ser nosso: tudo na contestação, o devolvido no reembolso, nada (ainda) na reclamação
  const lost = kind === 'contestacao' ? total : kind === 'reembolso' ? Math.min(refunded || total, total) : 0;

  // linha do pagamento no painel
  let row = null;
  if (auto) {
    row = await get('SELECT id, ref_month, amount_cents, method FROM payments WHERE subscriber_id = ? AND mp_payment_id = ?', [subId, String(d.id)]);
  } else {
    const rows = await all('SELECT id, ref_month, amount_cents, method, notes FROM payments WHERE subscriber_id = ? AND ref_month = ? AND mp_payment_id IS NOT NULL', [subId, `${m[2]}-${m[3]}`]);
    row = (d.order?.id && rows.find((r) => r.notes && r.notes.includes(String(d.order.id)))) || (rows.length === 1 ? rows[0] : null);
  }
  let reopened = false;
  if (row && lost > 0) {
    const left = Math.max(0, total - lost);
    if (Number(row.amount_cents) > left) {
      await run("UPDATE payments SET amount_cents = ?, notes = trim(coalesce(notes, '') || ?) WHERE id = ?",
        [left, ` · ${kind === 'contestacao' ? 'contestado no banco' : 'devolvido'} R$ ${money(lost).replace('.', ',')} em ${todayISO().split('-').reverse().join('/')}`, row.id]);
      console.log(`Pagamento ${d.id} (assinante ${subId}): ${kind}, ${money(lost)} de ${money(total)} saiu do recebido`);
      reopened = left === 0;
    }
  }
  const by = (d.refunds || []).some((r) => r.source?.type === 'collector') ? 'você (pela conta do Mercado Pago)' : kind === 'reembolso' ? 'Mercado Pago' : null;
  await notifyPaymentIssue({
    subscriberId: subId, kind, paymentId: d.id, totalCents: total, lostCents: lost,
    month: row?.ref_month || (m ? `${m[2]}-${m[3]}` : null), method: row?.method || METHOD[d.payment_type_id] || null, by, reopened,
  }).catch((e) => console.error('Aviso de reembolso/contestação:', e.message));
  return true;
}

/** Confere um pagamento pelo número (webhook de pagamento). */
export async function checkPaymentIssue(paymentId) {
  return handlePaymentIssue(await mp(`/v1/payments/${enc(paymentId)}`));
}

/** Confere os pagamentos de uma referência (webhook de pedido: sub_<id>_<AAAAMM>). */
export async function checkReferenceIssues(externalReference) {
  if (!externalReference) return 0;
  const r = await mp(`/v1/payments/search?external_reference=${enc(externalReference)}&limit=20`);
  let n = 0;
  for (const d of r.results || []) if (await handlePaymentIssue(d)) n++;
  return n;
}

/** Varredura (não depende do webhook): pagamentos devolvidos, contestados ou em reclamação nos últimos 60 dias. */
export async function scanPaymentIssues() {
  if (!mpConfigured) return 0;
  let n = 0;
  for (const status of ['refunded', 'charged_back', 'in_mediation']) {
    const r = await mp(`/v1/payments/search?status=${status}&sort=date_created&criteria=desc&range=date_created&begin_date=NOW-60DAYS&end_date=NOW&limit=50`);
    for (const d of r.results || []) if (await handlePaymentIssue(d).catch((e) => { console.error('Reembolso/contestação:', e.message); return false; })) n++;
  }
  return n;
}
