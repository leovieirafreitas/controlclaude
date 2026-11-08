// Avisos no WhatsApp pela Evolution API (v2): para o admin e para o cliente.
// Nunca bloqueia nem derruba o fluxo principal: se o envio falhar, só registra no log.
import { all, get, run } from './db.js';

const URL = (process.env.EVOLUTION_URL || '').replace(/\/$/, '');
const INSTANCE = process.env.EVOLUTION_INSTANCE || '';
const TOKEN = process.env.EVOLUTION_TOKEN || '';
const NUMBERS = (process.env.WHATSAPP_ADMIN_NUMBERS || '').split(',').map((n) => n.replace(/\D/g, '')).filter(Boolean);
const TZ = process.env.NOTIFY_TIMEZONE || 'America/Sao_Paulo';
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');
// Mensagens para o cliente (boas-vindas, lembrete, atraso). Desligue com WHATSAPP_CUSTOMER_MESSAGES=off
const CUSTOMER_ON = !/^(off|0|false|nao|não)$/i.test(process.env.WHATSAPP_CUSTOMER_MESSAGES || 'on');
const REMINDER_DAYS = Math.max(0, Number(process.env.REMINDER_DAYS_BEFORE ?? 3) || 0);

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
export async function notifyCustomer(phone, text) {
  if (!canSend || !CUSTOMER_ON) return false;
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
export async function notifyPayment({ subscriberId, month, amountCents, method, orderId }) {
  if (!canSend) return;
  const s = await subscriberInfo(subscriberId).catch(() => null);
  if (!s) return;
  const first = s.payments_count <= 1;
  const how = METHOD[method] || method;

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
      `📅 Sua mensalidade vence todo dia ${s.due_day}.`,
      accountLink() ? `\nNa sua área você vê seus dados, pagamentos e pode pagar as próximas mensalidades:\n${accountLink()}` : null,
      '',
      'Qualquer dúvida, é só responder esta mensagem.',
    ].filter((l) => l !== null).join('\n')
    : [
      `Olá, ${firstName(s.name)}! ✅`,
      '',
      `Recebemos seu pagamento de ${brl(amountCents)} via ${how}, referente a ${fmtMonth(month)}.`,
      `Seu plano *${s.plan_name}* segue ativo. Obrigado!`,
    ].join('\n')));
}

/** Cliente cancelou pela Área do assinante. */
export async function notifyCancel(subscriberId) {
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
    `🕒 ${nowBR()}`,
  ].join('\n')));
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
           (SELECT MAX(ref_month) FROM payments WHERE subscriber_id = s.id) AS last_paid_month,
           (SELECT COALESCE(SUM(amount_cents), 0) FROM payments WHERE subscriber_id = s.id AND ref_month = ?) AS paid_this,
           (SELECT COALESCE(SUM(amount_cents), 0) FROM payments WHERE subscriber_id = s.id AND ref_month = ?) AS paid_next
    FROM subscribers s JOIN plans p ON p.id = s.plan_id
    WHERE s.status = 'ativo' AND p.price_cents > 0`, [thisMonth, nextMonth]);

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

async function noticesFor(s, month, daysLeft, due) {
  const value = brl(s.price_cents);
  const plural = (n) => `${n} dia${n > 1 ? 's' : ''}`;

  // Cliente: 3 dias antes (ou assim que entrar na janela)
  if (daysLeft >= 0 && daysLeft <= REMINDER_DAYS && s.phone && CUSTOMER_ON && (await claim('lembrete', s.id, month))) {
    const ok = await notifyCustomer(s.phone, [
      `Olá, ${firstName(s.name)}! 👋`,
      '',
      daysLeft === 0
        ? `Sua mensalidade do *${s.plan_name}* (${value}) vence *hoje* (${due}).`
        : `Sua mensalidade do *${s.plan_name}* (${value}) vence em *${plural(daysLeft)}*, no dia *${due}*.`,
      '',
      'O pagamento é feito por você, na sua área do assinante, por *Pix* ou *cartão*. Assim que o pagamento for confirmado, seu plano continua ativo.',
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
        accountLink() ? `\nVocê pode pagar agora por Pix ou cartão:\n👉 ${accountLink()}` : null,
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
          link ? `\nÉ rapidinho, por Pix ou cartão:\n👉 ${link}` : null,
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
        link ? `\nVocê pode pagar por Pix ou cartão aqui:\n👉 ${link}` : null,
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
