// Aba WhatsApp: mostra se a instância da Evolution API está conectada e permite conectar pelo QR Code.
import { api } from '../api.js';
import { $, esc, toast } from '../utils.js';

const POLL_MS = 3000;       // confere a conexão enquanto o QR está na tela
const QR_REFRESH_MS = 30000; // o WhatsApp troca o QR a cada ~40 s
const QR_GIVE_UP_MS = 3 * 60_000;

let pollTimer = null;
let qrTimer = null;
let qrStartedAt = 0;

const fmtPhone = (n) => {
  const d = String(n || '').replace(/\D/g, '');
  const m = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(d);
  return m ? `+55 (${m[1]}) ${m[2]}-${m[3]}` : d ? `+${d}` : '—';
};

const visible = () => !$('#tab-whatsapp').classList.contains('hidden');

function stopQr() {
  clearInterval(pollTimer);
  clearInterval(qrTimer);
  pollTimer = qrTimer = null;
}

/** Bolinha verde/vermelha no botão da aba. */
export function setWhatsappDot(state) {
  const dot = $('#wa-dot');
  if (!dot) return;
  dot.className = `wa-dot ${state === 'open' ? 'on' : state === 'unknown' ? '' : 'off'}`;
  dot.title = state === 'open' ? 'WhatsApp conectado' : 'WhatsApp desconectado';
}

export async function refreshWhatsappDot() {
  try {
    const st = await (await fetch('/api/whatsapp', { credentials: 'same-origin' })).json();
    setWhatsappDot(st.configured ? st.state : 'close');
  } catch { setWhatsappDot('unknown'); }
}

function render(st) {
  const box = $('#wa-status');
  setWhatsappDot(st.configured ? st.state : 'close');

  if (!st.configured) {
    stopQr();
    box.innerHTML = `
      <div class="wa-head"><span class="wa-pill off">Não configurado</span></div>
      <p class="muted">Defina <code>EVOLUTION_URL</code>, <code>EVOLUTION_INSTANCE</code> e <code>EVOLUTION_TOKEN</code> no arquivo <code>.env</code> do servidor.</p>`;
    return;
  }

  if (st.state === 'open') {
    stopQr();
    box.innerHTML = `
      <div class="wa-connected">
        ${st.picture ? `<img class="wa-avatar" src="${esc(st.picture)}" alt="" referrerpolicy="no-referrer">` : '<div class="wa-avatar wa-avatar-empty"></div>'}
        <div>
          <span class="wa-pill on"><span class="wa-live"></span> Conectado</span>
          <p class="wa-number">${esc(fmtPhone(st.number))}</p>
          <p class="muted small">${st.name ? `${esc(st.name)} · ` : ''}Instância ${esc(st.instance)}</p>
        </div>
      </div>
      <p class="muted small">Os avisos saem deste número para: <strong>${st.admin_numbers.map(fmtPhone).map(esc).join(', ') || '—'}</strong>, e as mensagens para os clientes (boas-vindas, lembrete e atraso).</p>
      <div class="wa-actions">
        <button class="btn" id="wa-test">Enviar mensagem de teste</button>
        <button class="btn danger" id="wa-logout">Desconectar</button>
      </div>`;
    return;
  }

  // desconectado
  if (!pollTimer) {
    box.innerHTML = `
      <div class="wa-head"><span class="wa-pill off">Desconectado</span></div>
      <p>Enquanto estiver desconectado, <strong>nenhum aviso é enviado</strong> (nem para você nem para os clientes).</p>
      <div class="wa-actions"><button class="btn primary" id="wa-connect">Conectar com QR Code</button></div>`;
  }
}

function renderQr({ qr, pairing_code }) {
  $('#wa-status').innerHTML = `
    <div class="wa-head"><span class="wa-pill wait"><span class="wa-spin"></span> Aguardando leitura do QR Code</span></div>
    <div class="wa-qr-wrap">
      ${qr ? `<img class="wa-qr" src="${qr}" alt="QR Code para conectar o WhatsApp" width="264" height="264">` : '<div class="wa-qr wa-qr-empty">Gerando…</div>'}
      <ol class="wa-steps">
        <li>Abra o <strong>WhatsApp</strong> no celular que vai enviar os avisos.</li>
        <li>Toque em <strong>⋮ Mais opções</strong> (Android) ou <strong>Configurações</strong> (iPhone).</li>
        <li>Toque em <strong>Dispositivos conectados → Conectar dispositivo</strong>.</li>
        <li>Aponte a câmera para este QR Code.</li>
      </ol>
    </div>
    ${pairing_code ? `<p class="muted small">Ou conecte com o código: <strong>${esc(pairing_code)}</strong></p>` : ''}
    <p class="muted small">O QR Code é renovado automaticamente. Esta tela muda sozinha quando conectar.</p>
    <div class="wa-actions"><button class="btn" id="wa-cancel">Cancelar</button></div>`;
}

