// Permet à l'appli de s'ouvrir même sans réseau.
// Après une mise à jour des fichiers, change le numéro ci-dessous (v1 → v2…).
const CACHE = "phant-accueil-v3";
const FICHIERS = [
  "./", "index.html", "style.css", "app.js", "astuces.js", "droplets.js", "manifest.webmanifest",
  "icons/icon32.png", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FICHIERS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(cles => Promise.all(cles.filter(k => k.startsWith("phant-accueil-") && k !== CACHE).map(k => caches.delete(k)))) // ne pas toucher aux caches des autres applis du site
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Météo : toujours en direct
  if (url.hostname.endsWith("open-meteo.com")) return;

  // Fichiers de l'appli, polices et icônes : on sert la copie, et on la rafraîchit en fond
  const aGarder = url.origin === location.origin
    || url.hostname === "fonts.googleapis.com"
    || url.hostname === "fonts.gstatic.com"
    || url.pathname.startsWith("/s2/favicons");
  if (!aGarder) return;

  e.respondWith(
    caches.open(CACHE).then(async cache => {
      const copie = await cache.match(req, { ignoreSearch: url.origin === location.origin });
      const reseau = fetch(req).then(rep => {
        if (rep && (rep.ok || rep.type === "opaque")) cache.put(req, rep.clone());
        return rep;
      }).catch(() => copie);
      return copie || reseau;
    })
  );
});
