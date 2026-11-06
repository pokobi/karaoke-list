// 触覚フィードバック（スマホの振動）。
// - Android など Vibration API がある端末：震える長さで強さを変える。
// - iPhone（Safari）：Vibration API がないため、iOS 18 以降でスイッチ（<input type="checkbox" switch>）を
//   切り替えたときに出る「コッ」という触覚を借りる。強さは変えられないので、鳴らす回数で強弱をつける。
//   操作（タップなど）の処理の中で呼んだときだけ振動する。

export const HAPTIC_LEVELS = [
  { id: 'weak', label: '弱' },
  { id: 'medium', label: '中' },
  { id: 'strong', label: '強' },
];

// 設定で 1 つずつオン・オフできる操作
export const HAPTIC_EVENTS = [
  { id: 'key', label: 'キーの変更' },
  { id: 'sung', label: '「歌った！」の記録' },
  { id: 'fav', label: 'お気に入りの切り替え' },
];

// 操作ごとの振動の種類。tap：1 回／success：記録できたことが分かるよう、少し多めに
const KIND = { key: 'tap', fav: 'tap', sung: 'success', test: 'tap' };

// Android の振動の種類。Web からは「何ミリ秒震わせるか」しか指定できないため、
// ごく短く震わせて、端末の「ポコッ」とした触覚に近づける候補を用意する。
// ms：強さ（弱・中・強）ごとの震える長さ（ミリ秒）、pulses：1 回の操作で震える回数
export const HAPTIC_TYPES = [
  { id: 'pop', label: 'ポコッ', desc: 'ごく短く 1 回', ms: { weak: 4, medium: 6, strong: 9 }, pulses: 1 },
  { id: 'click', label: 'コツッ', desc: '短く 1 回', ms: { weak: 8, medium: 12, strong: 18 }, pulses: 1 },
  { id: 'double', label: 'ポコポコ', desc: 'ごく短く 2 回', ms: { weak: 4, medium: 6, strong: 9 }, pulses: 2 },
  { id: 'standard', label: '標準', desc: '長めに 1 回', ms: { weak: 10, medium: 22, strong: 40 }, pulses: 1 },
];
const typeOf = (id) => HAPTIC_TYPES.find((t) => t.id === id) ?? HAPTIC_TYPES.at(-1);

// iPhone：鳴らす回数と間隔（ミリ秒）
const TICKS = { weak: 1, medium: 2, strong: 3 };
const TICK_GAP = 110;

export function defaultHaptics() {
  return { on: true, level: 'medium', type: 'standard', key: true, sung: true, fav: true };
}

export function sanitizeHaptics(raw) {
  const d = defaultHaptics();
  const p = raw && typeof raw === 'object' ? raw : {};
  const out = {
    on: p.on !== false,
    level: HAPTIC_LEVELS.some((l) => l.id === p.level) ? p.level : d.level,
    type: HAPTIC_TYPES.some((t) => t.id === p.type) ? p.type : d.type,
  };
  for (const ev of HAPTIC_EVENTS) out[ev.id] = p[ev.id] !== false;
  return out;
}

export function vibratePattern(kind, level, type = 'standard') {
  const t = typeOf(type);
  const ms = t.ms[level] ?? t.ms.medium;
  const one = t.pulses === 2 ? [ms, 45, ms] : [ms];
  return kind === 'success' ? [...one, t.pulses === 2 ? 90 : 70, ...one] : one;
}

// スワイプが実行される位置を超えたとき：選んだ種類の「弱」で 1 回だけ
export function swipePattern(type = 'standard') {
  return [typeOf(type).ms.weak];
}

export function tickCount(kind, level) {
  const n = TICKS[level] ?? TICKS.medium;
  return kind === 'success' ? n + 1 : n;
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

// event：HAPTIC_EVENTS の id、'test'（設定画面での試し）、'swipe'（スワイプが実行される位置を超えたとき）
export function playHaptic(event, prefs, e = browserEnv()) {
  const p = sanitizeHaptics(prefs);
  if (!p.on || !e.mode) return false;
  if (event in p && !p[event]) return false;
  try {
    if (e.mode === 'vibrate') {
      e.vibrate(event === 'swipe' ? swipePattern(p.type) : vibratePattern(KIND[event] ?? 'tap', p.level, p.type));
      return true;
    }
    // iPhone では、指を動かしている途中（スワイプ中）には鳴らせない
    if (event === 'swipe') return false;
    const n = tickCount(KIND[event] ?? 'tap', p.level);
    e.tick();
    for (let i = 1; i < n; i++) e.later(e.tick, i * TICK_GAP);
    return true;
  } catch {
    return false;
  }
}
