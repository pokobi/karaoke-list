// 触覚フィードバック（スマホの振動）。強さは「弱」で固定する。
// - Android など Vibration API がある端末：短く震わせる。
// - iPhone（Safari）：Vibration API がないため、iOS 18 以降でスイッチ（<input type="checkbox" switch>）を
//   切り替えたときに出る「コッ」という触覚を借りる。操作（タップなど）の処理の中で呼んだときだけ振動する。

// 設定はオン・オフだけ（オンのときは、キーの変更・「歌った！」の記録・お気に入りの切り替え・
// ランダム選曲・スワイプで振動する）。
// 操作ごとの振動のしかた。tap：1 回／success：記録できたことが分かるよう 2 回
const KIND = { key: 'tap', fav: 'tap', sung: 'success', random: 'tap' };

// Android：震える長さと、2 回震わせるときの間隔（ミリ秒）
const TAP_MS = 10;
const PULSE_GAP = 70;
// iPhone：続けて鳴らすときの間隔（ミリ秒）
const TICK_GAP = 110;

export function defaultHaptics() {
  return { on: true };
}

// 以前の版で保存した操作ごとのオン・オフ（key・sung など）は捨てる
export function sanitizeHaptics(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  return { on: p.on !== false };
}

export function vibratePattern(kind) {
  return kind === 'success' ? [TAP_MS, PULSE_GAP, TAP_MS] : [TAP_MS];
}

export function tickCount(kind) {
  return kind === 'success' ? 2 : 1;
}

// この端末で使える振動のしかた。'ios'／'vibrate'／null（指で操作しない端末や、振動できない端末）
export function hapticMode(nav = globalThis.navigator, matchMediaFn = globalThis.matchMedia) {
  if (!nav) return null;
  const coarse = typeof matchMediaFn === 'function' && matchMediaFn('(pointer: coarse)').matches;
  if (!coarse) return null;
  const ua = nav.userAgent ?? '';
  const ios = /iPhone|iPad|iPod/.test(ua) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
  if (ios) return 'ios';
  return typeof nav.vibrate === 'function' ? 'vibrate' : null;
}

// iPhone：見えないスイッチを 1 回切り替えて、システムの触覚を鳴らす
function iosTick() {
  const label = document.createElement('label');
  label.setAttribute('aria-hidden', 'true');
  label.style.display = 'none';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('switch', '');
  label.append(input);
  // ページのほかの処理にクリックとして伝わらないようにする
  const stop = (e) => e.stopPropagation();
  label.addEventListener('click', stop);
  input.addEventListener('click', stop);
  document.head.append(label);
  label.click();
  label.remove();
}

let env = null;
function browserEnv() {
  env ??= {
    mode: hapticMode(),
    vibrate: (pattern) => globalThis.navigator.vibrate(pattern),
    tick: iosTick,
    later: (fn, ms) => setTimeout(fn, ms),
  };
  return env;
}

// event：'key'／'sung'／'fav'／'random'、または 'swipe'（スワイプが実行される位置を超えたとき）
export function playHaptic(event, prefs, e = browserEnv()) {
  const p = sanitizeHaptics(prefs);
  if (!p.on || !e.mode) return false;
  try {
    const kind = KIND[event] ?? 'tap';
    if (e.mode === 'vibrate') {
      e.vibrate(vibratePattern(kind));
      return true;
    }
    // iPhone では、指を動かしている途中（スワイプ中）には鳴らせない
    if (event === 'swipe') return false;
    const n = tickCount(kind);
    e.tick();
    for (let i = 1; i < n; i++) e.later(e.tick, i * TICK_GAP);
    return true;
  } catch {
    return false;
  }
}
