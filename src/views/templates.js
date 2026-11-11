// Editor dos modelos de mensagem (notificações push do painel e WhatsApp para os clientes).
// Cada modelo é um bloco que abre: liga/desliga, texto, variáveis clicáveis, pré-visualização e teste.
import { api } from '../api.js';
import { esc, toast } from '../utils.js';

const CHEVRON = '<svg class="ui-icon tpl-chevron" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';

/** Troca {variavel} pelo exemplo (mesma regra do servidor: linha com {link} vazio some). */
function fill(text, samples) {
  return String(text || '')
    .split('\n')
    .map((line) => line.replace(/\{(\w+)\}/g, (m, name) => (samples[name] !== undefined ? samples[name] : m)).replace(/ {2,}/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Texto do WhatsApp → HTML: *negrito*, _itálico_ e quebras de linha. */
function waHtml(text) {
  return esc(text)
    .replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s.,!?)])/g, '$1<em>$2</em>')
    .replace(/\n/g, '<br>');
}

function previewHtml(t, title, body) {
  const samples = Object.fromEntries(t.vars.map((v) => [v.name, v.sample]));
  if (t.channel === 'push') {
    return `
      <div class="push-preview">
        <img src="/icons/admin-192.png" alt="" width="38" height="38">
        <div>
          <p class="push-preview-title">${esc(fill(title, samples)) || '&nbsp;'}<span>agora</span></p>
          <p class="push-preview-body">${esc(fill(body, samples)).replace(/\n/g, '<br>')}</p>
        </div>
      </div>`;
  }
  return `<div class="wa-preview"><div class="wa-bubble">${waHtml(fill(body, samples))}</div></div>`;
}

function itemHtml(t) {
  const isPush = t.channel === 'push';
  return `
    <details class="tpl" data-key="${esc(t.key)}">
      <summary>
        <span class="tpl-name"><strong>${esc(t.label)}</strong><span class="muted small">${esc(t.hint)}</span></span>
        <span class="tpl-state ${t.on ? 'on' : 'off'}">${t.on ? 'Ligada' : 'Desligada'}</span>
        ${CHEVRON}
      </summary>
      <form class="tpl-form" novalidate>
        <label class="switch"><input type="checkbox" name="on" ${t.on ? 'checked' : ''}><span class="switch-track"></span><span class="switch-text">${isPush ? 'Enviar esta notificação' : 'Enviar esta mensagem'}</span></label>
        <div class="tpl-cols">
          <div class="tpl-edit">
            ${isPush ? `<label>Título<input name="title" maxlength="80" value="${esc(t.title)}"></label>` : ''}
            <label>${isPush ? 'Texto' : 'Mensagem'}<textarea name="body" rows="${isPush ? 3 : 10}" maxlength="2000">${esc(t.body)}</textarea></label>
            <div class="tpl-vars">
              <span class="muted small">Toque para inserir no texto:</span>
              <div class="tpl-chips">${t.vars.map((v) => `<button type="button" class="tpl-chip" data-var="${esc(v.name)}" title="${esc(v.label)} — ex.: ${esc(v.sample)}">${esc(v.label)}</button>`).join('')}</div>
            </div>
            ${isPush ? '' : '<p class="muted small">Dica: *texto* fica em <strong>negrito</strong> no WhatsApp. A linha com o link some sozinha se o site estiver sem endereço.</p>'}
          </div>
          <div class="tpl-side">
            <p class="muted small">Como o ${isPush ? 'aviso aparece' : 'cliente recebe'} (com dados de exemplo)</p>
            <div class="tpl-preview">${previewHtml(t, t.title, t.body)}</div>
          </div>
        </div>
        <div class="tpl-actions">
          <button class="btn primary" type="submit">Salvar</button>
          <button class="btn" type="button" data-act="test">${isPush ? 'Enviar teste para este aparelho' : 'Enviar teste para o meu WhatsApp'}</button>
          <button class="btn" type="button" data-act="reset">Restaurar texto padrão</button>
        </div>
      </form>
    </details>`;
}

function render(container, list) {
  const groups = [];
  for (const t of list) {
    let g = groups.find((x) => x.name === t.group);
    if (!g) groups.push(g = { name: t.group, items: [] });
    g.items.push(t);
  }
  container.innerHTML = groups.map((g) => `
    <div class="tpl-group">
      <p class="side-label tpl-group-name">${esc(g.name)}</p>
      ${g.items.map(itemHtml).join('')}
    </div>`).join('');
}

