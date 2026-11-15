import { enhanceControls } from './controls.js';
import { methodIcon } from './icons.js';

enhanceControls(); // calendário com o visual do site

const $ = (s, root = document) => root.querySelector(s);
const brl = (cents) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtDate = (iso) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '—');
const fmtMonth = (m) => `${m.slice(5, 7)}/${m.slice(0, 4)}`;
const digits = (v) => String(v || '').replace(/\D/g, '');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STATUS = { ativo: 'Ativo', aguardando: 'Aguardando pagamento', pausado: 'Desativado', cancelado: 'Cancelado' };
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
  for (const id of ['#support-card', '#auth-support', '#wa-float', '#pay-help']) $(id)?.classList.remove('hidden');
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

/** Data do vencimento num mês (AAAA-MM): o dia combinado ou o último dia do mês, se ele for mais curto. */
function dueDateOf(month, dueDay) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return `${month}-${String(Math.min(dueDay, last)).padStart(2, '0')}`;
}
/** A mensalidade em cobrança ainda não venceu? */
const notDueYet = (sub) => dueDateOf(sub.next_charge.month, sub.due_day) >= new Date().toLocaleDateString('sv-SE');

function renderPlanChoices(plans, currentId) {
  $('#mini-plans').innerHTML = plans.map((p) => `
    <div class="mini-plan ${p.featured ? 'featured' : ''}">
      <div><strong>${esc(p.name)}</strong>${p.description ? `<span class="muted">${esc(p.description)}</span>` : ''}${p.max_seats > 1 ? `<span class="muted seats-note">Preço por vaga · até ${p.max_seats} vagas</span>` : ''}</div>
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
    $('#plan-name').textContent = sub.seats > 1 ? `${sub.plan.name} · ${sub.seats} vagas` : sub.plan.name;
    $('#plan-price').textContent = sub.seats > 1
      ? `${brl(sub.plan.price_cents)} por mês (${sub.seats} × ${brl(Math.round(sub.plan.price_cents / sub.seats))})`
      : `${brl(sub.plan.price_cents)} por mês`;
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
    $('#pay-btn').textContent = sub.first_charge ? `Pagar ${brl(sub.first_charge.cents)}`
      : failed ? (state.card_enabled ? 'Pagar com outro cartão ou Pix' : `Pagar ${fmtMonth(next.month)} por Pix`)
      : cancelled ? 'Reativar plano'
      : `Pagar ${fmtMonth(next.month)}`;
    $('#charge-info').textContent = cancelled
      ? 'Seu plano está cancelado. Você não será mais cobrado.'
      : scheduled ? 'Cancelamento agendado: nenhuma nova cobrança será feita.'
      : failed ? `A cobrança automática no ${card} não foi aprovada. ${state.card_enabled ? 'Pague com outro cartão' : 'Pague por Pix'} para manter o acesso.`
      : apOn ? (nextDate ? `Renovação automática: em ${nextDate} cobramos ${brl(sub.plan.price_cents)} no ${card}. Você não precisa fazer nada.` : 'Renovação automática ligada.')
      : next.current_paid
        ? (state.card_subscription ? 'Sua mensalidade deste mês está paga. Perto do próximo vencimento avisamos você pelo WhatsApp. Se quiser, ative a renovação automática no cartão ao pagar a próxima.'
          : 'Sua mensalidade deste mês está paga. Perto do próximo vencimento avisamos você pelo WhatsApp.')
        : sub.status === 'pausado' ? `Seu plano está desativado por falta de pagamento. Pague a mensalidade de ${fmtMonth(next.month)} para reativar: o plano volta assim que o pagamento for confirmado.`
        : sub.plan.sold_out ? `O plano ${sub.plan.name} está esgotado no momento. Escolha outro plano ou fale com o suporte.`
        : sub.first_charge ? firstChargeNote(sub).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ')
        : active && notDueYet(sub) ? `Próxima mensalidade (${fmtMonth(next.month)}): ${brl(sub.plan.price_cents)}, vence em ${fmtDate(dueDateOf(next.month, sub.due_day))}. Você já pode pagar${!state.card_enabled ? ' por Pix' : state.pix_enabled ? ' com cartão de crédito ou Pix' : ' no cartão de crédito'}.`
        : state.pix_enabled
          ? (state.card_subscription ? `Mensalidade de ${fmtMonth(next.month)} em aberto. Pague por Pix ou cartão de crédito (no cartão, só este mês ou com renovação automática).`
            : `Mensalidade de ${fmtMonth(next.month)} em aberto. Pague ${state.card_enabled ? 'com cartão de crédito ou Pix' : 'por Pix'}. Todo mês você paga de novo (avisamos pelo WhatsApp antes do vencimento).`)
          : state.card_subscription
            ? `Mensalidade de ${fmtMonth(next.month)} em aberto. O pagamento é no cartão de crédito, com renovação automática todo mês.`
            : `Mensalidade de ${fmtMonth(next.month)} em aberto. Pague no cartão de crédito. Todo mês você paga de novo (avisamos pelo WhatsApp antes do vencimento).`;
  }

  $('#payments-card').classList.toggle('hidden', !sub);
  $('#payments').innerHTML = payments.length
    ? payments.map((p) => `<tr><td>${fmtDate(p.paid_at)}</td><td>${sub && p.ref_month < String(sub.start_date).slice(0, 7) ? '1º pagamento' : fmtMonth(p.ref_month)}</td><td><span class="pm-inline m-${esc(p.method)}">${methodIcon(p.method)}${esc(METHOD[p.method] || p.method)}</span></td><td class="r">${brl(p.amount_cents)}</td></tr>`).join('')
    : '<tr><td colspan="4" class="empty">Nenhum pagamento ainda.</td></tr>';

  show('#panel');
}

// ------------------------------------------------------------------ pagamento: cartão de crédito com renovação automática (assinatura do Mercado Pago)

let mpInstance = null;
let brickController = null;
let pixTimer = null;
let payMode = 'pay'; // 'pay' = assinar com renovação automática · 'card' = só trocar o cartão · 'once' = plano B: este mês avulso

/** Escolhe o plano (cria/atualiza a assinatura) e abre o pagamento. */
async function choosePlan(planId) {
  // plano com várias vagas (ex.: Max até 5): pergunta quantas antes de assinar
  const plans = state?.plans || (await call('/me')).plans || [];
  const plan = plans.find((p) => p.id === Number(planId));
  const sub = state?.subscription;
  const locked = sub && sub.plan.id === Number(planId) && ['ativo', 'pausado'].includes(sub.status);
  let seats = 1;
  if (plan && plan.max_seats > 1 && !locked) {
    seats = await askSeats(plan, sub?.plan.id === plan.id ? sub.seats : 1);
    if (!seats) return; // desistiu
  }
  const view = await call('/subscribe', { method: 'POST', body: { plan_id: planId, seats } });
  render(view);
  if (view.manual) {
    flash(view.manual.pix_key ? `Plano escolhido! Pague via Pix na chave ${view.manual.pix_key}.` : 'Plano escolhido! Entraremos em contato para o pagamento.', 'ok');
    return;
  }
  openPayment(cardMode());
}

/** Pergunta quantas vagas (1 até o máximo do plano). Devolve o número ou null se fechar. */
function askSeats(plan, initial = 1) {
  const max = Math.max(1, Math.min(plan.max_seats, plan.licenses_left ?? plan.max_seats));
  let n = Math.min(Math.max(1, initial), max);
  const dlg = $('#seats-dlg');
  const paint = () => {
    $('#seats-n').textContent = n;
    $('#seats-total').innerHTML = `<strong>${brl(plan.price_cents * n)}</strong>/mês${n > 1 ? ` <span class="muted">(${n} × ${brl(plan.price_cents)})</span>` : ''}`;
    $('#seats-minus').disabled = n <= 1;
    $('#seats-plus').disabled = n >= max;
  };
  $('#seats-plan').textContent = plan.name;
  $('#seats-max').textContent = max === 1 ? 'Só há 1 vaga livre neste plano agora.' : `Você pode escolher de 1 a ${max} vagas. Cada vaga é um acesso separado.`;
  $('#seats-minus').onclick = () => { if (n > 1) { n--; paint(); } };
  $('#seats-plus').onclick = () => { if (n < max) { n++; paint(); } };
  paint();
  return new Promise((resolve) => {
    dlg.onclose = () => resolve(dlg.returnValue === 'ok' ? n : null);
    dlg.returnValue = '';
    dlg.showModal();
  });
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
    // e-mail e CPF do TITULAR do cartão (passo anterior): o antifraude compara com os dados do cartão
    initialization: {
      amount: (sub.next_charge.amount_cents ?? sub.plan.price_cents) / 100,
      payer: {
        email: holder?.email || state.customer.email,
        ...(holder?.cpf ? { identification: { type: 'CPF', number: holder.cpf } } : {}),
      },
    },
    customization: {
      // só cartão de crédito, à vista: é ele que o Mercado Pago cobra todo mês
      paymentMethods: { maxInstallments: 1, types: { excluded: ['debit_card'] } },
      visual: {
        style: { theme: dark ? 'dark' : 'default' },
        // textos mais claros (o padrão do Mercado Pago diz "crédito ou débito" e "data de vencimento")
        texts: { formTitle: 'Cartão de crédito', expirationDate: { label: 'Validade do cartão' } },
      },
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
            holder: holder || undefined,
            device_id: window.MP_DEVICE_SESSION_ID || undefined,
          },
        }).then(async (out) => {
          resolve();
          if (out.status === 'challenge') return showChallenge(out);
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
            cardNote = $('#pay-month').innerHTML;
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

/** Texto do 1º pagamento proporcional (cliente novo com vencimento fixo). Vazio se não se aplica. */
function firstChargeNote(sub) {
  const f = sub.first_charge;
  if (!f) return '';
  const monthly = brl(sub.plan.price_cents);
  const dias = `${f.days} dia${f.days > 1 ? 's' : ''}`;
  const due = `dia ${sub.due_day}`;
  return f.merged
    ? `<strong>Primeiro pagamento: ${brl(f.cents)}</strong> = ${dias} até o ${due} (${brl(f.part_cents)}) + a mensalidade seguinte (${monthly}).
       Depois, <strong>${monthly} todo ${due}</strong>, a partir de ${fmtDate(f.next_due)}.`
    : `<strong>Primeiro pagamento proporcional: ${brl(f.cents)}</strong> (${dias}, até o ${due}).
       Depois, <strong>${monthly} todo ${due}</strong>, a partir de ${fmtDate(f.next_due)}.`;
}
/** Modo do pagamento no cartão: assinatura só quando ligada e não for o 1º pagamento proporcional. */
const cardMode = () => 'once'; // ao abrir, o cartão começa no avulso; o cliente pode trocar para a renovação automática
/** A renovação automática pode ser escolhida agora? (o 1º pagamento proporcional é sempre avulso) */
const canAutopay = () => Boolean(state.card_subscription && !state.subscription?.first_charge);

/** Texto explicando o que acontece no cartão, conforme o modo. */
function cardNoteFor(mode) {
  const sub = state.subscription;
  const price = brl(sub.next_charge.amount_cents ?? sub.plan.price_cents);
  const first = firstChargeNote(sub);
  if (mode === 'card') return 'As próximas cobranças automáticas serão feitas no novo cartão. <strong>Nada é cobrado agora.</strong>';
  if (first) return `${first} Nada é cobrado sozinho.`;
  if (mode === 'once') {
    return `Pagamento da mensalidade de <strong>${fmtMonth(sub.next_charge.month)} (${price})</strong> no cartão de crédito, <strong>só este mês</strong>.
      Nada é cobrado sozinho depois: no próximo mês avisamos você pelo WhatsApp para pagar de novo.`;
  }
  return `Cobramos <strong>${price} agora</strong> (mensalidade de ${fmtMonth(sub.next_charge.month)}) e depois <strong>todo mês, automaticamente</strong>, no mesmo cartão.
    Você pode cancelar quando quiser: a cobrança para e o acesso continua até o fim do período pago, sem estorno.`;
}

/** Troca entre cartão avulso ('once') e renovação automática ('pay'). */
function setCardMode(mode) {
  payMode = mode;
  document.querySelectorAll('#card-mode button').forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  cardNote = cardNoteFor(mode);
  $('#mp-link-alt').classList.toggle('hidden', mode !== 'pay');
  if (!$('#pay-card').classList.contains('hidden')) $('#pay-month').innerHTML = cardNote;
}
document.querySelectorAll('#card-mode button').forEach((b) => b.addEventListener('click', () => setCardMode(b.dataset.mode)));

function openPayment(mode = 'once') {
  const sub = state.subscription;
  if (!sub || !state.can_pay) return;
  const price = brl(sub.next_charge.amount_cents ?? sub.plan.price_cents);
  const first = firstChargeNote(sub);
  // cartão desligado para pagamentos novos: só Pix (a troca de cartão de quem já tem renovação automática continua)
  const pixOnly = !state.card_enabled && state.pix_enabled && mode !== 'card';
  $('#pay-eyebrow').innerHTML = mode === 'card' ? `${methodIcon('credito')} Trocar cartão`
    : pixOnly ? `${methodIcon('pix')} Pagamento por Pix` : `${methodIcon(state.pix_enabled ? 'pix' : 'credito')} Pagamento da mensalidade`;
  $('#pay-plan').textContent = sub.seats > 1 ? `${sub.plan.name} · ${sub.seats} vagas` : sub.plan.name;
  $('#pay-amount').textContent = first ? `${price} agora` : `${price}/mês`;
  // no cartão o cliente escolhe: só este mês ou renovação automática (menos na troca de cartão e no 1º pagamento proporcional)
  $('#card-mode').classList.toggle('hidden', !(mode !== 'card' && canAutopay() && state.card_once));
  $('#card-error').classList.add('hidden');
  $('#pay-tabs').classList.toggle('hidden', !(state.pix_enabled && state.card_enabled && mode !== 'card'));
  $('#pay-lock-text').textContent = pixOnly ? 'Pagamento processado pelo Mercado Pago.' : 'Pagamento processado pelo Mercado Pago. Os dados do cartão não passam pelo nosso servidor.';
  $('#pix-error').classList.add('hidden');
  $('#pix-start').classList.remove('hidden');
  $('#pix-show').classList.add('hidden');
  stopPix();
  setCardMode(mode === 'card' ? 'card' : canAutopay() && !state.card_once ? 'pay' : mode === 'pay' && canAutopay() ? 'pay' : 'once');
  if (pixOnly) {
    unmountBrick();
    payMethod('pix');
    $('#pay-dlg').showModal();
    return;
  }
  // abre no Pix (aprova na hora); o cartão fica na outra aba, começando pelos dados do titular
  $('#pay-dlg').showModal();
  showHolderForm();
  payMethod(mode !== 'card' && state.pix_enabled ? 'pix' : 'card');
}

// ------------------------------------------------------------------ passo 1: dados do titular do cartão

let holder = null; // { name, cpf, email, phone } do dono do cartão (fica só nesta tela)

const onlyDigits = (v) => String(v || '').replace(/\D/g, '');
function validCpf(v) {
  const d = onlyDigits(v);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const dv = (n) => {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Number(d[i]) * (n + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
}
const fmtCpf = (v) => onlyDigits(v).slice(0, 11)
  .replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2');

function showHolderForm() {
  const c = state.customer || {};
  $('#h-name').value = holder?.name || c.name || '';
  $('#h-cpf').value = holder?.cpf ? fmtCpf(holder.cpf) : '';
  $('#h-email').value = holder?.email || c.email || '';
  $('#h-phone').value = holder?.phone || c.phone || '';
  const a = holder?.address || {};
  $('#h-cep').value = a.zip ? fmtCep(a.zip) : '';
  $('#h-number').value = a.number || '';
  $('#h-street').value = a.street || '';
  $('#h-district').value = a.district || '';
  $('#h-city').value = a.city || '';
  $('#h-uf').value = a.state || '';
  $('#h-cep-info').classList.add('hidden');
  $('#holder-error').classList.add('hidden');
  $('#mp-link-alt').classList.toggle('hidden', payMode !== 'pay');
  showCardForm(false);
}

$('#h-cpf').addEventListener('input', (e) => { e.target.value = fmtCpf(e.target.value); });

// CEP: formata e, com os 8 números, busca rua, bairro, cidade e estado (ViaCEP). Se a busca falhar, o cliente digita.
const fmtCep = (v) => onlyDigits(v).slice(0, 8).replace(/^(\d{5})(\d)/, '$1-$2');
let cepLookup = '';
$('#h-cep').addEventListener('input', async (e) => {
  e.target.value = fmtCep(e.target.value);
  const cep = onlyDigits(e.target.value);
  const info = $('#h-cep-info');
  if (cep.length !== 8 || cep === cepLookup) return;
  cepLookup = cep;
  info.textContent = 'Buscando o endereço…';
  info.classList.remove('hidden');
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(`https://viacep.com.br/ws/${cep}/json/`, { signal: ctrl.signal });
    clearTimeout(timer);
    const d = await r.json();
    if (onlyDigits($('#h-cep').value) !== cep) return; // o cliente já mudou o CEP
    if (d.erro) { info.textContent = 'CEP não encontrado. Confira os números ou preencha o endereço abaixo.'; return; }
    if (d.logradouro) $('#h-street').value = d.logradouro;
    if (d.bairro) $('#h-district').value = d.bairro;
    if (d.localidade) $('#h-city').value = d.localidade;
    if (d.uf) $('#h-uf').value = d.uf;
    info.classList.add('hidden');
    if (!$('#h-number').value) $('#h-number').focus();
  } catch {
    cepLookup = '';
    info.textContent = 'Não foi possível buscar o CEP agora. Preencha o endereço abaixo.';
  }
});

