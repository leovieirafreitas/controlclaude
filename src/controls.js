// Controles com o visual do site no lugar dos nativos do navegador:
//   <select>             → lista suspensa própria
//   <input type="month"> → seletor de mês
//   <input type="date">  → calendário
// O elemento original continua no formulário (escondido): valor, "required", eventos
// "change"/"input" e atribuições como `campo.value = ...` funcionam como antes.

const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const MON_SHORT = ['jan.', 'fev.', 'mar.', 'abr.', 'mai.', 'jun.', 'jul.', 'ago.', 'set.', 'out.', 'nov.', 'dez.'];
const WEEK = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];

const pad = (n) => String(n).padStart(2, '0');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const now = () => {
  const d = new Date();
  return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const ICON = {
  chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  left: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg>',
  right: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>',
};

// ------------------------------------------------------------------ popover (um aberto por vez)

let current = null; // { pop, trigger, close }

function closeCurrent() {
  current?.close();
}

document.addEventListener('mousedown', (e) => {
  if (current && !current.pop.contains(e.target) && !current.trigger.contains(e.target)) closeCurrent();
}, true);
window.addEventListener('resize', closeCurrent);
document.addEventListener('scroll', (e) => {
  if (current && !current.pop.contains(e.target)) closeCurrent();
}, true);

function openPopover(trigger, className, build) {
  closeCurrent();
  const pop = document.createElement('div');
  pop.className = `cc-pop ${className}`;
  // dentro de um <dialog> aberto, o popover precisa ficar no mesmo "top layer"
  (trigger.closest('dialog') || document.body).appendChild(pop);
  const close = () => {
    pop.remove();
    trigger.setAttribute('aria-expanded', 'false');
    trigger.classList.remove('open');
    if (current?.pop === pop) current = null;
  };
  current = { pop, trigger, close };
  trigger.setAttribute('aria-expanded', 'true');
  trigger.classList.add('open');
  build(pop);
  position(pop, trigger);
  return current;
}

function position(pop, trigger) {
  const r = trigger.getBoundingClientRect();
  pop.style.minWidth = `${r.width}px`;
  const ph = pop.offsetHeight;
  const pw = pop.offsetWidth;
  let top = r.bottom + 6;
  if (top + ph > innerHeight - 8 && r.top - ph - 6 > 8) top = r.top - ph - 6;
  const left = Math.max(8, Math.min(r.left, innerWidth - pw - 8));
  pop.style.top = `${top}px`;
  pop.style.left = `${left}px`;
}

/** Faz o campo original "avisar" quando o código muda o valor (campo.value = ...). */
function watchValue(el, proto, props, refresh) {
  for (const prop of props) {
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    Object.defineProperty(el, prop, {
      configurable: true,
      get() { return desc.get.call(el); },
      set(v) { desc.set.call(el, v); refresh(); },
    });
  }
  el.form?.addEventListener('reset', () => setTimeout(refresh));
}

function setNative(el, proto, value) {
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function wrapField(el, kind) {
  const wrap = document.createElement('span');
  wrap.className = `cc-field cc-${kind}${el.closest('.filters') ? ' cc-inline' : ''}`;
  el.parentNode.insertBefore(wrap, el);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cc-trigger';
  btn.setAttribute('aria-expanded', 'false');
  if (el.id) btn.dataset.for = el.id;
  wrap.append(btn, el); // o botão vem antes: clicar no <label> abre o controle
  el.classList.add('cc-native');
  el.tabIndex = -1;
  el.dataset.enhanced = '1';
  return { wrap, btn };
}

// ------------------------------------------------------------------ <select>

function enhanceSelect(sel) {
  const { btn } = wrapField(sel, 'select');
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.innerHTML = `<span class="cc-labels"></span>${ICON.chevron}`;
  const labels = btn.querySelector('.cc-labels');
  let active = -1;

  const refresh = () => {
    const opts = [...sel.options];
    // todos os textos empilhados: a largura acompanha a opção mais longa
    labels.innerHTML = opts.length
      ? opts.map((o, i) => `<span class="${i === sel.selectedIndex ? 'on' : ''}">${esc(o.textContent.trim())}</span>`).join('')
      : '<span class="on cc-ph">—</span>';
    btn.disabled = sel.disabled;
  };

  const choose = (i) => {
    if (i < 0) return;
    const changed = i !== sel.selectedIndex;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex').set.call(sel, i);
    refresh();
    if (changed) {
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    closeCurrent();
    btn.focus();
  };

  const paintActive = () => {
    current?.pop.querySelectorAll('.cc-opt').forEach((o, i) => o.classList.toggle('active', i === active));
    current?.pop.querySelector('.cc-opt.active')?.scrollIntoView({ block: 'nearest' });
  };

  const open = () => {
    if (sel.disabled) return;
    active = sel.selectedIndex;
    openPopover(btn, 'cc-list', (pop) => {
      pop.setAttribute('role', 'listbox');
      pop.innerHTML = [...sel.options].map((o, i) => `
        <div class="cc-opt${i === sel.selectedIndex ? ' selected' : ''}${o.disabled ? ' disabled' : ''}" role="option" data-i="${i}" aria-selected="${i === sel.selectedIndex}">
          <span>${esc(o.textContent.trim())}</span>${i === sel.selectedIndex ? ICON.check : ''}
        </div>`).join('');
      pop.addEventListener('mousedown', (e) => e.preventDefault()); // não tira o foco do botão
      pop.addEventListener('click', (e) => {
        const opt = e.target.closest('.cc-opt:not(.disabled)');
        if (opt) choose(Number(opt.dataset.i));
      });
      pop.addEventListener('mousemove', (e) => {
        const opt = e.target.closest('.cc-opt');
        if (opt && Number(opt.dataset.i) !== active) { active = Number(opt.dataset.i); paintActive(); }
      });
    });
    paintActive();
  };

  const isOpen = () => current?.trigger === btn;

  btn.addEventListener('click', () => (isOpen() ? closeCurrent() : open()));
  btn.addEventListener('keydown', (e) => {
    const n = sel.options.length;
    if (!isOpen()) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); open(); }
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeCurrent(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(n - 1, active + 1); paintActive(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); paintActive(); }
    else if (e.key === 'Home') { e.preventDefault(); active = 0; paintActive(); }
    else if (e.key === 'End') { e.preventDefault(); active = n - 1; paintActive(); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(active); }
    else if (e.key === 'Tab') closeCurrent();
    else if (e.key.length === 1) {
      const k = e.key.toLowerCase();
      const opts = [...sel.options];
      const start = (active + 1) % n;
      const hit = [...opts.slice(start), ...opts.slice(0, start)].find((o) => o.textContent.trim().toLowerCase().startsWith(k));
      if (hit) { active = opts.indexOf(hit); paintActive(); }
    }
  });

  watchValue(sel, HTMLSelectElement.prototype, ['value', 'selectedIndex'], refresh);
  new MutationObserver(refresh).observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['selected', 'disabled', 'label'] });
  refresh();
}

