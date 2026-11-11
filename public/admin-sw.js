// Service worker do painel (app instalado): só recebe as notificações push.
// Não guarda páginas em cache: o painel sempre mostra os dados atuais.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data && event.data.text() }; }
  const title = data.title || 'Control Claude';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    tag: data.tag || undefined,
    icon: '/icons/admin-192.png',
    badge: '/icons/admin-192.png',
    data: { url: data.url || '/admin' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/admin', self.location.origin);
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((w) => new URL(w.url).pathname.startsWith('/admin'));
    if (win) {
      win.postMessage({ type: 'open', hash: url.hash });
      return win.focus();
    }
    return self.clients.openWindow(url.href);
  })());
});