$('#holder-box').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#h-name').value.trim().replace(/\s+/g, ' ');
  const cpf = onlyDigits($('#h-cpf').value);
  const email = $('#h-email').value.trim().toLowerCase();
  const phone = $('#h-phone').value.trim();
  const fail = (msg, el) => {
    $('#holder-error').textContent = msg;
    $('#holder-error').classList.remove('hidden');
    $(el).focus();
  };
  if (name.split(' ').length < 2 || name.length < 5) return fail('Digite o nome completo do titular (nome e sobrenome).', '#h-name');
  if (!validCpf(cpf)) return fail('CPF inválido. Confira os números.', '#h-cpf');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail('E-mail inválido.', '#h-email');
  if (onlyDigits(phone).length < 10) return fail('Digite o celular com DDD.', '#h-phone');
  const one = (id) => $(id).value.trim().replace(/\s+/g, ' ');
  const address = { zip: onlyDigits($('#h-cep').value), number: one('#h-number'), street: one('#h-street'), district: one('#h-district'), city: one('#h-city'), state: one('#h-uf').toUpperCase() };
  if (address.zip.length !== 8) return fail('Digite o CEP com 8 números.', '#h-cep');
  if (!address.number) return fail('Digite o número do endereço (ou S/N).', '#h-number');
  if (address.street.length < 2) return fail('Digite a rua.', '#h-street');
  if (address.district.length < 2) return fail('Digite o bairro.', '#h-district');
  if (address.city.length < 2) return fail('Digite a cidade.', '#h-city');
  if (!/^[A-Z]{2}$/.test(address.state)) return fail('Digite o estado com 2 letras (ex.: AM).', '#h-uf');
  holder = { name, cpf, email, phone, address };
  showCardForm(true);
});

