// Envio de e-mail pelo Resend (https://resend.com)
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM = process.env.RESEND_FROM || 'Control Claude <onboarding@resend.dev>';

export const mailConfigured = Boolean(RESEND_API_KEY);

export async function sendLoginCode(to, code, purpose = 'login') {
  const reset = purpose === 'reset';
  if (!mailConfigured) throw new Error('RESEND_API_KEY não configurada');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [to],
      subject: reset ? `Código para criar nova senha: ${code}` : `Seu código de acesso: ${code}`,
      text: `${reset ? 'Seu código para criar uma nova senha' : 'Seu código para entrar no painel'} é ${code}.\n\nEle vale por 10 minutos e só pode ser usado uma vez.\nSe não foi você que pediu, ignore este e-mail.`,
      html: `
        <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:420px;margin:0 auto;padding:24px;color:#1f1e1b">
          <p style="margin:0 0 16px;font-size:18px;font-weight:500">Control <b style="color:#c96442">Claude</b></p><h2 style="font-weight:600;margin:0 0 12px">${reset ? 'Recuperar senha' : 'Código de acesso'}</h2>
          <p style="margin:0 0 20px;color:#6b6963">${reset ? 'Use este código para criar uma nova senha:' : 'Use este código para entrar no painel:'}</p>
          <div style="font-size:34px;font-weight:700;letter-spacing:8px;background:#f6e6de;color:#c96442;border-radius:12px;padding:18px;text-align:center">${code}</div>
          <p style="margin:20px 0 0;font-size:13px;color:#6b6963">Vale por 10 minutos e só pode ser usado uma vez. Se não foi você que pediu, ignore este e-mail.</p>
        </div>`,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${body.slice(0, 300)}`);
  }
}
