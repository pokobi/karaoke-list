// アプリの外のサイトを開く。
// Android でホーム画面に追加したアプリとして使っているときは、普通に開くとブラウザの簡易表示（アプリにかぶさる画面）で
// 開くので、Android のインテントで開き、規定のブラウザアプリ（そのサイトの専用アプリがあればそのアプリ）で開く。
// それ以外（PC・iPhone・ブラウザのタブで使っているとき）は、今までどおり新しいタブで開く。

const STANDALONE = ['standalone', 'fullscreen', 'minimal-ui'];

export function opensInBrowserApp() {
  if (typeof navigator === 'undefined' || typeof matchMedia !== 'function') return false;
  if (!/Android/i.test(navigator.userAgent)) return false;
  return STANDALONE.some((m) => matchMedia(`(display-mode: ${m})`).matches);
}

// https / http の URL を、Android のインテントの URL にする。それ以外は null。
// URL の「#」以降はインテントの指定と重なるので使わない
export function intentUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const scheme = u.protocol.slice(0, -1);
  u.hash = '';
  return `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=${scheme};action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;S.browser_fallback_url=${encodeURIComponent(u.href)};end`;
}

export function openExternal(url) {
  const intent = opensInBrowserApp() ? intentUrl(url) : null;
  if (!intent) {
    window.open(url, '_blank', 'noopener');
    return;
  }
  const a = document.createElement('a');
  a.href = intent;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
}

// 新しいタブで開くリンク（target="_blank"）を、上の決まりで開く。
// アプリの中で開くリンク（data-in-app）や、ほかの処理が先に受け持ったクリックはそのままにする
export function installExternalLinks() {
  window.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button > 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest?.('a[target="_blank"][href]');
    if (!a || a.hasAttribute('data-in-app') || !opensInBrowserApp()) return;
    let u;
    try {
      u = new URL(a.href);
    } catch {
      return;
    }
    if (u.origin === location.origin || !/^https?:$/.test(u.protocol)) return;
    e.preventDefault();
    openExternal(u.href);
  });
}