/** Carrega e desenha os modelos de um canal ('push' | 'whatsapp') dentro do container. */
export async function loadTemplates(container, channel) {
  const open = [...container.querySelectorAll('details.tpl[open]')].map((d) => d.dataset.key);
  // não redesenha por cima de um texto alterado e ainda não salvo
  if (container.querySelector('.tpl-form[data-dirty="1"]')) return;
  try {
    const { templates } = await api.templates(channel);
    container._tpl = Object.fromEntries(templates.map((t) => [t.key, t]));
    render(container, templates);
    for (const key of open) container.querySelector(`details.tpl[data-key="${key}"]`)?.setAttribute('open', '');
  } catch {
    container.innerHTML = '<p class="muted">Não foi possível carregar os modelos.</p>';
  }
}

function refreshItem(container, saved) {
  container._tpl[saved.key] = saved;
  const el = container.querySelector(`details.tpl[data-key="${saved.key}"]`);
  const tmp = document.createElement('div');
  tmp.innerHTML = itemHtml(saved);
  const fresh = tmp.firstElementChild;
  fresh.setAttribute('open', '');
  el.replaceWith(fresh);
}

/** Liga os eventos do editor (uma vez por container). */
export function initTemplates(container) {
  const tplOf = (el) => container._tpl?.[el.closest('details.tpl')?.dataset.key];
  const draft = (form) => ({ on: form.elements.on.checked, title: form.elements.title?.value, body: form.elements.body.value });

  container.addEventListener('input', (e) => {
    const form = e.target.closest('.tpl-form');
    if (!form) return;
    const t = tplOf(form);
    if (!t) return;
    form.dataset.dirty = '1';
    const d = draft(form);
    form.querySelector('.tpl-preview').innerHTML = previewHtml(t, d.title, d.body);
  });

  container.addEventListener('change', (e) => {
    if (e.target.name !== 'on') return;
    const form = e.target.closest('.tpl-form');
    if (form) form.dataset.dirty = '1'; // vale depois de Salvar; a etiqueta do resumo mostra o que está salvo
  });

  container.addEventListener('click', async (e) => {
    const chip = e.target.closest('.tpl-chip');
    if (chip) {
      const form = chip.closest('.tpl-form');
      // insere no campo que estava em uso (título ou texto); por padrão, no texto
      const field = form._lastField && form.contains(form._lastField) ? form._lastField : form.elements.body;
      const token = `{${chip.dataset.var}}`;
      const start = field.selectionStart ?? field.value.length;
      const end = field.selectionEnd ?? field.value.length;
      field.value = field.value.slice(0, start) + token + field.value.slice(end);
      field.focus();
      field.setSelectionRange(start + token.length, start + token.length);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const form = btn.closest('.tpl-form');
    const t = tplOf(form);
    if (!t) return;
    btn.disabled = true;
    try {
      if (btn.dataset.act === 'test') {
        const d = draft(form);
        await api.testTemplate(t.key, { title: d.title, body: d.body });
        toast(t.channel === 'push' ? 'Notificação de teste enviada.' : 'Teste enviado para o seu WhatsApp.');
      } else if (btn.dataset.act === 'reset') {
        if (!confirm('Voltar esta mensagem para o texto padrão? O que você escreveu será apagado.')) return;
        refreshItem(container, await api.resetTemplate(t.key));
        toast('Texto padrão restaurado.');
      }
    } catch { /* toast já mostrado */ } finally { btn.disabled = false; }
  });

  container.addEventListener('focusin', (e) => {
    const form = e.target.closest('.tpl-form');
    if (form && (e.target.name === 'body' || e.target.name === 'title')) form._lastField = e.target;
  });

  container.addEventListener('submit', async (e) => {
    const form = e.target.closest('.tpl-form');
    if (!form) return;
    e.preventDefault();
    const t = tplOf(form);
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      refreshItem(container, await api.saveTemplate(t.key, draft(form)));
      toast('Modelo salvo.');
    } catch { /* toast já mostrado */ } finally { btn.disabled = false; }
  });
}
