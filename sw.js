// Service worker mínimo: guarda a página para ela abrir mesmo se o box ligar sem internet.
// Estratégia "rede primeiro": sempre tenta a versão nova; sem rede, usa a cópia guardada.
var CACHE = 'painel-agro-v1';
var ARQUIVOS = ['./', 'index.html'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ARQUIVOS); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  // Só a própria página; data.json e APIs externas são tratados pelo painel (com localStorage).
  if (req.method !== 'GET' || req.mode !== 'navigate') return;
  e.respondWith(fetch(req).then(function (r) {
    var copia = r.clone();
    caches.open(CACHE).then(function (c) { c.put('index.html', copia); });
    return r;
  }).catch(function () {
    return caches.match('index.html');
  }));
});
