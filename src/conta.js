import { enhanceControls } from './controls.js';
import { methodIcon } from './icons.js';

enhanceControls(); // calendário com o visual do site

const $ = (s, root = document) => root.querySelector(s);
const brl = (cents) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtDate = (iso) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '—');
const fmtMonth = (m) => `${m.slice(5, 7)}/${m.slice(0, 4)}`;
const digits = (v) => String(v || '').replace(/\D/g, '');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STATUS = { ativo: 'Ativo', aguardando: 'Aguardando pagamento', pausado: 'Pausado', cancelado: 'Cancelado' };
const METHOD = { pix: 'Pix', credito: 'Cartão de crédito', debito: 'Cartão de débito', cartao: 'Cartão', boleto: 'Boleto', dinheiro: 'Dinheiro', transferencia: 'Transferência' };

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api/member${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Erro ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function show(id) {
  for (const s of ['#loading', '#auth', '#panel']) $(s).classList.toggle('hidden', s !== id);
  $('#logout').classList.toggle('hidden', id !== '#panel');
}

function formError(form, msg) {
  const el = $('.form-error', form);
  el.textContent = msg || '';
  el.classList.toggle('hidden', !msg);
}

function flash(msg, kind = 'ok') {
  const el = $('#flash');
  el.className = `flash ${kind}`;
  el.textContent = msg;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/** Desabilita o botão de envio enquanto a ação roda. */
async function busy(form, fn) {
  const btn = $('button:not([type="button"])', form);
  btn.disabled = true;
  try {
    return await fn();
  } finally {
    btn.disabled = false;
  }
}

// ------------------------------------------------------------------ suporte (WhatsApp das Configurações do painel)

async function showSupport() {
  const info = await fetch('/api/public/info').then((r) => r.json()).catch(() => null);
  const shown = info?.settings?.whatsapp || '';
  let n = digits(shown);
  if (!n) return;
  if (n.length <= 11) n = `55${n}`; // sem DDI: assume Brasil
  const href = `https://wa.me/${n}?text=${encodeURIComponent('Olá! Preciso de ajuda com minha assinatura da Control Claude.')}`;
  document.querySelectorAll('.support-link').forEach((a) => { a.href = href; });
  $('#support-number').textContent = shown;
  for (const id of ['#support-card', '#auth-support', '#wa-float']) $(id).classList.remove('hidden');
}
showSupport();

// ------------------------------------------------------------------ plano escolhido na página de vendas

const params = new URLSearchParams(location.search);
const PENDING_KEY = 'cc_plano';
let pendingPlan = params.get('plano');
try {
  if (pendingPlan) sessionStorage.setItem(PENDING_KEY, pendingPlan);
  else pendingPlan = sessionStorage.getItem(PENDING_KEY);
} catch { /* sem storage: segue só com a URL */ }
const clearPending = () => {
  pendingPlan = null;
  try { sessionStorage.removeItem(PENDING_KEY); } catch { /* ok */ }
};

async function showChosenPlan() {
  if (!pendingPlan) return;
  const info = await fetch('/api/public/info').then((r) => r.json()).catch(() => null);
  const plan = info?.plans.find((p) => String(p.id) === String(pendingPlan));
  if (!plan) return clearPending();
  if (plan.sold_out) {
    clearPending();
    return flash(`O plano ${plan.name} está esgotado no momento. Escolha outro plano.`, 'bad');
  }
  const box = $('#chosen-plan');
  box.innerHTML = `<span>Plano escolhido</span><strong>${esc(plan.name)}</strong><em>${brl(plan.price_cents)}/mês</em>`;
  box.classList.remove('hidden');
}

/** Depois de entrar/criar conta: se havia um plano escolhido, já vai para o pagamento. */
async function afterAuth() {
  if (pendingPlan) {
    const plan = pendingPlan;
    clearPending();
    try {
      await choosePlan(Number(plan));
      return;
    } catch (err) {
      render(await call('/me'));
      return flash(err.message, 'bad');
    }
  }
  render(await call('/me'));
}

// ------------------------------------------------------------------ abas e formulários de acesso

function goPane(name) {
  for (const f of ['login', 'code', 'register', 'forgot', 'reset']) $(`#${f}-form`).classList.toggle('hidden', f !== name);
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $('.tabs').classList.toggle('hidden', ['forgot', 'reset', 'code'].includes(name));
  const first = $(`#${name}-form input:not([type=hidden]):not([disabled])`);
  first?.focus();
}

document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => goPane(b.dataset.tab)));
document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => goPane(b.dataset.go)));
document.querySelectorAll('.eye').forEach((b) => b.addEventListener('click', () => {
  const input = b.previousElementSibling;
  input.type = input.type === 'password' ? 'text' : 'password';
  b.textContent = input.type === 'password' ? 'Mostrar' : 'Ocultar';
}));

