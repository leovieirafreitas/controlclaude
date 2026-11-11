// Ícones das formas de pagamento (SVG inline, herdam a cor do texto com currentColor).
// Usados no painel admin (utils.js) e na área do assinante (conta.js).
const svg = (body, { fill = false } = {}) =>
  `<svg class="pm-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false" ${
    fill ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
  }>${body}</svg>`;

// Pix: o losango de 4 pétalas do símbolo do Pix
const PIX = svg(`
  <path d="M17.6 16.9a2.9 2.9 0 0 1-2.06-.85l-2.98-2.98a.57.57 0 0 0-.79 0l-2.99 2.99a2.9 2.9 0 0 1-2.06.85h-.59l3.77 3.77a3 3 0 0 0 4.24 0l3.78-3.78h-.32Z"/>
  <path d="M6.72 7.07c.78 0 1.51.3 2.06.85l2.99 2.99c.22.22.57.22.79 0l2.98-2.98a2.9 2.9 0 0 1 2.06-.85h.32L14.14 3.3a3 3 0 0 0-4.24 0L6.13 7.07h.59Z"/>
  <path d="m20.7 9.88-2.28-2.28a.45.45 0 0 1-.16.03H17.6c-.6 0-1.17.24-1.6.66l-2.98 2.98a1.6 1.6 0 0 1-2.24 0L7.8 8.28a2.26 2.26 0 0 0-1.6-.66h-.85a.45.45 0 0 1-.15-.03L2.9 9.88a3 3 0 0 0 0 4.24l2.3 2.29a.45.45 0 0 1 .15-.03h.85c.6 0 1.17-.24 1.6-.66l2.98-2.99c.6-.6 1.65-.6 2.25 0l2.98 2.98c.42.43 1 .66 1.6.66h.66c.06 0 .11.01.16.03l2.28-2.28a3 3 0 0 0 0-4.24Z"/>`, { fill: true });

// Cartão: cartão com tarja magnética
const CARD = svg('<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19"/><path d="M6.5 15h4"/>');
// Boleto: código de barras
const BARCODE = svg('<path d="M4 6v12M7 6v12M10 6v12M13.5 6v12M16 6v12M20 6v12"/>');
// Dinheiro: cédula
const CASH = svg('<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 9.5v5M18 9.5v5"/>');
// Transferência: setas
const TRANSFER = svg('<path d="M4 8h14l-3.5-3.5"/><path d="M20 16H6l3.5 3.5"/>');

export const METHOD_ICON = {
  pix: PIX, credito: CARD, debito: CARD, cartao: CARD, card: CARD,
  boleto: BARCODE, dinheiro: CASH, transferencia: TRANSFER,
};

export const methodIcon = (m) => METHOD_ICON[m] || CARD;

// Ícones de interface do painel (mesmo traço dos ícones acima)
const ui = (body, size = 16) =>
  `<svg class="ui-icon" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
// Sino (notificações)
export const ICON_BELL = ui('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>');
// Compartilhar do iPhone (quadrado com seta para cima)
export const ICON_SHARE = ui('<path d="M12 3v12"/><path d="m8 7 4-4 4 4"/><path d="M8 11H6.5A1.5 1.5 0 0 0 5 12.5v7A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-7a1.5 1.5 0 0 0-1.5-1.5H16"/>');
