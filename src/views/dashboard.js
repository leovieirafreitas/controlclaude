import { api } from '../api.js';
import { $, brl, esc, fmtDate, fmtMonth, badge, thisMonth, methodChip, methodInline } from '../utils.js';
import { openPayment } from './payments.js';

let data = null;

export async function loadDashboard() {
  data = await api.dashboard($('#dash-month').value);
  const k = data.kpis;

  $('#kpis').innerHTML = [
    ['Assinantes ativos', k.active_subscribers],
    ['Previsto no mês', brl(k.expected_cents)],
    ['Recebido no mês', brl(k.received_cents)],
    ['A receber', brl(k.pending_cents)],
    ['Pagaram', `${k.paid_count} / ${k.active_subscribers}`],
    ['Em atraso', k.overdue_count],
  ].map(([label, value]) => `<div class="kpi"><div class="label">${label}</div><div class="value">${value}</div></div>`).join('');

  const max = Math.max(1, ...data.history.map((h) => h.received_cents));
  $('#history').innerHTML = data.history.map((h) => `
    <div class="bar" title="${brl(h.received_cents)}">
      <span class="v">${h.received_cents ? brl(h.received_cents).replace(',00', '') : ''}</span>
      <div class="fill" style="height:${(h.received_cents / max) * 100}%"></div>
      <span class="m">${fmtMonth(h.month)}</span>
    </div>`).join('');

  $('#by-plan').innerHTML = data.by_plan.map((p) => `
    <div class="plan-row">
      <span>${esc(p.name)} <span class="muted">· ${brl(p.price_cents)}</span></span>
      <strong>${p.subscribers}</strong>
    </div>`).join('') || '<div class="muted">Nenhum plano</div>';

  renderMethods();
  renderRows();
}

function renderMethods() {
  const rows = data.by_method;
  const total = rows.reduce((s, r) => s + r.total_cents, 0);
  $('#methods-month').textContent = `· ${fmtMonth(data.month)}`;
  $('#by-method').innerHTML = rows.length
    ? rows.map((r) => {
      const pct = total ? Math.round((r.total_cents / total) * 100) : 0;
      return `
        <div class="method m-${esc(r.method)}">
          <div class="method-top">${methodChip(r.method)}<strong>${brl(r.total_cents)}</strong></div>
          <div class="meter"><span style="width:${pct}%"></span></div>
          <div class="muted small">${r.count} pagamento${r.count > 1 ? 's' : ''} · ${pct}% do recebido${r.online ? ` · ${r.online === r.count ? 'todos' : r.online} pelo site` : ' · lançado no painel'}</div>
        </div>`;
    }).join('')
    : '<div class="muted">Nenhum pagamento neste mês.</div>';
}

function renderRows() {
  const filter = $('#dash-filter').value;
  const list = data.subscribers.filter((s) => !filter || s.pay_status === filter);
  const month = data.month.slice(5, 7);

  $('#dash-rows').innerHTML = list.map((s) => `
    <tr>
      <td><strong>${esc(s.name)}</strong><div class="muted">${esc(s.phone || s.email)}</div></td>
      <td>${esc(s.plan_name)}</td>
      <td class="num">${brl(s.price_cents)}</td>
      <td>${String(s.due_day).padStart(2, '0')}/${month}</td>
      <td class="num">${s.paid_cents ? `${brl(s.paid_cents)}<div class="muted">${fmtDate(s.last_paid_at)} · ${(s.paid_methods || '').split(',').filter(Boolean).map(methodInline).join(' + ')}</div>` : '—'}</td>
      <td>${badge(s.pay_status)}${s.status === 'ativo' && s.cancel_at ? ` <span class="badge b-aguardando" title="Pediu cancelamento${s.retention_answer === 'nao' ? ' e confirmou no WhatsApp' : ''}">Cancela em ${fmtDate(s.cancel_at)}</span>` : ''}</td>
      <td>${s.pay_status !== 'pago' ? `<button class="btn small primary" data-quickpay="${s.id}">Marcar pago</button>` : ''}</td>
    </tr>`).join('')
    || `<tr><td colspan="7" class="empty">Nenhum assinante ${filter ? 'com este status' : 'ativo neste mês'}.</td></tr>`;
}

export function initDashboard() {
  $('#dash-month').value = thisMonth();
  $('#dash-month').addEventListener('change', loadDashboard);
  $('#dash-filter').addEventListener('change', renderRows);
  $('#dash-rows').addEventListener('click', (e) => {
    const id = e.target.dataset.quickpay;
    if (id) openPayment({ subscriber_id: id, ref_month: data.month });
  });
}
