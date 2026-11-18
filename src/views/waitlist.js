// Aba "Lista de espera": quem se cadastrou em /espera, se a mensagem com o link do grupo saiu no WhatsApp,
// e se a pessoa já virou cliente. Também guarda o link do grupo e mostra o link de cadastro para copiar.
import { api } from '../api.js';
import { $, esc, toast } from '../utils.js';

let rows = [];
const SEEN_KEY = 'cc-waitlist-seen'; // último cadastro já visto, para a bolinha da aba

const fmtDateTime = (iso) => (iso
  ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  : '—');
const isNew = (iso) => Date.now() - new Date(iso).getTime() < 24 * 3600_000;
const signupUrl = () => `${location.origin}/espera`;

function getSeen() {
  try { return localStorage.getItem(SEEN_KEY) || ''; } catch { return ''; }
}
function setSeen(iso) {
  try { if (iso) localStorage.setItem(SEEN_KEY, iso); } catch { /* sem armazenamento: só não guarda */ }
}

function waLink(phone) {
  let n = String(phone || '').replace(/\D/g, '');
  if (n.length === 10 || n.length === 11) n = `55${n}`;
  return n ? `https://wa.me/${n}` : '';
}

function situation(r) {
  if (r.sub_status === 'ativo') return '<span class="badge b-ativo">Já é assinante</span>';
  if (r.sub_status) return `<span class="badge b-aguardando">Tem conta · ${esc(r.sub_status)}</span>`;
  if (r.customer_id) return '<span class="badge b-pendente">Criou conta</span>';
  return '<span class="muted">Esperando</span>';
}

function message(r) {
  if (r.whatsapp_sent_at) return `<span class="badge b-ativo" title="Enviada em ${fmtDateTime(r.whatsapp_sent_at)}">Enviada</span>`;
  if (r.whatsapp_error) return `<span class="badge b-atrasado">Não enviada</span><div class="muted">${esc(r.whatsapp_error)}</div>`;
  return '<span class="muted">—</span>';
}

function render() {
  const week = Date.now() - 7 * 24 * 3600_000;
  $('#wait-kpis').innerHTML = [
    ['Na lista', rows.length],
    ['Últimos 7 dias', rows.filter((r) => new Date(r.created_at).getTime() > week).length],
    ['Mensagem enviada', rows.filter((r) => r.whatsapp_sent_at).length],
    ['Já são assinantes', rows.filter((r) => r.sub_status === 'ativo').length],
  ].map(([label, value]) => `<div class="kpi"><div class="label">${label}</div><div class="value">${value}</div></div>`).join('');

  const q = $('#wait-search').value.toLowerCase();
  const list = rows.filter((r) => !q || [r.name, r.email, r.phone].join(' ').toLowerCase().includes(q));
  $('#wait-rows').innerHTML = list.map((r) => `
    <tr>
      <td><strong>${esc(r.name)}</strong>${isNew(r.created_at) ? ' <span class="badge b-pago">Novo</span>' : ''}</td>
      <td>${esc(r.email)}<div class="muted">${waLink(r.phone) ? `<a href="${waLink(r.phone)}" target="_blank" rel="noopener">${esc(r.phone)}</a>` : esc(r.phone)}</div></td>
      <td>${fmtDateTime(r.created_at)}</td>
      <td>${message(r)}</td>
      <td>${situation(r)}</td>
      <td><div class="wait-actions">
        <button class="btn small" data-resend="${r.id}">${r.whatsapp_sent_at ? 'Reenviar' : 'Enviar'}</button>
        <button class="btn small danger" data-del="${r.id}">Remover</button>
      </div></td>
    </tr>`).join('')
    || `<tr><td colspan="6" class="empty">${rows.length ? 'Ninguém encontrado com essa busca.' : 'Ninguém na lista de espera ainda.'}</td></tr>`;
}

export async function loadWaitlist() {
  const data = await api.waitlist();
  rows = data.rows;
  const f = $('#wait-settings');
  if (document.activeElement !== f.group_url) f.group_url.value = data.group_url;
  $('#wait-signup-url').value = signupUrl();
  $('#wait-open-url').href = signupUrl();
  render();
  setSeen(rows[0]?.created_at);
  $('#wait-dot').classList.add('hidden');
}

/** Fora da aba: acende a bolinha quando entra alguém novo na lista. */
export async function refreshWaitlistDot() {
  const data = await api.waitlist().catch(() => null);
  if (!data) return;
  const latest = data.rows[0]?.created_at || '';
  const seen = getSeen();
  if (!seen) return setSeen(latest); // primeira vez neste navegador: nada é "novo"
  $('#wait-dot').classList.toggle('hidden', !(latest && latest > seen));
}

async function copy(text, done) {
  try { await navigator.clipboard.writeText(text); toast(done); } catch { toast('Não foi possível copiar. Selecione e copie manualmente.'); }
}

export function initWaitlist() {
  $('#wait-search').addEventListener('input', render);
  $('#wait-copy-url').addEventListener('click', () => copy(signupUrl(), 'Link de cadastro copiado'));
  $('#wait-copy-phones').addEventListener('click', () => {
    const phones = rows.map((r) => r.phone).filter(Boolean);
    if (!phones.length) return toast('Ninguém na lista ainda.');
    copy(phones.join('\n'), `${phones.length} número(s) copiado(s)`);
  });

  $('#wait-settings').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const out = await api.saveWaitlistSettings({ group_url: e.target.group_url.value.trim() });
      e.target.group_url.value = out.group_url;
      toast('Link do grupo salvo');
    } catch { /* erro já exibido */ }
  });

  $('#wait-rows').addEventListener('click', async (e) => {
    const resend = e.target.closest('[data-resend]');
    const del = e.target.closest('[data-del]');
    if (resend) {
      resend.disabled = true;
      try {
        await api.waitlistResend(resend.dataset.resend);
        toast('Mensagem enviada no WhatsApp');
      } catch { /* erro já exibido */ }
      loadWaitlist().catch(() => {});
    } else if (del) {
      const r = rows.find((x) => String(x.id) === del.dataset.del);
      if (!confirm(`Remover ${r?.name || 'esta pessoa'} da lista de espera?`)) return;
      try {
        await api.waitlistDelete(del.dataset.del);
        toast('Removido da lista');
      } catch { /* erro já exibido */ }
      loadWaitlist().catch(() => {});
    }
  });
}
