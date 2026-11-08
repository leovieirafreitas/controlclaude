import { toast } from './utils.js';

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

async function request(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    const err = new Error('Sem conexão com o servidor.');
    err.status = 0;
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/login')) {
    onUnauthorized();
    const err = new Error('Não autenticado');
    err.status = 401;
    throw err;
  }
  if (!res.ok) {
    const message = data.error || `Erro ${res.status}`;
    if (!path.startsWith('/login') && path !== '/me') toast(message);
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  me: () => request('/me'),
  requestCode: (email) => request('/login/code', { method: 'POST', body: { email } }),
  verifyCode: (email, code) => request('/login/verify', { method: 'POST', body: { email, code } }),
  logout: () => request('/logout', { method: 'POST' }),

  dashboard: (month) => request(`/dashboard?month=${encodeURIComponent(month)}`),

  plans: () => request('/plans'),
  savePlan: (id, body) => request(id ? `/plans/${id}` : '/plans', { method: id ? 'PUT' : 'POST', body }),
  deletePlan: (id) => request(`/plans/${id}`, { method: 'DELETE' }),

  whatsapp: () => request('/whatsapp'),
  whatsappQr: () => request('/whatsapp/qr', { method: 'POST' }),
  whatsappLogout: () => request('/whatsapp/logout', { method: 'POST' }),
  whatsappTest: () => request('/whatsapp/test', { method: 'POST' }),

  settings: () => request('/settings'),
  saveSettings: (body) => request('/settings', { method: 'PUT', body }),

  subscribers: () => request('/subscribers'),
  saveSubscriber: (id, body) => request(id ? `/subscribers/${id}` : '/subscribers', { method: id ? 'PUT' : 'POST', body }),
  deleteSubscriber: (id) => request(`/subscribers/${id}`, { method: 'DELETE' }),

  payments: (month, method) => {
    const q = new URLSearchParams();
    if (month) q.set('month', month);
    if (method) q.set('method', method);
    return request(`/payments${q.size ? `?${q}` : ''}`);
  },
  createPayment: (body) => request('/payments', { method: 'POST', body }),
  deletePayment: (id) => request(`/payments/${id}`, { method: 'DELETE' }),
};
