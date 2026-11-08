// 画面のあちこちで使う状態と小さな関数（読み込んだデータ、この端末の設定、おすすめキー、日付の表記など）

import { RANGE_FIELDS, isNote, keyTone, recommendKey, splitRecKey, describeKey } from '../notes.js';
import { sanitizeView, defaultView, allTags, sanitizePrefs } from '../model.js';
import { sanitizeHaptics, playHaptic } from '../haptics.js';
import { sanitizeRandomFx } from '../random-fx.js';

const VIEW_KEY = 'karaoke-list:view:v1';
// ログインの操作をしたしるし（ページを移動してログインする場合に備えて、タブの中だけに残す）
export const MOVE_AFTER_LOGIN_KEY = 'karaoke-list:move-after-login';
export const HOLD_MS = 1400;
export const DEFAULT_OCTAVE = { low: 1, chestHigh: 2, falsettoHigh: 3 };
export const wide = matchMedia('(min-width: 1024px)');

// この端末だけの設定（テーマ・一覧の文字の大きさ・スワイプ・触覚フィードバック）。アクセントカラーは起動直後の表示用に控えておく
const PREFS_KEY = 'karaoke-list:prefs:v1';
export const devicePrefs = (() => {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
    return {
      theme: p.theme === 'light' || p.theme === 'dark' ? p.theme : 'system',
      density: p.density === 'compact' || p.density === 'large' ? p.density : 'normal',
      accent: typeof p.accent === 'string' ? p.accent : 'indigo',
      swipe: p.swipe !== false,
      haptics: sanitizeHaptics(p.haptics),
      randomFx: sanitizeRandomFx(p.randomFx),
    };
  } catch {
    return { theme: 'system', density: 'normal', accent: 'indigo', swipe: true, haptics: sanitizeHaptics(), randomFx: sanitizeRandomFx() };
  }
})();

// 設定に合わせて、スマホを振動させる（設定でオフの操作や、振動できない端末では何もしない）
export const haptic = (event) => playHaptic(event, devicePrefs.haptics);

export function saveDevicePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(devicePrefs));
  } catch { /* 保存できなくても動作は続ける */ }
}

export const state = {
  store: null,
  user: null,
  unsub: null,
  // ログインした直後に、この端末の曲をアカウントへ移すか聞く
  moveAfterLogin: sessionFlag(MOVE_AFTER_LOGIN_KEY),
  signingIn: false,
  moving: false,
  loaded: false,
  songs: [],
  byId: new Map(),
  profile: { range: {}, artists: [], tags: null, prefs: sanitizePrefs(), aliases: {}, tagColors: new Map() },
  query: '',
  view: loadView(),
  visible: [],
  hold: null,
  detail: null,
  keyPop: null,
  settings: null,
  artistsSheet: null,
  filterSheet: null,
  historySheet: null,
  random: { opts: null, sheet: null, picks: [], artistQuery: '', session: null },
  filterArtistQuery: '', // 絞り込みのアーティストの検索語
  select: { on: false, ids: new Set() },
  tagSheet: null,
  bulkSheet: null,
};

export function sessionFlag(key, value) {
  try {
    if (value === undefined) return sessionStorage.getItem(key) === '1';
    if (value) sessionStorage.setItem(key, '1');
    else sessionStorage.removeItem(key);
  } catch { /* 使えなくても動く */ }
  return !!value;
}

function loadView() {
  try {
    return sanitizeView(JSON.parse(localStorage.getItem(VIEW_KEY)));
  } catch {
    return defaultView();
  }
}

export function saveView() {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(state.view));
  } catch { /* 保存できなくても動作は続ける */ }
}

export const voice = () => state.profile.range ?? {};
export const hasVoice = () => RANGE_FIELDS.some((f) => isNote(voice()[f.id]));
export const recOffset = () => state.profile.prefs?.recOffset ?? 2;
export const recUp = () => state.profile.prefs?.recUp !== false;
// 追加した曲の音域を、追加機能で自動で補うか（追加機能がないときは使わない）
export const rangeAuto = () => state.profile.prefs?.rangeAuto !== false;
export const recommend = (s) => recommendKey(s, voice(), { offset: recOffset(), allowUp: recUp() });

// 自分の音域を超える音の説明（例：「裏声最高音が1半音高い」）
export const ISSUE_LABEL = { low: ['最低音', '低い'], chestHigh: ['地声最高音', '高い'], falsettoHigh: ['裏声最高音', '高い'] };
export const issueText = (x) => `${ISSUE_LABEL[x.field][0]}が${x.by}半音${ISSUE_LABEL[x.field][1]}`;
// 注意の印の色。はみ出しが 1 半音なら薄い黄色、離れるほど赤に近づける（6 半音以上で赤）
export function warnColor(by) {
  const t = Math.min(1, Math.max(0, (by - 1) / 5));
  return `hsl(${Math.round(50 * (1 - t))} ${Math.round(92 - 12 * t)}% ${Math.round(62 - 12 * t)}%)`;
}
export const tagList = () => allTags(state.songs, state.profile.tags);
export const pad2 = (n) => String(n).padStart(2, '0');
export const fmtDate = (ms) => {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
};
export const fmtScore = (v) => (v == null ? '' : String(Math.round(v * 1000) / 1000));
// 実際のキー（原曲からのずれ）を、オク下・オク上つきの表示にする（おすすめキーなど）
// おすすめキーの表記（機械のキーが ±6 を超えるときはオク下・オク上で出す）。
// 「オク下」は下げる色、「オク上」は上げる色にし、機械のキーはその向きの色にする（例：オク下は青、+2 は赤）
export function recKeyHTML(total) {
  const d = describeKey(total, splitRecKey(total).octave);
  const oct = d.oct ? `<span class="tone-${d.octave < 0 ? 'down' : 'up'}">${d.oct}</span> ` : '';
  return `<b class="rec-key">${oct}<span class="tone-${keyTone(d.machine)}">${d.main}</span></b>`;
}
// 今のキーの設定が、おすすめキーの設定（実際のキーとオク下・オク上）と同じか
export const isRecSetting = (s, total) => s.key === total && (s.octave || 0) === splitRecKey(total).octave;

// キーの欄（一覧・詳細・フォーム共通）。オク下・オク上のときは 2 段で出す
export function paintKv(el, key, octave) {
  const d = describeKey(key, octave);
  el.innerHTML = d.oct ? `<span class="kv-oct">${d.oct}</span><span class="kv-num">${d.main}</span>` : `<span class="kv-num">${d.main}</span>`;
  el.dataset.tone = keyTone(d.machine);
  el.dataset.oct = d.octave < 0 ? 'down' : d.octave > 0 ? 'up' : '';
  el.classList.toggle('has-oct', !!d.oct);
  return d;
}

// 指定した時間だけ待つ
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