// ------------------------------------------------------------------ <input type="month">

function enhanceMonth(input) {
  const { btn } = wrapField(input, 'month');
  btn.innerHTML = `<span class="cc-value"></span>${ICON.calendar}`;
  const text = btn.querySelector('.cc-value');
  const proto = HTMLInputElement.prototype;

  const parse = () => {
    const m = /^(\d{4})-(\d{2})$/.exec(input.value || '');
    return m ? { y: Number(m[1]), m: Number(m[2]) } : null;
  };
  const refresh = () => {
    const v = parse();
    text.textContent = v ? `${MONTHS[v.m - 1]} de ${v.y}` : (input.placeholder || 'Selecione o mês');
    text.classList.toggle('cc-ph', !v);
    btn.disabled = input.disabled;
  };
  const set = (y, m) => { setNative(input, proto, y ? `${y}-${pad(m)}` : ''); refresh(); closeCurrent(); btn.focus(); };

  const open = () => {
    const sel = parse();
    const t = now();
    let year = sel?.y ?? t.y;
    openPopover(btn, 'cc-cal', (pop) => {
      const draw = () => {
        pop.innerHTML = `
          <div class="cc-head">
            <button type="button" class="cc-nav" data-act="prev" aria-label="Ano anterior">${ICON.left}</button>
            <span class="cc-title">${year}</span>
            <button type="button" class="cc-nav" data-act="next" aria-label="Próximo ano">${ICON.right}</button>
          </div>
          <div class="cc-grid cc-grid-4">
            ${MON_SHORT.map((name, i) => {
              const m = i + 1;
              const cls = [sel && sel.y === year && sel.m === m ? 'selected' : '', t.y === year && t.m === m ? 'today' : ''].join(' ');
              return `<button type="button" class="cc-cell ${cls}" data-m="${m}">${name}</button>`;
            }).join('')}
          </div>
          <div class="cc-foot">
            <button type="button" class="cc-link" data-act="clear">Limpar</button>
            <button type="button" class="cc-link" data-act="today">Este mês</button>
          </div>`;
      };
      draw();
      pop.addEventListener('mousedown', (e) => e.preventDefault());
      pop.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.m) return set(year, Number(b.dataset.m));
        if (b.dataset.act === 'prev') { year--; draw(); }
        if (b.dataset.act === 'next') { year++; draw(); }
        if (b.dataset.act === 'clear') set(null);
        if (b.dataset.act === 'today') set(t.y, t.m);
      });
    });
  };

  btn.addEventListener('click', () => (current?.trigger === btn ? closeCurrent() : open()));
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && current?.trigger === btn) { e.preventDefault(); e.stopPropagation(); closeCurrent(); }
    if (e.key === 'ArrowDown' && current?.trigger !== btn) { e.preventDefault(); open(); }
  });
  watchValue(input, proto, ['value'], refresh);
  refresh();
}