// ao corrigir um campo, o aviso de erro antigo some
$('#holder-box').addEventListener('input', () => $('#holder-error').classList.add('hidden'));

$('#holder-back').addEventListener('click', (e) => {
  e.preventDefault();
  showHolderForm();
});

/** form = true: formulário do cartão (Mercado Pago); false: passo dos dados do titular. */
function showCardForm(form) {
  $('#holder-box').classList.toggle('hidden', form);
  $('#holder-edit').classList.toggle('hidden', !form);
  $('#cardPaymentBrick_container').classList.toggle('hidden', !form);
  $('#card-error').classList.add('hidden');
  if (!form) return unmountBrick();
  mountBrick().catch((err) => {
    console.error(err);
    $('#card-error').textContent = 'Não foi possível abrir o formulário do cartão. Tente de novo em instantes.';
    $('#card-error').classList.remove('hidden');
  });
}

// alternativa: assinar pela página do Mercado Pago (para quem quer usar a conta de lá)
$('#autopay-btn').addEventListener('click', async (e) => {
  e.preventDefault();
  const btn = e.currentTarget;
  if (btn.dataset.busy) return;
  btn.dataset.busy = '1';
  btn.textContent = 'Abrindo o Mercado Pago…';
  $('#card-error').classList.add('hidden');
  try {
    const { url } = await call('/autopay-link', { method: 'POST', body: {} });
    window.location.href = url;
  } catch (err) {
    $('#card-error').textContent = err.message;
    $('#card-error').classList.remove('hidden');
    delete btn.dataset.busy;
    btn.textContent = 'Assinar pelo site do Mercado Pago';
  }
});

