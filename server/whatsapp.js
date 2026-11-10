// Avisos no WhatsApp pela Evolution API (v2): para o admin e para o cliente.
// Nunca bloqueia nem derruba o fluxo principal: se o envio falhar, só registra no log.
import { all, get, run } from './db.js';
import { setAutopayStatus } from './mp.js';

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

// ------------------------------------------------------------------ eventos

/** Pagamento aprovado pelo site: "nova assinatura" no 1º pagamento, "pagamento recebido" nos seguintes. */
export async function notifyPayment({ subscriberId, month, amountCents, method, orderId, autopay = false }) {
  if (!canSend) return;
  const s = await subscriberInfo(subscriberId).catch(() => null);
  if (!s) return;
  const first = s.payments_count <= 1;
  const how = autopay ? `${METHOD[method] || 'Cartão'} (renovação automática)` : METHOD[method] || method;
  const card = s.card_last4 ? ` final ${s.card_last4}` : '';

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

  fire(notifyCustomer(s.phone, first
    ? [
      `Olá, ${firstName(s.name)}! 🎉`,
      '',
      `Sua assinatura do *${s.plan_name}* está ativa. Seja bem-vindo(a) à Control Claude!`,
      '',
      `💵 Pagamento de ${brl(amountCents)} via ${how} confirmado (${fmtMonth(month)}).`,
      autopay
        ? `🔁 A renovação é automática: todo mês, por volta do dia ${s.due_day}, cobramos no seu cartão${card}. Você não precisa fazer nada.`
        : `📅 Sua mensalidade vence todo dia ${s.due_day}.`,
      accountLink() ? `\nNa sua área você vê seus dados e pagamentos, troca o cartão ou cancela quando quiser:\n${accountLink()}` : null,
      '',
      'Qualquer dúvida, é só responder esta mensagem.',
    ].filter((l) => l !== null).join('\n')
    : [
      `Olá, ${firstName(s.name)}! ✅`,
      '',
      autopay
        ? `A renovação automática do seu plano foi feita: cobramos ${brl(amountCents)} no seu cartão${card}, referente a ${fmtMonth(month)}.`
        : `Recebemos seu pagamento de ${brl(amountCents)} via ${how}, referente a ${fmtMonth(month)}.`,
      `Seu plano *${s.plan_name}* segue ativo. Obrigado!`,
    ].join('\n')));
}

