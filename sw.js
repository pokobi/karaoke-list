// オフラインでも最後に開いた画面を表示するための Service Worker。
// アプリのファイルは通信を優先し、時間がかかるときやオフラインのときはキャッシュを使う。
// Firebase SDK はバージョン固定の URL なので、キャッシュを優先する。

const CACHE = 'karaoke-list-v29';
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
  './js/text-import.js',
  './js/plugins.js',
  './js/random.js',
  './js/random-fx.js',
  './js/haptics.js',
  './js/preview.js',
  './js/itunes-preview.js',
  './js/pitch-worklet.js',
  './js/display.js',
  './js/config.js',
  './js/store.js',
  './js/store-local.js',
  './js/store-firebase.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
];
const NETWORK_TIMEOUT = 2500;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
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

// ブラウザの HTTP キャッシュに古いファイルが残っていても使わず、毎回サーバーに更新を確かめる
// （更新直後に新旧のファイルが混ざると、読み込みに失敗して画面が出なくなるため）
function fetchFresh(req) {
  if (req.mode === 'navigate') return fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' });
  return fetch(req, { cache: 'no-cache' });
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  const net = fetchFresh(req).then((res) => {
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
