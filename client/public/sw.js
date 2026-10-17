// On garde en cache la coquille de l'application pour qu'elle s'ouvre sans réseau (caisse hors-ligne).
// Les données (/api) ne sont jamais mises en cache ici : la caisse garde ses propres données (offline.js).
const CACHE = 'boutique-shell-v3';
const SHELL = ['/', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put('/', copy)); return r; })
      .catch(() => caches.match('/')));
    return;
  }
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return r;
    })),
  );
});

// ----- notifications (commande envoyée en cuisine, commande prête) -----
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Boutique', body: e.data ? e.data.text() : '' }; }
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const visible = wins.some((w) => w.visibilityState === 'visible');
    for (const w of wins) w.postMessage({ type: 'push', data: d }); // l'application ouverte se met à jour tout de suite
    if (visible && d.kind !== 'test') return; // application à l'écran : elle sonne elle-même, pas de doublon
    await self.registration.showNotification(d.title || 'Boutique', {
      body: d.body || '', tag: d.tag || undefined, renotify: true, icon: '/icon-192.png', badge: '/icon-192.png',
      vibrate: d.kind === 'ready' ? [300, 120, 300, 120, 300] : [200, 100, 200], requireInteraction: d.kind === 'new' || d.kind === 'ready',
      data: { url: d.url || '/' },
    });
  })());
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) { try { await w.focus(); w.postMessage({ type: 'open', url }); return; } catch { /* essai suivant */ } }
    await self.clients.openWindow(url);
  })());
});