const pwProblem = (pw) => (pw.length < 8 ? 'A senha precisa ter pelo menos 8 caracteres.' : !/[A-Za-z]/.test(pw) || !/\d/.test(pw) ? 'Use letras e números na senha.' : null);

$('#login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  const email = f.email.value.trim();
  if (!email || !f.password.value) return formError(f, 'Informe e-mail e senha.');
  busy(f, async () => {
    try {
      const r = await call('/login', { method: 'POST', body: { email, password: f.password.value } });
      formError(f, '');
      if (r.need_code) {
        // 2ª etapa: guarda e-mail e senha só em memória, para o "Reenviar código"
        askCode({ email, password: f.password.value }, r.message, 'login');
        f.reset();
        return;
      }
      f.reset();
      await afterAuth();
    } catch (err) {
      formError(f, err.message);
    }
  });
});

let loginPending = null;
let codeBack = 'login';
function askCode(pending, message, from) {
  loginPending = pending;
  codeBack = from;
  $('#code-title').textContent = from === 'register' ? 'Confirme seu e-mail' : 'Confirme que é você';
  $('#code-hint').textContent = message;
  $('#code-form').querySelector('button.btn').textContent = from === 'register' ? 'Confirmar e entrar' : 'Entrar';
  formError($('#code-form'), '');
  goPane('code');
}
$('#code-back').addEventListener('click', () => { loginPending = null; goPane(codeBack); });
$('#code-form').code.addEventListener('input', (e) => { e.target.value = digits(e.target.value).slice(0, 6); });
$('#code-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  if (!loginPending) return goPane('login');
  if (digits(f.code.value).length !== 6) return formError(f, 'Digite os 6 dígitos do código.');
  busy(f, async () => {
    try {
      await call('/login/verify', { method: 'POST', body: { email: loginPending.email, code: f.code.value } });
      loginPending = null;
      f.reset();
      $('#register-form').reset();
      formError(f, '');
      await afterAuth();
    } catch (err) {
      formError(f, err.message);
    }
  });
});
$('#code-resend').addEventListener('click', async () => {
  const f = $('#code-form');
  if (!loginPending) return goPane('login');
  try {
    const r = await call('/login', { method: 'POST', body: loginPending });
    $('#code-hint').textContent = r.message;
    formError(f, '');
  } catch (err) {
    formError(f, err.message);
  }
});

$('#register-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  const body = Object.fromEntries(new FormData(f));
  if (body.name.trim().length < 2) return formError(f, 'Informe seu nome completo.');
  if (!f.email.checkValidity() || !body.email) return formError(f, 'Informe um e-mail válido.');
  if (!body.birth_date) return formError(f, 'Informe sua data de nascimento.');
  if (digits(body.phone).length < 10) return formError(f, 'Informe seu WhatsApp com DDD. É por ele que avisamos o vencimento.');
  const p = pwProblem(body.password);
  if (p) return formError(f, p);
  if (body.password !== body.password2) return formError(f, 'As senhas não conferem.');
  if (!f.accept_terms.checked) return formError(f, 'Para criar a conta, aceite os Termos de uso e a Política de privacidade.');
  delete body.password2;
  body.accept_terms = true;
  busy(f, async () => {
    try {
      const r = await call('/register', { method: 'POST', body });
      formError(f, '');
      if (r.need_code) {
        // Conta só vale depois do código: se o e-mail estiver errado, o cliente volta e corrige
        askCode({ email: body.email.trim(), password: body.password }, r.message, 'register');
        return;
      }
      f.reset();
      await afterAuth();
    } catch (err) {
      formError(f, err.message);
    }
  });
});

