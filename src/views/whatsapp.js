// Aba WhatsApp: mostra se a instância da Evolution API está conectada e permite conectar pelo QR Code.
import { api } from '../api.js';
import { $, esc, toast } from '../utils.js';
import { initTemplates, loadTemplates } from './templates.js';

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

// ---------------------------------------------------------------- proteção contra bloqueio (ritmo dos avisos)

// Velocidades prontas (em segundos). "custom" = o que estiver nos campos.
const PRESETS = {
  slow: { gap_min: 120, gap_max: 300, per_hour: 10, per_day: 40, hint: 'Mais lenta e mais segura. Boa para número novo ou que já levou aviso do WhatsApp.' },
  normal: { gap_min: 60, gap_max: 180, per_hour: 15, per_day: 60, hint: 'Equilíbrio entre segurança e rapidez. É a que recomendamos.' },
  fast: { gap_min: 30, gap_max: 90, per_hour: 30, per_day: 120, hint: 'Mais rápida, com um pouco mais de risco. Só para número antigo e com bastante conversa.' },
};
const PRESET_KEYS = ['gap_min', 'gap_max', 'per_hour', 'per_day'];
const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' ? Number(v) : d);
const fmtMin = (sec) => String(Math.round((sec / 60) * 10) / 10).replace('.', ',');
const fmtDuration = (min) => {
  const m = Math.max(1, Math.round(min));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}h${String(r).padStart(2, '0')}` : `${h}h`;
};

/** Lê os campos da tela (minutos → segundos). */
function readPacing() {
  const f = $('#form-pacing');
  const gapMin = Math.round(num(f.elements.gap_min_m.value, 1) * 60);
  const gapMax = Math.round(num(f.elements.gap_max_m.value, 3) * 60);
  return {
    on: f.elements.on.checked,
    gap_min: gapMin, gap_max: Math.max(gapMin, gapMax),
    per_hour: num(f.elements.per_hour.value, 15), per_day: num(f.elements.per_day.value, 60),
    hour_start: num(f.elements.hour_start.value, 9), hour_end: num(f.elements.hour_end.value, 20),
  };
}

function writePacing(c) {
  const f = $('#form-pacing');
  f.elements.gap_min_m.value = Math.round((c.gap_min / 60) * 100) / 100;
  f.elements.gap_max_m.value = Math.round((c.gap_max / 60) * 100) / 100;
  f.elements.per_hour.value = c.per_hour;
  f.elements.per_day.value = c.per_day;
  if (c.hour_start !== undefined) f.elements.hour_start.value = c.hour_start;
  if (c.hour_end !== undefined) f.elements.hour_end.value = c.hour_end;
}

const presetOf = (c) => Object.keys(PRESETS).find((k) => PRESET_KEYS.every((f) => PRESETS[k][f] === c[f])) || 'custom';

/** Atualiza botões de velocidade, o exemplo "na prática" e o estado ligado/desligado. */
function updatePacingUi() {
  const f = $('#form-pacing');
  const c = readPacing();
  const preset = presetOf(c);
  document.querySelectorAll('#pacing-presets button').forEach((b) => b.classList.toggle('active', b.dataset.preset === preset));
  $('#pacing-preset-hint').textContent = preset === 'custom' ? 'Você escolheu os seus próprios valores nos campos abaixo.' : PRESETS[preset].hint;
  f.querySelector('.switch-text').textContent = c.on ? 'Ligada' : 'Desligada';
  $('#pacing-fields').classList.toggle('is-off', !c.on);
  f.querySelectorAll('#pacing-fields input, #pacing-fields button').forEach((el) => { el.disabled = !c.on; });

  const box = $('#pacing-example');
  if (!c.on) {
    box.innerHTML = '<p><strong>Proteção desligada.</strong> Se 20 clientes precisarem de aviso no mesmo dia, as 20 mensagens saem juntas, em poucos segundos. É assim que números costumam ser bloqueados.</p>';
    return;
  }
  // Exemplo: 20 avisos no mesmo dia
  const N = 20;
  const avg = (c.gap_min + c.gap_max) / 2;                       // segundos entre mensagens
  const perHour = Math.max(1, Math.min(c.per_hour, Math.floor(3600 / avg) + 1));
  const today = Math.min(N, c.per_day, perHour * Math.max(1, c.hour_end - c.hour_start));
  const fullHours = Math.ceil(today / perHour) - 1;
  const rest = today - fullHours * perHour;
  const minutes = fullHours * 60 + ((rest - 1) * avg) / 60;
  const lines = [
    `A primeira mensagem sai às <strong>${c.hour_start}h</strong>. Depois, uma a cada <strong>${fmtMin(c.gap_min)} a ${fmtMin(c.gap_max)} minutos</strong> (o tempo muda a cada envio, como uma pessoa faria).`,
    perHour < N ? `Saem no máximo <strong>${perHour} por hora</strong>; as que sobrarem continuam na hora seguinte.` : null,
    today >= N
      ? `Os 20 avisos terminam em cerca de <strong>${fmtDuration(minutes)}</strong>.`
      : `Hoje saem <strong>${today}</strong>; os outros <strong>${N - today}</strong> ficam para o dia seguinte, a partir das ${c.hour_start}h.`,
  ].filter(Boolean);
  box.innerHTML = `<p class="pacing-example-title">Na prática: se 20 clientes precisarem de aviso no mesmo dia</p><ul>${lines.map((l) => `<li>${l}</li>`).join('')}</ul>`;
}

/** Descarta o que foi alterado e não salvo (ao entrar na aba). */
export function resetPacingDraft() {
  const f = $('#form-pacing');
  if (f) f.dataset.dirty = '';
}

function renderPacing(st) {
  const f = $('#form-pacing');
  f.elements.on.checked = st.config.on;
  writePacing(st.config);
  updatePacingUi();
  renderPacingStatus(st);
}

function renderPacingStatus(st) {
  const last = st.last_sent_at ? new Date(st.last_sent_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : 'nenhum ainda';
  $('#pacing-status').innerHTML = [
    `Enviados na última hora: <strong>${st.sent_last_hour}</strong>`,
    `nas últimas 24h: <strong>${st.sent_last_24h}</strong>`,
    `último envio: ${esc(last)}`,
    st.waiting ? `<strong>${st.waiting}</strong> na fila agora` : null,
    st.config.on && !st.in_window ? 'fora do horário de envio' : null,
  ].filter(Boolean).join(' · ');
}

async function loadPacing() {
  const f = $('#form-pacing');
  try {
    const st = await api.pacing();
    if (f.dataset.dirty === '1') renderPacingStatus(st); // não apaga o que está sendo editado
    else renderPacing(st);
  } catch { $('#pacing-status').textContent = 'Não foi possível carregar a configuração.'; }
}

export async function loadWhatsapp() {
  loadPacing();
  loadTemplates($('#wa-templates'), 'whatsapp');
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
  const touched = () => { pf.dataset.dirty = '1'; updatePacingUi(); };
  pf.addEventListener('input', touched);
  $('#pacing-presets').addEventListener('click', (e) => {
    const key = e.target.closest('button')?.dataset.preset;
    if (!key) return;
    if (PRESETS[key]) writePacing(PRESETS[key]);
    else pf.elements.gap_min_m.focus(); // personalizada: leva para os campos
    touched();
  });
  pf.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = pf.querySelector('button.primary');
    btn.disabled = true;
    try {
      const st = await api.savePacing(readPacing());
      pf.dataset.dirty = '';
      renderPacing(st);
      toast(st.config.on ? 'Proteção contra bloqueio salva.' : 'Proteção desligada.');
    } catch { /* toast já mostrado */ } finally { btn.disabled = false; }
  });
  initTemplates($('#wa-templates'));

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
