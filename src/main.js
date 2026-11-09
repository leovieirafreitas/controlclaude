import { api, setUnauthorizedHandler } from './api.js';
import { $ } from './utils.js';
import { initDashboard, loadDashboard } from './views/dashboard.js';
import { initSubscribers, loadSubscribers } from './views/subscribers.js';
import { initCustomers, loadCustomers, refreshCustomersDot } from './views/customers.js';
import { initPayments, loadPayments } from './views/payments.js';
import { initPlans, loadPlans } from './views/plans.js';
import { initWhatsapp, loadWhatsapp, refreshWhatsappDot } from './views/whatsapp.js';
import { enhanceControls } from './controls.js';

enhanceControls(); // listas e calendários com o visual do site

const loaders = {
  dashboard: loadDashboard,
  customers: loadCustomers,
  subscribers: loadSubscribers,
  payments: loadPayments,
  plans: loadPlans,
  whatsapp: loadWhatsapp,
};

let currentTab = 'dashboard';
const refresh = () => loaders[currentTab]().catch(() => {});

function showTab(tab) {
  currentTab = tab;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('main > section').forEach((s) => s.classList.toggle('hidden', s.id !== `tab-${tab}`));
  refresh();
}

function showLogin() {
  $('#app').classList.add('hidden');
  $('#login-screen').classList.remove('hidden');
  $('#code-form').classList.add('hidden');
  $('#login-form').classList.remove('hidden');
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  $('#login-form').email.focus();
}

function showApp(email) {
  if (email) $('#user-email').textContent = email;
  $('#login-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  showTab(currentTab);
  if (currentTab !== 'whatsapp') refreshWhatsappDot();
  if (currentTab !== 'customers') refreshCustomersDot();
}

// ---------- eventos
setUnauthorizedHandler(showLogin);

$('#tabs').addEventListener('click', (e) => {
  if (e.target.dataset.tab) showTab(e.target.dataset.tab);
});

// ---------- login por código
let loginEmail = '';
let resendTimer;

function setError(id, message) {
  const el = $(id);
  el.textContent = message || '';
  el.classList.toggle('hidden', !message);
}

function startResendCooldown(seconds = 60) {
  const btn = $('#code-resend');
  clearInterval(resendTimer);
  let left = seconds;
  btn.disabled = true;
  btn.textContent = `Reenviar em ${left}s`;
  resendTimer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(resendTimer);
      btn.disabled = false;
      btn.textContent = 'Reenviar código';
    } else btn.textContent = `Reenviar em ${left}s`;
  }, 1000);
}

async function sendCode(email, button) {
  button.disabled = true;
  try {
    const { message } = await api.requestCode(email);
    loginEmail = email;
    $('#code-hint').textContent = message;
    $('#login-form').classList.add('hidden');
    $('#code-form').classList.remove('hidden');
    $('#code-form').reset();
    setError('#code-error', '');
    $('#code-form').code.focus();
    startResendCooldown();
    return true;
  } catch (error) {
    return error.message;
  } finally {
    button.disabled = false;
  }
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = e.target.email.value.trim();
  if (!email) return setError('#login-error', 'Informe seu e-mail.');
  const r = await sendCode(email, $('#login-send'));
  setError('#login-error', r === true ? '' : r);
});

$('#code-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = e.target.code.value.replace(/\D/g, '');
  if (code.length !== 6) return setError('#code-error', 'Digite os 6 dígitos do código.');
  const btn = $('#code-verify');
  btn.disabled = true;
  try {
    const { email } = await api.verifyCode(loginEmail, code);
    clearInterval(resendTimer);
    setError('#code-error', '');
    showApp(email);
  } catch (error) {
    setError('#code-error', error.message);
    e.target.code.select();
  } finally {
    btn.disabled = false;
  }
});

$('#code-form').code.addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
  if (e.target.value.length === 6) $('#code-form').requestSubmit();
});

$('#code-back').addEventListener('click', showLogin);

$('#code-resend').addEventListener('click', async () => {
  const r = await sendCode(loginEmail, $('#code-resend'));
  if (r !== true) setError('#code-error', r);
});

$('#logout').addEventListener('click', async () => {
  await api.logout().catch(() => {});
  showLogin();
});

initDashboard();
initCustomers();
initSubscribers(refresh);
initPayments(refresh);
initPlans();
initWhatsapp();
setInterval(() => { if (!$('#app').classList.contains('hidden')) refreshWhatsappDot(); }, 5 * 60_000);
// Clientes: atualiza a lista (ou a bolinha de "novo cadastro") a cada 30 s, só com a aba do navegador aberta
setInterval(() => {
  if ($('#app').classList.contains('hidden') || document.hidden) return;
  if (currentTab === 'customers') loadCustomers().catch(() => {});
  else refreshCustomersDot();
}, 30_000);

// ---------- início
// Só mostra o login se o servidor disser que não há sessão. Se o servidor estiver
// reiniciando ou instável (erro 500, sem conexão), tenta de novo em vez de deslogar.
async function boot(attempt = 1) {
  try {
    const { authenticated, email } = await api.me();
    $('#boot-msg')?.remove();
    return authenticated ? showApp(email) : showLogin();
  } catch (err) {
    if (err.status === 401) return showLogin();
    if (attempt >= 10) { $('#boot-msg')?.remove(); return showLogin(); }
    let msg = $('#boot-msg');
    if (!msg) {
      msg = document.createElement('div');
      msg.id = 'boot-msg';
      msg.className = 'boot-msg';
      document.body.append(msg);
    }
    msg.textContent = 'Conectando ao servidor…';
    setTimeout(() => boot(attempt + 1), Math.min(500 * attempt, 3000));
  }
}
boot();