$('#once-link')?.addEventListener('click', () => {
  payMode = 'once';
  const price = brl(state.subscription.plan.price_cents);
  $('#pay-eyebrow').innerHTML = `${methodIcon('credito')} Cartão de crédito · pagamento deste mês`;
  $('#pay-month').innerHTML = `Pague <strong>este mês (${price})</strong> no cartão, de forma avulsa (mensalidade de ${fmtMonth(state.subscription.next_charge.month)}). Sem renovação automática: no próximo mês você paga de novo.`;
  cardNote = $('#pay-month').innerHTML;
  showCardForm(true);
});

let cardNote = '';
function payMethod(method) {
  document.querySelectorAll('#pay-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.method === method));
  $('#pay-card').classList.toggle('hidden', method !== 'card');
  $('#pay-pix').classList.toggle('hidden', method !== 'pix');
  const sub = state.subscription;
  $('#pay-month').innerHTML = method === 'pix'
    ? sub.first_charge ? `${firstChargeNote(sub)} O plano ativa assim que o Pix for confirmado (leva poucos segundos).`
    : `Pix de <strong>${brl(sub.plan.price_cents)}</strong> referente à mensalidade de ${fmtMonth(sub.next_charge.month)}.
       ${state.card_subscription ? 'Com Pix, <strong>você paga todo mês</strong> (avisamos pelo WhatsApp antes do vencimento). Prefere não se preocupar? Use o cartão com renovação automática.'
         : 'O plano ativa assim que o Pix for confirmado (leva poucos segundos).'}`
    : cardNote;
}

function stopPix() {
  clearInterval(pixTimer);
  pixTimer = null;
}

// ------------------------------------------------------------------ confirmação do banco (3DS)

let challenge = null; // { orderId, timer, busy }

function stopChallenge() {
  if (challenge) clearInterval(challenge.timer);
  challenge = null;
  $('#challenge-box').classList.add('hidden');
  $('#challenge-frame').removeAttribute('src');
  $('#pay-tabs').classList.toggle('hidden', !(state?.pix_enabled && state?.card_enabled && payMode !== 'card'));
}

/** Consulta o resultado do pedido. final = true depois que o banco avisou que terminou (insiste por mais tempo). */
async function checkChallenge(showWaiting = false) {
  if (!challenge || challenge.busy) return;
  challenge.busy = true;
  try {
    const out = await call('/pay/challenge', { method: 'POST', body: { order_id: challenge.orderId } });
    if (!challenge) return;
    if (out.status === 'approved') {
      closePayment();
      render(out.view);
      return flash('Pagamento aprovado! Seu plano está ativo.', 'ok');
    }
    if (out.status === 'rejected') {
      stopChallenge();
      state = out.view;
      showHolderForm();
      $('#card-error').textContent = out.message;
      $('#card-error').classList.remove('hidden');
      return;
    }
    if (out.status === 'pending') {
      closePayment();
      render(out.view);
      return flash(out.message, 'warn');
    }
    if (showWaiting) $('#challenge-status').textContent = 'O banco ainda não confirmou. Conclua a confirmação acima.';
  } catch { /* tenta de novo no próximo ciclo */ } finally {
    if (challenge) challenge.busy = false;
  }
}

async function showChallenge(out) {
  await unmountBrick();
  $('#cardPaymentBrick_container').classList.add('hidden');
  $('#holder-edit').classList.add('hidden');
  $('#card-error').classList.add('hidden');
  $('#pay-tabs').classList.add('hidden');
  $('#challenge-status').textContent = 'Aguardando a confirmação do banco…';
  $('#challenge-frame').src = out.challenge_url;
  $('#challenge-box').classList.remove('hidden');
  const started = Date.now();
  challenge = { orderId: out.order_id, busy: false, timer: null };
  // confere a cada 5 s (o banco dá até 40 min para confirmar)
  challenge.timer = setInterval(() => {
    if (Date.now() - started > 40 * 60_000) {
      stopChallenge();
      showHolderForm();
      $('#card-error').textContent = 'O tempo para confirmar com o banco acabou. Tente de novo.';
      $('#card-error').classList.remove('hidden');
      return;
    }
    checkChallenge();
  }, 5000);
}

// o banco avisa (pelo iframe) que a confirmação terminou: confere o resultado na hora
window.addEventListener('message', (e) => {
  if (challenge && e.data?.status === 'COMPLETE') {
    $('#challenge-status').textContent = 'Confirmando o pagamento…';
    checkChallenge();
  }
});
$('#challenge-check').addEventListener('click', () => checkChallenge(true));

function closePayment() {
  stopPix();
  stopChallenge();
  unmountBrick();
  if ($('#pay-dlg').open) $('#pay-dlg').close();
}

document.querySelectorAll('.pm-slot').forEach((el) => { el.outerHTML = methodIcon(el.dataset.icon); }); // ícones nas abas
document.querySelectorAll('#pay-tabs button').forEach((b) => b.addEventListener('click', () => payMethod(b.dataset.method)));
$('#pay-close').addEventListener('click', closePayment);
$('#pay-dlg').addEventListener('cancel', () => { stopPix(); stopChallenge(); unmountBrick(); });

$('#pix-btn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Gerando…';
  $('#pix-error').classList.add('hidden');
  try {
    const { pix } = await call('/pay', { method: 'POST', body: { method: 'pix' } });
    if (pix.qr_code_base64) $('#pix-qr').src = `data:image/png;base64,${pix.qr_code_base64}`;
    $('#pix-qr').classList.toggle('hidden', !pix.qr_code_base64);
    $('#pix-code').value = pix.qr_code || '';
    $('#pix-start').classList.add('hidden');
    $('#pix-show').classList.remove('hidden');
    // confere a cada 5 s (até 30 min) se o Pix foi pago
    const started = Date.now();
    const paidBefore = state.payments.length;
    stopPix();
    pixTimer = setInterval(async () => {
      if (Date.now() - started > 30 * 60_000) return stopPix();
      try {
        const data = await call('/sync', { method: 'POST', body: { order_id: pix.order_id } });
        if (data.payments.length > paidBefore) {
          closePayment();
          render(data);
          flash('Pix recebido! Seu plano está ativo.', 'ok');
        }
      } catch { /* tenta de novo no próximo ciclo */ }
    }, 5000);
  } catch (err) {
    $('#pix-error').textContent = err.message;
    $('#pix-error').classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Gerar Pix';
  }
});

