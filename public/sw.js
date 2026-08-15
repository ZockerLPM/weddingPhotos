/* Service Worker: Netz zuerst, Cache als Fallback.
 * Kein aggressives Caching – Updates sind sofort sichtbar, aber ein kurzer
 * Netzausfall wirft die Seite nicht weg.
 */
var CACHE = 'fotowand-v1';

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.pathname.indexOf('/api/') === 0) return; // API nie cachen
  if (url.pathname.indexOf('/i/') === 0) return;   // Bilder: Browser-Cache reicht

  e.respondWith(
    fetch(e.request).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      return res;
    }).catch(function () {
      return caches.match(e.request);
    })
  );
});
