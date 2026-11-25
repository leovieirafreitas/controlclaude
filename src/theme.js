// Tema do painel: claro, noite ou automático (segue o sistema). A escolha fica salva neste navegador.
// O <head> do index.html já aplica o tema salvo antes de pintar a página, para não piscar.
const KEY = 'theme';

function saved() {
  try { const t = localStorage.getItem(KEY); return t === 'light' || t === 'dark' ? t : 'auto'; } catch { return 'auto'; }
}

function apply(mode) {
  if (mode === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = mode;
  for (const b of document.querySelectorAll('[data-theme-set]')) b.setAttribute('aria-pressed', String(b.dataset.themeSet === mode));
}

export function initTheme() {
  apply(saved());
  document.getElementById('theme-switch')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-theme-set]');
    if (!b) return;
    const mode = b.dataset.themeSet;
    try { mode === 'auto' ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, mode); } catch { /* navegador sem armazenamento: vale só nesta visita */ }
    apply(mode);
  });
}
