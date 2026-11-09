// Aba "Clientes": todas as contas criadas na área do assinante (/conta),
// com e-mail confirmado ou não e a situação do plano. Atualiza sozinha (ver main.js).
import { api } from '../api.js';
import { $, brl, esc, fmtDate } from '../utils.js';

let customers = [];
const SEEN_KEY = 'cc-customers-seen'; // último cadastro já visto, para a bolinha da aba

const fmtDateTime = (iso) => (iso
  ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  : '—');
const isNew = (iso) => Date.now() - new Date(iso).getTime() < 24 * 3600_000;

function getSeen() {
  try { return localStorage.getItem(SEEN_KEY) || ''; } catch { return ''; }
}
function setSeen(iso) {
  try { if (iso) localStorage.setItem(SEEN_KEY, iso); } catch { /* sem armazenamento: só não guarda */ }
}

/** Situação do cliente em uma palavra (usada no filtro e no selo). */
function situation(c) {
  if (!c.email_verified_at) return 'nao-confirmado';
  if (!c.subscriber_id) return 'sem-plano';
  if (c.status === 'ativo') return 'ativo';
  if (c.status === 'aguardando') return 'aguardando';
  return 'cancelado';
}

const SITUATION = {
  ativo: ['b-ativo', 'Ativo'],
  aguardando: ['b-aguardando', 'Aguardando pagamento'],
  'sem-plano': ['b-pendente', 'Sem plano'],
  'nao-confirmado': ['b-atrasado', 'Não confirmou o e-mail'],
  cancelado: ['b-cancelado', 'Cancelado'],
};

function situationBadge(c) {
  const key = situation(c);
  let [cls, label] = SITUATION[key];
  if (key === 'cancelado' && c.status === 'pausado') [cls, label] = ['b-pausado', 'Pausado'];
  let extra = '';
  if (key === 'ativo' && c.cancel_at) extra = ` <span class="badge b-aguardando">Cancela em ${fmtDate(c.cancel_at)}</span>`;
  return `<span class="badge ${cls}">${label}</span>${extra}`;
}

export async function loadCustomers() {
  customers = await api.customers();
  render();
  setSeen(customers[0]?.created_at);
  $('#cust-dot').classList.add('hidden');
  $('#cust-updated').textContent = `Última atualização: ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
}

/** Fora da aba: acende a bolinha quando entra um cadastro novo. */
export async function refreshCustomersDot() {
  const list = await api.customers().catch(() => null);
  if (!list) return;
  const latest = list[0]?.created_at || '';
  const seen = getSeen();
  if (!seen) return setSeen(latest); // primeira vez neste navegador: nada é "novo"
  $('#cust-dot').classList.toggle('hidden', !(latest && latest > seen));
}

function render() {
  const count = (key) => customers.filter((c) => situation(c) === key).length;
  $('#cust-kpis').innerHTML = [
    ['Contas criadas', customers.length],
    ['Plano ativo', count('ativo')],
    ['Aguardando pagamento', count('aguardando')],
    ['Sem plano', count('sem-plano')],
    ['Não confirmaram o e-mail', count('nao-confirmado')],
  ].map(([label, value]) => `<div class="kpi"><div class="label">${label}</div><div class="value">${value}</div></div>`).join('');

  const q = $('#cust-search').value.toLowerCase();
  const filter = $('#cust-filter').value;
  const list = customers.filter((c) => (!q || [c.name, c.email, c.phone].join(' ').toLowerCase().includes(q))
    && (!filter || situation(c) === filter));

  $('#cust-rows').innerHTML = list.map((c) => `
    <tr>
      <td><strong>${esc(c.name)}</strong>${isNew(c.created_at) ? ' <span class="badge b-pago">Novo</span>' : ''}
        ${c.birth_date ? `<div class="muted">nasc. ${fmtDate(c.birth_date)}</div>` : ''}</td>
      <td>${esc(c.email)}<div class="muted">${esc(c.phone)}</div></td>
      <td>${fmtDateTime(c.created_at)}</td>
      <td>${c.email_verified_at
        ? `<span class="badge b-ativo" title="Confirmado em ${fmtDateTime(c.email_verified_at)}">Confirmado</span>`
        : '<span class="badge b-atrasado">Não confirmado</span>'}</td>
      <td>${c.plan_name ? `${esc(c.plan_name)} <span class="muted">· ${brl(c.price_cents)}</span>` : '<span class="muted">—</span>'}
        ${c.last_paid_at ? `<div class="muted">último pagamento ${fmtDate(c.last_paid_at)}</div>` : ''}</td>
      <td>${situationBadge(c)}</td>
    </tr>`).join('')
    || `<tr><td colspan="6" class="empty">${customers.length ? 'Nenhum cliente encontrado com esse filtro.' : 'Nenhuma conta criada ainda.'}</td></tr>`;
}

export function initCustomers() {
  $('#cust-search').addEventListener('input', render);
  $('#cust-filter').addEventListener('change', render);
}