let resetEmail = '';
$('#forgot-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  const email = f.email.value.trim();
  if (!email) return formError(f, 'Informe seu e-mail.');
  busy(f, async () => {
    try {
      const { message } = await call('/password/forgot', { method: 'POST', body: { email } });
      resetEmail = email;
      formError(f, '');
      $('#reset-hint').textContent = message;
      goPane('reset');
    } catch (err) {
      formError(f, err.message);
    }
  });
});

$('#reset-form').code.addEventListener('input', (e) => { e.target.value = digits(e.target.value).slice(0, 6); });
$('#reset-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  if (digits(f.code.value).length !== 6) return formError(f, 'Digite os 6 dígitos do código.');
  const p = pwProblem(f.password.value);
  if (p) return formError(f, p);
  busy(f, async () => {
    try {
      await call('/password/reset', { method: 'POST', body: { email: resetEmail, code: f.code.value, password: f.password.value } });
      f.reset();
      await afterAuth();
      flash('Senha alterada com sucesso.', 'ok');
    } catch (err) {
      formError(f, err.message);
    }
  });
});

// ------------------------------------------------------------------ painel

let state = null;

function renderPlanChoices(plans, currentId) {
  $('#mini-plans').innerHTML = plans.map((p) => `
    <div class="mini-plan ${p.featured ? 'featured' : ''}">
      <div><strong>${esc(p.name)}</strong>${p.description ? `<span class="muted">${esc(p.description)}</span>` : ''}</div>
      <div class="mini-right">
        <span class="mini-price">${brl(p.price_cents)}<small>/mês</small></span>
        ${p.sold_out
    ? '<button class="btn btn-outline" disabled>Esgotado</button>'
    : `<button class="btn ${p.featured ? 'btn-primary' : 'btn-outline'}" data-plan="${p.id}">${p.id === currentId ? 'Pagar este plano' : 'Assinar'}</button>`}
      </div>
    </div>`).join('') || '<p class="muted">Nenhum plano disponível no momento.</p>';
}

