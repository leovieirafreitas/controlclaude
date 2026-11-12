import { api } from '../api.js';
import { $, brl, esc, fmtDate, badge, autopayBadge, today, toast, bindDialogForm } from '../utils.js';
import { openAdminPix } from './pix.js';

let subscribers = [];
let plans = [];

export async function loadSubscribers() {
  [subscribers, plans] = await Promise.all([api.subscribers(), api.plans()]);
  render();
}

/** E-mail institucional (Google Workspace) do assinante. */
function workspaceLine(s) {
  const w = s.workspace_email;
  if (w && !w.startsWith('(')) return `<div class="ws-line" title="E-mail institucional (Google Workspace)">${esc(w)}</div>`;
  if (w === '(criando)') return '<div class="muted small">Criando e-mail…</div>';
  if (s.workspace_error) return `<div class="ws-line ws-error" title="${esc(s.workspace_error)}">E-mail não criado: ${esc(s.workspace_error.slice(0, 60))}</div>`;
  return '';
}

function render() {
  const q = $('#sub-search').value.toLowerCase();
  const list = subscribers.filter((s) => !q || [s.name, s.email, s.phone].join(' ').toLowerCase().includes(q));

  $('#sub-rows').innerHTML = list.map((s) => `
    <tr>
      <td><strong>${esc(s.name)}</strong>${s.notes ? `<div class="muted">${esc(s.notes)}</div>` : ''}</td>
      <td>${esc(s.email)}<div class="muted">${esc(s.phone)}${s.birth_date ? ` · nasc. ${fmtDate(s.birth_date)}` : ''}</div>${workspaceLine(s)}</td>
      <td>${esc(s.plan_name)} <span class="muted">· ${brl(s.price_cents)}</span>${s.plan_price_cents != null && s.plan_price_cents !== s.price_cents ? `<div class="muted small" title="Valor travado de quando assinou">preço atual do plano: ${brl(s.plan_price_cents)}</div>` : ''}</td>
      <td>${fmtDate(s.start_date)}</td>
      <td>dia ${s.due_day}</td>
      <td>${badge(s.status)}${autopayBadge(s)}${s.status === 'ativo' && s.cancel_at ? ` <span class="badge b-aguardando" title="Pediu cancelamento${s.retention_answer === 'nao' ? ' e confirmou no WhatsApp' : ''}">Cancela em ${fmtDate(s.cancel_at)}</span>` : ''}</td>
      <td>
        ${s.status === 'aguardando' ? `<button class="btn small primary" data-activate="${s.id}">Ativar</button>` : ''}
        ${s.price_cents > 0 ? `<button class="btn small" data-pix="${s.id}" title="Gerar um Pix da mensalidade para mandar ao cliente">Gerar Pix</button>` : ''}
        ${!s.workspace_email || s.workspace_email === '(manual)' ? `<button class="btn small" data-ws="${s.id}" title="Criar o e-mail institucional no Google Workspace">Criar e-mail</button>` : ''}
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
  // valor travado do assinante (cadastro novo: preço do plano escolhido)
  const planPrice = (id) => plans.find((p) => p.id === Number(id))?.price_cents;
  const toReais = (c) => (c == null ? '' : (c / 100).toFixed(2).replace('.', ','));
  f.monthly.value = toReais(sub ? sub.price_cents : planPrice(f.plan_id.value));
  f.plan_id.onchange = () => { f.monthly.value = toReais(planPrice(f.plan_id.value)); };
  $('#dlg-sub').showModal();
}

export function initSubscribers(onChange) {
  $('#sub-search').addEventListener('input', render);
  $('#new-sub').addEventListener('click', () => openSubscriber());

  $('#sub-rows').addEventListener('click', async (e) => {
    const { edit, del, activate, pix, ws } = e.target.dataset;
    if (ws) {
      const s = subscribers.find((x) => x.id === Number(ws));
      if (!confirm(`Criar agora o e-mail institucional de ${s.name} no Google Workspace? Usa uma licença do Google. Os dados vão para o seu WhatsApp.`)) return;
      e.target.disabled = true;
      e.target.textContent = 'Criando…';
      try {
        const r = await api.createWorkspace(s.id);
        toast(`E-mail criado: ${r.email}. Os dados foram para o seu WhatsApp.`);
      } catch { /* toast já mostrado */ }
      return loadSubscribers();
    }
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

  bindDialogForm($('#form-sub'), async ({ id, monthly, ...body }) => {
    const v = String(monthly || '').replace(/[^\d,.]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
    if (v !== '') {
      const cents = Math.round(Number(v) * 100);
      if (!Number.isFinite(cents) || cents < 0) { toast('Valor da mensalidade inválido.'); throw new Error('valor'); }
      body.monthly_cents = cents;
    }
    await api.saveSubscriber(id, body);
    toast('Assinante salvo');
    onChange();
  });
}
