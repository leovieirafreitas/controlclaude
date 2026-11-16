// Data de "hoje" do sistema. O servidor roda em UTC (4 horas à frente de Manaus): sem isto, o dia virava às 20h
// de Manaus, e vencimento, janela de vendas e valor proporcional eram calculados como se já fosse o dia seguinte.
// Usa o mesmo fuso dos avisos do WhatsApp (NOTIFY_TIMEZONE).
export const APP_TZ = process.env.NOTIFY_TIMEZONE || 'America/Manaus';

/** Hoje em AAAA-MM-DD no fuso do negócio. */
export const todayISO = (now = new Date()) => now.toLocaleDateString('sv-SE', { timeZone: APP_TZ });
