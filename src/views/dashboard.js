import { api } from '../api.js';
import { $, brl, esc, fmtDate, fmtMonth, badge, thisMonth, today, methodChip, methodInline, autopayBadge } from '../utils.js';
import { openPayment } from './payments.js';

let data = null;
let upTab = null;      // aba dos próximos vencimentos (null = a mais urgente que tiver gente)
let rowFilter = '';    // aba das mensalidades do mês: '' | falta | atrasado | pago

const plural = (n) => `${n} dia${n === 1 ? '' : 's'}`;
/** "em 5 dias", "amanhã", "hoje", "há 2 dias" */
const whenLabel = (days) => (days === 0 ? 'hoje' : days === 1 ? 'amanhã' : days > 0 ? `em ${plural(days)}` : `há ${plural(-days)}`);
const tabsHtml = (tabs, active) => tabs.map((t) => `
  <button type="button" data-tab="${t.key}" class="${t.key === active ? 'active' : ''}${t.tone && t.count ? ` tone-${t.tone}` : ''}">
    ${t.label} <span class="n">${t.count}</span>
  </button>`).join('');
const shortDate = (iso) => fmtDate(iso).slice(0, 5); // dd/mm
const plain = (v) => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

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
  renderUpcoming();
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

// ------------------------------------------------------------------ próximos vencimentos (a partir de hoje)

const UP_GROUPS = [
  { key: 'atrasado', label: 'Atrasados', tone: 'bad', test: (u) => u.status === 'ativo' && u.days < 0 },
  { key: 'hoje', label: 'Vencem hoje', tone: 'warn', test: (u) => u.status === 'ativo' && u.days === 0 },
  { key: 'semana', label: 'Próximos 7 dias', test: (u) => u.status === 'ativo' && u.days >= 1 && u.days <= 7 },
  { key: 'depois', label: 'Mais adiante', test: (u) => u.status === 'ativo' && u.days > 7 },
  { key: 'desativado', label: 'Desativados', tone: 'bad', test: (u) => u.status === 'pausado' },
];

function renderUpcoming() {
  const all = data.upcoming || [];
  const groups = UP_GROUPS.map((g) => ({ ...g, items: all.filter(g.test) }));
  // sem aba escolhida: abre na mais urgente que tiver alguém
  const active = groups.find((g) => g.key === upTab) || groups.find((g) => g.items.length && g.key !== 'desativado') || groups[2];

  $('#up-tabs').innerHTML = tabsHtml(groups.map((g) => ({ key: g.key, label: g.label, tone: g.tone, count: g.items.length })), active.key);

  const billable = active.items.filter((u) => !u.ends_before);
  const total = billable.reduce((s, u) => s + Math.max(u.amount_cents - u.paid_cents, 0), 0);
  $('#up-total').textContent = billable.length ? `${billable.length} assinante${billable.length > 1 ? 's' : ''} · ${brl(total)} a receber` : '';

  $('#up-list').innerHTML = active.items.map((u) => {
    const tone = u.status === 'pausado' || u.days < 0 ? 'bad' : u.days === 0 ? 'warn' : u.days <= 7 ? 'soon' : '';
    const left = Math.max(u.amount_cents - u.paid_cents, 0);
    const tags = [
      u.status === 'pausado' ? '<span class="badge b-atrasado" title="Plano desativado por falta de pagamento">Desativado</span>' : '',
      autopayBadge(u).trim(),
      u.cancel_at ? `<span class="badge b-aguardando" title="${u.ends_before ? 'Cancela antes do vencimento: não será cobrado' : 'Pediu cancelamento'}">Cancela em ${fmtDate(u.cancel_at)}</span>` : '',
    ].filter(Boolean).join('');
    return `
      <div class="due-item">
        <div class="due-when ${tone ? `tone-${tone}` : ''}">
          <strong>${shortDate(u.due)}</strong>
          <span>${whenLabel(u.days)}</span>
        </div>
        <div class="due-who">
          <strong>${esc(u.name)}</strong>
          <span class="muted">${esc(u.plan_name)}${u.phone || u.email ? ` · ${esc(u.phone || u.email)}` : ''}</span>
        </div>
        <div class="due-tags">${tags}</div>
        <div class="due-amount">
          <strong>${brl(left)}</strong>
          ${u.paid_cents ? `<span class="muted">já pagou ${brl(u.paid_cents)}</span>` : `<span class="muted">${fmtMonth(u.month)}</span>`}
        </div>
        <button class="btn small primary" data-quickpay="${u.id}" data-month="${u.month}">Marcar pago</button>
      </div>`;
  }).join('') || `<div class="empty">${active.key === 'atrasado' ? 'Ninguém em atraso.' : active.key === 'hoje' ? 'Ninguém vence hoje.' : active.key === 'desativado' ? 'Nenhum plano desativado por falta de pagamento.' : 'Nenhum vencimento neste período.'}</div>`;
}

