// オフラインでも最後に開いた画面を表示するための Service Worker。
// アプリのファイルは通信を優先し、時間がかかるときやオフラインのときはキャッシュを使う。
// Firebase SDK はバージョン固定の URL なので、キャッシュを優先する。

const CACHE = 'karaoke-list-v4';
// 一時的に range-note という名前だったときのキャッシュも片付ける
const OLD_PREFIXES = ['karaoke-list-', 'range-note-'];
const SCOPE = new URL('./', self.location).pathname;
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/ui.js',
  './js/notes.js',
  './js/model.js',
  './js/text.js',
  './js/csv.js',
  './js/itunes.js',
  './js/history.js',
  './js/plugins.js',
  './js/random.js',
  './js/config.js',
  './js/store-local.js',
  './js/store-firebase.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
];
const NETWORK_TIMEOUT = 2500;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => OLD_PREFIXES.some((p) => k.startsWith(p)) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin && url.pathname.startsWith(SCOPE)) {
    e.respondWith(networkFirst(req));
  } else if (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) {
    e.respondWith(cacheFirst(req));
  }
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  const net = fetch(req).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  });
  const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT, null));
  const first = await Promise.race([net.catch(() => null), timeout]);
  if (first) return first;
  const hit = await cache.match(req, { ignoreSearch: true })
    ?? (req.mode === 'navigate' ? await cache.match('./index.html') : undefined);
  if (hit) return hit;
  return net;
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}
