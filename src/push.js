// App do painel (PWA) e notificações push: novos clientes e pagamentos chegam como notificação no celular.
// iPhone: precisa do iOS 16.4+ e do painel adicionado à Tela de Início (abrir pelo ícone, não pelo Safari).
import { api } from './api.js';
import { $, esc, toast } from './utils.js';
import { ICON_BELL, ICON_SHARE } from './icons.js';

const SW_URL = '/admin-sw.js';
const SCOPE = '/admin';

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

let registration = null;

async function getRegistration() {
  if (registration) return registration;
  if (!('serviceWorker' in navigator)) return null;
  registration = await navigator.serviceWorker.register(SW_URL, { scope: SCOPE });
  await navigator.serviceWorker.ready;
  return registration;
}

async function currentSubscription() {
  const reg = await getRegistration().catch(() => null);
  return reg ? reg.pushManager.getSubscription() : null;
}

/** Chave pública VAPID (base64url) → bytes, como o navegador espera. */
function keyBytes(base64url) {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function setDot(on) {
  const dot = $('#push-dot');
  if (dot) dot.className = `push-dot${on ? ' on' : ''}`;
  $('#push-btn')?.setAttribute('title', on ? 'Notificações ativadas neste aparelho' : 'Ativar notificações no celular');
}

function installSteps() {
  return `
    <p>Para receber notificações no iPhone, instale o painel como app:</p>
    <ol class="push-steps">
      <li>Abra <strong>${esc(location.origin)}/admin</strong> no <strong>Safari</strong>.</li>
      <li>Toque em <strong>Compartilhar</strong> <span class="push-inline-icon">${ICON_SHARE}</span> (o quadrado com a seta para cima).</li>
      <li>Toque em <strong>Adicionar à Tela de Início</strong> → <strong>Adicionar</strong>.</li>
      <li>Abra o app <strong>Control Claude</strong> pelo ícone na tela, entre com seu e-mail e toque no sino <span class="push-inline-icon">${ICON_BELL}</span> de novo.</li>
    </ol>
    <p class="muted small">Precisa do iOS 16.4 ou mais novo (Ajustes → Geral → Sobre).</p>`;
}

async function render() {
  const body = $('#push-body');
  if (!supported()) {
    body.innerHTML = isIOS() && !isStandalone()
      ? installSteps()
      : '<p>Este navegador não aceita notificações. No iPhone, use o app instalado pela Tela de Início; no computador, use Chrome, Edge, Firefox ou Safari atualizado.</p>';
    setDot(false);
    return;
  }
  if (Notification.permission === 'denied') {
    body.innerHTML = `
      <p><strong>As notificações estão bloqueadas neste aparelho.</strong></p>
      <p>${isIOS() ? 'No iPhone: <strong>Ajustes → Notificações → Control Claude</strong> → ative <strong>Permitir Notificações</strong>. Depois feche e abra o app.' : 'Libere as notificações deste site nas configurações do navegador (ícone de cadeado ao lado do endereço) e recarregue a página.'}</p>`;
    setDot(false);
    return;
  }

  const sub = await currentSubscription();
  let devices = [];
  try { devices = (await api.push(sub?.endpoint)).devices || []; } catch { /* mostra sem a lista */ }
  const known = sub && devices.some((d) => d.current);
  setDot(Boolean(known));

  const others = devices.filter((d) => !d.current).length;
  const otherLine = others ? `<p class="muted small">Também ${others === 1 ? 'há 1 outro aparelho' : `há ${others} outros aparelhos`} recebendo as notificações.</p>` : '';
  const what = '<p class="muted small">Você recebe uma notificação quando: um <strong>cliente novo cria a conta</strong>, chega uma <strong>nova assinatura</strong> ou um <strong>pagamento</strong> (Pix, cartão ou renovação automática).</p>';

  if (known) {
    body.innerHTML = `
      <p><span class="push-pill on"><span class="push-pill-dot"></span>Ativadas neste aparelho</span></p>
      ${what}${otherLine}
      <div class="wa-actions">
        <button class="btn primary" type="button" id="push-test">Enviar notificação de teste</button>
        <button class="btn danger" type="button" id="push-off">Desativar neste aparelho</button>
      </div>`;
  } else {
    body.innerHTML = `
      ${isIOS() && !isStandalone() ? installSteps() : ''}
      ${what}${otherLine}
      <div class="wa-actions"><button class="btn primary" type="button" id="push-on">Ativar notificações neste aparelho</button></div>`;
  }
}

async function enable(btn) {
  btn.disabled = true;
  try {
    // Pedir a permissão primeiro, direto no toque (o iPhone exige isso)
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { await render(); return; }
    const reg = await getRegistration();
    const { public_key } = await api.push();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      // Se o serviço de push do aparelho não responder, não deixa o botão travado
      sub = await Promise.race([
        reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(public_key) }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('o aparelho demorou para responder. Verifique a internet e tente de novo.')), 60_000)),
      ]);
    }
    await api.pushSubscribe(sub.toJSON());
    toast('Notificações ativadas!');
    await api.pushTest().catch(() => {});
  } catch (err) {
    toast(`Não foi possível ativar: ${err.message}`);
  } finally {
    btn.disabled = false;
    await render();
  }
}

async function disable(btn) {
  btn.disabled = true;
  try {
    const sub = await currentSubscription();
    if (sub) {
      await api.pushUnsubscribe(sub.endpoint).catch(() => {});
      await sub.unsubscribe();
    }
    toast('Notificações desativadas neste aparelho.');
  } finally {
    btn.disabled = false;
    await render();
  }
}

export function initPush() {
  const dlg = $('#dlg-push');
  $('#push-btn').addEventListener('click', () => { dlg.showModal(); render(); });
  $('#push-close').addEventListener('click', () => dlg.close());
  $('#push-body').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.id === 'push-on') return enable(btn);
    if (btn.id === 'push-off') return disable(btn);
    if (btn.id === 'push-test') {
      btn.disabled = true;
      try { await api.pushTest(); toast('Notificação de teste enviada.'); } catch { /* toast já mostrado */ } finally { btn.disabled = false; }
    }
  });
}

/** Depois do login: registra o service worker e acende a bolinha do sino se já estiver ativo. */
export async function refreshPush() {
  if (!supported()) return setDot(false);
  try {
    const sub = await currentSubscription();
    if (!sub || Notification.permission !== 'granted') return setDot(false);
    // Garante que o servidor conhece este aparelho (ex.: depois de trocar as chaves ou limpar o banco)
    await api.pushSubscribe(sub.toJSON()).catch(() => {});
    setDot(true);
  } catch { setDot(false); }
}