/** Cliente cancelou pela Área do assinante. `accessUntil` = último dia de acesso (null = acabou na hora). */
export async function notifyCancel(subscriberId, accessUntil = null) {
  if (!whatsappConfigured) return;
  const s = await subscriberInfo(subscriberId).catch(() => null);
  if (!s) return;
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
  if (!whatsappConfigured) return;
  const s = await subscriberInfo(subscriberId).catch(() => null);
  if (!s) return;
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

/** Cliente criou a conta (ainda sem pagar). */
export function notifySignup({ name, email, phone, birth_date }) {
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
 * Cada aviso sai no máximo uma vez por mensalidade. Só envia das 9h às 20h (fuso NOTIFY_TIMEZONE).
 * Se o servidor estiver desligado no dia exato, o aviso sai na próxima conferência dentro da janela.
 */
export async function runDailyNotices() {
  if (!canSend) return;
  const now = new Date();
  const hour = Number(now.toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }));
  if (hour < 9 || hour >= 20) return;
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

    if (daysLeft <= RETENTION_DAYS && !s.retention_answer && s.phone && canSend && (await claim('retencao', s.id, String(s.cancel_at)))) {
      const ok = await notifyCustomer(s.phone, [
        `Oi, ${firstName(s.name)}! 👋`,
        '',
        `Você cancelou o plano *${s.plan_name}*, e seu acesso vai até *${until}*.`,
        '',
        '*Você quer continuar usando?*',
        'Responda esta mensagem com:',
        '👉 *SIM* — para continuar',
        '👉 *NÃO* — para encerrar no dia ' + until,
      ].join('\n'), { force: true });
      if (!ok) await unclaim('retencao', s.id, String(s.cancel_at));
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
    await claim('lembrete', s.id, month);
    const resumed = await setAutopayStatus(s, 'authorized').catch((e) => { console.error('Mercado Pago (retomar renovação):', e.message); return false; });
    const autopay = resumed || s.autopay_status === 'authorized';
    await notifyCustomer(s.phone, [
      `Que ótimo, ${firstName(s.name)}! 🎉 Seu plano *${s.plan_name}* continua.`,
      '',
      autopay
        ? `A renovação automática voltou: em *${until}* cobramos ${brl(s.price_cents)} no seu cartão${s.card_last4 ? ` final ${s.card_last4}` : ''}. Você não precisa fazer nada.`
        : `A próxima mensalidade (${brl(s.price_cents)}) vence em *${until}*.`,
      !autopay && accountLink() ? `Ative a renovação automática com seu cartão aqui:\n👉 ${accountLink()}` : null,
    ].filter((l) => l !== null).join('\n'), { force: true });
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
  await notifyCustomer(s.phone, [
    `Tudo bem, ${firstName(s.name)}. Seu acesso continua até *${until}* e depois o plano será encerrado.`,
    '',
    'Obrigado por ter sido nosso assinante! Se quiser voltar, é só assinar de novo pelo site. 💛',
  ].join('\n'), { force: true });
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
  if (daysLeft > REMINDER_DAYS && daysLeft <= CARD_NOTICE_DAYS && s.phone && CUSTOMER_ON && (await claim('aviso_cartao', s.id, month))) {
    const ok = await notifyCustomer(s.phone, [
      `Olá, ${firstName(s.name)}! 👋`,
      '',
      `Um aviso rápido sobre a sua assinatura do *${s.plan_name}*:`,
      '',
      `A partir da próxima mensalidade (${due}), o pagamento passa a ser *automático no cartão de crédito*. Você cadastra o cartão uma vez e todo mês a cobrança acontece sozinha, sem precisar lembrar de pagar.`,
      '',
      accountLink()
        ? `Uns dias antes do vencimento te mandamos o link para cadastrar o cartão. Se preferir, já pode fazer isso agora na sua área:\n👉 ${accountLink()}`
        : 'Uns dias antes do vencimento te mandamos o link para cadastrar o cartão.',
      '',
      'Você pode cancelar quando quiser: a cobrança para e o acesso continua até o fim do mês pago.',
      '',
      'Qualquer dúvida, é só responder esta mensagem.',
    ].join('\n'));
    if (!ok) await unclaim('aviso_cartao', s.id, month);
  }

  // Cliente: 3 dias antes (ou assim que entrar na janela)
  if (daysLeft >= 0 && daysLeft <= REMINDER_DAYS && s.phone && CUSTOMER_ON && (await claim('lembrete', s.id, month))) {
    const ok = await notifyCustomer(s.phone, [
      `Olá, ${firstName(s.name)}! 👋`,
      '',
      daysLeft === 0
        ? `Sua mensalidade do *${s.plan_name}* (${value}) vence *hoje* (${due}).`
        : `Sua mensalidade do *${s.plan_name}* (${value}) vence em *${plural(daysLeft)}*, no dia *${due}*.`,
      '',
      'Para continuar, pague na sua área do assinante com *cartão de crédito*. Assim você ativa a *renovação automática* e não precisa mais se preocupar com o vencimento.',
      accountLink() ? `
👉 Pagar agora: ${accountLink()}` : null,
      '',
      'Se já pagou, desconsidere esta mensagem. 😉',
    ].filter((l) => l !== null).join('\n'));
    if (!ok) await unclaim('lembrete', s.id, month);
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
    if (s.phone && CUSTOMER_ON && (await claim('atraso_cliente', s.id, month))) {
      const ok = await notifyCustomer(s.phone, [
        `Olá, ${firstName(s.name)}.`,
        '',
        `Não identificamos o pagamento da mensalidade do *${s.plan_name}* (${value}), que venceu em ${due}.`,
        accountLink() ? `\nVocê pode pagar agora com cartão de crédito:\n👉 ${accountLink()}` : null,
        '',
        'Se já pagou, desconsidere. Qualquer dúvida, é só responder aqui.',
      ].filter((l) => l !== null).join('\n'));
      if (!ok) await unclaim('atraso_cliente', s.id, month);
    }
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

  if (daysLeft >= 0 && daysLeft <= REMINDER_DAYS && s.phone && CUSTOMER_ON && (await claim('lembrete', s.id, month))) {
    const ok = await notifyCustomer(s.phone, [
      `Olá, ${firstName(s.name)}! 👋`,
      '',
      daysLeft === 0
        ? `Hoje (${due}) cobramos a mensalidade do *${s.plan_name}* (${value}) no seu cartão${card}.`
        : `No dia *${due}* vamos cobrar a mensalidade do *${s.plan_name}* (${value}) no seu cartão${card}.`,
      '',
      'É automático: você não precisa fazer nada. 😉',
      accountLink() ? `\nPara trocar o cartão ou ver seus pagamentos: ${accountLink()}` : null,
    ].filter((l) => l !== null).join('\n'));
    if (!ok) await unclaim('lembrete', s.id, month);
  }

  if (daysLeft <= -2) {
    if (s.phone && CUSTOMER_ON && (await claim('atraso_cliente', s.id, month))) {
      const ok = await notifyCustomer(s.phone, [
        `Olá, ${firstName(s.name)}.`,
        '',
        `A cobrança automática da mensalidade do *${s.plan_name}* (${value}) no seu cartão${card} *não foi aprovada*.`,
        'Pode ser limite, cartão vencido ou bloqueado.',
        accountLink() ? `\nPara não perder o acesso, atualize o cartão aqui:\n👉 ${accountLink()}` : null,
        '',
        'Qualquer dúvida, é só responder esta mensagem.',
      ].filter((l) => l !== null).join('\n'));
      if (!ok) await unclaim('atraso_cliente', s.id, month);
    }
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
 * Se ele pagar antes, nada é enviado. Só envia das 8h às 21h (fuso NOTIFY_TIMEZONE);
 * fora desse horário, a mensagem espera até as 8h. Considera só pedidos dos últimos 7 dias.
 */
export async function runCheckoutReminders() {
  if (!canSend) return;
  const hour = Number(new Date().toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }));
  if (hour < 8 || hour >= 21) return;

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
      if (s.phone && CUSTOMER_ON && (await claim('checkout_24h', s.id, 'inicio'))) {
        const ok = await notifyCustomer(s.phone, [
          `Oi, ${firstName(s.name)}! 😊`,
          '',
          `Sua assinatura do *${s.plan_name}* (${value}/mês) ainda está esperando o pagamento para ser ativada.`,
          link ? `\nÉ rapidinho, com cartão de crédito:\n👉 ${link}` : null,
          '',
          'Se tiver qualquer dúvida ou dificuldade para pagar, é só responder esta mensagem que a gente te ajuda.',
        ].filter((l) => l !== null).join('\n'));
        if (!ok) await unclaim('checkout_24h', s.id, 'inicio');
      }
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
    } else if (s.phone && CUSTOMER_ON && (await claim('checkout_1h', s.id, 'inicio'))) {
      const ok = await notifyCustomer(s.phone, [
        `Oi, ${firstName(s.name)}! 👋`,
        '',
        `Vi que você escolheu o plano *${s.plan_name}* (${value}/mês), mas o pagamento ainda não foi concluído.`,
        link ? `\nVocê pode pagar com cartão de crédito aqui:\n👉 ${link}` : null,
        '',
        'Precisa de ajuda? É só responder esta mensagem.',
      ].filter((l) => l !== null).join('\n'));
      if (!ok) await unclaim('checkout_1h', s.id, 'inicio');
    }
  }
}

/** Liga as rotinas: vencimentos de hora em hora; quem não pagou o 1º pedido a cada 10 min. */
export function startNoticeScheduler() {
  if (!canSend) return;
  const daily = () => runDailyNotices().catch((e) => console.error('Avisos automáticos:', e.message));
  const checkout = () => runCheckoutReminders().catch((e) => console.error('Lembretes de pagamento:', e.message));
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
