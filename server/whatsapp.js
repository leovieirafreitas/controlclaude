// Avisos no WhatsApp pela Evolution API (v2): para o admin e para o cliente.
// Nunca bloqueia nem derruba o fluxo principal: se o envio falhar, só registra no log.
import { all, get, run } from './db.js';
import { setAutopayStatus } from './mp.js';
import { firePush } from './push.js';
import { render } from './templates.js';

const URL = (process.env.EVOLUTION_URL || '').replace(/\/$/, '');
const INSTANCE = process.env.EVOLUTION_INSTANCE || '';
const TOKEN = process.env.EVOLUTION_TOKEN || '';
const NUMBERS = (process.env.WHATSAPP_ADMIN_NUMBERS || '').split(',').map((n) => n.replace(/\D/g, '')).filter(Boolean);
const TZ = process.env.NOTIFY_TIMEZONE || 'America/Sao_Paulo';
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');
// Mensagens para o cliente (boas-vindas, lembrete, atraso). Desligue com WHATSAPP_CUSTOMER_MESSAGES=off
const CUSTOMER_ON = !/^(off|0|false|nao|não)$/i.test(process.env.WHATSAPP_CUSTOMER_MESSAGES || 'on');
const REMINDER_DAYS = Math.max(0, Number(process.env.REMINDER_DAYS_BEFORE ?? 3) || 0);
// Aviso de que o pagamento passa a ser automático no cartão (clientes sem renovação automática), em dias antes do vencimento
// Pix como alternativa ao cartão (mesma chave do member.js): muda os textos dos lembretes
const PIX_ON = !/^(off|0|false|nao|não)$/i.test(process.env.PIX_ENABLED || 'on');
const PAY_HOW = PIX_ON ? 'cartão de crédito ou Pix' : 'cartão de crédito';
const CARD_NOTICE_DAYS = Math.max(REMINDER_DAYS + 1, Number(process.env.CARD_NOTICE_DAYS_BEFORE ?? 5) || 5);
// Quantos dias antes do fim do acesso perguntar se o cliente quer continuar
const RETENTION_DAYS = Math.max(1, Number(process.env.RETENTION_DAYS_BEFORE ?? 3) || 3);

export const whatsappConfigured = Boolean(URL && INSTANCE && TOKEN && NUMBERS.length);
export const ADMIN_WHATSAPP_NUMBERS = NUMBERS;
const canSend = Boolean(URL && INSTANCE && TOKEN);

