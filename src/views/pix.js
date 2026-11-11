// Pix gerado pelo admin para um assinante que não conseguiu pagar no cartão.
// Mostra QR Code + "copia e cola" para mandar ao cliente, e confere sozinho quando ele paga.
import { api } from '../api.js';
import { $, brl, esc, toast } from '../utils.js';

const POLL_MS = 5000;
const POLL_MAX_MS = 30 * 60_000; // depois de 30 min com a janela aberta, para de conferir (o sistema confere sozinho)
let timer = null;
let current = null; // { sub, pix, onChange, startedAt }

const ICON_COPY = '<svg class="ui-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>';
const ICON_CHAT = '<svg class="ui-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-12.3 7.4L3 21l2.1-5.6A8.4 8.4 0 1 1 21 11.5Z"/></svg>';
const ICON_CHECK = '<svg class="ui-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 7"/></svg>';

const fmtMonth = (m) => `${m.slice(5, 7)}/${m.slice(0, 4)}`;
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || '';

/** Número com DDI para o link do WhatsApp (Brasil = 55). */
function waNumber(phone) {
  let d = String(phone || '').replace(/\D/g, '').replace(/^0+/, '');
  if (d.length === 10 || d.length === 11) d = `55${d}`;
  return d.length >= 12 && d.length <= 13 ? d : '';
}

function messageFor(p) {
  return [
    `Olá, ${firstName(p.name)}! Segue o Pix da sua mensalidade do ${p.plan_name} (${brl(p.amount_cents)}), referente a ${fmtMonth(p.month)}.`,
    '',
    'É só copiar o código abaixo e colar no app do seu banco, em Pix > Copia e cola:',
    '',
    p.qr_code,
    '',
    'Assim que o pagamento cair, seu plano é ativado automaticamente.',
  ].join('\n');
}

function stop() {
  clearInterval(timer);
  timer = null;
}

function renderPix(p) {
  const wa = waNumber(p.phone);
  const expires = p.expires_at ? new Date(p.expires_at) : null;
  $('#pix-admin-body').innerHTML = `
    <div class="pix-admin-head">
      <div>
        <strong>${esc(p.name)}</strong>
        <p class="muted small">${esc(p.plan_name)} · mensalidade de ${esc(fmtMonth(p.month))}</p>
      </div>
      <span class="pix-admin-amount">${brl(p.amount_cents)}</span>
    </div>
    <div class="pix-admin-main">
      ${p.qr_code_base64 ? `<img class="pix-admin-qr" src="data:image/png;base64,${esc(p.qr_code_base64)}" alt="QR Code do Pix" width="200" height="200">` : ''}
      <div class="pix-admin-code">
        <label class="muted small" for="pix-admin-text">Pix copia e cola</label>
        <textarea id="pix-admin-text" rows="4" readonly>${esc(p.qr_code)}</textarea>
        <div class="wa-actions">
          <button class="btn primary" type="button" id="pix-copy-code">${ICON_COPY}<span>Copiar código</span></button>
          <button class="btn" type="button" id="pix-copy-msg">${ICON_COPY}<span>Copiar mensagem pronta</span></button>
          ${wa ? `<a class="btn" id="pix-open-wa" href="https://wa.me/${wa}?text=${encodeURIComponent(messageFor(p))}" target="_blank" rel="noopener">${ICON_CHAT}<span>Abrir conversa no WhatsApp</span></a>` : ''}
        </div>
        ${expires && !Number.isNaN(expires.getTime()) ? `<p class="muted small">Vale até ${esc(expires.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }))}.</p>` : ''}
      </div>
    </div>
    <div class="pix-admin-status" id="pix-admin-status">
      <span class="wa-spin"></span>
      <span>Aguardando o pagamento. Quando ele pagar, o plano é ativado sozinho — pode fechar esta janela.</span>
    </div>`;
}

function showPaid() {
  stop();
  const el = $('#pix-admin-status');
  if (!el) return;
  el.className = 'pix-admin-status paid';
  el.innerHTML = `${ICON_CHECK}<span><strong>Pago!</strong> O pagamento foi registrado e o plano está ativo.</span>`;
  toast(`Pix pago: ${current?.sub?.name || 'assinante'}`);
  current?.onChange?.();
}

async function poll() {
  if (!current || !$('#dlg-pix').open) return stop();
  if (Date.now() - current.startedAt > POLL_MAX_MS) return stop();
  try {
    const r = await api.subscriberPixStatus(current.sub.id, current.pix.order_id);
    if (r.paid) showPaid();
  } catch { /* tenta de novo no próximo ciclo */ }
}

async function copy(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg);
  } catch {
    const ta = $('#pix-admin-text');
    ta.focus();
    ta.select();
    toast('Selecionei o código: use Copiar do seu teclado.');
  }
}

/** Abre a janela e gera um Pix novo da mensalidade em aberto do assinante. */
export async function openAdminPix(sub, onChange) {
  if (!sub) return;
  if (!confirm(`Gerar um Pix de ${brl(sub.price_cents)} para ${sub.name}?`)) return;
  stop();
  current = null;
  $('#pix-admin-body').innerHTML = '<p class="muted">Gerando o Pix no Mercado Pago…</p>';
  $('#dlg-pix').showModal();
  try {
    const pix = await api.subscriberPix(sub.id);
    current = { sub, pix, onChange, startedAt: Date.now() };
    renderPix(pix);
    timer = setInterval(poll, POLL_MS);
  } catch (err) {
    $('#pix-admin-body').innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

export function initAdminPix() {
  $('#pix-admin-close').addEventListener('click', () => { stop(); $('#dlg-pix').close(); });
  $('#dlg-pix').addEventListener('close', stop);
  $('#pix-admin-body').addEventListener('click', (e) => {
    const id = e.target.closest('button')?.id;
    if (!current) return;
    if (id === 'pix-copy-code') copy(current.pix.qr_code, 'Código Pix copiado. Cole na conversa com o cliente.');
    if (id === 'pix-copy-msg') copy(messageFor(current.pix), 'Mensagem copiada. Cole na conversa com o cliente.');
  });
}