function render(data) {
  state = data;
  const { customer: c, subscription: sub, payments, plans, can_pay } = data;
  $('#first-name').textContent = c.name.split(/\s+/)[0];

  // dados
  const f = $('#data-form');
  f.name.value = c.name;
  f.email.value = c.email;
  f.birth_date.value = c.birth_date || '';
  f.phone.value = c.phone || '';

  // sem assinatura → escolher plano
  $('#sub-card').classList.toggle('hidden', !sub);
  $('#choose').classList.toggle('hidden', Boolean(sub));
  $('#choose-title').textContent = 'Escolha seu plano';
  renderPlanChoices(plans, sub?.plan.id);

  if (sub) {
    const cancelled = sub.status === 'cancelado';
    const active = sub.status === 'ativo';
    const next = sub.next_charge;
    $('#status').textContent = sub.status === 'ativo' && sub.cancel_at ? `Ativo até ${fmtDate(sub.cancel_at)}` : STATUS[sub.status] || sub.status;
    $('#status').className = `status st-${sub.status === 'ativo' && sub.cancel_at ? 'aguardando' : sub.status}`;
    $('#plan-name').textContent = sub.plan.name;
    $('#plan-price').textContent = `${brl(sub.plan.price_cents)} por mês`;
    $('#since').textContent = fmtDate(sub.start_date);
    $('#due').textContent = `Todo dia ${sub.due_day}`;
    const scheduled = active && Boolean(sub.cancel_at);
    $('#cancel-btn').classList.toggle('hidden', cancelled || scheduled);
    $('#keep-box').classList.toggle('hidden', !scheduled);
    if (scheduled) $('#keep-text').innerHTML = `Você pediu o cancelamento. Seu plano continua ativo até <strong>${fmtDate(sub.cancel_at)}</strong> e depois será encerrado. Mudou de ideia?`;
    $('#change-btn').classList.toggle('hidden', active);

    // renovação automática no cartão
    const ap = sub.autopay;
    const apOn = ap?.status === 'authorized';
    const card = ap?.card_last4 ? `cartão final ${ap.card_last4}` : 'seu cartão';
    const nextDate = ap?.next_charge_date ? fmtDate(ap.next_charge_date) : null;
    const failed = apOn && !next.current_paid && active && ap.next_charge_date && ap.next_charge_date < new Date().toLocaleDateString('sv-SE');
    $('#autopay-row').classList.toggle('hidden', !ap);
    $('#autopay').textContent = !ap ? '' : apOn ? `Ligada · ${card}` : 'Pausada (cancelamento agendado)';
    $('#card-btn').classList.toggle('hidden', !ap || cancelled);
    $('#due').textContent = apOn && nextDate ? `Próxima cobrança em ${nextDate}` : `Todo dia ${sub.due_day}`;

    const showPay = can_pay && !scheduled && !sub.plan.sold_out && (!apOn || failed);
    $('#pay-btn').classList.toggle('hidden', !showPay);
    $('#check-btn').classList.toggle('hidden', !can_pay || scheduled || (active && next.current_paid));
    $('#pay-btn').textContent = sub.autopay_blocked && !next.current_paid ? `Pagar ${fmtMonth(next.month)} no cartão`
      : failed ? 'Pagar com outro cartão'
      : cancelled ? 'Reativar plano'
      : next.current_paid ? 'Ativar renovação automática'
      : `Assinar com cartão de crédito`;
    $('#charge-info').textContent = cancelled
      ? 'Seu plano está cancelado. Você não será mais cobrado.'
      : scheduled ? 'Cancelamento agendado: nenhuma nova cobrança será feita.'
      : failed ? `A cobrança automática no ${card} não foi aprovada. Pague com outro cartão para manter o acesso.`
      : apOn ? (nextDate ? `Renovação automática: em ${nextDate} cobramos ${brl(sub.plan.price_cents)} no ${card}. Você não precisa fazer nada.` : 'Renovação automática ligada.')
      : next.current_paid
        ? 'Sua mensalidade deste mês está paga. Ative a renovação automática para não se preocupar com o vencimento.'
        : sub.plan.sold_out ? `O plano ${sub.plan.name} está esgotado no momento. Escolha outro plano ou fale com o suporte.`
        : `Mensalidade de ${fmtMonth(next.month)} em aberto. O pagamento é no cartão de crédito, com renovação automática todo mês.`;
  }

  $('#payments-card').classList.toggle('hidden', !sub);
  $('#payments').innerHTML = payments.length
    ? payments.map((p) => `<tr><td>${fmtDate(p.paid_at)}</td><td>${fmtMonth(p.ref_month)}</td><td><span class="pm-inline m-${esc(p.method)}">${methodIcon(p.method)}${esc(METHOD[p.method] || p.method)}</span></td><td class="r">${brl(p.amount_cents)}</td></tr>`).join('')
    : '<tr><td colspan="4" class="empty">Nenhum pagamento ainda.</td></tr>';

  show('#panel');
}

// ------------------------------------------------------------------ pagamento: cartão de crédito com renovação automática (assinatura do Mercado Pago)

let mpInstance = null;
let brickController = null;
let payMode = 'pay'; // 'pay' = assinar com renovação automática · 'card' = só trocar o cartão · 'once' = plano B: este mês avulso

/** Escolhe o plano (cria/atualiza a assinatura) e abre o pagamento. */
async function choosePlan(planId) {
  const view = await call('/subscribe', { method: 'POST', body: { plan_id: planId } });
  render(view);
  if (view.manual) {
    flash(view.manual.pix_key ? `Plano escolhido! Pague via Pix na chave ${view.manual.pix_key}.` : 'Plano escolhido! Entraremos em contato para o pagamento.', 'ok');
    return;
  }
  openPayment();
}

async function unmountBrick() {
  if (brickController) {
    try { await brickController.unmount(); } catch { /* ok */ }
    brickController = null;
  }
}