const brl = (cents) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtDate = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '—');
const fmtMonth = (m) => `${m.slice(5, 7)}/${m.slice(0, 4)}`;
const nowBR = () => new Date().toLocaleString('pt-BR', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' });
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';
const accountLink = () => (APP_URL ? `${APP_URL}/conta` : '');
const METHOD = { pix: 'Pix', credito: 'Cartão de crédito', debito: 'Cartão de débito', boleto: 'Boleto', dinheiro: 'Dinheiro', transferencia: 'Transferência' };

/** Telefone digitado pelo cliente → número do WhatsApp com DDI (Brasil = 55). */
function toWhatsNumber(phone) {
  let d = String(phone || '').replace(/\D/g, '').replace(/^0+/, '');
  if (d.length === 10 || d.length === 11) d = `55${d}`;
  return d.length >= 12 && d.length <= 13 ? d : '';
}

async function send(number, text) {
  try {
    const res = await fetch(`${URL}/message/sendText/${encodeURIComponent(INSTANCE)}`, {
      method: 'POST',
      headers: { apikey: TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ number, text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) console.error(`WhatsApp: envio para ${number} falhou (${res.status}): ${(await res.text()).slice(0, 200)}`);
    return res.ok;
  } catch (err) {
    console.error(`WhatsApp: envio para ${number} falhou: ${err.message}`);
    return false;
  }
}

/** Envia um texto para todos os números do admin. */
export async function notifyAdmin(text) {
  if (!whatsappConfigured) return;
  await Promise.all(NUMBERS.map((n) => send(n, text)));
}

/** Envia um texto para o cliente (se ele informou WhatsApp). Retorna true se enviou. */
export async function notifyCustomer(phone, text, { force = false } = {}) {
  if (!canSend || (!CUSTOMER_ON && !force)) return false;
  const number = toWhatsNumber(phone);
  return number ? send(number, text) : false;
}

/** Código de segurança pelo WhatsApp (recuperar senha do cliente ou entrar no painel). Lança erro se não enviar. */
export async function sendCodeWhatsapp(phone, code, purpose = 'reset') {
  if (!canSend) throw new Error('WhatsApp não configurado');
  const number = toWhatsNumber(phone);
  if (!number) throw new Error('cliente sem WhatsApp válido');
  const ok = await send(number, [
    '🔐 *Control Claude*',
    '',
    purpose === 'admin' ? `Seu código para entrar no *painel admin* é: *${code}*` : `Seu código para criar uma nova senha é: *${code}*`,
    '',
    'Ele vale por 10 minutos e só pode ser usado uma vez.',
    'Se não foi você que pediu, ignore esta mensagem. Ninguém da nossa equipe vai pedir este código.',
  ].join('\n'));
  if (!ok) throw new Error('falha no envio pelo WhatsApp');
}

/** Dispara sem esperar (para não atrasar a resposta ao cliente). */
const fire = (p) => { Promise.resolve(p).catch(() => {}); };

async function subscriberInfo(subscriberId) {
  return get(`
    SELECT s.id, s.name, s.email, s.phone, s.birth_date, s.due_day, s.start_date, p.name AS plan_name, p.price_cents,
           s.card_last4, s.next_charge_date,
           (SELECT COUNT(*) FROM payments WHERE subscriber_id = s.id) AS payments_count
    FROM subscribers s JOIN plans p ON p.id = s.plan_id WHERE s.id = ?`, [subscriberId]);
}

const contactLines = (s) => [
  `👤 *Cliente:* ${s.name}`,
  `📧 *E-mail:* ${s.email || '—'}`,
  `📱 *WhatsApp:* ${s.phone || '—'}`,
];

/** Valores das variáveis dos modelos ({nome}, {plano}...) para um assinante. */
const varsFor = (s, extra = {}) => ({
  nome: firstName(s.name), cliente: s.name || '', email: s.email || '', telefone: s.phone || '',
  plano: s.plan_name || '', valor: s.price_cents != null ? brl(s.price_cents) : '',
  dia_vencimento: s.due_day ?? '', cartao: s.card_last4 ? `final ${s.card_last4}` : '',
  formas_pagamento: PAY_HOW, link: accountLink(), ...extra,
});
/** Modelo de WhatsApp pronto (ou null se desligado no painel). */
const waText = (key, vars) => render(key, vars).catch((e) => { console.error('Modelo', key, e.message); return null; });
/** Notificação push do painel a partir do modelo (não envia se estiver desligada). */
/** Push que só pode sair uma vez (atraso, checkout): marca em notifications_sent. */
async function pushOnce(key, subscriberId, ref, vars) {
  const m = await render(key, vars).catch(() => null);
  if (!m || !(await claim(key, subscriberId, ref))) return;
  firePush({ ...m, tag: `${key}-${subscriberId}-${ref}` });
}
async function pushEvent(key, vars, tag) {
  const m = await render(key, vars).catch(() => null);
  if (m) firePush({ ...m, tag });
  return Boolean(m);
}

// ------------------------------------------------------------------ eventos

/** Pagamento aprovado pelo site: "nova assinatura" no 1º pagamento, "pagamento recebido" nos seguintes. */
export async function notifyPayment({ subscriberId, month, amountCents, method, orderId, autopay = false }) {
  const s = await subscriberInfo(subscriberId).catch(() => null);
  if (!s) return;
  const first = s.payments_count <= 1;
  const how = autopay ? `${METHOD[method] || 'Cartão'} (renovação automática)` : METHOD[method] || method;

  // Notificação no app do painel (celular do admin)
  const pv = varsFor(s, { valor: brl(amountCents), forma: how, mes: fmtMonth(month) });
  pushEvent(first ? 'push_nova_assinatura' : 'push_pagamento', pv, `pagamento-${s.id}-${month}`);
  if (!canSend) return;
  if (whatsappConfigured) {
    fire(notifyAdmin([
      first ? '🎉 *Nova assinatura!*' : '💰 *Pagamento recebido*',
      '',
      ...contactLines(s),
      `🎂 *Nascimento:* ${fmtDate(s.birth_date)}`,
      '',
      `📦 *Plano:* ${s.plan_name} (${brl(s.price_cents)}/mês)`,
      `💵 *Valor pago:* ${brl(amountCents)} via ${how}`,
      `🗓️ *Referente a:* ${fmtMonth(month)}`,
      first ? `📅 *Vencimento:* todo dia ${s.due_day}` : null,
      '',
      `🧾 Pedido Mercado Pago: ${orderId}`,
      `🕒 ${nowBR()}`,
    ].filter((l) => l !== null).join('\n')));
  }

  const key = first ? (autopay ? 'wa_boas_vindas_auto' : 'wa_boas_vindas') : (autopay ? 'wa_renovacao' : 'wa_pagamento');
  const text = await waText(key, pv);
  if (text) fire(notifyCustomer(s.phone, text));
}

/** Cliente cancelou pela Área do assinante. `accessUntil` = último dia de acesso (null = acabou na hora). */
export async function notifyCancel(subscriberId, accessUntil = null) {
  const s = await subscriberInfo(subscriberId).catch(() => null);
  if (!s) return;
  pushEvent('push_cancelamento', varsFor(s, { acesso_ate: accessUntil ? fmtDate(accessUntil) : 'hoje' }), `cancelamento-${s.id}`);
  if (!whatsappConfigured) return;
  fire(notifyAdmin([
    '❌ *Assinatura cancelada pelo cliente*',
    '',
    ...contactLines(s),
    `📦 *Plano:* ${s.plan_name} (${brl(s.price_cents)}/mês)`,
    `📅 Assinante desde ${fmtDate(s.start_date)}`,
    '',
    accessUntil
      ? `🔓 *Acesso pago até ${fmtDate(accessUntil)}.* Ele continua usando até lá.\n_Uns dias antes eu pergunto se ele quer continuar, e no dia ${fmtDate(accessUntil)} te aviso para desativar._`
      : '⛔ *Não tinha período pago em aberto: o acesso terminou agora.* Desative ele do seu sistema.',
    '',
    `🕒 ${nowBR()}`,
  ].join('\n')));
}

/** Cliente desistiu do cancelamento pelo site. */
export async function notifyKeep(subscriberId) {
  if (!whatsappConfigured) return;
  const s = await subscriberInfo(subscriberId).catch(() => null);
  if (!s) return;
  fire(notifyAdmin([
    '✅ *Cliente desistiu do cancelamento*',
    '',
    ...contactLines(s),
    `📦 *Plano:* ${s.plan_name} (${brl(s.price_cents)}/mês)`,
    'Clicou em "Manter meu plano" na área do assinante. O plano segue normal.',
  ].join('\n')));
}

/** Pagamento no cartão recusado pelo Mercado Pago na área do assinante (para o admin poder ajudar na hora). */
export async function notifyCardRejected(subscriberId, { once = false, message = '' } = {}) {
  const s = await subscriberInfo(subscriberId).catch(() => null);
  if (!s) return;
  pushEvent('push_cartao_recusado', varsFor(s), `cartao-${s.id}`);
  if (!whatsappConfigured) return;
  fire(notifyAdmin([
    once ? '💳 *Pagamento avulso no cartão recusado*' : '💳 *Renovação automática recusada pelo Mercado Pago*',
    '',
    ...contactLines(s),
    `📦 *Plano:* ${s.plan_name} (${brl(s.price_cents)}/mês)`,
    message ? `🧾 *Motivo:* ${message}` : null,
    '',
    once
      ? '_O cliente tentou pagar este mês de forma avulsa e também foi recusado. Vale um contato pessoal._'
      : '_A tela ofereceu ao cliente pagar este mês de forma avulsa no cartão._',
    `🕒 ${nowBR()}`,
  ].filter((l) => l !== null).join('\n')));
}

/** Pagamento aprovado, mas menor que o preço do plano atual: o plano NÃO foi ativado. */
export async function notifyUnderpaid({ subscriberId, month, paidCents, lastCents }) {
  const s = await subscriberInfo(subscriberId).catch(() => null);
  if (!s) return;
  firePush({ title: 'Pagamento menor que o plano', body: `${s.plan_name}: pago ${brl(paidCents)} de ${brl(s.price_cents)}. Plano não ativado.`, tag: `menor-${s.id}-${month}`, url: '/admin#payments' });
  if (!whatsappConfigured) return;
  fire(notifyAdmin([
    '⚠️ *Pagamento menor que o preço do plano*',
    '',
    ...contactLines(s),
    `📦 *Plano atual:* ${s.plan_name} (${brl(s.price_cents)}/mês)`,
    `💵 *Pago em ${fmtMonth(month)}:* ${brl(paidCents)} (último pagamento: ${brl(lastCents)})`,
    '',
    '_O pagamento foi registrado, mas o plano *não foi ativado*. Pode ser troca de plano depois de gerar o pagamento. Confira e ative pelo painel se estiver tudo certo._',
    `🕒 ${nowBR()}`,
  ].join('\n')));
}

/** Cliente criou a conta (ainda sem pagar). */
export function notifySignup({ name, email, phone, birth_date }) {
  pushEvent('push_cadastro', { cliente: name || '', email: email || '', telefone: phone || '' }, `cadastro-${email}`);
  if (!whatsappConfigured) return;
  fire(notifyAdmin([
    '🆕 *Nova conta criada* (ainda sem pagamento)',
    '',
    ...contactLines({ name, email, phone }),
    `🎂 *Nascimento:* ${fmtDate(birth_date)}`,
    '',
    `🕒 ${nowBR()}`,
  ].join('\n')));
}

// ------------------------------------------------------------------ rotina diária (lembrete e atraso)

/** Marca o aviso como enviado. Retorna false se ele já tinha sido enviado antes. */
async function claim(kind, subscriberId, ref) {
  const r = await run(`
    INSERT INTO notifications_sent (kind, subscriber_id, ref) VALUES (?, ?, ?)
    ON CONFLICT DO NOTHING RETURNING kind`, [kind, subscriberId, ref]);
  return r.rowCount > 0;
}
const unclaim = (kind, subscriberId, ref) =>
  run('DELETE FROM notifications_sent WHERE kind = ? AND subscriber_id = ? AND ref = ?', [kind, subscriberId, ref]);

// ------------------------------------------------------------------ ritmo dos avisos programados (anti-bloqueio)

/**
 * Avisos programados para clientes (lembretes, aviso do cartão, atraso, retenção, checkout) saem em fila,
 * um de cada vez, com um intervalo sorteado entre eles e limite por hora e por dia — para o WhatsApp
 * não tratar o número como disparo em massa. Mensagens imediatas (confirmação de pagamento, códigos,
 * respostas) não passam pela fila. Configurável na aba WhatsApp do painel (tabela settings).
 */
export const PACING_DEFAULTS = { on: true, gap_min: 60, gap_max: 180, per_hour: 15, per_day: 60, hour_start: 9, hour_end: 20 };
const PACED_KINDS = ['aviso_cartao', 'lembrete', 'atraso_cliente', 'retencao', 'checkout_1h', 'checkout_24h'];
const PACING_KEY = 'whatsapp_pacing';

const clampInt = (v, min, max, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

/** Valida e completa a configuração (valores fora da faixa são ajustados). */
export function normalizePacing(raw = {}) {
  const d = PACING_DEFAULTS;
  const p = {
    on: raw.on === undefined ? d.on : raw.on === true || raw.on === 'true' || raw.on === 'on',
    gap_min: clampInt(raw.gap_min, 5, 3600, d.gap_min),
    gap_max: clampInt(raw.gap_max, 5, 3600, d.gap_max),
    per_hour: clampInt(raw.per_hour, 1, 200, d.per_hour),
    per_day: clampInt(raw.per_day, 1, 1000, d.per_day),
    hour_start: clampInt(raw.hour_start, 0, 23, d.hour_start),
    hour_end: clampInt(raw.hour_end, 1, 24, d.hour_end),
  };
  if (p.gap_max < p.gap_min) p.gap_max = p.gap_min;
  if (p.hour_end <= p.hour_start) p.hour_end = Math.min(24, p.hour_start + 1);
  return p;
}

export async function getPacing() {
  const row = await get('SELECT value FROM settings WHERE key = ?', [PACING_KEY]).catch(() => null);
  let raw = {};
  try { raw = row?.value ? JSON.parse(row.value) : {}; } catch { /* valor inválido: usa o padrão */ }
  return normalizePacing(raw);
}

export async function savePacing(body) {
  const p = normalizePacing({ ...(await getPacing()), ...body });
  await run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [PACING_KEY, JSON.stringify(p)]);
  return p;
}

const kindsList = PACED_KINDS.map((k) => `'${k}'`).join(', ');
async function pacedCounts() {
  const r = await get(`
    SELECT COUNT(*) FILTER (WHERE created_at > now() - interval '1 hour') AS hour,
           COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours') AS day,
           MAX(created_at) AS last
    FROM notifications_sent WHERE kind IN (${kindsList}) AND created_at > now() - interval '24 hours'`);
  return { hour: Number(r?.hour || 0), day: Number(r?.day || 0), last: r?.last || null };
}

const localHour = () => Number(new Date().toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }));
const inWindow = (p) => { const h = localHour(); return h >= p.hour_start && h < p.hour_end; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let paceChain = Promise.resolve();
let lastPacedAt = 0;
let queued = 0;

/** Situação da fila para o painel. */
export async function pacingStatus() {
  const [config, counts] = await Promise.all([getPacing(), pacedCounts().catch(() => ({ hour: 0, day: 0, last: null }))]);
  return { config, defaults: PACING_DEFAULTS, sent_last_hour: counts.hour, sent_last_24h: counts.day, last_sent_at: counts.last, waiting: queued, in_window: inWindow(config) };
}

/**
 * Envia um aviso programado para o cliente no máximo uma vez (kind + assinante + referência), respeitando
 * a fila. Se o limite da hora/dia já foi atingido ou estiver fora do horário, não envia agora: o aviso
 * fica para a próxima conferência (de hora em hora / a cada 10 min).
 */
export async function sendScheduled(kind, subscriberId, ref, phone, text, opts = {}) {
  if (!text) return false; // modelo desligado no painel
  queued++;
  const job = paceChain.then(async () => {
    try {
      const already = await get('SELECT 1 AS x FROM notifications_sent WHERE kind = ? AND subscriber_id = ? AND ref = ?', [kind, subscriberId, ref]);
      if (already) return false;
      const p = await getPacing();
      if (p.on) {
        if (!inWindow(p)) return false;
        const c = await pacedCounts();
        if (c.hour >= p.per_hour || c.day >= p.per_day) return false;
        const gap = (p.gap_min + Math.random() * (p.gap_max - p.gap_min)) * 1000;
        const wait = lastPacedAt + gap - Date.now();
        if (wait > 0) await sleep(wait);
        if (!inWindow(p)) return false;
      }
      if (!(await claim(kind, subscriberId, ref))) return false;
      const ok = await notifyCustomer(phone, text, opts);
      lastPacedAt = Date.now();
      if (!ok) await unclaim(kind, subscriberId, ref);
      return ok;
    } finally {
      queued--;
    }
  });
  paceChain = job.catch(() => {});
  return job;
}

const addMonths = (month, n) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};
const daysBetween = (fromISO, toISO) => Math.round((Date.parse(toISO) - Date.parse(fromISO)) / 86400_000);

/**
 * Confere as mensalidades em aberto dos assinantes ativos (mês atual e o próximo) e manda:
 *  - cliente: lembrete REMINDER_DAYS dias antes do vencimento (padrão 3), com o link para pagar;
 *  - admin:   aviso 1 dia antes do vencimento;
 *  - cliente e admin: aviso de atraso no dia seguinte ao vencimento.
 * Cada aviso sai no máximo uma vez por mensalidade. Só envia no horário configurado no painel (padrão 9h às 20h, fuso NOTIFY_TIMEZONE),
 * e os avisos para clientes saem pela fila com intervalo (ver sendScheduled).
 * Se o servidor estiver desligado no dia exato, o aviso sai na próxima conferência dentro da janela.
 */
export async function runDailyNotices() {
  if (!canSend) return;
  const now = new Date();
  if (!inWindow(await getPacing())) return; // horário de envio configurado no painel (padrão 9h às 20h)
  const today = now.toLocaleDateString('sv-SE', { timeZone: TZ });
  const thisMonth = today.slice(0, 7);
  const nextMonth = addMonths(thisMonth, 1);

  const subs = await all(`
    SELECT s.id, s.name, s.email, s.phone, s.due_day, s.start_date, p.name AS plan_name, p.price_cents,
           s.autopay_status, s.card_last4,
           (SELECT MAX(ref_month) FROM payments WHERE subscriber_id = s.id) AS last_paid_month,
           (SELECT COALESCE(SUM(amount_cents), 0) FROM payments WHERE subscriber_id = s.id AND ref_month = ?) AS paid_this,
           (SELECT COALESCE(SUM(amount_cents), 0) FROM payments WHERE subscriber_id = s.id AND ref_month = ?) AS paid_next
    FROM subscribers s JOIN plans p ON p.id = s.plan_id
    WHERE s.status = 'ativo' AND p.price_cents > 0 AND s.cancel_at IS NULL`, [thisMonth, nextMonth]);

  await runCancellations(today);

  for (const s of subs) {
    for (const [month, paid] of [[thisMonth, s.paid_this], [nextMonth, s.paid_next]]) {
      if (paid >= s.price_cents) continue;                       // já pago
      if (String(s.start_date).slice(0, 7) >= month) continue;  // mês da adesão: coberto pelo 1º pagamento
      const dueISO = `${month}-${String(s.due_day).padStart(2, '0')}`;
      const daysLeft = daysBetween(today, dueISO);
      const due = fmtDate(dueISO);
      await noticesFor(s, month, daysLeft, due);
    }
  }
}

// ------------------------------------------------------------------ cancelamento agendado

/**
 * Assinantes que cancelaram mas ainda têm período pago (cancel_at = último dia de acesso):
 *  - RETENTION_DAYS dias antes: pergunta ao cliente se quer continuar (ele responde SIM ou NÃO no WhatsApp);
 *  - no dia cancel_at: o plano vira "cancelado" e o admin recebe o aviso para desativar.
 */
async function runCancellations(today) {
  const list = await all(`
    SELECT s.id, s.name, s.email, s.phone, s.due_day, s.cancel_at, s.retention_answer, p.name AS plan_name, p.price_cents,
           s.mp_preapproval_id, s.autopay_status
    FROM subscribers s JOIN plans p ON p.id = s.plan_id
    WHERE s.status = 'ativo' AND s.cancel_at IS NOT NULL`);
  for (const s of list) {
    const daysLeft = daysBetween(today, String(s.cancel_at));
    const until = fmtDate(s.cancel_at);

    if (daysLeft <= 0) {
      await run("UPDATE subscribers SET status = 'cancelado' WHERE id = ? AND status = 'ativo'", [s.id]);
      await setAutopayStatus(s, 'cancelled').catch((e) => console.error('Mercado Pago (encerrar renovação):', e.message));
      if (whatsappConfigured && (await claim('fim_acesso', s.id, String(s.cancel_at)))) {
        await notifyAdmin([
          '⛔ *Fim do acesso — desative este cliente*',
          '',
          ...contactLines(s),
          `📦 *Plano:* ${s.plan_name} (${brl(s.price_cents)}/mês)`,
          `📅 *Último dia pago:* ${until}`,
          '',
          s.retention_answer === 'nao' ? '_Ele confirmou no WhatsApp que não vai continuar._'
            : '_Ele não respondeu se queria continuar._',
          'O plano foi marcado como *Cancelado* no painel.',
        ].join('\n'));
      }
      continue;
    }

    if (daysLeft <= RETENTION_DAYS && !s.retention_answer && s.phone && canSend) {
      await sendScheduled('retencao', s.id, String(s.cancel_at), s.phone, await waText('wa_retencao', varsFor(s, { acesso_ate: until })), { force: true });
    }
  }
}

/** Telefone → chave para comparar (DDD + 8 últimos dígitos), ignorando 55 e o 9 extra. */
const phoneKey = (v) => {
  let d = String(v || '').replace(/\D/g, '');
  if (d.startsWith('55') && d.length >= 12) d = d.slice(2);
  return d.length >= 10 ? d.slice(0, 2) + d.slice(-8) : '';
};

/**
 * Mensagem recebida no WhatsApp (webhook da Evolution). Se for a resposta de um cliente
 * com cancelamento agendado que recebeu a pergunta, trata SIM / NÃO. Retorna o que fez.
 */
export async function handleIncomingMessage(fromNumber, text) {
  const key = phoneKey(fromNumber);
  const answer = String(text || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (!key || !answer) return 'ignorado';
  const yes = /^(sim|s|quero|quero continuar|vou continuar|continuar|continuo|claro|com certeza)\b/.test(answer);
  const no = /^(nao|n|nao quero|encerrar|cancelar|nao vou)\b/.test(answer);
  if (!yes && !no) return 'ignorado';

  const candidates = await all(`
    SELECT s.id, s.name, s.email, s.phone, s.due_day, s.cancel_at, p.name AS plan_name, p.price_cents,
           s.mp_preapproval_id, s.autopay_status, s.card_last4
    FROM subscribers s JOIN plans p ON p.id = s.plan_id
    WHERE s.status = 'ativo' AND s.cancel_at IS NOT NULL AND s.retention_answer IS NULL
      AND EXISTS (SELECT 1 FROM notifications_sent n WHERE n.kind = 'retencao' AND n.subscriber_id = s.id)`);
  const s = candidates.find((c) => phoneKey(c.phone) === key);
  if (!s) return 'ignorado';
  const until = fmtDate(s.cancel_at);

  if (yes) {
    await run(`UPDATE subscribers SET cancel_at = NULL, cancel_requested_at = NULL, retention_answer = NULL,
               notes = trim(notes || ' · Desistiu do cancelamento pelo WhatsApp em ' || ?::text) WHERE id = ?`,
    [fmtDate(new Date().toLocaleDateString('sv-SE', { timeZone: TZ })), s.id]);
    // a próxima mensalidade vence no último dia de acesso: o lembrete já vai nesta resposta
    const month = String(s.cancel_at).slice(0, 7);
    const resumed = await setAutopayStatus(s, 'authorized').catch((e) => { console.error('Mercado Pago (retomar renovação):', e.message); return false; });
    const autopay = resumed || s.autopay_status === 'authorized';
    const simText = await waText(autopay ? 'wa_retencao_sim_auto' : 'wa_retencao_sim', varsFor(s, { acesso_ate: until }));
    // a próxima mensalidade vence no último dia de acesso: se esta resposta saiu, ela já vale como lembrete do mês
    if (simText && (await notifyCustomer(s.phone, simText, { force: true }))) await claim('lembrete', s.id, month);
    if (whatsappConfigured) {
      await notifyAdmin([
        '✅ *Cliente desistiu do cancelamento*',
        '',
        ...contactLines(s),
        `📦 *Plano:* ${s.plan_name} (${brl(s.price_cents)}/mês)`,
        `Respondeu *SIM* no WhatsApp. Próximo vencimento: ${until}.`,
      ].join('\n'));
    }
    return 'continuou';
  }

  await run('UPDATE subscribers SET retention_answer = ? WHERE id = ?', ['nao', s.id]);
  const naoText = await waText('wa_retencao_nao', varsFor(s, { acesso_ate: until }));
  if (naoText) await notifyCustomer(s.phone, naoText, { force: true });
  if (whatsappConfigured) {
    await notifyAdmin([
      '❌ *Cliente confirmou que NÃO vai continuar*',
      '',
      ...contactLines(s),
      `📦 *Plano:* ${s.plan_name} (${brl(s.price_cents)}/mês)`,
      `🔓 Acesso até *${until}*. No dia eu te aviso para desativar.`,
    ].join('\n'));
  }
  return 'confirmou_nao';
}

/** Faz a Evolution avisar o servidor das mensagens recebidas (para ler as respostas SIM/NÃO). */
export async function ensureIncomingWebhook(url) {
  if (!canSend || !url) return;
  const current = await evo(`/webhook/find/${encodeURIComponent(INSTANCE)}`).catch(() => null);
  if (current?.enabled && current?.url === url) return;
  await evoPost(`/webhook/set/${encodeURIComponent(INSTANCE)}`, {
    webhook: { enabled: true, url, byEvents: false, base64: false, events: ['MESSAGES_UPSERT'] },
  });
  console.log('WhatsApp: webhook de mensagens recebidas configurado');
}

async function noticesFor(s, month, daysLeft, due) {
  const value = brl(s.price_cents);
  const plural = (n) => `${n} dia${n > 1 ? 's' : ''}`;
  if (s.autopay_status === 'authorized') return autopayNoticesFor(s, month, daysLeft, due);

  // Cliente ainda sem renovação automática (pagava por Pix ou cartão avulso): 5 dias antes do vencimento,
  // avisa que a partir desta mensalidade o pagamento passa a ser automático no cartão de crédito.
  if (daysLeft > REMINDER_DAYS && daysLeft <= CARD_NOTICE_DAYS && s.phone && CUSTOMER_ON) {
    await sendScheduled('aviso_cartao', s.id, month, s.phone, await waText('wa_aviso_cartao', varsFor(s, { vencimento: due })));
  }

  // Cliente: 3 dias antes (ou assim que entrar na janela)
  if (daysLeft >= 0 && daysLeft <= REMINDER_DAYS && s.phone && CUSTOMER_ON) {
    await sendScheduled('lembrete', s.id, month, s.phone,
      await waText(daysLeft === 0 ? 'wa_lembrete_hoje' : 'wa_lembrete', varsFor(s, { vencimento: due, dias: plural(daysLeft) })));
  }

  // Admin: 1 dia antes (ou no próprio dia, se a conferência de véspera não rodou)
  if (daysLeft >= 0 && daysLeft <= 1 && whatsappConfigured && (await claim('vence_admin', s.id, month))) {
    await notifyAdmin([
      daysLeft === 1 ? '⏰ *Ainda não pagou — vence amanhã*' : '⏰ *Ainda não pagou — vence hoje*',
      '',
      ...contactLines(s),
      `📦 *Plano:* ${s.plan_name} (${value}/mês)`,
      `📅 *Vencimento:* ${due}`,
      `🧾 *Último mês pago:* ${s.last_paid_month ? fmtMonth(s.last_paid_month) : 'nenhum'}`,
      '',
      s.phone && CUSTOMER_ON ? '_O cliente foi lembrado no WhatsApp._' : '⚠️ _Cliente sem WhatsApp cadastrado: não recebeu lembrete._',
    ].join('\n'));
  }

  // Atraso: dia seguinte ao vencimento
  if (daysLeft < 0) {
    if (s.phone && CUSTOMER_ON) {
      await sendScheduled('atraso_cliente', s.id, month, s.phone, await waText('wa_atraso', varsFor(s, { vencimento: due })));
    }
    await pushOnce('push_atraso', s.id, month, varsFor(s, { vencimento: due }));
    if (whatsappConfigured && (await claim('atraso_admin', s.id, month))) {
      await notifyAdmin([
        '⚠️ *Mensalidade atrasada*',
        '',
        ...contactLines(s),
        `📦 *Plano:* ${s.plan_name} (${value}/mês)`,
        `📅 *Venceu em:* ${due} (${plural(-daysLeft)} de atraso)`,
        `🧾 *Último mês pago:* ${s.last_paid_month ? fmtMonth(s.last_paid_month) : 'nenhum'}`,
        s.phone && CUSTOMER_ON ? '\n_O cliente também recebeu um aviso no WhatsApp._' : null,
      ].filter((l) => l !== null).join('\n'));
    }
  }
}

/**
 * Assinante com renovação automática no cartão:
 *  - cliente: aviso REMINDER_DAYS dias antes de que o cartão será cobrado (não precisa fazer nada);
 *  - se a cobrança não passar até 2 dias depois do vencimento (o Mercado Pago tenta de novo nesse meio-tempo):
 *    cliente recebe o link para trocar o cartão e o admin é avisado.
 */
async function autopayNoticesFor(s, month, daysLeft, due) {
  const value = brl(s.price_cents);
  const card = s.card_last4 ? ` final *${s.card_last4}*` : '';

  if (daysLeft >= 0 && daysLeft <= REMINDER_DAYS && s.phone && CUSTOMER_ON) {
    await sendScheduled('lembrete', s.id, month, s.phone,
      await waText(daysLeft === 0 ? 'wa_auto_hoje' : 'wa_auto_lembrete', varsFor(s, { vencimento: due })));
  }

  if (daysLeft <= -2) {
    if (s.phone && CUSTOMER_ON) {
      await sendScheduled('atraso_cliente', s.id, month, s.phone, await waText('wa_auto_recusada', varsFor(s, { vencimento: due })));
    }
    await pushOnce('push_atraso', s.id, month, varsFor(s, { vencimento: due }));
    if (whatsappConfigured && (await claim('atraso_admin', s.id, month))) {
      await notifyAdmin([
        '⚠️ *Cobrança automática não passou*',
        '',
        ...contactLines(s),
        `📦 *Plano:* ${s.plan_name} (${value}/mês)`,
        `💳 *Cartão:*${card || ' —'}`,
        `📅 *Venceu em:* ${due}`,
        `🧾 *Último mês pago:* ${s.last_paid_month ? fmtMonth(s.last_paid_month) : 'nenhum'}`,
        s.phone && CUSTOMER_ON ? '\n_O cliente recebeu o link para trocar o cartão. O Mercado Pago também tenta cobrar de novo._' : null,
      ].filter((l) => l !== null).join('\n'));
    }
  }
}

// ------------------------------------------------------------------ recuperação de quem escolheu o plano e não pagou

/**
 * Cliente novo que escolheu o plano (status "aguardando") e ainda não fez nenhum pagamento:
 *  - 1 hora depois: lembrete com o link para pagar;
 *  - 24 horas depois: último lembrete + aviso para o admin.
 * Se ele pagar antes, nada é enviado. Só envia no horário configurado no painel (padrão 9h às 20h);
 * fora desse horário, a mensagem espera o próximo horário de envio. Considera só pedidos dos últimos 7 dias.
 */
export async function runCheckoutReminders() {
  if (!canSend) return;
  if (!inWindow(await getPacing())) return;

  const pending = await all(`
    SELECT s.id, s.name, s.email, s.phone, s.created_at, p.name AS plan_name, p.price_cents,
           EXTRACT(EPOCH FROM (now() - s.created_at)) / 3600 AS hours
    FROM subscribers s JOIN plans p ON p.id = s.plan_id
    WHERE s.status = 'aguardando' AND p.price_cents > 0
      AND s.created_at > now() - interval '7 days'
      AND s.created_at < now() - interval '1 hour'
      AND NOT EXISTS (SELECT 1 FROM payments WHERE subscriber_id = s.id)`);

  for (const s of pending) {
    const value = brl(s.price_cents);
    const link = accountLink();

    if (s.hours >= 24) {
      await claim('checkout_1h', s.id, 'inicio'); // passou do prazo do 1º lembrete: vai direto para o último
      if (s.phone && CUSTOMER_ON) {
        await sendScheduled('checkout_24h', s.id, 'inicio', s.phone, await waText('wa_checkout_24h', varsFor(s)));
      }
      await pushOnce('push_checkout', s.id, 'inicio', varsFor(s));
      if (whatsappConfigured && (await claim('checkout_admin', s.id, 'inicio'))) {
        await notifyAdmin([
          '🕐 *Cliente não concluiu o pagamento (24h)*',
          '',
          ...contactLines(s),
          `📦 *Plano escolhido:* ${s.plan_name} (${value}/mês)`,
          `📅 *Escolheu o plano em:* ${new Date(s.created_at).toLocaleString('pt-BR', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' })}`,
          '',
          s.phone && CUSTOMER_ON ? '_Ele recebeu lembretes com 1h e 24h. Vale um contato pessoal._' : '⚠️ _Cliente sem WhatsApp cadastrado: não recebeu lembretes._',
        ].join('\n'));
      }
    } else if (s.phone && CUSTOMER_ON) {
      await sendScheduled('checkout_1h', s.id, 'inicio', s.phone, await waText('wa_checkout_1h', varsFor(s)));
    }
  }
}

/** Liga as rotinas: vencimentos de hora em hora; quem não pagou o 1º pedido a cada 10 min. */
export function startNoticeScheduler() {
  if (!canSend) return;
  // Uma rodada de cada vez: com a fila de intervalos, uma rodada pode levar vários minutos.
  const once = (fn, label) => { let busy = false; return async () => { if (busy) return; busy = true; try { await fn(); } catch (e) { console.error(label, e.message); } finally { busy = false; } }; };
  const daily = once(runDailyNotices, 'Avisos automáticos:');
  const checkout = once(runCheckoutReminders, 'Lembretes de pagamento:');
  setTimeout(() => { daily(); checkout(); }, 60_000).unref();
  setInterval(daily, 60 * 60_000).unref();
  setInterval(checkout, 10 * 60_000).unref();
}

// ------------------------------------------------------------------ conexão da instância (aba WhatsApp do painel)

async function evo(path, method = 'GET') {
  if (!canSend) throw new Error('WhatsApp não configurado: defina EVOLUTION_URL, EVOLUTION_INSTANCE e EVOLUTION_TOKEN no .env.');
  const res = await fetch(`${URL}${path}`, { method, headers: { apikey: TOKEN }, signal: AbortSignal.timeout(20_000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.response?.message || data?.message || data?.error || `erro ${res.status}`;
    throw new Error(`Evolution API: ${Array.isArray(msg) ? msg.join(' ') : msg}`);
  }
  return data;
}

async function evoPost(path, body) {
  if (!canSend) throw new Error('WhatsApp não configurado');
  const res = await fetch(`${URL}${path}`, {
    method: 'POST', headers: { apikey: TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Evolution API ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

/** Situação da conexão: { configured, state: 'open' | 'connecting' | 'close', number, name, picture } */
export async function whatsappStatus() {
  if (!canSend) return { configured: false, state: 'close' };
  const list = await evo(`/instance/fetchInstances?instanceName=${encodeURIComponent(INSTANCE)}`);
  const inst = (Array.isArray(list) ? list : [list]).find((i) => (i.name || i.instance?.instanceName) === INSTANCE) || {};
  const state = inst.connectionStatus || inst.instance?.state || 'close';
  const number = String(inst.ownerJid || inst.owner || '').split('@')[0] || null;
  return {
    configured: true,
    instance: INSTANCE,
    state,
    number: state === 'open' ? number : null,
    name: state === 'open' ? inst.profileName || null : null,
    picture: state === 'open' ? inst.profilePicUrl || null : null,
    admin_numbers: NUMBERS,
  };
}

/** Gera o QR Code para conectar. Retorna { state, qr } (qr = imagem data:image/png;base64,...). */
export async function whatsappQr() {
  const data = await evo(`/instance/connect/${encodeURIComponent(INSTANCE)}`);
  if (data?.instance?.state === 'open') return { state: 'open', qr: null };
  let qr = data.base64 || data.qrcode?.base64 || null;
  if (qr && !qr.startsWith('data:')) qr = `data:image/png;base64,${qr}`;
  return { state: 'connecting', qr, pairing_code: data.pairingCode || null };
}

/** Desconecta o WhatsApp da instância (depois é preciso ler um novo QR Code). */
export async function whatsappLogout() {
  await evo(`/instance/logout/${encodeURIComponent(INSTANCE)}`, 'DELETE');
}