// ------------------------------------------------------------------ mensalidades do mês escolhido

const ORDER = { atrasado: 0, parcial: 1, pendente: 2, pago: 3 };
const unpaid = (s) => s.pay_status !== 'pago';

function renderRows() {
  const subs = data.subscribers;
  const [y, m] = data.month.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  const dueOf = (s) => Math.min(s.due_day, lastDay);
  const isCurrent = data.month === (data.today || today()).slice(0, 7);
  const todayDay = Number((data.today || today()).slice(8, 10));

  $('#dash-month-label').textContent = fmtMonth(data.month);
  $('#dash-tabs').innerHTML = tabsHtml([
    { key: '', label: 'Todos', count: subs.length },
    { key: 'falta', label: 'Faltam pagar', count: subs.filter(unpaid).length },
    { key: 'atrasado', label: 'Atrasados', tone: 'bad', count: subs.filter((s) => s.pay_status === 'atrasado').length },
    { key: 'pago', label: 'Pagos', count: subs.filter((s) => s.pay_status === 'pago').length },
  ], rowFilter);

  const q = plain($('#dash-search').value.trim());
  const list = subs
    .filter((s) => (rowFilter === 'falta' ? unpaid(s) : !rowFilter || s.pay_status === rowFilter))
    .filter((s) => !q || plain(`${s.name} ${s.phone} ${s.email} ${s.plan_name}`).includes(q))
    // quem falta pagar primeiro (atrasado, parcial, pendente), depois por vencimento
    .sort((a, b) => ORDER[a.pay_status] - ORDER[b.pay_status] || dueOf(a) - dueOf(b) || a.name.localeCompare(b.name, 'pt-BR'));

  $('#dash-rows').innerHTML = list.map((s) => {
    const days = dueOf(s) - todayDay;
    const when = isCurrent && unpaid(s) ? `<div class="muted${days < 0 ? ' txt-bad' : ''}">${days < 0 ? 'venceu ' : 'vence '}${whenLabel(days)}</div>` : '';
    return `
    <tr class="${unpaid(s) ? '' : 'row-done'}">
      <td><strong>${esc(s.name)}</strong><div class="muted">${esc(s.plan_name)}${s.phone || s.email ? ` · ${esc(s.phone || s.email)}` : ''}</div></td>
      <td class="num">${brl(s.price_cents)}${s.prorata_cents ? `<div class="muted" title="1º pagamento proporcional, pago neste mês">+ ${brl(s.prorata_cents)} proporcional</div>` : ''}</td>
      <td>${String(dueOf(s)).padStart(2, '0')}/${String(m).padStart(2, '0')}${when}</td>
      <td class="num">${s.paid_cents ? `${brl(s.paid_cents)}<div class="muted">${shortDate(s.last_paid_at)} · ${(s.paid_methods || '').split(',').filter(Boolean).map(methodInline).join(' + ')}</div>` : s.prorata_cents ? '' : '—'}${s.prorata_cents ? `<div>${brl(s.prorata_cents)} <span class="muted small">proporcional</span></div><div class="muted">${shortDate(s.prorata_paid_at)} · ${(s.prorata_methods || '').split(',').filter(Boolean).map(methodInline).join(' + ')}</div>` : ''}</td>
      <td>${badge(s.pay_status)}${s.status === 'ativo' && s.cancel_at ? ` <span class="badge b-aguardando" title="Pediu cancelamento${s.retention_answer === 'nao' ? ' e confirmou no WhatsApp' : ''}">Cancela em ${fmtDate(s.cancel_at)}</span>` : ''}</td>
      <td>${unpaid(s) ? `<button class="btn small primary" data-quickpay="${s.id}" data-month="${data.month}">Marcar pago</button>` : ''}</td>
    </tr>`;
  }).join('')
    || `<tr><td colspan="6" class="empty">${q ? 'Nenhum assinante encontrado com essa busca.' : rowFilter ? 'Ninguém nesta lista.' : 'Nenhum assinante ativo neste mês.'}</td></tr>`;
}

export function initDashboard() {
  $('#dash-month').value = thisMonth();
  $('#dash-month').addEventListener('change', loadDashboard);
  $('#dash-search').addEventListener('input', renderRows);
  $('#up-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) { upTab = b.dataset.tab; renderUpcoming(); }
  });
  $('#dash-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) { rowFilter = b.dataset.tab; renderRows(); }
  });
  $('#tab-dashboard').addEventListener('click', (e) => {
    const b = e.target.closest('[data-quickpay]');
    if (b) openPayment({ subscriber_id: b.dataset.quickpay, ref_month: b.dataset.month || data.month });
  });
}