async function mountBrick() {
  await unmountBrick();
  const sub = state.subscription;
  if (!window.MercadoPago) {
    $('#card-error').textContent = 'Não foi possível carregar o formulário do Mercado Pago. Verifique sua conexão.';
    $('#card-error').classList.remove('hidden');
    return;
  }
  mpInstance ||= new window.MercadoPago(state.mp_public_key, { locale: 'pt-BR' });
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  brickController = await mpInstance.bricks().create('cardPayment', 'cardPaymentBrick_container', {
    initialization: { amount: sub.plan.price_cents / 100, payer: { email: state.customer.email } },
    customization: {
      // só cartão de crédito, à vista: é ele que o Mercado Pago cobra todo mês
      paymentMethods: { maxInstallments: 1, types: { excluded: ['debit_card'] } },
      visual: { style: { theme: dark ? 'dark' : 'default' } },
    },
    callbacks: {
      onReady: () => {},
      onError: (error) => console.error('Brick:', error),
      onSubmit: (formData, additionalData) => new Promise((resolve, reject) => {
        $('#card-error').classList.add('hidden');
        call(payMode === 'card' ? '/card' : '/pay', {
          method: 'POST',
          body: {
            card: { ...formData, payment_type_id: additionalData?.paymentTypeId },
            mode: payMode === 'once' ? 'once' : undefined,
            device_id: window.MP_DEVICE_SESSION_ID || undefined,
          },
        }).then(async (out) => {
          resolve();
          if (out.status === 'approved') {
            closePayment();
            render(out.view);
            flash(payMode === 'card' ? out.message
              : payMode === 'once' ? 'Pagamento aprovado! Seu plano está ativo.'
              : 'Pagamento aprovado! Sua assinatura está ativa, com renovação automática.', 'ok');
          } else if (out.status === 'pending') {
            closePayment();
            render(out.view);
            flash(out.message, 'warn');
          } else if (out.allow_once && payMode === 'pay') {
            // Plano B: o Mercado Pago não aprovou a renovação automática → pagar este mês de forma avulsa
            payMode = 'once';
            const price = brl(state.subscription.plan.price_cents);
            $('#pay-eyebrow').innerHTML = `${methodIcon('credito')} Cartão de crédito · pagamento deste mês`;
            $('#pay-month').innerHTML = `<strong>${esc(out.message)}</strong><br>
              Sem problema: você pode pagar <strong>este mês (${price})</strong> normalmente no cartão. Digite os dados do cartão de novo abaixo.
              No próximo vencimento, tentamos ativar a renovação automática outra vez.`;
            $('#card-error').classList.add('hidden');
            await mountBrick();
          } else {
            $('#card-error').textContent = out.message;
            $('#card-error').classList.remove('hidden');
            await mountBrick(); // novo formulário para tentar de novo
          }
        }).catch(async (err) => {
          reject();
          $('#card-error').textContent = err.message;
          $('#card-error').classList.remove('hidden');
          await mountBrick();
        });
      }),
    },
  });
}

function openPayment(mode = 'pay') {
  const sub = state.subscription;
  if (!sub || !state.can_pay) return;
  // renovação automática recusada há poucos dias: vai direto para o pagamento avulso deste mês
  if (mode === 'pay' && sub.autopay_blocked) mode = 'once';
  payMode = mode;
  const price = brl(sub.plan.price_cents);
  $('#pay-eyebrow').innerHTML = `${methodIcon('credito')} ${mode === 'card' ? 'Trocar cartão' : mode === 'once' ? 'Cartão de crédito · pagamento deste mês' : 'Cartão de crédito · renovação automática'}`;
  $('#pay-plan').textContent = sub.plan.name;
  $('#pay-amount').textContent = `${price}/mês`;
  $('#pay-month').innerHTML = mode === 'card'
    ? 'As próximas cobranças automáticas serão feitas no novo cartão. <strong>Nada é cobrado agora.</strong>'
    : mode === 'once'
      ? `Pague <strong>este mês (${price})</strong> no cartão de crédito, de forma avulsa (mensalidade de ${fmtMonth(sub.next_charge.month)}).
         No próximo vencimento, tentamos ativar a renovação automática outra vez.`
    : `Cobramos <strong>${price} agora</strong> (mensalidade de ${fmtMonth(sub.next_charge.month)}) e depois <strong>todo mês, automaticamente</strong>, neste cartão.
       Você pode cancelar quando quiser: a cobrança para e o acesso continua até o fim do período pago, sem estorno.`;
  $('#card-error').classList.add('hidden');
  $('#pay-dlg').showModal();
  mountBrick().catch((err) => {
    console.error(err);
    $('#card-error').textContent = 'Não foi possível abrir o formulário do cartão. Tente de novo em instantes.';
    $('#card-error').classList.remove('hidden');
  });
}

function closePayment() {
  unmountBrick();
  if ($('#pay-dlg').open) $('#pay-dlg').close();
}

