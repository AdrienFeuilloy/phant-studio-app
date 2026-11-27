/* Service worker Phant Studio : permet d'ouvrir l'appli sans réseau.
   - Fichiers de l'appli : réseau d'abord (toujours la dernière version), copie de secours sinon.
   - Icônes / Tailwind : copie locale d'abord, mise à jour en arrière-plan.
   - GitHub et Gemini : jamais interceptés. */
const CACHE = 'phant-studio-v5';
const APP_FILES = ['./', 'index.html', 'script.js', 'style.css', 'manifest.webmanifest',
    'fonts/commissioner.woff2', 'fonts/passion-one.woff2'];
const CDN_HOSTS = ['cdn.tailwindcss.com', 'unpkg.com'];

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k.startsWith('phant-studio-') && k !== CACHE).map(k => caches.delete(k)))) // ne pas toucher aux caches des autres applis du site
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);

    if (url.origin === self.location.origin) {
        event.respondWith(
            fetch(req)
                .then(res => {
                    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
                    return res;
                })
                .catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
        );
        return;
    }

    if (CDN_HOSTS.includes(url.hostname)) {
        event.respondWith(
            caches.open(CACHE).then(cache => cache.match(req).then(cached => {
                const network = fetch(req).then(res => {
                    if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
                    return res;
                }).catch(() => cached);
                return cached || network;
            }))
        );
    }
});