async function fetchQr() {
  try {
    const r = await api.whatsappQr();
    if (r.state === 'open') return onConnected();
    renderQr(r);
  } catch { stopQr(); load(); }
}

async function onConnected() {
  stopQr();
  toast('WhatsApp conectado!');
  render(await api.whatsapp());
}

async function startQr() {
  stopQr();
  qrStartedAt = Date.now();
  renderQr({});
  pollTimer = setInterval(async () => {
    if (!visible()) return stopQr();
    if (Date.now() - qrStartedAt > QR_GIVE_UP_MS) {
      stopQr();
      $('#wa-status').innerHTML = `
        <div class="wa-head"><span class="wa-pill off">Desconectado</span></div>
        <p>O QR Code expirou.</p>
        <div class="wa-actions"><button class="btn primary" id="wa-connect">Gerar novo QR Code</button></div>`;
      return;
    }
    try {
      const st = await api.whatsapp();
      if (st.state === 'open') onConnected();
    } catch { /* tenta de novo no próximo ciclo */ }
  }, POLL_MS);
  qrTimer = setInterval(() => { if (visible()) fetchQr(); }, QR_REFRESH_MS);
  await fetchQr();
}

// ---------------------------------------------------------------- intervalo entre os avisos automáticos

const PACING_FIELDS = ['gap_min', 'gap_max', 'per_hour', 'per_day', 'hour_start', 'hour_end'];

function renderPacing(st) {
  const f = $('#form-pacing');
  f.elements.on.checked = st.config.on;
  for (const k of PACING_FIELDS) f.elements[k].value = st.config[k];
  for (const k of PACING_FIELDS) f.elements[k].disabled = !st.config.on;
  const last = st.last_sent_at ? new Date(st.last_sent_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : 'nenhum';
  $('#pacing-status').innerHTML = st.config.on
    ? `Enviados na última hora: <strong>${st.sent_last_hour}</strong> de ${st.config.per_hour} · nas últimas 24h: <strong>${st.sent_last_24h}</strong> de ${st.config.per_day} · último envio: ${esc(last)}${st.waiting ? ` · <strong>${st.waiting}</strong> na fila agora` : ''}${st.in_window ? '' : ' · fora do horário de envio'}`
    : '<strong>Desativado:</strong> os avisos saem todos de uma vez, sem pausa (maior risco de bloqueio).';
}

async function loadPacing() {
  try { renderPacing(await api.pacing()); } catch { $('#pacing-status').textContent = 'Não foi possível carregar a configuração.'; }
}

export async function loadWhatsapp() {
  loadPacing();
  if (pollTimer) return; // QR na tela: não redesenha
  $('#wa-status').innerHTML = '<p class="muted">Verificando conexão…</p>';
  try {
    render(await api.whatsapp());
  } catch (err) {
    $('#wa-status').innerHTML = `
      <div class="wa-head"><span class="wa-pill off">Sem resposta</span></div>
      <p class="muted">${esc(err.message)}</p>
      <div class="wa-actions"><button class="btn" id="wa-retry">Tentar de novo</button></div>`;
  }
}
const load = loadWhatsapp;

export function initWhatsapp() {
  const pf = $('#form-pacing');
  pf.elements.on.addEventListener('change', () => { for (const k of PACING_FIELDS) pf.elements[k].disabled = !pf.elements.on.checked; });
  pf.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { on: pf.elements.on.checked };
    for (const k of PACING_FIELDS) if (pf.elements[k].value !== '') body[k] = Number(pf.elements[k].value);
    const btn = pf.querySelector('button');
    btn.disabled = true;
    try {
      const st = await api.savePacing(body);
      renderPacing(st);
      toast(st.config.on ? 'Intervalo entre os avisos ativado.' : 'Intervalo desativado.');
    } catch { /* toast já mostrado */ } finally { btn.disabled = false; }
  });

  $('#wa-status').addEventListener('click', async (e) => {
    const id = e.target.closest('button')?.id;
    if (!id) return;
    const btn = e.target.closest('button');
    if (id === 'wa-connect') return startQr();
    if (id === 'wa-cancel') { stopQr(); return load(); }
    if (id === 'wa-retry') return load();
    if (id === 'wa-test') {
      btn.disabled = true;
      try {
        await api.whatsappTest();
        toast('Mensagem de teste enviada. Confira seu WhatsApp.');
      } catch { /* toast já mostrado */ } finally { btn.disabled = false; }
    }
    if (id === 'wa-logout') {
      if (!confirm('Desconectar o WhatsApp? Os avisos param até você conectar de novo pelo QR Code.')) return;
      btn.disabled = true;
      try {
        render(await api.whatsappLogout());
        toast('WhatsApp desconectado.');
      } catch { btn.disabled = false; }
    }
  });
}
