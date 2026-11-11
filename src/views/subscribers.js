import { api } from '../api.js';
import { $, brl, esc, fmtDate, badge, autopayBadge, today, toast, bindDialogForm } from '../utils.js';
import { openAdminPix } from './pix.js';

let subscribers = [];
let plans = [];

export async function loadSubscribers() {
  [subscribers, plans] = await Promise.all([api.subscribers(), api.plans()]);
  render();
}

function render() {
  const q = $('#sub-search').value.toLowerCase();
  const list = subscribers.filter((s) => !q || [s.name, s.email, s.phone].join(' ').toLowerCase().includes(q));

  $('#sub-rows').innerHTML = list.map((s) => `
    <tr>
      <td><strong>${esc(s.name)}</strong>${s.notes ? `<div class="muted">${esc(s.notes)}</div>` : ''}</td>
      <td>${esc(s.email)}<div class="muted">${esc(s.phone)}${s.birth_date ? ` · nasc. ${fmtDate(s.birth_date)}` : ''}</div></td>
      <td>${esc(s.plan_name)} <span class="muted">· ${brl(s.price_cents)}</span></td>
      <td>${fmtDate(s.start_date)}</td>
      <td>dia ${s.due_day}</td>
      <td>${badge(s.status)}${autopayBadge(s)}${s.status === 'ativo' && s.cancel_at ? ` <span class="badge b-aguardando" title="Pediu cancelamento${s.retention_answer === 'nao' ? ' e confirmou no WhatsApp' : ''}">Cancela em ${fmtDate(s.cancel_at)}</span>` : ''}</td>
      <td>
        ${s.status === 'aguardando' ? `<button class="btn small primary" data-activate="${s.id}">Ativar</button>` : ''}
        ${s.price_cents > 0 ? `<button class="btn small" data-pix="${s.id}" title="Gerar um Pix da mensalidade para mandar ao cliente">Gerar Pix</button>` : ''}
        <button class="btn small" data-edit="${s.id}">Editar</button>
        <button class="btn small danger" data-del="${s.id}">Excluir</button>
      </td>
    </tr>`).join('')
    || '<tr><td colspan="7" class="empty">Nenhum assinante cadastrado.</td></tr>';
}

async function openSubscriber(sub) {
  if (!plans.length) plans = await api.plans();
  const f = $('#form-sub');
  f.reset();
  $('#sub-title').textContent = sub ? 'Editar assinante' : 'Novo assinante';
  f.plan_id.innerHTML = plans
    .filter((p) => p.active || p.id === sub?.plan_id)
    .map((p) => `<option value="${p.id}" ${p.id === sub?.plan_id ? 'selected' : ''}>${esc(p.name)} — ${brl(p.price_cents)}</option>`)
    .join('');
  f.id.value = sub?.id ?? '';
  f.name.value = sub?.name ?? '';
  f.email.value = sub?.email ?? '';
  f.phone.value = sub?.phone ?? '';
  f.birth_date.value = sub?.birth_date ?? '';
  f.start_date.value = sub?.start_date ?? today();
  f.due_day.value = sub?.due_day ?? 10;
  f.status.value = sub?.status ?? 'ativo';
  f.notes.value = sub?.notes ?? '';
  $('#dlg-sub').showModal();
}

export function initSubscribers(onChange) {
  $('#sub-search').addEventListener('input', render);
  $('#new-sub').addEventListener('click', () => openSubscriber());

  $('#sub-rows').addEventListener('click', async (e) => {
    const { edit, del, activate, pix } = e.target.dataset;
    if (pix) return openAdminPix(subscribers.find((x) => x.id === Number(pix)), onChange);
    if (activate) {
      const s = subscribers.find((x) => x.id === Number(activate));
      await api.saveSubscriber(s.id, { ...s, status: 'ativo' });
      toast(`${s.name} ativado`);
      onChange();
    }
    if (edit) openSubscriber(subscribers.find((s) => s.id === Number(edit)));
    if (del && confirm('Excluir este assinante e todo o histórico de pagamentos dele?')) {
      await api.deleteSubscriber(del);
      toast('Assinante excluído');
      loadSubscribers();
    }
  });

  bindDialogForm($('#form-sub'), async ({ id, ...body }) => {
    await api.saveSubscriber(id, body);
    toast('Assinante salvo');
    onChange();
  });
}
