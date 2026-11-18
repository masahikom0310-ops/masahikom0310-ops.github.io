// オフライン対応: ネットにつながっていれば常に最新を取り、つながらないときは保存しておいたものを使う。
var CACHE = 'kantoku-20261118115758';
var SHELL = ['./', 'index.html', 'style.css?v=20261118115758', 'data.enc.js?v=20261118115758', 'engine.js?v=20261118115758', 'app.js?v=20261118115758',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon-180.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('kantoku-') === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // ページ本体(HTML)とsw.jsはブラウザのキャッシュを使わず、毎回サーバーに最新か確認する(古い版のまま動き続けないように)。
  var fresh = req.mode === 'navigate' || /\/(index\.html)?$/.test(new URL(req.url).pathname);
  e.respondWith((fresh ? fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }) : fetch(req)).then(function (res) {
    if (res && res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
    return res;
  }).catch(function () {
    return caches.match(req, { ignoreSearch: false }).then(function (hit) {
      return hit || caches.match('index.html');
    });
  }));
});
