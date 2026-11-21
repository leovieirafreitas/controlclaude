// Quadro (kanban): cada pessoa em uma coluna conforme a situação de hoje. Os cartões mudam de coluna sozinhos
// (pagou, venceu, foi desativado...). Filtro por plano e busca por nome.
import { api } from '../api.js';
import { $, brl, esc, fmtDate, autopayBadge, tabsHtml, whenLabel } from '../utils.js';
import { openPayment } from './payments.js';
import { openAdminPix } from './pix.js';
import { waLink } from './waitlist.js';

const COLUMNS = [
  { key: 'espera', title: 'Lista de espera', hint: 'Deixou o contato, ainda sem conta', tone: '' },
  { key: 'processo', title: 'Em processo', hint: 'Criou conta ou escolheu o plano, falta pagar', tone: 'warn' },
  { key: 'emdia', title: 'Em dia', hint: 'Pago. Próximo vencimento a mais de 7 dias', tone: 'ok', sum: 'por mês' },
  { key: 'vence', title: 'Vence em 7 dias', hint: 'Falta pagar a próxima mensalidade', tone: 'info', sum: 'a receber' },
  { key: 'atraso', title: 'Vence hoje ou atrasado', hint: 'Se não pagar, é desativado no dia seguinte', tone: 'bad', sum: 'a receber' },
  { key: 'desativado', title: 'Desativados', hint: 'Não pagou: tirar do Claude', tone: 'bad', sum: 'em aberto' },
  { key: 'cancelado', title: 'Cancelados', hint: 'Não é mais assinante', tone: '' },
];

const ICON_WA = '<svg class="ui-icon" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-12.3 7.4L3 21l2.1-5.6A8.4 8.4 0 1 1 21 11.5Z"/></svg>';

let data = null;
let planTab = '';   // '' = todos os planos
const plain = (v) => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const shortDate = (iso) => fmtDate(String(iso || '').slice(0, 10)).slice(0, 5); // dd/mm
const owed = (c) => Math.max((c.amount_cents || 0) - (c.paid_cents || 0), 0);

export async function loadBoard() {
  data = await api.board();
  render();
}

/** Linha de situação do cartão, conforme a coluna. */
function statusLine(c) {
  switch (c.col) {
    case 'espera': return `<span class="muted">Na lista desde ${shortDate(c.since)}</span>`;
    case 'processo': return c.kind === 'conta'
      ? `<span class="muted">Criou conta em ${shortDate(c.since)} · ainda sem plano</span>`
      : `<span class="k-warn">Escolheu o plano em ${shortDate(c.since)} · falta pagar</span>`;
    case 'emdia': return `<span class="k-ok">Próximo vencimento ${shortDate(c.due)}</span> <span class="muted">· ${whenLabel(c.days)}</span>`;
    case 'vence': return `<span class="k-info">Vence ${shortDate(c.due)} · ${whenLabel(c.days)}</span>`;
    case 'atraso': return `<span class="k-bad">${c.days === 0 ? 'Vence hoje' : `Venceu ${shortDate(c.due)} · ${whenLabel(c.days)}`}</span>`;
    case 'desativado': return `<span class="k-bad">Venceu ${shortDate(c.due)} · ${whenLabel(c.days)}</span>`;
    default: return `<span class="muted">${c.last_paid_at ? `Último pagamento ${fmtDate(c.last_paid_at)}` : 'Nunca pagou'}</span>`;
  }
}

