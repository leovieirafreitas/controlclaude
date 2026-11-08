import { api } from '../api.js';
import { $, brl, esc, badge, toast, bindDialogForm } from '../utils.js';

let plans = [];

async function loadSettings() {
  const s = await api.settings();
  const f = $('#form-settings');
  for (const [k, v] of Object.entries(s)) if (f[k]) f[k].value = v;
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
      <td>${badge(p.active ? 'ativo' : 'inativo')}</td>
      <td>
        <button class="btn small" data-edit="${p.id}">Editar</button>
        <button class="btn small danger" data-del="${p.id}">Excluir</button>
      </td>
    </tr>`).join('')
    || '<tr><td colspan="6" class="empty">Nenhum plano.</td></tr>';
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