$('#pay-close').addEventListener('click', closePayment);
$('#pay-dlg').addEventListener('cancel', () => { unmountBrick(); });

$('#mini-plans').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-plan]');
  if (!btn) return;
  btn.disabled = true;
  try {
    await choosePlan(Number(btn.dataset.plan));
  } catch (err) {
    flash(err.message, 'bad');
  } finally {
    btn.disabled = false;
  }
});

$('#pay-btn').addEventListener('click', () => openPayment('pay'));
$('#card-btn').addEventListener('click', () => openPayment('card'));

$('#change-btn').addEventListener('click', () => {
  $('#choose').classList.remove('hidden');
  $('#choose-title').textContent = 'Escolher outro plano';
  $('#choose').scrollIntoView({ behavior: 'smooth' });
});

$('#check-btn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  const before = state.payments.length;
  try {
    const data = await call('/sync', { method: 'POST', body: {} });
    render(data);
    const found = data.payments.length > before;
    flash(found ? 'Pagamento encontrado e registrado!' : 'Ainda não encontramos um pagamento aprovado. Se acabou de pagar, pode levar alguns minutos.', found ? 'ok' : 'warn');
  } catch (err) {
    flash(err.message, 'bad');
  } finally {
    btn.disabled = false;
  }
});

$('#data-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { name: f.name.value.trim(), birth_date: f.birth_date.value, phone: f.phone.value.trim() };
  if (body.name.length < 2) return formError(f, 'Informe seu nome completo.');
  if (!body.birth_date) return formError(f, 'Informe sua data de nascimento.');
  if (digits(body.phone).length < 10) return formError(f, 'Informe seu WhatsApp com DDD. É por ele que avisamos o vencimento.');
  busy(f, async () => {
    try {
      render(await call('/me', { method: 'PUT', body }));
      formError(f, '');
      flash('Dados atualizados.', 'ok');
    } catch (err) {
      formError(f, err.message);
    }
  });
});

$('#password-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  const p = pwProblem(f.new_password.value);
  if (!f.current_password.value) return formError(f, 'Informe sua senha atual.');
  if (p) return formError(f, p);
  busy(f, async () => {
    try {
      await call('/password', { method: 'PUT', body: { current_password: f.current_password.value, new_password: f.new_password.value } });
      f.reset();
      formError(f, '');
      f.closest('details').open = false;
      flash('Senha alterada.', 'ok');
    } catch (err) {
      formError(f, err.message);
    }
  });
});

$('#keep-btn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    render(await call('/keep', { method: 'POST', body: {} }));
    flash('Pronto! Seu plano continua ativo. 🎉', 'ok');
  } catch (err) {
    flash(err.message, 'bad');
  } finally {
    btn.disabled = false;
  }
});

$('#cancel-btn').addEventListener('click', () => $('#cancel-dlg').showModal());
$('#cancel-dlg').addEventListener('close', async () => {
  if ($('#cancel-dlg').returnValue !== 'yes') return;
  try {
    const data = await call('/cancel', { method: 'POST' });
    render(data);
    const until = data.subscription?.cancel_at;
    flash(until
      ? `Cancelamento agendado. Você continua usando até ${fmtDate(until)} e não será mais cobrado.`
      : 'Seu plano foi cancelado. Você não será mais cobrado.', 'warn');
  } catch (err) {
    flash(err.message, 'bad');
  }
});

$('#logout').addEventListener('click', async () => {
  await call('/logout', { method: 'POST' }).catch(() => {});
  clearPending();
  location.href = '/conta';
});

// ------------------------------------------------------------------ início

async function start(attempt = 1) {
  try {
    await call('/me');
    await afterAuth(); // logado: se veio de "Assinar" na página de vendas, já abre o pagamento
  } catch (err) {
    // Servidor reiniciando ou instável: tenta de novo em vez de mandar para o login
    if (err.status !== 401 && attempt < 10) {
      $('#loading').textContent = 'Conectando…';
      setTimeout(() => start(attempt + 1), Math.min(500 * attempt, 3000));
      return;
    }
    if (err.status !== 401) console.error(err);
    if (params.has('plano')) history.replaceState(null, '', '/conta');
    await showChosenPlan();
    show('#auth');
    goPane(pendingPlan ? 'register' : 'login');
  }
}

start();