$('#pix-copy').addEventListener('click', async (e) => {
  try { await navigator.clipboard.writeText($('#pix-code').value); } catch { $('#pix-code').select(); document.execCommand('copy'); }
  e.currentTarget.textContent = 'Copiado!';
  setTimeout(() => { e.currentTarget.textContent = 'Copiar código'; }, 1800);
});

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

// sem assinatura (padrão): o botão paga só a mensalidade em aberto
$('#pay-btn').addEventListener('click', () => openPayment(cardMode()));
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

/** Voltou da página do Mercado Pago depois de assinar: confere a assinatura algumas vezes. */
async function afterMercadoPago() {
  history.replaceState(null, '', '/conta');
  flash('Conferindo sua assinatura no Mercado Pago…', 'warn');
  for (let i = 0; i < 6; i++) {
    const data = await call('/sync', { method: 'POST', body: {} }).catch(() => null);
    if (data) render(data);
    if (data?.subscription?.autopay?.status === 'authorized') {
      return flash('Assinatura confirmada! A renovação automática está ativa.', 'ok');
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  flash('Ainda não recebemos a confirmação do Mercado Pago. Se você concluiu a assinatura, ela aparece aqui em alguns minutos.', 'warn');
}

async function start(attempt = 1) {
  try {
    await call('/me');
    if (params.has('assinatura')) {
      render(await call('/me'));
      return afterMercadoPago();
    }
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