// ------------------------------------------------------------------ <input type="date">

function enhanceDate(input) {
  const { btn } = wrapField(input, 'date');
  btn.innerHTML = `<span class="cc-value"></span>${ICON.calendar}`;
  const text = btn.querySelector('.cc-value');
  const proto = HTMLInputElement.prototype;

  const parse = () => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.value || '');
    return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
  };
  const refresh = () => {
    const v = parse();
    text.textContent = v ? `${pad(v.d)}/${pad(v.m)}/${v.y}` : 'dd/mm/aaaa';
    text.classList.toggle('cc-ph', !v);
    btn.disabled = input.disabled;
  };
  const set = (y, m, d) => { setNative(input, proto, y ? `${y}-${pad(m)}-${pad(d)}` : ''); refresh(); closeCurrent(); btn.focus(); };

  const open = () => {
    const sel = parse();
    const t = now();
    // data de nascimento abre direto na escolha do ano
    const isBirth = /birth|nasc/i.test(input.name || input.id || '');
    let y = sel?.y ?? (isBirth ? t.y - 30 : t.y);
    let m = sel?.m ?? t.m;
    let view = sel || !isBirth ? 'days' : 'years';

    openPopover(btn, 'cc-cal', (pop) => {
      const head = (title, prevLabel, nextLabel, titleAct) => `
        <div class="cc-head">
          <button type="button" class="cc-nav" data-act="prev" aria-label="${prevLabel}">${ICON.left}</button>
          <button type="button" class="cc-title cc-title-btn" data-act="${titleAct}">${title}${titleAct ? ICON.chevron : ''}</button>
          <button type="button" class="cc-nav" data-act="next" aria-label="${nextLabel}">${ICON.right}</button>
        </div>`;

      const draw = () => {
        let body = '';
        if (view === 'days') {
          const first = new Date(y, m - 1, 1).getDay();
          const days = new Date(y, m, 0).getDate();
          const cells = [];
          for (let i = 0; i < first; i++) cells.push('<span class="cc-cell cc-empty"></span>');
          for (let d = 1; d <= days; d++) {
            const cls = [sel && sel.y === y && sel.m === m && sel.d === d ? 'selected' : '', t.y === y && t.m === m && t.d === d ? 'today' : ''].join(' ');
            cells.push(`<button type="button" class="cc-cell cc-day ${cls}" data-d="${d}">${d}</button>`);
          }
          body = `${head(`${cap(MONTHS[m - 1])} ${y}`, 'Mês anterior', 'Próximo mês', 'months')}
            <div class="cc-grid cc-grid-7 cc-week">${WEEK.map((w) => `<span>${w}</span>`).join('')}</div>
            <div class="cc-grid cc-grid-7">${cells.join('')}</div>`;
        } else if (view === 'months') {
          body = `${head(String(y), 'Ano anterior', 'Próximo ano', 'years')}
            <div class="cc-grid cc-grid-4">${MON_SHORT.map((name, i) => {
              const cls = [sel && sel.y === y && sel.m === i + 1 ? 'selected' : '', t.y === y && t.m === i + 1 ? 'today' : ''].join(' ');
              return `<button type="button" class="cc-cell ${cls}" data-m="${i + 1}">${name}</button>`;
            }).join('')}</div>`;
        } else {
          const start = Math.floor(y / 12) * 12;
          body = `${head(`${start} – ${start + 11}`, 'Anos anteriores', 'Próximos anos', '')}
            <div class="cc-grid cc-grid-4">${Array.from({ length: 12 }, (_, i) => start + i).map((yy) => {
              const cls = [sel && sel.y === yy ? 'selected' : '', t.y === yy ? 'today' : ''].join(' ');
              return `<button type="button" class="cc-cell ${cls}" data-y="${yy}">${yy}</button>`;
            }).join('')}</div>`;
        }
        pop.innerHTML = `${body}
          <div class="cc-foot">
            <button type="button" class="cc-link" data-act="clear">Limpar</button>
            ${isBirth ? '' : '<button type="button" class="cc-link" data-act="today">Hoje</button>'}
          </div>`;
      };
      draw();

      pop.addEventListener('mousedown', (e) => e.preventDefault());
      pop.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.d) return set(y, m, Number(b.dataset.d));
        if (b.dataset.m) { m = Number(b.dataset.m); view = 'days'; return draw(); }
        if (b.dataset.y) { y = Number(b.dataset.y); view = 'months'; return draw(); }
        const act = b.dataset.act;
        if (act === 'prev' || act === 'next') {
          const dir = act === 'prev' ? -1 : 1;
          if (view === 'days') { m += dir; if (m < 1) { m = 12; y--; } if (m > 12) { m = 1; y++; } }
          else if (view === 'months') y += dir;
          else y += dir * 12;
          draw();
        }
        if (act === 'months') { view = 'months'; draw(); }
        if (act === 'years') { view = 'years'; draw(); }
        if (act === 'clear') set(null);
        if (act === 'today') set(t.y, t.m, t.d);
        position(pop, btn);
      });
    });
  };

  btn.addEventListener('click', () => (current?.trigger === btn ? closeCurrent() : open()));
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && current?.trigger === btn) { e.preventDefault(); e.stopPropagation(); closeCurrent(); }
    if (e.key === 'ArrowDown' && current?.trigger !== btn) { e.preventDefault(); open(); }
  });
  watchValue(input, proto, ['value'], refresh);
  refresh();
}

// ------------------------------------------------------------------ aplicar em todos

export function enhanceControls(root = document) {
  root.querySelectorAll('select:not([data-enhanced]):not([multiple])').forEach(enhanceSelect);
  root.querySelectorAll('input[type="month"]:not([data-enhanced])').forEach(enhanceMonth);
  root.querySelectorAll('input[type="date"]:not([data-enhanced])').forEach(enhanceDate);
}