function cardHtml(c, planIndex) {
  const wa = waLink(c.phone);
  const canPay = c.kind === 'assinante' && ['vence', 'atraso', 'desativado'].includes(c.col);
  const canPix = c.kind === 'assinante' && c.col !== 'cancelado' && c.col !== 'emdia' && c.price_cents > 0;
  const amount = c.kind !== 'assinante' ? '' : ['vence', 'atraso', 'desativado'].includes(c.col) ? brl(owed(c)) : brl(c.price_cents);
  return `
    <article class="k-card">
      <div class="k-top">
        <strong title="${esc(c.name)}">${esc(c.name)}</strong>
        ${amount ? `<span class="k-amount">${amount}</span>` : ''}
      </div>
      ${c.plan_name ? `<div class="k-plan p${planIndex.get(c.plan_id) % 4}"><i></i>${esc(c.plan_name)}${c.paid_cents ? ` <span class="muted">· já pagou ${brl(c.paid_cents)}</span>` : ''}</div>` : ''}
      <div class="k-status">${statusLine(c)}</div>
      ${c.kind === 'assinante' && (c.autopay_status || c.cancel_at) ? `<div class="k-tags">${autopayBadge(c).trim()}${c.cancel_at ? `<span class="badge b-aguardando">Cancela em ${fmtDate(c.cancel_at)}</span>` : ''}</div>` : ''}
      <div class="k-foot">
        ${wa ? `<a class="k-wa" href="${wa}" target="_blank" rel="noopener" title="Abrir conversa no WhatsApp">${ICON_WA}<span>${esc(c.phone)}</span></a>` : `<span class="muted k-wa">${esc(c.phone || c.email || '')}</span>`}
        <span class="k-actions">
          ${canPix ? `<button class="btn small" data-kpix="${c.id}" title="Gerar um Pix para mandar ao cliente">Pix</button>` : ''}
          ${canPay ? `<button class="btn small primary" data-kpay="${c.id}" data-month="${c.month}">Marcar pago</button>` : ''}
        </span>
      </div>
    </article>`;
}

function render() {
  const planIndex = new Map(data.plans.map((p, i) => [p.id, i]));
  const q = plain($('#board-search').value.trim());
  const match = (c) => !q || plain(`${c.name} ${c.phone} ${c.email} ${c.plan_name || ''}`).includes(q);
  const searched = data.cards.filter(match);

  // abas por plano (quem ainda não tem plano só aparece em "Todos")
  $('#board-plans').innerHTML = tabsHtml([
    { key: '', label: 'Todos os planos', count: searched.length },
    ...data.plans.map((p) => ({ key: String(p.id), label: esc(p.name), count: searched.filter((c) => c.plan_id === p.id).length })),
  ], planTab);

  const cards = searched.filter((c) => !planTab || String(c.plan_id) === planTab);
  // a atualização automática não pode devolver as colunas para o topo
  const scroll = new Map([...document.querySelectorAll('#board .k-list')].map((el) => [el.dataset.col, el.scrollTop]));
  $('#board').innerHTML = COLUMNS.map((col) => {
    const list = cards.filter((c) => c.col === col.key).sort((a, b) =>
      (a.days ?? 0) - (b.days ?? 0) || String(b.since || '').localeCompare(String(a.since || '')) || a.name.localeCompare(b.name, 'pt-BR'));
    if (col.key === 'desativado') list.reverse(); // quem acabou de ser desativado primeiro
    const total = col.sum ? list.reduce((s, c) => s + (col.key === 'emdia' ? c.price_cents || 0 : owed(c)), 0) : 0;
    return `
      <section class="k-col ${col.tone ? `tone-${col.tone}` : ''}" aria-label="${col.title}">
        <header>
          <div class="k-title"><i></i><h3>${col.title}</h3><span class="k-count">${list.length}</span></div>
          <p class="muted">${col.sum && list.length ? `${brl(total)} ${col.sum}` : col.hint}</p>
        </header>
        <div class="k-list" data-col="${col.key}">
          ${list.map((c) => cardHtml(c, planIndex)).join('') || '<div class="k-empty">Ninguém aqui</div>'}
        </div>
      </section>`;
  }).join('');
  for (const el of document.querySelectorAll('#board .k-list')) el.scrollTop = scroll.get(el.dataset.col) || 0;
}

export function initBoard(onChange) {
  $('#board-search').addEventListener('input', render);
  $('#board-plans').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) { planTab = b.dataset.tab; render(); }
  });
  $('#board').addEventListener('click', (e) => {
    const pay = e.target.closest('[data-kpay]');
    if (pay) return openPayment({ subscriber_id: pay.dataset.kpay, ref_month: pay.dataset.month });
    const pix = e.target.closest('[data-kpix]');
    if (pix) openAdminPix(data.cards.find((c) => c.kind === 'assinante' && String(c.id) === pix.dataset.kpix), onChange);
  });
}
