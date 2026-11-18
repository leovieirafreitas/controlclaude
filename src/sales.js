const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const digits = (v) => String(v || '').replace(/\D/g, '');

function waLink(number, text) {
  let n = digits(number);
  if (!n) return '';
  if (n.length <= 11) n = `55${n}`; // sem DDI: assume Brasil
  return `https://wa.me/${n}?text=${encodeURIComponent(text)}`;
}

const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>';

/** Selo de vagas: só aparece quando o plano tem limite de licenças. */
function spots(p) {
  if (p.sold_out) return '<p class="spots out">Esgotado: todas as vagas foram preenchidas</p>';
  if (p.licenses_left == null) return '';
  const n = p.licenses_left;
  return `<p class="spots">${n === 1 ? 'Resta só 1 vaga' : `Restam ${n} vagas`}</p>`;
}

let lastPlans = '';

function renderPlans(plans, sales = { open: true }) {
  const key = JSON.stringify([plans, sales]);
  if (key === lastPlans) return; // nada mudou: não redesenha
  lastPlans = key;
  const box = $('#plans');
  if (!plans.length) {
    box.innerHTML = '<p class="empty">Nenhum plano disponível no momento. Volte em breve.</p>';
    return;
  }
  box.classList.toggle('single', plans.length === 1);
  const notice = $('#sales-closed');
  notice.innerHTML = sales.open ? '' : `${esc(sales.message)} <a href="/espera">Entre na lista de espera</a> para ser avisado(a) primeiro.`;
  notice.classList.toggle('hidden', sales.open);
  box.innerHTML = plans.map((p) => {
    const [reais, cents] = (p.price_cents / 100).toFixed(2).split('.');
    const features = String(p.features || '').split('\n').map((f) => f.trim()).filter(Boolean);
    return `
      <article class="plan ${p.featured ? 'featured' : ''} ${p.sold_out ? 'sold-out' : ''}">
        ${p.featured ? '<span class="ribbon">Recomendado</span>' : ''}
        <h3>${esc(p.name)}</h3>
        ${p.description ? `<p class="plan-desc">${esc(p.description)}</p>` : ''}
        <div class="price">
          <span class="cur">R$</span><span class="int">${Number(reais).toLocaleString('pt-BR')}</span><span class="dec">,${cents}</span><span class="per">/mês${p.max_seats > 1 ? " por vaga" : ""}</span>
        </div>
        ${spots(p)}
        ${p.max_seats > 1 ? `<p class="plan-desc">Compre de 1 a ${p.max_seats} vagas (um acesso por vaga).</p>` : ""}
        ${features.length ? `<ul class="features">${features.map((f) => `<li>${CHECK}<span>${esc(f)}</span></li>`).join('')}</ul>` : '<div class="spacer"></div>'}
        ${p.sold_out
    ? '<button class="btn btn-outline btn-lg btn-block" disabled>Esgotado</button>'
    : !sales.open ? `<button class="btn btn-outline btn-lg btn-block" disabled>Abre em ${esc(sales.opens_label)}</button>`
    : `<a class="btn ${p.featured ? 'btn-primary' : 'btn-outline'} btn-lg btn-block" href="/conta?plano=${p.id}">Assinar ${esc(p.name)}</a>`}
      </article>`;
  }).join('');
}

function applySettings(settings) {
  const brand = settings.brand_name?.trim();
  if (brand && brand !== 'Control Claude') {
    $('#brand').textContent = brand;
    $('#footer-brand').textContent = brand;
    document.title = `${brand} · Assine agora`;
  }
  if (settings.headline) $('#headline').textContent = settings.headline;
  if (settings.subheadline) $('#subheadline').textContent = settings.subheadline;
  // vencimento no mesmo dia para todos (1º pagamento proporcional)
  if (!/^(off|0|false)$/i.test(settings.prorata_on || 'on') && $('#faq-due')) {
    const day = Number(settings.prorata_day) || 30;
    $('#faq-due').textContent = `Todo dia ${day}. No primeiro pagamento você paga só os dias até o próximo dia ${day} (valor proporcional) e, a partir daí, a mensalidade cheia todo dia ${day}${day > 28 ? ' (em fevereiro, no último dia do mês)' : ''}. Avisamos você pelo WhatsApp antes do vencimento.`;
  }
  const wa = waLink(settings.whatsapp, 'Olá! Tenho uma dúvida sobre os planos.');
  if (wa) {
    $('#wa-float').href = wa;
    $('#wa-float').classList.remove('hidden');
  }
}

$('#year').textContent = new Date().getFullYear();

const loadInfo = () => fetch('/api/public/info', { cache: 'no-store' })
  .then((r) => (r.ok ? r.json() : Promise.reject()))
  .then((data) => {
    applySettings(data.settings);
    renderPlans(data.plans, data.sales);
  });

loadInfo().catch(() => {
  $('#plans').innerHTML = '<p class="empty">Não foi possível carregar os planos. Atualize a página.</p>';
});

// O que for mudado no painel (preço, limite de licenças, esgotado) aparece aqui sem recarregar a página
setInterval(() => { if (!document.hidden) loadInfo().catch(() => {}); }, 30_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadInfo().catch(() => {}); });

// Se já estiver logado, troca "Entrar" por "Minha conta"
fetch('/api/member/me', { credentials: 'same-origin' })
  .then((r) => {
    if (!r.ok) return;
    document.querySelectorAll('a[href="/conta"]').forEach((a) => { if (a.textContent.trim() === 'Entrar') a.textContent = 'Minha conta'; });
  })
  .catch(() => {});
