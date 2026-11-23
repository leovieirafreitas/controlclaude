import { api } from '../api.js';
import { $, brl, esc, badge, toast, bindDialogForm } from '../utils.js';

let plans = [];

async function loadSettings() {
  const s = await api.settings();
  const f = $('#form-settings');
  for (const [k, v] of Object.entries(s)) if (f[k]) f[k].value = v;
  // vencimento fixo (pro rata): sem nada salvo, vale ligado no dia 30
  if (!s.prorata_on) f.prorata_on.value = 'on';
  if (!s.prorata_day) f.prorata_day.value = 30;
  // janela de vendas: sem nada salvo, vale ligada do dia 1 ao dia 15
  if (!s.sales_window_on) f.sales_window_on.value = 'on';
  if (!s.sales_open_day) f.sales_open_day.value = 1;
  if (!s.sales_close_day) f.sales_close_day.value = 15;
}

function licenses(p) {
  if (p.max_licenses == null) return `${p.licenses_used} <span class="muted">/ sem limite</span>`;
  const full = p.licenses_used >= p.max_licenses;
  return `${p.licenses_used} / ${p.max_licenses}${full ? ' <span class="badge b-cancelado">Esgotado</span>' : ''}`;
}

export async function loadPlans() {
  loadSettings().catch(() => {});
  plans = await api.plans();
  $('#plan-rows').innerHTML = plans.map((p) => `
    <tr>
      <td><strong>${esc(p.name)}</strong>${p.featured ? ' <span class="badge b-aguardando">Recomendado</span>' : ''}</td>
      <td class="num">${brl(p.price_cents)}</td>
      <td class="muted">${esc(p.description)}</td>
      <td>${p.active_subscribers}</td>
      <td>${licenses(p)}</td>
      <td>${badge(p.active ? 'ativo' : 'inativo')}</td>
      <td>
        <button class="btn small" data-edit="${p.id}">Editar</button>
        <button class="btn small danger" data-del="${p.id}">Excluir</button>
      </td>
    </tr>`).join('')
    || '<tr><td colspan="7" class="empty">Nenhum plano.</td></tr>';
}

function openPlan(plan) {
  const f = $('#form-plan');
  f.reset();
  $('#plan-title').textContent = plan ? 'Editar plano' : 'Novo plano';
  f.id.value = plan?.id ?? '';
  f.name.value = plan?.name ?? '';
  f.price.value = plan ? (plan.price_cents / 100).toFixed(2) : '';
  f.description.value = plan?.description ?? '';
  f.active.value = !plan || plan.active ? '1' : '0';
  f.features.value = plan?.features ?? '';
  f.featured.checked = Boolean(plan?.featured);
  f.max_licenses.value = plan?.max_licenses ?? '';
  f.max_seats.value = plan?.max_seats ?? 1;
  $('#dlg-plan').showModal();
}

export function initPlans() {
  $('#new-plan').addEventListener('click', () => openPlan());

  $('#plan-rows').addEventListener('click', async (e) => {
    const { edit, del } = e.target.dataset;
    if (edit) openPlan(plans.find((p) => p.id === Number(edit)));
    if (del && confirm('Excluir este plano?')) {
      await api.deletePlan(del);
      toast('Plano excluído');
      loadPlans();
    }
  });

  $('#form-settings').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    if (Number(f.sales_open_day.value || 1) > Number(f.sales_close_day.value || 15)) {
      return toast('O dia de abertura das inscrições precisa ser antes (ou igual) ao dia de fechamento.');
    }
    try {
      await api.saveSettings(Object.fromEntries(new FormData(e.target)));
      toast('Página de vendas atualizada');
    } catch { /* erro já exibido */ }
  });

  bindDialogForm($('#form-plan'), async ({ id, ...body }) => {
    await api.savePlan(id, { ...body, active: body.active === '1', featured: body.featured === '1' });
    toast('Plano salvo');
    loadPlans();
  });
}
