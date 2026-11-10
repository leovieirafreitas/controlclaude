import { methodIcon } from './icons.js';
export const $ = (selector) => document.querySelector(selector);

export const brl = (cents) =>
  (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const fmtDate = (iso) => (iso ? iso.split('-').reverse().join('/') : '—');

export const fmtMonth = (month) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1).toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' });
};

export const today = () => new Date().toLocaleDateString('sv-SE'); // AAAA-MM-DD
export const thisMonth = () => today().slice(0, 7);

const STATUS_LABEL = {
  aguardando: 'Aguardando pagamento', pago: 'Pago', pendente: 'Pendente', atrasado: 'Atrasado', parcial: 'Parcial',
  ativo: 'Ativo', pausado: 'Pausado', cancelado: 'Cancelado', inativo: 'Inativo',
};

export const badge = (status) => `<span class="badge b-${status}">${STATUS_LABEL[status] || esc(status)}</span>`;

export const METHOD_LABEL = {
  pix: 'Pix', credito: 'Cartão de crédito', debito: 'Cartão de débito', cartao: 'Cartão',
  boleto: 'Boleto', dinheiro: 'Dinheiro', transferencia: 'Transferência',
};
export const methodChip = (m) => `<span class="chip m-${esc(m)}">${methodIcon(m)} ${esc(METHOD_LABEL[m] || m)}</span>`;
/** Ícone + nome da forma de pagamento, em texto discreto (sem o "chip" colorido). */
export const methodInline = (m) => `<span class="pm-inline m-${esc(m)}">${methodIcon(m)}${esc(METHOD_LABEL[m] || m)}</span>`;

let toastTimer;
export function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

/** Liga um <form method="dialog"> ao handler; só chama onSave quando clicam em "Salvar". */
export function bindDialogForm(form, onSave) {
  form.addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'ok') return;
    e.preventDefault();
    try {
      await onSave(Object.fromEntries(new FormData(form)));
      form.closest('dialog').close();
    } catch {
      /* erro já exibido no toast */
    }
  });
}

/** Selo da renovação automática no cartão (assinatura do Mercado Pago). */
export function autopayBadge(x) {
  if (x.autopay_status === 'authorized') {
    const tip = [x.card_last4 ? `Cartão final ${x.card_last4}` : null, x.next_charge_date ? `próxima cobrança ${fmtDate(String(x.next_charge_date).slice(0, 10))}` : null].filter(Boolean).join(' · ');
    return ` <span class="badge b-autopay" title="${esc(tip)}">${methodIcon('credito')} Renovação automática</span>`;
  }
  if (x.autopay_status === 'paused') return ' <span class="badge b-pausado" title="Pediu cancelamento: cobrança pausada">Renovação pausada</span>';
  return '';
}
