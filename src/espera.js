// Página pública da lista de espera (/espera): nome, e-mail e WhatsApp.
// O servidor manda no WhatsApp da pessoa o link do grupo; se não conseguir, o link aparece aqui mesmo.
const $ = (s) => document.querySelector(s);
const form = $('#wait-form');
const error = form.querySelector('.form-error');

function showError(msg) {
  error.textContent = msg || '';
  error.classList.toggle('hidden', !msg);
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('');
  const data = Object.fromEntries(new FormData(form));
  if (String(data.name || '').trim().split(/\s+/).length < 2) return showError('Informe seu nome completo (nome e sobrenome).');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(data.email || '').trim())) return showError('Informe um e-mail válido.');
  if (String(data.phone || '').replace(/\D/g, '').length < 10) return showError('Informe seu WhatsApp com DDD.');

  const btn = form.querySelector('button');
  btn.disabled = true;
  btn.textContent = 'Enviando…';
  try {
    const res = await fetch('/api/public/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || 'Não foi possível concluir. Tente de novo.');

    $('#wait-msg').textContent = out.sent
      ? (out.already
        ? 'Você já estava na lista. O link do grupo foi enviado para o seu WhatsApp. Confira suas mensagens.'
        : 'Enviamos agora no seu WhatsApp o link do nosso grupo. Confira suas mensagens e entre no grupo.')
      : 'Toque no botão abaixo para entrar no nosso grupo do WhatsApp.';
    if (!out.sent && out.group_url) {
      $('#wait-group').href = out.group_url;
      $('#wait-group').classList.remove('hidden');
    }
    form.classList.add('hidden');
    $('#wait-done').classList.remove('hidden');
  } catch (err) {
    showError(err.message || 'Sem conexão. Tente de novo.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Entrar na lista de espera';
  }
});
