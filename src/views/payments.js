import { api } from '../api.js';
import { $, brl, esc, fmtDate, fmtMonth, thisMonth, today, toast, bindDialogForm, methodChip } from '../utils.js';

export async function loadPayments() {
  const rows = await api.payments($('#pay-month').value, $('#pay-method').value);
  const total = rows.reduce((sum, r) => sum + r.amount_cents, 0);

  // Resumo por forma de pagamento (do filtro atual)
  const byMethod = {};
  for (const r of rows) (byMethod[r.method] ||= { total: 0, count: 0 }, byMethod[r.method].total += r.amount_cents, byMethod[r.method].count++);
  $('#pay-summary').innerHTML = Object.entries(byMethod)
    .sort((a, b) => b[1].total - a[1].total)
    .map(([m, v]) => `<div class="sum-item">${methodChip(m)}<strong>${brl(v.total)}</strong><span class="muted">${v.count}×</span></div>`).join('');

  $('#pay-rows').innerHTML = rows.length
    ? rows.map((p) => `
      <tr>
        <td>${fmtDate(p.paid_at)}</td>
        <td><strong>${esc(p.subscriber_name)}</strong></td>
        <td>${esc(p.plan_name)}</td>
        <td>${fmtMonth(p.ref_month)}</td>
        <td class="num">${brl(p.amount_cents)}</td>
        <td>${methodChip(p.method)}</td>
        <td>${p.mp_payment_id ? '<span class="badge b-ativo">Site · Mercado Pago</span>' : '<span class="badge b-pausado">Manual</span>'}</td>
        <td class="muted">${esc(p.notes)}</td>
        <td><button class="btn small danger" data-del="${p.id}">Excluir</button></td>
      </tr>`).join('')
      + `<tr><td colspan="4"><strong>Total</strong></td><td class="num"><strong>${brl(total)}</strong></td><td colspan="4"></td></tr>`
    : '<tr><td colspan="9" class="empty">Nenhum pagamento registrado.</td></tr>';
}

export async function openPayment(prefill = {}) {
  const subs = (await api.subscribers()).filter((s) => s.status !== 'cancelado' || String(s.id) === String(prefill.subscriber_id));
  if (!subs.length) return toast('Cadastre um assinante primeiro');

  const f = $('#form-pay');
  f.reset();
  f.subscriber_id.innerHTML = subs.map((s) => `
    <option value="${s.id}" ${String(s.id) === String(prefill.subscriber_id) ? 'selected' : ''}>
      ${esc(s.name)} — ${esc(s.plan_name)} (${brl(s.price_cents)})
    </option>`).join('');
  f.ref_month.value = prefill.ref_month || thisMonth();
  f.paid_at.value = today();
  $('#dlg-pay').showModal();
}

export function initPayments(onChange) {
  $('#pay-month').value = thisMonth();
  $('#pay-month').addEventListener('change', loadPayments);
  $('#pay-method').addEventListener('change', loadPayments);
  $('#new-pay').addEventListener('click', () => openPayment({ ref_month: $('#pay-month').value || thisMonth() }));

  $('#pay-rows').addEventListener('click', async (e) => {
    const id = e.target.dataset.del;
    if (id && confirm('Excluir este pagamento?')) {
      await api.deletePayment(id);
      toast('Pagamento excluído');
      loadPayments();
    }
  });

  bindDialogForm($('#form-pay'), async (body) => {
    await api.createPayment(body);
    toast('Pagamento registrado');
    onChange();
  });
}
