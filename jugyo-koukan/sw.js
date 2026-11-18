/* 授業交換ナビ: オフラインでも起動できるようにする(画面の部品だけを保存。先生・時間割などのデータは端末の localStorage にあり、ここには含まれない) */
const CACHE = 'jugyo-koukan-v1';
const FILES = ['./', 'index.html', 'style.css', 'data.js', 'engine.js', 'nenkan.js', 'app.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon-180.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
// ネットワーク優先(更新がすぐ反映される)。つながらないときだけ保存分を使う。
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request).then((res) => { const cp = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); return res; }).catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))));
});
