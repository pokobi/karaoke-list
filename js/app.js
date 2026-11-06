import { FIREBASE_CONFIG } from './config.js';
import {
  RANGE_FIELDS, KEY_MIN, KEY_MAX, isNote, noteName, formatKey, keyTone, clampKey, recommendKey, rangeIssues,
  splitKey, describeKey, toggleOctave,
} from './notes.js';
import { collator, normalize } from './text.js';
import {
  SORTS, emptySong, normalizeSong, toPayload, dupKey, sanitizeView, defaultView, applyView, hasRangeFilter,
  artistCounts, allTags, suggestArtists, tagCounts, ACCENTS, NOTE_STYLES, REC_OFFSETS, sanitizePrefs, planLocalMove,
  TAG_COLORS, tagColorMap, tagColorList, newSongId, isRangeMissing,
} from './model.js';
import { setNoteStyle, getNoteStyle, fmtNote, fmtNoteHTML } from './display.js';
import { songsToCSV, parseCSV, rowsToSongs } from './csv.js';
import { suggestArtistsOnline, suggestSongsOnline, songsOfArtist, searchTracks, findTrack, waitForSlot, searchSongs, trimReading } from './itunes.js';
import {
  MAX_LINES, parseLines, analyzeLine, aliasMap, sanitizeAliases, scoreSongs, mergeCandidates, judge, fallbackTerms,
  guessSong, aliasToLearn, looseKey,
} from './text-import.js';
import { readHistoryFile, aggregate, thumbnailUrl } from './history.js';
import { $, $$, h, esc, icon, openSheet, choiceDialog, confirmDialog, toast, openPopover, closePopover, popoverAnchor, pickNote, promptDialog } from './ui.js';
import { createLocalStore } from './store-local.js';
import { createStore } from './store.js';
import { plugins } from './plugins.js';
import { COUNTS, EXCLUDE_DAYS, defaultRandomOptions, sanitizeRandomOptions, randomPool, pickRandom, hasRandomRange } from './random.js';
import { HAPTIC_EVENTS, sanitizeHaptics, hapticMode, playHaptic } from './haptics.js';
import { RANDOM_FX, sanitizeRandomFx, playRandomFx } from './random-fx.js';
import { previewSupported, createPreview, audioFiles, formatBytes } from './preview.js';
import { itunesPreviewSource } from './itunes-preview.js';

const VIEW_KEY = 'karaoke-list:view:v1';
// ログインの操作をしたしるし（ページを移動してログインする場合に備えて、タブの中だけに残す）
const MOVE_AFTER_LOGIN_KEY = 'karaoke-list:move-after-login';
const HOLD_MS = 1400;
const DEFAULT_OCTAVE = { low: 1, chestHigh: 2, falsettoHigh: 3 };
const wide = matchMedia('(min-width: 1024px)');

// この端末だけの設定（テーマ・一覧の文字の大きさ・スワイプ・触覚フィードバック）。アクセントカラーは起動直後の表示用に控えておく
const PREFS_KEY = 'karaoke-list:prefs:v1';
const devicePrefs = (() => {
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
const haptic = (event) => playHaptic(event, devicePrefs.haptics);

function saveDevicePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(devicePrefs));
  } catch { /* 保存できなくても動作は続ける */ }
}

const state = {
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
  random: { opts: null, sheet: null, picks: [], artistQuery: '' },
  select: { on: false, ids: new Set() },
  tagSheet: null,
  bulkSheet: null,
};

function sessionFlag(key, value) {
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

function saveView() {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(state.view));
  } catch { /* 保存できなくても動作は続ける */ }
}

const voice = () => state.profile.range ?? {};
const hasVoice = () => RANGE_FIELDS.some((f) => isNote(voice()[f.id]));
const recOffset = () => state.profile.prefs?.recOffset ?? 2;
const recommend = (s) => recommendKey(s, voice(), { offset: recOffset() });

// 自分の音域を超える音の説明（例：「裏声最高音が1半音高い」）
const ISSUE_LABEL = { low: ['最低音', '低い'], chestHigh: ['地声最高音', '高い'], falsettoHigh: ['裏声最高音', '高い'] };
const issueText = (x) => `${ISSUE_LABEL[x.field][0]}が${x.by}半音${ISSUE_LABEL[x.field][1]}`;
// 注意の印の色。はみ出しが 1 半音なら薄い黄色、離れるほど赤に近づける（6 半音以上で赤）
function warnColor(by) {
  const t = Math.min(1, Math.max(0, (by - 1) / 5));
  return `hsl(${Math.round(50 * (1 - t))} ${Math.round(92 - 12 * t)}% ${Math.round(62 - 12 * t)}%)`;
}
const tagList = () => allTags(state.songs, state.profile.tags);
const pad2 = (n) => String(n).padStart(2, '0');
const fmtDate = (ms) => {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
};
const fmtScore = (v) => (v == null ? '' : String(Math.round(v * 1000) / 1000));
const keyText = (k) => formatKey(k);
// 実際のキー（原曲からのずれ）を、オク下・オク上つきの表示にする（おすすめキーなど）
const totalKeyText = (total) => describeKey(total, splitKey(total).octave).text;

// キーの欄（一覧・詳細・フォーム共通）。オク下・オク上のときは 2 段で出す
function paintKv(el, key, octave) {
  const d = describeKey(key, octave);
  el.innerHTML = d.oct ? `<span class="kv-oct">${d.oct}</span><span class="kv-num">${d.main}</span>` : `<span class="kv-num">${d.main}</span>`;
  el.dataset.tone = keyTone(d.machine);
  el.dataset.oct = d.octave < 0 ? 'down' : d.octave > 0 ? 'up' : '';
  el.classList.toggle('has-oct', !!d.oct);
  return d;
}

// ---- 起動 -------------------------------------------------------------

boot();

async function boot() {
  applyDevicePrefs();
  registerServiceWorker();
  bindStatic();
  // ログインは任意。ログインしていなければ、この端末のブラウザだけに保存する
  const forceLocal = ['localhost', '127.0.0.1'].includes(location.hostname) && new URLSearchParams(location.search).has('local');
  state.store = createStore({
    local: createLocalStore(),
    loadRemote: FIREBASE_CONFIG && !forceLocal
      ? async () => (await import('./store-firebase.js')).createFirebaseStore(FIREBASE_CONFIG)
      : null,
  });
  state.store.onWriteError = (e) => {
    console.error(e);
    const code = errorCode(e);
    toast(code === 'permission-denied'
      ? '保存できませんでした（権限エラー：permission-denied）'
      : `保存に失敗しました（${code}）`, { duration: 7000 });
  };
  state.store.onAuth(startSession, (e) => {
    console.error(e);
    showFatal('データベースに接続できませんでした。通信状況を確認して、ページを再読み込みしてください。');
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('service worker', e));
  });
}

function showFatal(msg) {
  $('#boot').hidden = true;
  $('#app').hidden = true;
  const el = $('#fatal');
  el.innerHTML = `<p>${esc(msg)}</p><button type="button" class="btn primary" onclick="location.reload()">再読み込み</button>`;
  el.hidden = false;
}

function errorCode(e) {
  return String(e?.code ?? e?.name ?? 'unknown').replace(/^firestore\//, '');
}

function startSession(user) {
  state.unsub?.();
  state.user = user;
  state.loaded = false;
  state.loadError = null;
  $('#boot').hidden = true;
  $('#app').hidden = false;
  render();
  state.unsub = state.store.subscribe(onData, (e) => {
    console.error(e);
    if (state.loaded) {
      toast(`データを読み込めませんでした（${errorCode(e)}）`, { duration: 7000 });
      return;
    }
    state.loadError = errorCode(e);
    render();
  });
}

function onData({ songs, profile }) {
  state.songs = songs.map(normalizeSong);
  state.byId = new Map(state.songs.map((s) => [s.id, s]));
  state.profile = {
    range: profile?.range && typeof profile.range === 'object' ? profile.range : {},
    artists: Array.isArray(profile?.artists) ? profile.artists.filter((n) => typeof n === 'string') : [],
    tags: Array.isArray(profile?.tags) ? profile.tags.filter((n) => typeof n === 'string' && n.trim()) : null,
    prefs: sanitizePrefs(profile?.prefs),
    aliases: sanitizeAliases(profile?.aliases),
    tagColors: tagColorMap(profile?.tagColors),
  };
  applyAccountPrefs();
  const first = !state.loaded;
  state.loaded = true;
  render();
  paintDetail();
  paintKeyMenu();
  paintSettings();
  paintArtists();
  paintRandom();
  paintTagManager();
  paintSelbar();
  if (first && !state.user?.local && state.moveAfterLogin) {
    state.moveAfterLogin = sessionFlag(MOVE_AFTER_LOGIN_KEY, false);
    offerLocalMove({ afterLogin: true });
  }
}

// ---- ログインと、この端末のデータの移動 ---------------------------------

async function signIn() {
  if (state.signingIn) return;
  state.signingIn = true;
  paintSettings();
  state.moveAfterLogin = sessionFlag(MOVE_AFTER_LOGIN_KEY, true);
  try {
    await state.store.signIn();
  } catch (e) {
    state.moveAfterLogin = sessionFlag(MOVE_AFTER_LOGIN_KEY, false);
    if (['auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/user-cancelled'].includes(e?.code)) return;
    console.error(e);
    toast(e?.code === 'auth/unauthorized-domain'
      ? 'このURLからのログインが許可されていません。Firebase の承認済みドメインを確認してください。'
      : e?.code
        ? `ログインできませんでした（${e.code}）`
        : 'ログインできませんでした。通信状況を確認してください。', { duration: 7000 });
  } finally {
    state.signingIn = false;
    paintSettings();
  }
}

// ログインする前にこの端末に保存した曲を、アカウントへ移す（聞いてから）
async function offerLocalMove({ afterLogin = false } = {}) {
  if (state.user?.local || state.moving) return;
  const local = state.store.localData();
  const n = local.songs.length;
  if (!n) return;
  state.moving = true;
  paintSettings();
  try {
    let account;
    try {
      account = await state.store.fetchAccount();
    } catch (e) {
      console.error(e);
      toast('アカウントの曲を確かめられなかったため、この端末の曲はまだ移していません。設定の「アカウント」から移せます。', { duration: 7000 });
      return;
    }
    if (state.user?.local) return;
    const plan = planLocalMove(local, account);
    const message = [
      'ログインする前に、この端末に保存した曲です。アカウントにある曲は変わりません。',
      plan.skipped.length ? `うち${plan.skipped.length}曲は、アカウントにある曲と同じアーティスト・曲名のため追加しません。` : '',
      afterLogin ? '移さない場合はこの端末に残り、あとから設定の「アカウント」で移せます。' : '',
    ].filter(Boolean).join('\n');
    const ok = await choiceDialog({
      title: `この端末の${n}曲をアカウントに移しますか？`,
      message,
      choices: [{ value: false, label: afterLogin ? 'あとで' : 'キャンセル' }, { value: true, label: '移す', kind: 'primary' }],
    });
    // 聞いている間にログアウトしたら、何もしない（端末のリストに書いてしまわないように）
    if (!ok || state.user?.local) return;
    const saved = state.store.putSongs(plan.add.map(({ id, data }) => ({ id, data })));
    if (Object.keys(plan.profile).length) state.store.updateProfile(plan.profile);
    if (plan.artists.length) state.store.addArtists(plan.artists);
    toast(plan.add.length ? `${plan.add.length}曲をアカウントに移しました` : '移す曲はありませんでした（すべてアカウントにある曲でした）');
    relinkAudioFiles(plan);
    // サーバーに届いてから、この端末のリストを空にする（届く前に閉じても、次に移すときは同じ曲として扱う）
    if (await saved) state.store.clearLocal();
  } finally {
    state.moving = false;
    paintSettings();
  }
}

// 試聴の音楽ファイルは曲の ID で結び付いているので、ID が変わる曲・追加しない曲のファイルを付け替える
async function relinkAudioFiles(plan) {
  if (!previewSupported()) return;
  const moves = [
    ...plan.add.filter((e) => e.id !== e.from).map((e) => ({ from: e.from, to: e.id })),
    ...plan.skipped,
  ];
  for (const { from, to } of moves) {
    try {
      const rec = await audioFiles.get(from);
      if (!rec) continue;
      if (!(await audioFiles.get(to))) await audioFiles.put(to, rec);
      await audioFiles.remove(from);
    } catch (e) {
      console.warn(e);
    }
  }
}

// ---- 一覧の描画 -------------------------------------------------------

const items = new Map();
let holdTimer = 0;

function render() {
  if (!state.loaded) {
    if (state.loadError) renderLoadError();
    else renderSkeleton();
    return;
  }
  let list = applyView(state.songs, state.view, state.query);
  list = applyHold(list);
  state.visible = list;
  renderList(list);
  renderMeta(list);
  renderFilterPanel();
  renderChips();
  renderEmpty(list);
}

// キーを変えた直後は並び順と表示中の曲を固定し、押している行が動かないようにする
function holdOrder() {
  state.hold = { ids: state.visible.map((s) => s.id), until: Date.now() + HOLD_MS };
  clearTimeout(holdTimer);
  holdTimer = setTimeout(() => {
    state.hold = null;
    render();
  }, HOLD_MS + 30);
}

function applyHold(list) {
  const hd = state.hold;
  if (!hd || Date.now() > hd.until) return list;
  const prev = new Set(hd.ids);
  return [...hd.ids.map((id) => state.byId.get(id)).filter(Boolean), ...list.filter((s) => !prev.has(s.id))];
}

function renderSkeleton() {
  const ul = $('#list');
  if ($('.skeleton', ul)) return;
  ul.replaceChildren(...Array.from({ length: 8 }, () => h('<li class="song skeleton" aria-hidden="true"><span class="sk sk-main"></span><span class="sk sk-range"></span><span class="sk sk-key"></span></li>')));
  $('#empty').hidden = true;
  $('#count').textContent = '';
}

function renderLoadError() {
  $('#list').replaceChildren();
  $('#count').textContent = '';
  const el = $('#empty');
  el.hidden = false;
  el.innerHTML = `<div class="empty-icon">${icon('close')}</div>
    <p class="empty-title">データを読み込めませんでした</p>
    <p class="empty-text">エラー：${esc(state.loadError)}${state.loadError === 'permission-denied' ? '<br>データベースのアクセス権限の設定を確認してください。' : '<br>通信状況を確認して、再読み込みしてください。'}</p>
    <div class="empty-actions"><button type="button" class="btn primary" data-act="reload">${icon('refresh')}再読み込み</button></div>`;
}

function createItem(id) {
  const el = h(`<li class="song" data-id="${esc(id)}">
    <div class="swipe-bg" aria-hidden="true"><span class="sw-l">${icon('mic')}歌った！</span><span class="sw-r">${icon('star-fill')}<span class="sw-r-t">お気に入り</span></span></div>
    <div class="song-inner">
    <span class="sel-mark" aria-hidden="true">${icon('check')}</span>
    <span class="art" aria-hidden="true">${icon('music')}<img alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" hidden></span>
    <button type="button" class="song-main">
      <span class="song-title">${icon('star-fill', 'fav')}<span class="t"></span></span>
      <span class="song-sub"><span class="a"></span><span class="cnt" hidden><span class="vh">歌った回数</span>${icon('mic')}<span class="cn"></span><span class="vh">回</span></span><span class="tags"></span></span>
    </button>
    <div class="range" role="group" aria-label="音域">
      ${RANGE_FIELDS.map((f) => `<div class="rc"><span class="rl">${f.short}</span><span class="rv"></span><span class="vh rw"></span></div>`).join('')}
    </div>
    <div class="keyctl" role="group" aria-label="キー">
      <button type="button" class="kb k-down" aria-label="キーを1下げる">${icon('minus')}</button>
      <button type="button" class="kv"></button>
      <button type="button" class="kb k-up" aria-label="キーを1上げる">${icon('plus')}</button>
    </div>
    </div>
  </li>`);
  const art = $('.art img', el);
  // 読み込み中は透明にしておく（非表示にすると遅延読み込みが始まらないため）
  art.addEventListener('error', () => { art.hidden = true; });
  art.addEventListener('load', () => art.classList.add('ok'));
  return {
    el,
    art,
    t: $('.t', el),
    a: $('.a', el),
    tags: $('.tags', el),
    cnt: $('.cnt', el),
    cn: $('.cn', el),
    fav: $('.fav', el),
    rc: $$('.rc', el),
    rv: $$('.rv', el),
    rw: $$('.rw', el),
    kv: $('.kv', el),
    swR: $('.sw-r-t', el),
    kd: $('.k-down', el),
    ku: $('.k-up', el),
    sig: '',
  };
}

function updateItem(it, s) {
  const vo = voice();
  const sig = [s.title, s.artist, s.favorite, s.singCount, s.tags.map((t) => `${t}:${state.profile.tagColors.get(t) ?? ''}`).join('|'), s.low, s.chestHigh, s.falsettoHigh, s.key, s.octave, s.artwork, vo.low, vo.chestHigh, vo.falsettoHigh].join('\u0001');
  if (sig === it.sig) return;
  it.sig = sig;
  if (s.artwork) {
    if (it.art.getAttribute('src') !== s.artwork) {
      it.art.classList.remove('ok');
      it.art.hidden = false;
      it.art.src = s.artwork;
    }
  } else {
    it.art.hidden = true;
    it.art.removeAttribute('src');
  }
  it.t.textContent = s.title;
  it.a.textContent = s.artist;
  it.cnt.hidden = !s.singCount;
  it.cn.textContent = s.singCount ? String(s.singCount) : '';
  it.fav.style.display = s.favorite ? '' : 'none';
  it.swR.textContent = s.favorite ? '解除' : 'お気に入り';
  const shown = s.tags.slice(0, 2);
  it.tags.innerHTML = shown.map((t) => `<span class="tag"${tagC(t)}>${esc(t)}</span>`).join('') + (s.tags.length > 2 ? `<span class="tag more">+${s.tags.length - 2}</span>` : '');
  // 今のキーで自分の音域を超える音は、行に色を付ける（詳細画面の注意の印と同じ色）
  const issues = hasVoice() ? rangeIssues(s, vo, s.key) : [];
  RANGE_FIELDS.forEach((f, i) => {
    const v = s[f.id];
    const el = it.rv[i];
    const text = isNote(v) ? fmtNote(v + s.key) : '—';
    el.textContent = text;
    el.classList.toggle('none', !isNote(v));
    el.classList.toggle('long', text.length >= 7);
    el.classList.toggle('xlong', text.length >= 9);
    const issue = issues.find((x) => x.field === f.id);
    const rc = it.rc[i];
    const note = issue ? `自分の音域より${issue.by}半音${ISSUE_LABEL[f.id][1]}` : '';
    rc.classList.toggle('warn', !!issue);
    if (issue) rc.style.setProperty('--warn', warnColor(issue.by));
    else rc.style.removeProperty('--warn');
    rc.title = note;
    it.rw[i].textContent = note ? `（${note}）` : '';
  });
  const kd = paintKv(it.kv, s.key, s.octave);
  it.kv.setAttribute('aria-label', `キー ${kd.text}${kd.oct ? `（実際 ${kd.actual}）` : ''}。原キー・オク下・オク上のメニューを開く`);
  it.kd.disabled = s.key <= KEY_MIN;
  it.ku.disabled = s.key >= KEY_MAX;
}

function renderList(list) {
  const ul = $('#list');
  ul.classList.toggle('no-art', !state.view.showArt);
  ul.classList.toggle('selecting', state.select.on);
  $$('.skeleton', ul).forEach((el) => el.remove());
  const seen = new Set();
  let prev = null;
  let index = 0;
  for (const s of list) {
    let it = items.get(s.id);
    if (!it) {
      it = createItem(s.id);
      items.set(s.id, it);
    }
    // 最初に見える範囲の画像はすぐ読み込み、それより下は画面に近づいてから読み込む
    const loading = index++ < 16 ? 'eager' : 'lazy';
    if (it.art.loading !== loading) it.art.loading = loading;
    updateItem(it, s);
    it.el.classList.toggle('selected', state.select.on && state.select.ids.has(s.id));
    seen.add(s.id);
    const expected = prev ? prev.nextSibling : ul.firstChild;
    if (expected !== it.el) ul.insertBefore(it.el, expected);
    prev = it.el;
  }
  for (const [id, it] of items) {
    if (seen.has(id)) continue;
    it.el.remove();
    if (!state.byId.has(id)) items.delete(id);
  }
}

function filterCount() {
  const v = state.view;
  return (v.favoriteOnly ? 1 : 0) + (v.missingRange ? 1 : 0) + (v.artist ? 1 : 0) + v.tags.length
    + RANGE_FIELDS.filter((f) => isNote(v.range[f.id]?.min) || isNote(v.range[f.id]?.max)).length;
}

function renderMeta(list) {
  const total = state.songs.length;
  const filtered = list.length !== total || filterCount() > 0 || state.query.trim();
  $('#count').innerHTML = filtered && total
    ? `<b>${list.length}</b><span class="of"> / ${total}曲</span>`
    : `<b>${total}</b><span class="of">曲</span>`;
  const sort = SORTS.find((s) => s.id === state.view.sortBy);
  $('#sort-label').textContent = sort.label;
  const dirBtn = $('#btn-sort-dir');
  dirBtn.innerHTML = icon(state.view.sortDir === 'asc' ? 'arrow-up' : 'arrow-down');
  dirBtn.setAttribute('aria-label', state.view.sortDir === 'asc' ? '昇順（タップで降順）' : '降順（タップで昇順）');
  $('#btn-filter .dot').hidden = filterCount() === 0;
}

let chipsSig = '';
function renderChips() {
  const v = state.view;
  const chips = [];
  if (v.favoriteOnly) chips.push({ k: 'fav', label: `${icon('star-fill', 'chip-star')}お気に入り` });
  if (v.missingRange) chips.push({ k: 'missing', label: '音域未入力' });
  if (v.artist) chips.push({ k: 'artist', label: esc(v.artist) });
  for (const t of v.tags) chips.push({ k: `tag:${t}`, label: `${icon('tag')}${esc(t)}` });
  for (const f of RANGE_FIELDS) {
    const { min, max } = v.range[f.id] ?? {};
    if (!isNote(min) && !isNote(max)) continue;
    const text = isNote(min) && isNote(max) ? `${fmtNote(min)}〜${fmtNote(max)}` : isNote(min) ? `${fmtNote(min)}以上` : `${fmtNote(max)}以下`;
    chips.push({ k: `range:${f.id}`, label: `${f.short} ${text}${v.basis === 'original' ? '（原曲）' : ''}` });
  }
  const sig = JSON.stringify(chips);
  if (sig === chipsSig) return;
  chipsSig = sig;
  const el = $('#chips');
  el.hidden = !chips.length;
  el.innerHTML = chips.map((c) => `<button type="button" class="achip" data-chip="${esc(c.k)}" aria-label="条件を外す">${c.label}${icon('close', 'x')}</button>`).join('')
    + (chips.length > 1 ? '<button type="button" class="achip-clear" data-chip="all">すべて解除</button>' : '');
}

let fpSig = '';
function renderFilterPanel() {
  const counts = artistCounts(state.songs);
  const tags = tagList();
  const sig = JSON.stringify([state.view, [...counts], tags, getNoteStyle()]);
  if (sig === fpSig) return;
  fpSig = sig;
  const v = state.view;
  $('#f-fav').checked = v.favoriteOnly;
  $('#f-missing').checked = v.missingRange;
  const names = [...counts.keys()].sort(collator.compare);
  if (v.artist && !counts.has(v.artist)) names.unshift(v.artist);
  $('#f-artist').innerHTML = `<option value="">すべてのアーティスト</option>`
    + names.map((n) => `<option value="${esc(n)}"${n === v.artist ? ' selected' : ''}>${esc(n)}（${counts.get(n) ?? 0}）</option>`).join('');
  $('#f-tags').innerHTML = tags.map((t) => `<button type="button" class="chip${v.tags.includes(t) ? ' on' : ''}"${tagC(t)} data-tag="${esc(t)}" aria-pressed="${v.tags.includes(t)}">${esc(t)}</button>`).join('');
  $$('#f-basis button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === v.basis)));
  $('#f-range').innerHTML = RANGE_FIELDS.map((f) => {
    const { min, max } = v.range[f.id] ?? {};
    return `<div class="rf-row" data-field="${f.id}">
      <span class="rf-label">${f.label}</span>
      <button type="button" class="rf-btn${isNote(min) ? ' set' : ''}" data-bound="min">${isNote(min) ? fmtNote(min) : '下限なし'}</button>
      <span class="rf-sep">〜</span>
      <button type="button" class="rf-btn${isNote(max) ? ' set' : ''}" data-bound="max">${isNote(max) ? fmtNote(max) : '上限なし'}</button>
    </div>`;
  }).join('');
  $('#filter-panel [data-act="reset"]').disabled = filterCount() === 0;
}

function renderEmpty(list) {
  const el = $('#empty');
  if (list.length) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  if (!state.songs.length) {
    el.innerHTML = `<div class="empty-icon">${icon('music')}</div>
      <p class="empty-title">まだ曲が登録されていません</p>
      <p class="empty-text">右下の ＋ から曲を登録できます。CSV からまとめて読み込むこともできます。</p>
      <div class="empty-actions"><button type="button" class="btn primary" data-act="add">${icon('plus')}曲を登録</button><button type="button" class="btn" data-act="import">${icon('upload')}CSVを読み込む</button></div>
      ${state.user?.local && state.store.canSignIn ? `<div class="empty-login">
        <p class="empty-text">ログインしなくても使えます。Google アカウントでログインすると、スマホと PC で同じリストを使えます。</p>
        <button type="button" class="btn sm" data-act="login">${icon('login')}Google でログイン</button>
      </div>` : ''}`;
  } else {
    el.innerHTML = `<div class="empty-icon">${icon('search')}</div>
      <p class="empty-title">条件に合う曲がありません</p>
      <div class="empty-actions"><button type="button" class="btn" data-act="clear">検索と絞り込みを解除</button></div>`;
  }
}

function updateView(patch) {
  state.view = { ...state.view, ...patch };
  saveView();
  state.hold = null;
  render();
}

function clearFilters() {
  const d = defaultView();
  updateView({ favoriteOnly: false, missingRange: false, artist: '', tags: [], range: d.range });
}

// ---- 固定の要素のイベント ---------------------------------------------

function bindStatic() {
  const q = $('#q');
  q.addEventListener('input', () => {
    state.query = q.value;
    $('#q-clear').hidden = !q.value;
    state.hold = null;
    render();
  });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') q.blur();
  });
  $('#q-clear').addEventListener('click', () => {
    q.value = '';
    state.query = '';
    $('#q-clear').hidden = true;
    render();
    q.focus();
  });

  $('#btn-filter').addEventListener('click', openFilterSheet);
  $('#btn-menu').addEventListener('click', openSettings);
  $('#btn-sort').addEventListener('click', (e) => openSortMenu(e.currentTarget));
  $('#btn-sort-dir').addEventListener('click', () => updateView({ sortDir: state.view.sortDir === 'asc' ? 'desc' : 'asc' }));
  $('#btn-random').addEventListener('click', openRandom);
  $('#btn-select').addEventListener('click', () => setSelectMode(!state.select.on));
  $('#selbar').addEventListener('click', onSelbarClick);
  setupSwipe($('#list'));
  $('#fab').addEventListener('click', () => openForm());

  $('#list').addEventListener('click', (e) => {
    const li = e.target.closest('.song');
    if (!li || li.classList.contains('skeleton')) return;
    const id = li.dataset.id;
    const s = state.byId.get(id);
    if (!s) return;
    if (state.select.on) {
      toggleSelect(id);
      return;
    }
    if (e.target.closest('.k-up')) setKey(id, s.key + 1);
    else if (e.target.closest('.k-down')) setKey(id, s.key - 1);
    else if (e.target.closest('.kv')) openKeyMenu(id, e.target.closest('.kv'));
    else if (e.target.closest('.song-main, .art')) openDetail(id);
  });

  $('#chips').addEventListener('click', (e) => {
    const k = e.target.closest('[data-chip]')?.dataset.chip;
    if (!k) return;
    if (k === 'all') clearFilters();
    else if (k === 'fav') updateView({ favoriteOnly: false });
    else if (k === 'missing') updateView({ missingRange: false });
    else if (k === 'artist') updateView({ artist: '' });
    else if (k.startsWith('tag:')) updateView({ tags: state.view.tags.filter((t) => t !== k.slice(4)) });
    else if (k.startsWith('range:')) updateView({ range: { ...state.view.range, [k.slice(6)]: {} } });
  });

  $('#empty').addEventListener('click', (e) => {
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (a === 'add') openForm();
    else if (a === 'login') signIn();
    else if (a === 'reload') location.reload();
    else if (a === 'import') $('#csv-file').click();
    else if (a === 'clear') {
      $('#q').value = '';
      state.query = '';
      $('#q-clear').hidden = true;
      clearFilters();
    }
  });

  const fp = $('#filter-panel');
  fp.addEventListener('change', (e) => {
    if (e.target.id === 'f-fav') updateView({ favoriteOnly: e.target.checked });
    else if (e.target.id === 'f-missing') updateView({ missingRange: e.target.checked });
    else if (e.target.id === 'f-artist') updateView({ artist: e.target.value });
  });
  fp.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.tag != null) {
      const t = b.dataset.tag;
      const tags = state.view.tags.includes(t) ? state.view.tags.filter((x) => x !== t) : [...state.view.tags, t];
      updateView({ tags });
    } else if (b.dataset.v) {
      updateView({ basis: b.dataset.v });
    } else if (b.dataset.bound) {
      const field = b.closest('[data-field]').dataset.field;
      const bound = b.dataset.bound;
      const f = RANGE_FIELDS.find((x) => x.id === field);
      const r = state.view.range[field] ?? {};
      const v = await pickNote({
        title: `${f.label}の${bound === 'min' ? '下限' : '上限'}`,
        value: r[bound] ?? null,
        octave: DEFAULT_OCTAVE[field],
        clearLabel: '指定なし',
      });
      if (v === undefined) return;
      const next = { ...r, [bound]: v ?? undefined };
      if (isNote(next.min) && isNote(next.max) && next.min > next.max) [next.min, next.max] = [next.max, next.min];
      updateView({ range: { ...state.view.range, [field]: next } });
    } else if (b.dataset.act === 'reset') {
      clearFilters();
    } else if (b.dataset.act === 'close') {
      state.filterSheet?.close();
    }
  });

  $('#csv-file').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) importCSV(file);
  });

  $('#history-file').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) importHistory(file);
  });

  wide.addEventListener('change', () => {
    if (wide.matches) state.filterSheet?.close();
  });
}

function openFilterSheet() {
  if (wide.matches) return;
  const panel = $('#filter-panel');
  state.filterSheet = openSheet(panel, {
    label: '絞り込み',
    className: 'filter-layer',
    onClose: () => { state.filterSheet = null; },
    onRemoved: () => $('#sidebar').append(panel),
  });
}

function openSortMenu(anchor) {
  if (popoverAnchor() === anchor) {
    closePopover();
    return;
  }
  const html = `<div class="menu" role="menu">${SORTS.map((s) => {
    const on = s.id === state.view.sortBy;
    return `<button type="button" role="menuitemradio" aria-checked="${on}" data-sort="${s.id}"><span>${esc(s.label)}</span>${on ? icon('check') : ''}</button>`;
  }).join('')}</div>`;
  const p = openPopover(anchor, html, { className: 'pop-menu' });
  p.el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-sort]');
    if (!b) return;
    const s = SORTS.find((x) => x.id === b.dataset.sort);
    if (state.view.sortBy === s.id) updateView({ sortDir: state.view.sortDir === 'asc' ? 'desc' : 'asc' });
    else updateView({ sortBy: s.id, sortDir: s.dir });
    closePopover();
  });
}

// ---- キー -------------------------------------------------------------

function setKey(id, key, octave) {
  const s = state.byId.get(id);
  if (!s) return;
  const k = clampKey(key);
  const o = octave ?? s.octave;
  if (k === s.key && o === s.octave) return;
  haptic('key');
  s.key = k;
  s.octave = o;
  holdOrder();
  render();
  paintDetail();
  paintKeyMenu();
  state.store.updateSong(id, { key: k, octave: o });
}

// おすすめキーなど「実際のキー」で指定するとき。機械で設定できない分はオク下・オク上に回す
function setTotalKey(id, total) {
  setKey(id, total, splitKey(clampKey(total)).octave);
}

function toggleOct(id, target) {
  const s = state.byId.get(id);
  if (!s) return;
  const r = toggleOctave(s.key, s.octave, target);
  setKey(id, r.key, r.octave);
}

function recommendHTML(s, { compact = false } = {}) {
  if (!hasVoice()) {
    return `<button type="button" class="rec-link" data-act="voice">${icon('mic')}<span>自分の音域を登録すると、おすすめキーを表示します</span></button>`;
  }
  const rec = recommend(s);
  if (!rec) return '<p class="rec-note">音域が未入力のため、おすすめキーを計算できません</p>';
  const note = rec.fits ? '' : `<p class="rec-note warn" style="--warn:${warnColor(Math.max(...rec.issues.map((x) => x.by)))}">${icon('alert')}<span>おすすめキーでも、${rec.issues.map(issueText).join('、')}です</span></p>`;
  if (rec.key === s.key) {
    return `<div class="rec-ok">${icon('check')}<span>おすすめキー（<b class="tone-${keyTone(splitKey(rec.key).machine)}">${totalKeyText(rec.key)}</b>）です</span></div>${note}`;
  }
  return `<button type="button" class="rec-btn" data-k="${rec.key}">
      <span class="rec-l">おすすめ</span><b class="tone-${keyTone(splitKey(rec.key).machine)}">${totalKeyText(rec.key)}</b><span class="rec-go">${compact ? '' : 'に変更'}${icon('chevron-right')}</span>
    </button>${note}`;
}

function openKeyMenu(id, anchor) {
  if (popoverAnchor() === anchor) {
    closePopover();
    return;
  }
  const p = openPopover(anchor, '<div class="keymenu"></div>', {
    className: 'pop-key',
    onClose: () => { state.keyPop = null; },
  });
  state.keyPop = { id, el: p.el };
  paintKeyMenu();
  p.el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !state.keyPop) return;
    const s = state.byId.get(state.keyPop.id);
    if (!s) return;
    if (b.dataset.k != null) {
      setTotalKey(s.id, +b.dataset.k);
      closePopover();
    } else if (b.dataset.oct != null) {
      toggleOct(s.id, +b.dataset.oct);
      closePopover();
    } else if (b.dataset.act === 'voice') {
      closePopover();
      openSettings();
    } else if (b.dataset.plugin != null) {
      closePopover();
      runRangeAction(+b.dataset.plugin, songPluginCtx(s.id));
    }
  });
}

function paintKeyMenu() {
  const kp = state.keyPop;
  if (!kp) return;
  const s = state.byId.get(kp.id);
  if (!s) {
    closePopover();
    return;
  }
  const kd = describeKey(s.key, s.octave);
  $('.keymenu', kp.el).innerHTML = `
    <div class="km-head"><span class="km-title">キー</span><span class="km-curs"><b class="km-cur">${kd.oct ? `<span class="km-oct" data-oct="${kd.octave < 0 ? 'down' : 'up'}">${kd.oct}</span> ` : ''}<span class="tone-${keyTone(kd.machine)}">${kd.main}</span></b>${kd.oct ? `<span class="km-actual">実際 ${kd.actual}</span>` : ''}</span></div>
    <div class="km-row">
      <button type="button" class="km-btn" data-k="0"${s.key === 0 && !s.octave ? ' aria-pressed="true"' : ''}>${icon('reset')}<span>原キー</span></button>
      <button type="button" class="km-btn" data-oct="-1"${s.octave === -1 ? ' aria-pressed="true"' : ''}>${icon('octave')}<span>オク下</span></button>
      <button type="button" class="km-btn" data-oct="1"${s.octave === 1 ? ' aria-pressed="true"' : ''}>${icon('octave', 'flip')}<span>オク上</span></button>
    </div>
    <div class="km-rec">${recommendHTML(s, { compact: true })}</div>
    ${rangeActions().length ? `<div class="km-plug">${rangeActions().map((a, i) => `<button type="button" class="km-btn km-wide" data-plugin="${i}">${icon(a.icon ?? 'search')}<span>${esc(a.label)}</span></button>`).join('')}</div>` : ''}`;
}

// ---- 曲の詳細 ---------------------------------------------------------

function openDetail(id) {
  let preview = null;
  const sheet = openSheet('<div class="detail"></div>', {
    label: '曲の詳細',
    className: 'detail-layer',
    onClose: () => {
      preview?.destroy();
      if (state.detail?.sheet === sheet) state.detail = null;
    },
  });
  preview = previewSupported()
    ? createPreview({ getSong: () => state.byId.get(id), sources: previewSources(), ctx: previewCtx(id) })
    : null;
  state.detail = { id, sheet, sig: '', preview };
  paintDetail();
  sheet.el.addEventListener('click', onDetailClick);
}

function paintDetail() {
  const d = state.detail;
  if (!d) return;
  const s = state.byId.get(d.id);
  if (!s) {
    d.sheet.close();
    return;
  }
  const root = $('.detail', d.sheet.el);
  const sig = JSON.stringify([d.id, s.title, s.artist, s.favorite, s.tags, s.memo, s.score, s.singCount, s.lastSungAt, s.low, s.chestHigh, s.falsettoHigh, s.artwork, s.ext, voice(), state.profile.tags, getNoteStyle(), recOffset()]);
  let restore = null;
  if (sig !== d.sig) {
    d.sig = sig;
    // 描き直しても、スクロール位置と押したボタンはそのまま保つ（最後に戻す）
    restore = keepViewState(root);
    root.innerHTML = detailHTML(s, d);
  }
  const kd = paintKv($('[data-role="kv"]', root), s.key, s.octave);
  const actual = $('[data-role="actual"]', root);
  actual.hidden = !kd.oct;
  actual.innerHTML = kd.oct ? `実際のキー（原曲から）：<b class="tone-${keyTone(s.key)}">${kd.actual}</b>` : '';
  $('[data-act="k-down"]', root).disabled = s.key <= KEY_MIN;
  $('[data-act="k-up"]', root).disabled = s.key >= KEY_MAX;
  $('[data-act="k-reset"]', root).setAttribute('aria-pressed', String(s.key === 0 && !s.octave));
  $('[data-act="k-oct-down"]', root).setAttribute('aria-pressed', String(s.octave === -1));
  $('[data-act="k-oct-up"]', root).setAttribute('aria-pressed', String(s.octave === 1));
  // 今のキーで自分の音域を超える音には、注意の印を付ける
  const issues = hasVoice() ? rangeIssues(s, voice(), s.key) : [];
  for (const f of RANGE_FIELDS) {
    const td = $(`[data-role="cur-${f.id}"]`, root);
    const v = s[f.id];
    const issue = issues.find((x) => x.field === f.id);
    td.innerHTML = (isNote(v) ? fmtNoteHTML(v + s.key) : '—')
      + (issue ? `<span class="range-warn" style="--warn:${warnColor(issue.by)}" title="自分の音域より${issue.by}半音${ISSUE_LABEL[f.id][1]}" aria-label="自分の音域より${issue.by}半音${ISSUE_LABEL[f.id][1]}">${icon('alert')}</span>` : '');
    td.dataset.tone = isNote(v) ? keyTone(s.key) : 'zero';
    td.classList.toggle('over', !!issue);
  }
  $('[data-role="rec"]', root).innerHTML = recommendHTML(s);
  d.preview?.paint($('[data-role="preview"]', root));
  restore?.();
}

// 中身を描き直す前に呼ぶ。スクロールしている部分の位置と、フォーカスのあったボタンを覚え、
// 戻り値の関数で、描き直したあとの同じ場所に戻す
const FOCUS_KEYS = ['data-act', 'data-dtag', 'data-tag', 'data-plugin', 'data-opt', 'data-field'];
function keepViewState(root) {
  const scrolls = $$('.sheet-body', root).map((el) => el.scrollTop);
  const a = document.activeElement;
  let focus = null;
  if (a && a !== root && root.contains(a)) {
    const name = FOCUS_KEYS.find((k) => a.hasAttribute(k));
    if (name) focus = `[${name}="${CSS.escape(a.getAttribute(name))}"]`;
  }
  return () => {
    $$('.sheet-body', root).forEach((el, i) => {
      if (scrolls[i]) el.scrollTop = scrolls[i];
    });
    if (focus) $(focus, root)?.focus({ preventScroll: true });
  };
}

function detailHTML(s, d) {
  const vo = voice();
  const showVoice = hasVoice();
  const rows = RANGE_FIELDS.map((f) => {
    const v = s[f.id];
    return `<tr>
      <th scope="row">${f.label}</th>
      <td class="orig">${isNote(v) ? fmtNoteHTML(v) : '<span class="none">—</span>'}</td>
      <td class="cur" data-role="cur-${f.id}"></td>
      ${showVoice ? `<td class="mine">${isNote(vo[f.id]) ? fmtNoteHTML(vo[f.id]) : '—'}</td>` : ''}
    </tr>`;
  }).join('');
  return `
    <div class="sheet-head d-head">
      ${s.artwork ? `<img class="d-art" src="${esc(s.artwork)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
      <div class="d-titles">
        <h3 class="d-title">${esc(s.title)}</h3>
        <button type="button" class="d-artist" data-act="artist" title="このアーティストで絞り込む">${esc(s.artist)}${icon('chevron-right')}</button>
      </div>
      <button type="button" class="icon-btn d-fav${s.favorite ? ' on' : ''}" data-act="fav" aria-pressed="${s.favorite}" aria-label="お気に入り">${icon(s.favorite ? 'star-fill' : 'star')}</button>
      <button type="button" class="icon-btn" data-act="close" aria-label="閉じる">${icon('close')}</button>
    </div>
    <div class="sheet-body">
      <section class="d-sec d-keysec">
        <div class="d-keyrow">
          <div class="stepper lg">
            <button type="button" class="kb" data-act="k-down" aria-label="キーを1下げる">${icon('minus')}</button>
            <output class="kv" data-role="kv"></output>
            <button type="button" class="kb" data-act="k-up" aria-label="キーを1上げる">${icon('plus')}</button>
          </div>
          <div class="d-keybtns">
            <button type="button" class="pill" data-act="k-reset">${icon('reset')}原キー</button>
            <button type="button" class="pill" data-act="k-oct-down">${icon('octave')}オク下</button>
            <button type="button" class="pill" data-act="k-oct-up">${icon('octave', 'flip')}オク上</button>
          </div>
        </div>
        <p class="d-actual" data-role="actual" hidden></p>
        <div class="d-rec" data-role="rec"></div>
      </section>
      <table class="d-range">
        <thead><tr><th></th><th scope="col">原曲</th><th scope="col">キー適用後</th>${showVoice ? '<th scope="col">自分</th>' : ''}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${pluginDetailHTML(s)}
      ${rangeActionsHTML('d-ractions')}
      ${d.preview ? '<section class="d-sec d-pv" data-role="preview"></section>' : ''}
      <div class="d-stats">
        <div class="stat"><span class="sl">歌った回数</span><span class="sv">${s.singCount}<small>回</small></span>${s.singCount || s.lastSungAt ? `<button type="button" class="stat-reset" data-act="sung-reset" aria-label="歌った回数をリセット" title="歌った回数をリセット">${icon('reset')}</button>` : ''}</div>
        <div class="stat"><span class="sl">最終歌唱日</span><span class="sv">${s.lastSungAt ? fmtDate(s.lastSungAt) : '—'}</span></div>
        <div class="stat"><span class="sl">採点</span><span class="sv">${s.score != null ? `${fmtScore(s.score)}<small>点</small>` : '—'}</span></div>
      </div>
      <button type="button" class="btn primary wide sung" data-act="sung">${icon('mic')}歌った！</button>
      <section class="d-sec d-tagsec">
        <span class="label">タグ</span>
        <div class="chip-set">${tagList().map((t) => `<button type="button" class="chip${s.tags.includes(t) ? ' on' : ''}"${tagC(t)} data-dtag="${esc(t)}" aria-pressed="${s.tags.includes(t)}">${esc(t)}</button>`).join('')}<button type="button" class="chip add" data-act="tag-new">${icon('plus')}新しいタグ</button></div>
      </section>
      ${s.memo ? `<div class="d-memo">${esc(s.memo)}</div>` : ''}
    </div>
    <div class="sheet-foot">
      <button type="button" class="btn danger-ghost" data-act="delete">${icon('trash')}削除</button>
      <button type="button" class="btn" data-act="edit">${icon('edit')}編集</button>
    </div>`;
}

async function onDetailClick(e) {
  const b = e.target.closest('button');
  const d = state.detail;
  if (!b || !d) return;
  if (b.closest('[data-role="preview"]')) return;
  const s = state.byId.get(d.id);
  if (!s) return;
  if (b.dataset.k != null) {
    setTotalKey(s.id, +b.dataset.k);
    return;
  }
  if (b.dataset.plugin != null) {
    runRangeAction(+b.dataset.plugin, songPluginCtx(s.id));
    return;
  }
  if (b.dataset.act === 'range-web') {
    openRangeSearch(s.artist, s.title);
    return;
  }
  if (b.dataset.dtag != null) {
    const t = b.dataset.dtag;
    state.store.updateSong(s.id, { tags: s.tags.includes(t) ? s.tags.filter((x) => x !== t) : [...s.tags, t] });
    return;
  }
  switch (b.dataset.act) {
    case 'close': d.sheet.close(); break;
    case 'tag-new': {
      const name = await askNewTag();
      if (name && !s.tags.includes(name)) state.store.updateSong(s.id, { tags: [...s.tags, name] });
      break;
    }
    case 'k-down': setKey(s.id, s.key - 1); break;
    case 'k-up': setKey(s.id, s.key + 1); break;
    case 'k-reset': setKey(s.id, 0, 0); break;
    case 'k-oct-down': toggleOct(s.id, -1); break;
    case 'k-oct-up': toggleOct(s.id, 1); break;
    case 'fav':
      haptic('fav');
      state.store.updateSong(s.id, { favorite: !s.favorite });
      break;
    case 'sung': markSung(s.id); break;
    case 'sung-reset': resetSung(s.id); break;
    case 'voice': openSettings(); break;
    case 'edit': openForm(s); break;
    case 'delete': removeSong(s.id); break;
    case 'artist':
      d.sheet.close();
      updateView({ artist: s.artist });
      toast(`「${s.artist}」の曲を表示しています`);
      break;
    default:
  }
}

function markSung(id) {
  const s = state.byId.get(id);
  if (!s) return;
  const prev = { singCount: s.singCount, lastSungAt: s.lastSungAt };
  const next = { singCount: s.singCount + 1, lastSungAt: Date.now() };
  haptic('sung');
  state.store.updateSong(id, next);
  toast(`${next.singCount}回目を記録しました`, {
    action: '元に戻す',
    onAction: () => state.store.updateSong(id, prev),
  });
}

// 歌った回数を 0 に戻す（最終歌唱日も消す）。あとから元に戻せる
async function resetSung(id) {
  const s = state.byId.get(id);
  if (!s || (!s.singCount && !s.lastSungAt)) return;
  const ok = await confirmDialog({
    title: '歌った回数をリセットしますか？',
    message: `歌った回数（${s.singCount}回）を 0 にして、最終歌唱日も消します。`,
    ok: 'リセット',
    danger: true,
  });
  if (!ok) return;
  const prev = { singCount: s.singCount, lastSungAt: s.lastSungAt };
  state.store.updateSong(id, { singCount: 0, lastSungAt: null });
  toast('歌った回数をリセットしました', {
    action: '元に戻す',
    onAction: () => state.store.updateSong(id, prev),
  });
}

async function removeSong(id) {
  const s = state.byId.get(id);
  if (!s) return;
  const ok = await confirmDialog({
    title: 'この曲を削除しますか？',
    message: `${s.title}${s.artist ? ` / ${s.artist}` : ''}\n削除すると元に戻せません。`,
    ok: '削除する',
    danger: true,
  });
  if (!ok) return;
  if (state.detail?.id === id) state.detail.sheet.close();
  state.store.deleteSong(id);
  removeAudioFiles([id]);
  toast('削除しました');
}

// ---- ランダム選曲 -----------------------------------------------------
// 一覧の絞り込みとは別に、専用の条件を持つ。条件はこの端末に記憶する。

const RANDOM_KEY = 'karaoke-list:random:v1';

function loadRandomOptions() {
  try {
    return sanitizeRandomOptions(JSON.parse(localStorage.getItem(RANDOM_KEY)));
  } catch {
    return defaultRandomOptions();
  }
}

function saveRandomOptions() {
  try {
    localStorage.setItem(RANDOM_KEY, JSON.stringify(state.random.opts));
  } catch { /* 保存できなくても動作は続ける */ }
}

const randomPoolNow = () => randomPool(state.songs, state.random.opts, { voice: voice(), offset: recOffset() });

function hasRandomCondition() {
  const o = state.random.opts;
  return o.favoriteOnly || o.artists.length > 0 || o.tags.length > 0 || o.fitsVoice || o.excludeDays > 0 || o.preferLessSung || hasRandomRange(o);
}

function reroll() {
  const r = state.random;
  stopRandomFx();
  r.picks = pickRandom(randomPoolNow(), r.opts.count, { weighted: r.opts.preferLessSung, avoid: new Set(r.picks) }).map((s) => s.id);
  r.step = 'result';
  paintRandom();
  $('.sheet-body', r.sheet.el).scrollTop = 0;
  startRandomFx();
}

// ---- 選んでいる途中の演出 ----

function stopRandomFx() {
  const r = state.random;
  r.anim?.cancel();
  r.anim = null;
  r.animDirty = false;
}

function startRandomFx() {
  const r = state.random;
  const sheet = r.sheet;
  const style = devicePrefs.randomFx;
  if (!sheet || style === 'none' || !r.picks.length) return;
  const box = $('[data-role="results"]', sheet.el);
  const songs = r.picks.map((id) => state.byId.get(id)).filter(Boolean);
  const single = songs.length === 1;
  const targets = single
    ? [{ item: $('.rnd-card', box), face: $('.rnd-main', box), song: songs[0] }]
    : $$('.rnd-list > li', box).map((li, i) => ({ item: li, face: $('.rnd-row', li), song: songs[i] }));
  if (!targets.length || targets.some((x) => !x.item || !x.face || !x.song)) return;
  const pool = randomPoolNow();
  const poolEl = $('[data-role="pool"]', sheet.el);
  const doneText = poolEl.textContent;
  poolEl.textContent = `条件に合う ${pool.length}曲 から選んでいます…`;
  r.anim = playRandomFx(style, targets, {
    pool,
    render: single ? (s) => rndMainHTML(s) : (s, i) => rndRowHTML(s, i),
    backHTML: icon('dice'),
    onLand: () => haptic('random'),
    onDone: () => {
      poolEl.textContent = doneText;
      // 演出中にデータが変わっていたら、ここで描き直す
      if (r.animDirty) {
        r.animDirty = false;
        paintRandomResults(randomPoolNow().length);
      }
    },
  });
}

// 条件の画面（step = 'cond'）と結果の画面（step = 'result'）を切り替えて描く
function paintRandom() {
  const r = state.random;
  const sheet = r.sheet;
  if (!sheet) return;
  const poolSize = randomPoolNow().length;
  const result = r.step === 'result';
  $('[data-role="cond-view"]', sheet.el).hidden = result;
  $('[data-role="result-view"]', sheet.el).hidden = !result;
  $$('[data-count]', sheet.el).forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.count === r.opts.count)));
  const foot = $('[data-role="foot"]', sheet.el);
  if (result) {
    foot.innerHTML = `<button type="button" class="btn" data-act="cond">${icon('filter')}条件を変える</button>`
      + `<button type="button" class="btn primary" data-act="reroll"${poolSize ? '' : ' disabled'}>${icon('dice')}もう一度</button>`;
    paintRandomResults(poolSize);
  } else {
    const n = Math.min(r.opts.count, poolSize);
    foot.innerHTML = `<button type="button" class="btn" data-act="reset"${hasRandomCondition() ? '' : ' disabled'}>リセット</button>`
      + `<button type="button" class="btn primary" data-act="draw"${poolSize ? '' : ' disabled'}>${icon('dice')}${poolSize ? `${poolSize}曲から${n}曲選ぶ` : '条件に合う曲がありません'}</button>`;
  }
}

function openRandom() {
  if (state.random.sheet) return;
  state.random.opts ??= loadRandomOptions();
  const sheet = openSheet(`<div class="random">
      <div class="sheet-head"><h3>ランダム選曲</h3><button type="button" class="icon-btn" data-act="close" aria-label="閉じる">${icon('close')}</button></div>
      <div class="sheet-body">
        <div data-role="cond-view">
          <span class="set-label">選ぶ曲数</span>
          <div class="seg rnd-count" role="group" aria-label="選ぶ曲数">${COUNTS.map((c) => `<button type="button" data-count="${c}">${c}曲</button>`).join('')}</div>
          <div class="rnd-cond" data-role="cond"></div>
        </div>
        <div data-role="result-view" hidden>
          <p class="rnd-pool" data-role="pool"></p>
          <div class="rnd-results" data-role="results"></div>
          <p class="rnd-sum" data-role="sum"></p>
        </div>
      </div>
      <div class="sheet-foot rnd-foot" data-role="foot"></div>
    </div>`, {
    label: 'ランダム選曲',
    className: 'random-layer',
    onClose: () => {
      stopRandomFx();
      state.random.sheet = null;
    },
  });
  state.random.sheet = sheet;
  state.random.picks = [];
  state.random.step = 'cond';
  paintRandomConditions();
  paintRandom();
  sheet.el.addEventListener('click', onRandomClick);
  sheet.el.addEventListener('change', (e) => {
    const key = e.target.dataset.opt;
    if (key) updateRandom({ [key]: e.target.checked });
  });
  sheet.el.addEventListener('input', (e) => {
    if (e.target.dataset.role !== 'artist-q') return;
    state.random.artistQuery = e.target.value;
    paintArtistChips();
  });
}

function updateRandom(patch) {
  state.random.opts = { ...state.random.opts, ...patch };
  saveRandomOptions();
  paintRandomConditions();
  paintRandom();
}

function rangeText(s) {
  const parts = RANGE_FIELDS.filter((f) => isNote(s[f.id])).map((f) => `${f.short} ${fmtNote(s[f.id] + s.key)}`);
  return parts.length ? parts.join('・') : '音域未入力';
}

function randomArt(s, cls) {
  return `<span class="${cls}">${icon('music')}${s.artwork ? `<img src="${esc(s.artwork)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}</span>`;
}

function randomKeyText(s) {
  const d = describeKey(s.key, s.octave);
  return d.oct ? `${d.text}（実際 ${d.actual}）` : d.text;
}

function randomRec(s) {
  if (!hasVoice()) return '';
  const rec = recommend(s);
  if (!rec || rec.key === s.key) return '';
  return `<button type="button" class="pill rnd-rec" data-rec="${esc(s.id)}" data-k="${rec.key}">おすすめキー <b class="tone-${keyTone(splitKey(rec.key).machine)}">${totalKeyText(rec.key)}</b> にする</button>`;
}

const rndMainHTML = (s) => `${randomArt(s, 'rnd-art')}
  <span class="rnd-text"><span class="rnd-title">${esc(s.title)}</span><span class="rnd-artist">${esc(s.artist)}</span></span>`;

const rndRowHTML = (s, i) => `<span class="rnd-no">${i + 1}</span>
  ${randomArt(s, 'rnd-art sm')}
  <span class="rnd-text"><span class="rnd-title">${esc(s.title)}</span><span class="rnd-artist">${esc(s.artist)}</span><span class="rnd-range">${rangeText(s)}</span></span>
  <span class="rnd-key" data-tone="${keyTone(describeKey(s.key, s.octave).machine)}">${describeKey(s.key, s.octave).text}</span>`;

function paintRandomResults(poolSize) {
  const r = state.random;
  const sheet = r.sheet;
  if (!sheet) return;
  // 演出の途中は描き直さない（終わってから描き直す）
  if (r.anim?.active) {
    r.animDirty = true;
    return;
  }
  $('[data-role="pool"]', sheet.el).textContent = poolSize ? `条件に合う ${poolSize}曲 から選びました` : '';
  const picks = r.picks.map((id) => state.byId.get(id)).filter(Boolean);
  const box = $('[data-role="results"]', sheet.el);
  if (!picks.length) {
    box.innerHTML = `<div class="rnd-empty">
      <p class="empty-title">${state.songs.length ? '条件に合う曲がありません' : 'まだ曲が登録されていません'}</p>
      ${hasRandomCondition() ? '<p class="hint">「条件を変える」から、条件をゆるめてみてください。</p>' : ''}
    </div>`;
  } else if (picks.length === 1) {
    const s = picks[0];
    box.innerHTML = `<div class="rnd-card">
      <button type="button" class="rnd-main" data-open="${esc(s.id)}">${rndMainHTML(s)}</button>
      <div class="rnd-info"><span class="rnd-key" data-tone="${keyTone(describeKey(s.key, s.octave).machine)}">キー ${randomKeyText(s)}</span><span class="rnd-range">${rangeText(s)}</span></div>
      ${randomRec(s)}
      <div class="rnd-actions">
        <button type="button" class="btn" data-open="${esc(s.id)}">詳細を見る</button>
        <button type="button" class="btn" data-sung="${esc(s.id)}">${icon('mic')}歌った！</button>
      </div>
    </div>`;
  } else {
    box.innerHTML = `<ol class="rnd-list">${picks.map((s, i) => `<li>
      <button type="button" class="rnd-row" data-open="${esc(s.id)}">${rndRowHTML(s, i)}</button>
      ${randomRec(s)}
    </li>`).join('')}</ol>`;
  }
  $('[data-role="sum"]', sheet.el).innerHTML = randomSummary();
}

function randomSummary() {
  const o = state.random.opts;
  const parts = [];
  if (o.favoriteOnly) parts.push('お気に入り');
  if (o.artists.length) parts.push(o.artists.length === 1 ? o.artists[0] : `${o.artists[0]} ほか${o.artists.length - 1}組`);
  if (o.tags.length) parts.push(o.tags.join('・'));
  if (o.fitsVoice) parts.push(o.fitsMode === 'current' ? '今のキーで歌える' : '歌える曲');
  if (o.excludeDays) parts.push(`${o.excludeDays}日以内に歌った曲を除く`);
  if (o.preferLessSung) parts.push('歌っていない曲を優先');
  if (hasRandomRange(o)) parts.push('音域の高さ');
  return `<span class="rnd-sum-l">条件</span><span class="rnd-sum-t">${parts.length ? esc(parts.join(' / ')) : 'なし（すべての曲から）'}</span>`;
}

function paintRandomConditions() {
  const sheet = state.random.sheet;
  if (!sheet) return;
  const o = state.random.opts;
  const artistCount = artistCounts(state.songs).size;
  const tags = tagList();
  const voiceOk = hasVoice();
  $('[data-role="cond"]', sheet.el).innerHTML = `
    <label class="switch-row"><span>お気に入りのみ</span><input type="checkbox" class="switch" data-opt="favoriteOnly"${o.favoriteOnly ? ' checked' : ''}></label>
    <div class="fp-sec">
      <div class="label-row"><span class="label">アーティスト${o.artists.length ? `（${o.artists.length}組を選択中）` : ''}</span>${o.artists.length ? '<button type="button" class="link-btn" data-act="artists-clear">選択を解除</button>' : ''}</div>
      ${artistCount > 12 ? `<label class="search sm">${icon('search')}<input type="search" data-role="artist-q" placeholder="アーティストを探す" autocomplete="off" aria-label="アーティストを探す" value="${esc(state.random.artistQuery)}"></label>` : ''}
      <div class="chip-set" data-role="artist-chips"></div>
    </div>
    <div class="fp-sec">
      <span class="label">タグ</span>
      <div class="chip-set">${tags.map((t) => `<button type="button" class="chip${o.tags.includes(t) ? ' on' : ''}"${tagC(t)} data-tag="${esc(t)}" aria-pressed="${o.tags.includes(t)}">${esc(t)}</button>`).join('')}</div>
    </div>
    <div class="fp-sec">
      <label class="switch-row"><span>自分の音域で歌える曲だけ</span><input type="checkbox" class="switch" data-opt="fitsVoice"${o.fitsVoice && voiceOk ? ' checked' : ''}${voiceOk ? '' : ' disabled'}></label>
      ${voiceOk
        ? `<div class="seg seg-sm rnd-wide" role="group" aria-label="歌えるかの判定"><button type="button" data-mode="recommend" aria-pressed="${o.fitsMode === 'recommend'}">おすすめキーにすれば歌える</button><button type="button" data-mode="current" aria-pressed="${o.fitsMode === 'current'}">今のキーで歌える</button></div>`
        : '<p class="hint">設定で自分の音域を登録すると使えます。</p>'}
    </div>
    <div class="fp-sec">
      <span class="label">最近歌った曲を除く</span>
      <div class="seg seg-sm rnd-wide" role="group" aria-label="最近歌った曲を除く">${EXCLUDE_DAYS.map((d) => `<button type="button" data-days="${d}" aria-pressed="${o.excludeDays === d}">${d ? `${d}日以内` : 'しない'}</button>`).join('')}</div>
    </div>
    <label class="switch-row"><span>あまり歌っていない曲を出やすく</span><input type="checkbox" class="switch" data-opt="preferLessSung"${o.preferLessSung ? ' checked' : ''}></label>
    <div class="fp-sec">
      <span class="label">音域の高さ（キー適用後の音）</span>
      <div class="rf">${RANGE_FIELDS.map((f) => {
        const { min, max } = o.range[f.id] ?? {};
        return `<div class="rf-row" data-rfield="${f.id}">
          <span class="rf-label">${f.label}</span>
          <button type="button" class="rf-btn${isNote(min) ? ' set' : ''}" data-bound="min">${isNote(min) ? fmtNote(min) : '下限なし'}</button>
          <span class="rf-sep">〜</span>
          <button type="button" class="rf-btn${isNote(max) ? ' set' : ''}" data-bound="max">${isNote(max) ? fmtNote(max) : '上限なし'}</button>
        </div>`;
      }).join('')}</div>
    </div>`;
  paintArtistChips();
}

// アーティストの選択肢。選択中を先に、そのあと曲数の多い順。多いときは検索で絞る
function paintArtistChips() {
  const sheet = state.random.sheet;
  const box = sheet && $('[data-role="artist-chips"]', sheet.el);
  if (!box) return;
  const o = state.random.opts;
  const counts = artistCounts(state.songs);
  const q = normalize(state.random.artistQuery);
  const LIMIT = 40;
  const names = [...counts.keys()]
    .filter((n) => o.artists.includes(n) || !q || normalize(n).includes(q))
    .sort((a, b) => Number(o.artists.includes(b)) - Number(o.artists.includes(a)) || counts.get(b) - counts.get(a) || collator.compare(a, b));
  box.innerHTML = names.slice(0, LIMIT).map((n) => {
    const on = o.artists.includes(n);
    return `<button type="button" class="chip${on ? ' on' : ''}" data-artist="${esc(n)}" aria-pressed="${on}">${esc(n)}<span class="chip-n">${counts.get(n)}</span></button>`;
  }).join('') + (names.length > LIMIT ? `<span class="hint">ほか${names.length - LIMIT}組（検索で絞り込めます）</span>` : '')
    + (!names.length ? '<span class="hint">見つかりません</span>' : '');
}

async function onRandomClick(e) {
  const b = e.target.closest('button');
  const r = state.random;
  if (r.anim?.active && !e.target.closest('[data-act="close"]')) {
    e.preventDefault();
    r.anim.finish();
    return;
  }
  if (!b || !r.sheet) return;
  const o = r.opts;
  if (b.dataset.count) {
    r.opts = { ...o, count: +b.dataset.count };
    saveRandomOptions();
    paintRandom();
  } else if (b.dataset.artist != null) {
    const n = b.dataset.artist;
    updateRandom({ artists: o.artists.includes(n) ? o.artists.filter((x) => x !== n) : [...o.artists, n] });
  } else if (b.dataset.tag != null) {
    const t = b.dataset.tag;
    updateRandom({ tags: o.tags.includes(t) ? o.tags.filter((x) => x !== t) : [...o.tags, t] });
  } else if (b.dataset.mode) {
    updateRandom({ fitsMode: b.dataset.mode, fitsVoice: true });
  } else if (b.dataset.days != null) {
    updateRandom({ excludeDays: +b.dataset.days });
  } else if (b.dataset.bound) {
    const field = b.closest('[data-rfield]').dataset.rfield;
    const bound = b.dataset.bound;
    const f = RANGE_FIELDS.find((x) => x.id === field);
    const cur = o.range[field] ?? {};
    const v = await pickNote({ title: `${f.label}の${bound === 'min' ? '下限' : '上限'}`, value: cur[bound] ?? null, octave: DEFAULT_OCTAVE[field], clearLabel: '指定なし' });
    if (v === undefined) return;
    const next = { ...cur, [bound]: v ?? undefined };
    if (isNote(next.min) && isNote(next.max) && next.min > next.max) [next.min, next.max] = [next.max, next.min];
    updateRandom({ range: { ...o.range, [field]: next } });
  } else if (b.dataset.open) {
    openDetail(b.dataset.open);
  } else if (b.dataset.sung) {
    markSung(b.dataset.sung);
  } else if (b.dataset.rec) {
    setTotalKey(b.dataset.rec, +b.dataset.k);
    paintRandom();
  } else {
    switch (b.dataset.act) {
      case 'close': r.sheet.close(); break;
      case 'draw':
      case 'reroll': reroll(); break;
      case 'cond':
        stopRandomFx();
        r.step = 'cond';
        paintRandomConditions();
        paintRandom();
        $('.sheet-body', r.sheet.el).scrollTop = 0;
        break;
      case 'artists-clear': updateRandom({ artists: [] }); break;
      case 'reset':
        r.artistQuery = '';
        updateRandom({ ...defaultRandomOptions(), count: o.count });
        break;
      default:
    }
  }
}

// ---- 登録・編集フォーム -----------------------------------------------

function formHTML(isNew, openMore) {
  return `<form class="form" novalidate autocomplete="off">
    <div class="sheet-head">
      <h3>${isNew ? '曲を登録' : '曲を編集'}</h3>
      <button type="button" class="icon-btn" data-act="cancel" aria-label="閉じる">${icon('close')}</button>
    </div>
    <div class="sheet-body">
      <div class="field ac">
        <label class="label" for="fm-artist">アーティスト</label>
        <input class="input" id="fm-artist" name="artist" maxlength="100" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="next"
          role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="fm-artist-list">
        <ul class="ac-list" id="fm-artist-list" role="listbox" hidden></ul>
      </div>
      <div class="field ac">
        <label class="label" for="fm-title">曲名</label>
        <input class="input" id="fm-title" name="title" maxlength="150" autocomplete="off" enterkeyhint="done"
          role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="fm-title-list">
        <ul class="ac-list song-ac" id="fm-title-list" role="listbox" hidden></ul>
      </div>
      <div class="field">
        <span class="label">ジャケット画像</span>
        <div class="art-edit">
          <span class="art-prev" data-role="art-prev">${icon('music')}<img alt="" referrerpolicy="no-referrer" hidden></span>
          <button type="button" class="pill" data-act="art-find">${icon('search')}画像を探す</button>
          <button type="button" class="pill" data-act="art-clear" hidden>${icon('close')}外す</button>
        </div>
        <p class="hint">曲名を候補から選ぶと自動で入ります。未設定のまま登録すると、あとから自動で探します。</p>
      </div>
      <div class="field">
        <span class="label">音域</span>
        <div class="note-fields">
          ${RANGE_FIELDS.map((f) => `<button type="button" class="note-field" data-field="${f.id}"><span class="nf-l">${f.label}</span><span class="nf-v"></span></button>`).join('')}
        </div>
        <p class="field-warn" data-role="range-warn" hidden></p>
        ${rangeActionsHTML()}
      </div>
      <div class="field">
        <span class="label">キー</span>
        <div class="key-edit">
          <div class="stepper">
            <button type="button" class="kb" data-act="k-down" aria-label="キーを1下げる">${icon('minus')}</button>
            <output class="kv" data-role="kv"></output>
            <button type="button" class="kb" data-act="k-up" aria-label="キーを1上げる">${icon('plus')}</button>
          </div>
          <button type="button" class="pill" data-act="k-reset">${icon('reset')}原キー</button>
          <button type="button" class="pill" data-act="k-oct-down">${icon('octave')}オク下</button>
          <button type="button" class="pill" data-act="k-oct-up">${icon('octave', 'flip')}オク上</button>
          <span class="key-actual" data-role="key-actual"></span>
        </div>
      </div>
      <details class="more"${openMore ? ' open' : ''}>
        <summary><span>お気に入り・タグ・記録・メモ</span>${icon('chevron-down')}</summary>
        <div class="more-body">
          <label class="switch-row"><span>お気に入り</span><input type="checkbox" class="switch" name="favorite"></label>
          <div class="field">
            <span class="label">タグ</span>
            <div class="chip-set" data-role="tags"></div>
            <div class="tag-add">
              <input class="input" data-role="tag-input" placeholder="新しいタグ" maxlength="20" enterkeyhint="done" aria-label="新しいタグ">
              <button type="button" class="btn" data-act="tag-add">追加</button>
            </div>
          </div>
          <div class="field-grid">
            <div class="field"><label class="label" for="fm-score">採点</label><input class="input" id="fm-score" name="score" type="number" inputmode="decimal" min="0" max="100" step="0.001" placeholder="例 92.345"></div>
            <div class="field"><label class="label" for="fm-count">歌った回数</label><input class="input" id="fm-count" name="singCount" type="number" inputmode="numeric" min="0" step="1"></div>
            <div class="field span2"><label class="label" for="fm-last">最終歌唱日</label><input class="input" id="fm-last" name="lastSungAt" type="date"></div>
          </div>
          <div class="field"><label class="label" for="fm-memo">メモ</label><textarea class="input" id="fm-memo" name="memo" rows="3" maxlength="1000"></textarea></div>
        </div>
      </details>
      <p class="form-error" data-role="error" role="alert" hidden></p>
    </div>
    <div class="sheet-foot">
      ${isNew ? '<button type="button" class="btn" data-act="save-next">続けて登録</button>' : ''}
      <button type="submit" class="btn primary">${isNew ? '登録' : '保存'}</button>
    </div>
  </form>`;
}

// 追加機能が用意した、音域欄のボタン
const rangeActions = () => plugins.flatMap((p) => (p.rangeAction ? [p.rangeAction] : []));

function rangeActionsHTML(extraClass = '') {
  const actions = rangeActions();
  return `<div class="range-actions${extraClass ? ` ${extraClass}` : ''}">${actions.map((a, i) => `<button type="button" class="pill" data-plugin="${i}">${icon(a.icon ?? 'search')}${esc(a.label)}</button>`).join('')}<button type="button" class="pill" data-act="range-web">${icon('external')}Webで音域を検索</button></div>`;
}

// 「アーティスト名 曲名 音域」で Web 検索する。Google のアカウントの履歴に残らないよう、DuckDuckGo（日本の検索結果）を使う
const WEB_SEARCH_URL = 'https://duckduckgo.com/?kl=jp-jp&q=';
function openRangeSearch(artist, title) {
  const t = String(title ?? '').trim();
  if (!t) {
    toast('曲名を入れてから検索してください');
    return;
  }
  const q = [String(artist ?? '').trim(), t, '音域'].filter(Boolean).join(' ');
  window.open(WEB_SEARCH_URL + encodeURIComponent(q), '_blank', 'noopener');
}

// 追加機能が、まとめて追加した曲などの音域を補う（rangeBatch）。items：[{ id, artist, title }]
const rangeBatches = () => plugins.flatMap((p) => (p.rangeBatch ? [p.rangeBatch] : []));
const rangeBatchCtx = {
  getSong: (id) => state.byId.get(id) ?? null,
  // 音域を入れて保存する。すでに値がある項目は変えない。曲が消えていれば false
  applyRange(id, range, extPatch) {
    const s = state.byId.get(id);
    if (!s) return false;
    const patch = {};
    for (const f of RANGE_FIELDS) if (isNote(range?.[f.id]) && !isNote(s[f.id])) patch[f.id] = range[f.id];
    if (!Object.keys(patch).length) return false;
    if (extPatch) patch.ext = { ...(s.ext ?? {}), ...extPatch };
    state.store.updateSong(id, patch);
    return true;
  },
  openSong: (id) => {
    if (state.byId.has(id)) openDetail(id);
  },
};
function runRangeBatch(items) {
  if (!items.length) return;
  for (const b of rangeBatches()) {
    try {
      b.run(items, rangeBatchCtx);
    } catch (err) {
      console.error(err);
    }
  }
}

async function runRangeAction(index, ctx) {
  const action = rangeActions()[index];
  try {
    await action?.run(ctx);
  } catch (err) {
    console.error(err);
    toast('うまく動きませんでした');
  }
}

// 追加機能に渡す、登録済みの曲を操作するための窓口。音域を入れたら、その場で保存する
function songPluginCtx(id) {
  const get = () => state.byId.get(id);
  return {
    saves: true,
    get artist() { return get()?.artist ?? ''; },
    get title() { return get()?.title ?? ''; },
    current: () => {
      const s = get();
      return Object.fromEntries(RANGE_FIELDS.map((f) => [f.id, s?.[f.id] ?? null]));
    },
    applyRange: (range, extPatch) => {
      const s = get();
      if (!s) return;
      const prev = { ext: s.ext ?? null };
      const next = {};
      for (const f of RANGE_FIELDS) {
        prev[f.id] = s[f.id] ?? null;
        if (range[f.id] !== undefined) next[f.id] = range[f.id];
      }
      if (extPatch) next.ext = { ...(s.ext ?? {}), ...extPatch };
      state.store.updateSong(id, next);
      toast(`「${s.title}」の音域を保存しました`, {
        action: '元に戻す',
        onAction: () => state.store.updateSong(id, prev),
      });
    },
  };
}

// 追加機能が用意した、試聴の音源
const previewSources = () => [itunesPreviewSource, ...plugins.flatMap((p) => (p.previewSource ? [p.previewSource] : []))];

// 試聴の音源を選んだときなどに、曲の保存欄 song.ext に書く
function previewCtx(id) {
  return {
    saveExt: (patch) => {
      const s = state.byId.get(id);
      if (!s) return;
      state.store.updateSong(id, { ext: { ...(s.ext ?? {}), ...patch } });
    },
  };
}

function removeAudioFiles(ids) {
  if (!previewSupported()) return;
  for (const id of ids) audioFiles.remove(id).catch(() => {});
}

// 追加機能が詳細画面に足す表示
function pluginDetailHTML(song) {
  return plugins.map((p) => {
    try {
      return p.detailHTML?.(song) ?? '';
    } catch (e) {
      console.error(e);
      return '';
    }
  }).join('');
}

const dateInputValue = (ms) => {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

function openForm(song = null) {
  const isNew = !song;
  let draft = isNew ? emptySong() : { ...song, tags: [...song.tags] };
  const hasMore = !isNew && (song.favorite || song.tags.length || song.score != null || song.singCount || song.lastSungAt || song.memo);
  const sheet = openSheet(formHTML(isNew, hasMore), {
    label: isNew ? '曲を登録' : '曲を編集',
    dismissible: false,
    className: 'form-layer',
  });
  const form = $('form', sheet.el);
  const el = (sel) => $(sel, form);
  const extraTags = new Set();

  const fill = () => {
    form.artist.value = draft.artist;
    form.title.value = draft.title;
    form.favorite.checked = draft.favorite;
    form.score.value = draft.score ?? '';
    form.singCount.value = draft.singCount || '';
    form.lastSungAt.value = dateInputValue(draft.lastSungAt);
    form.memo.value = draft.memo;
    paintRange();
    paintKey();
    paintTags();
    paintArt();
  };

  // 追加機能に渡す、フォームを操作するための窓口
  const pluginCtx = {
    get artist() { return form.artist.value.trim(); },
    get title() { return form.title.value.trim(); },
    current: () => ({ low: draft.low, chestHigh: draft.chestHigh, falsettoHigh: draft.falsettoHigh }),
    applyRange: (range, extPatch) => {
      for (const f of RANGE_FIELDS) if (range[f.id] !== undefined) draft[f.id] = range[f.id];
      if (extPatch) draft.ext = { ...(draft.ext ?? {}), ...extPatch };
      paintRange();
    },
  };

  const paintArt = () => {
    const img = $('img', el('[data-role="art-prev"]'));
    if (draft.artwork) {
      img.src = draft.artwork;
      img.hidden = false;
    } else {
      img.hidden = true;
      img.removeAttribute('src');
    }
    el('[data-act="art-clear"]').hidden = !draft.artwork;
  };

  const paintRange = () => {
    for (const f of RANGE_FIELDS) {
      const b = el(`[data-field="${f.id}"]`);
      const v = draft[f.id];
      $('.nf-v', b).innerHTML = isNote(v) ? fmtNoteHTML(v) : f.id === 'falsettoHigh' ? 'なし' : '未選択';
      b.classList.toggle('set', isNote(v));
    }
    const warns = [];
    if (isNote(draft.low) && isNote(draft.chestHigh) && draft.low > draft.chestHigh) warns.push('最低音が地声最高音より高くなっています');
    if (isNote(draft.low) && isNote(draft.falsettoHigh) && draft.low > draft.falsettoHigh) warns.push('最低音が裏声最高音より高くなっています');
    const w = el('[data-role="range-warn"]');
    w.hidden = !warns.length;
    w.textContent = warns.join('。');
  };

  const paintKey = () => {
    const kd = paintKv(el('[data-role="kv"]'), draft.key, draft.octave);
    el('[data-role="key-actual"]').textContent = kd.oct ? `実際 ${kd.actual}` : '';
    el('[data-act="k-down"]').disabled = draft.key <= KEY_MIN;
    el('[data-act="k-up"]').disabled = draft.key >= KEY_MAX;
    el('[data-act="k-reset"]').setAttribute('aria-pressed', String(draft.key === 0 && !draft.octave));
    el('[data-act="k-oct-down"]').setAttribute('aria-pressed', String(draft.octave === -1));
    el('[data-act="k-oct-up"]').setAttribute('aria-pressed', String(draft.octave === 1));
  };

  const paintTags = () => {
    const tags = [...new Set([...tagList(), ...extraTags, ...draft.tags])];
    el('[data-role="tags"]').innerHTML = tags.map((t) => {
      const on = draft.tags.includes(t);
      return `<button type="button" class="chip${on ? ' on' : ''}"${tagC(t)} data-tag="${esc(t)}" aria-pressed="${on}">${esc(t)}</button>`;
    }).join('');
  };

  const addTag = () => {
    const input = el('[data-role="tag-input"]');
    const t = input.value.trim();
    if (!t) return;
    if (!draft.tags.includes(t)) draft.tags.push(t);
    extraTags.add(t);
    input.value = '';
    paintTags();
  };

  const showError = (msg, focusEl) => {
    const e = el('[data-role="error"]');
    e.textContent = msg;
    e.hidden = !msg;
    if (msg) {
      focusEl?.focus();
      e.scrollIntoView({ block: 'nearest' });
    }
  };

  // アーティストが決まったら、その曲一覧を先に読み込んでおき、曲名の候補をすぐ出せるようにする
  const prefetchSongs = () => {
    const a = form.artist.value.trim();
    if (a && navigator.onLine) songsOfArtist(a).catch(() => {});
  };
  form.artist.addEventListener('change', prefetchSongs);
  const titleSuggest = setupTitleSuggest(form.title, el('#fm-title-list'), () => form.artist.value, (s) => {
    if (s.artwork) {
      draft.artwork = s.artwork;
      paintArt();
    }
  });
  // アーティストが決まったら、キーボードを閉じて、そのアーティストの曲名の候補を出す
  const afterArtist = () => {
    prefetchSongs();
    form.artist.blur();
    if (form.artist.value.trim()) titleSuggest.open();
  };
  setupArtistSuggest(form.artist, el('#fm-artist-list'), afterArtist);

  form.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.tagName === 'TEXTAREA' || e.isComposing) return;
    if (e.target.matches('[data-role="tag-input"]')) {
      e.preventDefault();
      addTag();
    } else if (e.target === form.artist) {
      if (!e.defaultPrevented) {
        e.preventDefault();
        afterArtist();
      }
    } else if (e.target.matches('input')) {
      e.preventDefault();
      e.target.blur();
    }
  });

  form.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.tag != null) {
      const t = b.dataset.tag;
      draft.tags = draft.tags.includes(t) ? draft.tags.filter((x) => x !== t) : [...draft.tags, t];
      paintTags();
      return;
    }
    if (b.dataset.plugin != null) {
      await runRangeAction(+b.dataset.plugin, pluginCtx);
      return;
    }
    if (b.dataset.act === 'range-web') {
      openRangeSearch(form.artist.value, form.title.value);
      return;
    }
    if (b.dataset.field) {
      const f = RANGE_FIELDS.find((x) => x.id === b.dataset.field);
      const guess = isNote(draft.chestHigh) ? Math.floor(draft.chestHigh / 12) : DEFAULT_OCTAVE[f.id];
      const v = await pickNote({
        title: f.label,
        value: draft[f.id],
        octave: f.id === 'chestHigh' ? DEFAULT_OCTAVE.chestHigh : f.id === 'falsettoHigh' ? Math.max(guess, DEFAULT_OCTAVE.chestHigh) : DEFAULT_OCTAVE.low,
        clearLabel: f.id === 'falsettoHigh' ? '裏声なし' : '未選択に戻す',
      });
      if (v === undefined) return;
      draft[f.id] = v;
      paintRange();
      return;
    }
    switch (b.dataset.act) {
      case 'cancel': sheet.close(); break;
      case 'k-down': draft.key = clampKey(draft.key - 1); paintKey(); break;
      case 'k-up': draft.key = clampKey(draft.key + 1); paintKey(); break;
      case 'k-reset': draft.key = 0; draft.octave = 0; paintKey(); break;
      case 'k-oct-down': Object.assign(draft, toggleOctave(draft.key, draft.octave, -1)); paintKey(); break;
      case 'k-oct-up': Object.assign(draft, toggleOctave(draft.key, draft.octave, 1)); paintKey(); break;
      case 'tag-add': addTag(); break;
      case 'art-find': {
        const url = await openArtPicker(form.artist.value, form.title.value);
        if (url !== undefined) {
          draft.artwork = url;
          paintArt();
        }
        break;
      }
      case 'art-clear': draft.artwork = null; paintArt(); break;
      case 'save-next': save(true); break;
      default:
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    save(false);
  });

  async function save(next) {
    const artist = form.artist.value.trim();
    const title = form.title.value.trim();
    if (!artist) return showError('アーティストを入力してください', form.artist);
    if (!title) return showError('曲名を入力してください', form.title);
    let score = null;
    if (form.score.value.trim() !== '') {
      score = Number(form.score.value);
      if (!Number.isFinite(score) || score < 0 || score > 100) {
        el('.more').open = true;
        return showError('採点は 0〜100 の数字で入力してください', form.score);
      }
      score = Math.round(score * 1000) / 1000;
    }
    let singCount = 0;
    if (form.singCount.value.trim() !== '') {
      singCount = Number(form.singCount.value);
      if (!Number.isInteger(singCount) || singCount < 0) {
        el('.more').open = true;
        return showError('歌った回数は 0 以上の整数で入力してください', form.singCount);
      }
    }
    let lastSungAt = null;
    const dv = form.lastSungAt.value;
    // 歌った回数が 0 なら、最終歌唱日も消す
    if (dv && singCount > 0) {
      if (dv === dateInputValue(draft.lastSungAt)) lastSungAt = draft.lastSungAt;
      else {
        const [y, m, d] = dv.split('-').map(Number);
        lastSungAt = new Date(y, m - 1, d, 12, 0).getTime();
      }
    }
    showError('');
    const now = Date.now();
    const data = {
      ...draft,
      artist,
      title,
      favorite: form.favorite.checked,
      memo: form.memo.value.trim(),
      score,
      singCount,
      lastSungAt,
      updatedAt: now,
    };
    const dup = state.songs.find((x) => x.id !== song?.id && dupKey(x) === dupKey(data));
    if (dup) {
      const ok = await confirmDialog({
        title: '同じ曲が登録されています',
        message: `${dup.title} / ${dup.artist}\nこのまま${isNew ? '登録' : '保存'}しますか？`,
        ok: isNew ? '登録する' : '保存する',
      });
      if (!ok) return;
    }
    let id = song?.id;
    if (isNew) {
      data.createdAt = now;
      id = state.store.addSong(toPayload(data));
    } else {
      state.store.updateSong(song.id, toPayload(data));
    }
    if (!data.artwork) autoArtwork(id, artist, title);
    if (!state.profile.artists.includes(artist)) state.store.addArtists([artist]);
    if (data.tags.length) ensureTags(data.tags);
    toast(isNew ? `登録しました：${title}` : '保存しました');
    if (next) {
      draft = { ...emptySong(), artist, tags: [] };
      fill();
      el('.sheet-body').scrollTop = 0;
      // キーボードは閉じたまま、同じアーティストの曲名の候補を出す
      document.activeElement?.blur?.();
      // 登録した曲がデータに反映されてから出す（候補に「登録済み」と付けるため）
      setTimeout(() => titleSuggest.open(), 80);
    } else {
      sheet.close();
    }
  }

  fill();
  if (isNew) setTimeout(() => form.artist.focus({ preventScroll: true }), 60);
}

// 入力欄の下に候補を出す共通部品（キーボードの上下・Enter・Esc に対応）
function combobox(input, list, { idPrefix, onPick }) {
  let items = [];
  let active = -1;
  let renderFn = null;
  // pinned：入力欄にフォーカスがなくても（キーボードを閉じたまま）候補を出している状態。
  // このときは、候補と入力欄以外の場所をタップしたら閉じる
  let pinned = false;
  const onOutside = (e) => {
    if (!list.contains(e.target) && e.target !== input) hide();
  };
  const pin = () => {
    if (pinned) return;
    pinned = true;
    document.addEventListener('pointerdown', onOutside, true);
  };
  const unpin = () => {
    if (!pinned) return;
    pinned = false;
    document.removeEventListener('pointerdown', onOutside, true);
  };
  const canShow = () => pinned || document.activeElement === input;
  function hide() {
    list.hidden = true;
    active = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    unpin();
  }
  const show = (next, render, { pin: keep = false } = {}) => {
    items = next;
    renderFn = render;
    if (keep) pin();
    if (!canShow() || !items.length) return hide();
    if (active >= items.length) active = -1;
    list.innerHTML = render(items, active, idPrefix);
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (active >= 0) input.setAttribute('aria-activedescendant', `${idPrefix}-${active}`);
    else input.removeAttribute('aria-activedescendant');
  };
  const choose = (it) => {
    hide();
    onPick(it);
  };
  // 閉じるのは、少し待ってもフォーカスが戻っていないときだけ（すぐ別の操作で開き直すことがあるため）
  input.addEventListener('blur', () => setTimeout(() => {
    if (document.activeElement !== input && !pinned) hide();
  }, 120));
  input.addEventListener('keydown', (e) => {
    if (list.hidden || e.isComposing || !items.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      active = e.key === 'ArrowDown' ? (active + 1) % items.length : (active - 1 + items.length) % items.length;
      show(items, renderFn);
      e.preventDefault();
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      choose(items[active]);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      hide();
    }
  });
  list.addEventListener('pointerdown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => {
    const li = e.target.closest('[data-i]');
    if (li) choose(items[+li.dataset.i]);
  });
  // 選べない一行メッセージ（読み込み中など）を出す
  const message = (text, { pin: keep = false } = {}) => {
    if (keep) pin();
    if (!canShow()) return hide();
    items = [];
    list.innerHTML = `<li class="ac-head" role="presentation">${esc(text)}</li>`;
    list.hidden = false;
  };
  return { show, hide, message, reset: () => { active = -1; } };
}

const highlight = (name, query) => {
  const q = query.trim().toLowerCase();
  const at = q ? name.toLowerCase().indexOf(q) : -1;
  return at >= 0 ? `${esc(name.slice(0, at))}<mark>${esc(name.slice(at, at + q.length))}</mark>${esc(name.slice(at + q.length))}` : esc(name);
};

// アーティスト名：登録済みの名前を先に、その下に iTunes の候補を出す
function setupArtistSuggest(input, list, onPick) {
  let online = { q: '', names: [] };
  let timer = 0;
  let ctrl = null;
  const cb = combobox(input, list, {
    idPrefix: 'ac-artist',
    onPick: (it) => {
      input.value = it.name;
      onPick?.(it.name);
    },
  });
  const render = (items, active, pre) => {
    const counts = artistCounts(state.songs);
    let head = false;
    return items.map((it, i) => {
      const sep = it.online && !head ? ((head = true), '<li class="ac-head" role="presentation">iTunes の候補</li>') : '';
      const c = counts.get(it.name);
      return `${sep}<li role="option" id="${pre}-${i}" data-i="${i}" class="${i === active ? 'active' : ''}" aria-selected="${i === active}">
        <span class="ac-name">${highlight(it.name, input.value)}</span>${c ? `<span class="ac-count">${c}曲</span>` : ''}</li>`;
    }).join('');
  };
  const paint = () => {
    const value = input.value.trim();
    const local = suggestArtists(state.profile.artists, state.songs, input.value);
    const known = new Set([...local, ...state.profile.artists].map((n) => normalize(n)));
    const extra = online.q === value
      ? online.names.filter((n) => !known.has(normalize(n)) && n !== value).slice(0, 6)
      : [];
    cb.show([...local.map((name) => ({ name })), ...extra.map((name) => ({ name, online: true }))], render);
  };
  const fetchOnline = () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2 || !navigator.onLine || online.q === q) return;
    timer = setTimeout(async () => {
      ctrl?.abort();
      ctrl = new AbortController();
      try {
        const names = await suggestArtistsOnline(q, { signal: ctrl.signal });
        online = { q, names };
        if (input.value.trim() === q) paint();
      } catch (e) {
        if (e.name !== 'AbortError') console.warn('artist suggest', e);
      }
    }, 350);
  };
  input.addEventListener('focus', () => {
    paint();
    fetchOnline();
  });
  input.addEventListener('input', () => {
    cb.reset();
    paint();
    fetchOnline();
  });
}

// 曲名：入力済みのアーティストの曲を iTunes から出す（選ぶとジャケット画像も入る）
function setupTitleSuggest(input, list, getArtist, onPick) {
  let timer = 0;
  let ctrl = null;
  let loadedKey = '';
  let songs = [];
  const cb = combobox(input, list, {
    idPrefix: 'ac-title',
    onPick: (s) => {
      input.value = trimReading(s.title);
      input.blur();
      onPick?.(s);
    },
  });
  const render = (items, active, pre) => {
    const artist = getArtist().trim();
    const registered = new Set(state.songs.map(dupKey));
    return '<li class="ac-head" role="presentation">iTunes の候補</li>' + items.map((s, i) => {
      const title = trimReading(s.title);
      const done = registered.has(dupKey({ artist, title }));
      return `<li role="option" id="${pre}-${i}" data-i="${i}" class="song-opt${i === active ? ' active' : ''}" aria-selected="${i === active}">
        <span class="ac-art">${s.artwork ? `<img src="${esc(s.artwork)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : icon('music')}</span>
        <span class="ac-text"><span class="ac-name">${highlight(title, input.value)}</span>${s.album ? `<span class="ac-sub">${esc(s.album)}</span>` : ''}</span>
        ${done ? '<span class="ac-count">登録済み</span>' : ''}</li>`;
    }).join('');
  };
  const load = ({ pin = false } = {}) => {
    clearTimeout(timer);
    const artist = getArtist().trim();
    const q = input.value.trim();
    if (!artist || !navigator.onLine) return cb.hide();
    const key = `${artist}\u0001${q}`;
    if (key === loadedKey) return cb.show(songs, render, { pin });
    if (!songs.length || pin) cb.message('iTunes で曲を探しています…', { pin });
    timer = setTimeout(async () => {
      ctrl?.abort();
      ctrl = new AbortController();
      try {
        const found = await suggestSongsOnline(artist, q, { signal: ctrl.signal });
        if (`${getArtist().trim()}\u0001${input.value.trim()}` !== key) return;
        if (found.length) loadedKey = key;
        songs = found.slice(0, 8);
        cb.reset();
        cb.show(songs, render, { pin });
      } catch (e) {
        if (e.name !== 'AbortError') console.warn('title suggest', e);
      }
    }, q ? 300 : 30);
  };
  input.addEventListener('focus', () => load());
  input.addEventListener('input', () => {
    cb.reset();
    load();
  });
  // キーボードを閉じたまま、そのアーティストの曲名の候補を出す
  return { open: () => load({ pin: true }) };
}

// ---- ジャケット画像 ---------------------------------------------------

// iTunes で画像を探して選ぶ。戻り値：選んだ画像の URL、キャンセルなら undefined
function openArtPicker(artist, title) {
  return new Promise((resolve) => {
    let result;
    const sheet = openSheet(`<div class="artpick">
        <div class="sheet-head"><h3>ジャケット画像を選ぶ</h3><button type="button" class="icon-btn" data-act="close" aria-label="閉じる">${icon('close')}</button></div>
        <div class="sheet-body">
          <form class="search sm" data-role="form">${icon('search')}<input type="search" data-role="q" enterkeyhint="search" aria-label="検索する言葉" placeholder="アーティスト名と曲名"></form>
          <div class="art-grid" data-role="grid"></div>
        </div>
      </div>`, { label: 'ジャケット画像を選ぶ', className: 'artpick-layer', onClose: () => resolve(result) });
    const input = $('[data-role="q"]', sheet.el);
    const grid = $('[data-role="grid"]', sheet.el);
    let found = [];
    input.value = `${artist} ${title}`.trim();
    const run = async () => {
      const q = input.value.trim();
      if (!q) {
        grid.innerHTML = '<p class="hint">アーティスト名と曲名を入れて検索してください。</p>';
        return;
      }
      grid.innerHTML = '<p class="hint">検索しています…</p>';
      try {
        const songs = await searchTracks(q);
        if (songs === null) {
          grid.innerHTML = '<p class="hint">検索の回数が上限に近いため、1分ほど待ってからもう一度お試しください。</p>';
          return;
        }
        found = songs;
        grid.innerHTML = songs.length
          ? songs.map((s, i) => `<button type="button" class="art-cand" data-i="${i}">
              <img src="${esc(s.artwork)}" alt="" loading="lazy" referrerpolicy="no-referrer">
              <span class="art-cand-t">${esc(s.title)}</span><span class="art-cand-a">${esc(s.artist)}</span></button>`).join('')
          : '<p class="hint">見つかりませんでした。検索する言葉を変えてみてください。</p>';
      } catch (e) {
        console.warn(e);
        grid.innerHTML = '<p class="hint">検索できませんでした。通信状況を確認してください。</p>';
      }
    };
    $('[data-role="form"]', sheet.el).addEventListener('submit', (e) => {
      e.preventDefault();
      input.blur();
      run();
    });
    sheet.el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.act === 'close') sheet.close();
      if (b.dataset.i != null) {
        result = found[+b.dataset.i]?.artwork ?? undefined;
        sheet.close();
      }
    });
    run();
  });
}

// 画像が未設定の曲を登録したとき、裏で iTunes から探して入れる
async function autoArtwork(id, artist, title) {
  if (!id || !navigator.onLine) return;
  try {
    const r = await findTrack(artist, title);
    const s = state.byId.get(id);
    if (r?.match?.artwork && (!s || !s.artwork)) state.store.updateSong(id, { artwork: r.match.artwork });
  } catch (e) {
    console.warn('artwork', e);
  }
}

// 画像が未設定の曲をまとめて探す（1分あたりの問い合わせ回数を守るため、1曲ずつ間をあける）
const artJob = { running: false, cancel: false, done: 0, total: 0, found: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runArtJob() {
  if (artJob.running) return;
  const targets = state.songs.filter((s) => !s.artwork && s.title);
  if (!targets.length) {
    toast('ジャケット画像が未設定の曲はありません');
    return;
  }
  Object.assign(artJob, { running: true, cancel: false, done: 0, total: targets.length, found: 0 });
  paintArtJob();
  for (const t of targets) {
    if (artJob.cancel) break;
    await waitForSlot();
    try {
      const r = await findTrack(t.artist, t.title);
      const cur = state.byId.get(t.id);
      if (r?.match?.artwork && cur && !cur.artwork) {
        state.store.updateSong(t.id, { artwork: r.match.artwork });
        artJob.found++;
      }
    } catch (e) {
      console.warn('artwork', e);
    }
    artJob.done++;
    paintArtJob();
    if (artJob.done < artJob.total && !artJob.cancel) await sleep(3300);
  }
  artJob.running = false;
  paintArtJob();
  toast(`${artJob.done}曲を調べて、${artJob.found}曲に画像を設定しました`, { duration: 5000 });
}

// ---- 曲名の英語表記 -----------------------------------------------------
// 曲名の後ろに付いた英語表記（「さくら - Sakura」など）を外せる曲
const readingTargets = () => state.songs.flatMap((s) => {
  const to = trimReading(s.title);
  return to !== s.title ? [{ id: s.id, artist: s.artist, from: s.title, to }] : [];
});

function readingSettingsHTML() {
  const n = readingTargets().length;
  if (!n) return '';
  return `<section class="set-sec">
        <h4>曲名の英語表記</h4>
        <button type="button" class="btn wide" data-act="reading">${icon('pen')}曲名の英語表記を外す（${n}曲）</button>
        <p class="hint">「さくら - Sakura」のように曲名の後ろに付いた英語表記を、一覧で確認してから外します。</p>
      </section>`;
}

function openReadingCleanup() {
  const targets = readingTargets();
  if (!targets.length) return;
  const registered = new Set(state.songs.map(dupKey));
  // 外すと、登録済みのほかの曲と同じ曲名になるものは、最初はチェックを外しておく
  const items = targets.map((x) => ({ ...x, dup: registered.has(dupKey({ artist: x.artist, title: x.to })) }));
  const sheet = openSheet(`<div class="rdg">
      <div class="sheet-head"><h3>曲名の英語表記を外す</h3><button type="button" class="icon-btn" data-act="close" aria-label="閉じる">${icon('close')}</button></div>
      <div class="sheet-body">
        <p class="hint">英語表記を外す曲にチェックを付けてください。英語表記も曲名の一部の場合は、チェックを外してください。</p>
        <ul class="rdg-list">${items.map((x, i) => `<li><label class="rdg-row">
            <input type="checkbox" data-i="${i}"${x.dup ? '' : ' checked'}>
            <span class="rdg-text"><span class="rdg-to">${esc(x.to)}</span><span class="rdg-from">${esc(x.from)}${x.artist ? ` · ${esc(x.artist)}` : ''}</span>${x.dup ? '<span class="rdg-dup">外すと、登録済みの曲と同じ曲名になります</span>' : ''}</span>
          </label></li>`).join('')}</ul>
      </div>
      <div class="sheet-foot"><button type="button" class="btn primary" data-act="apply"></button></div>
    </div>`, { label: '曲名の英語表記を外す', className: 'history-layer' });
  const btn = $('[data-act="apply"]', sheet.el);
  const checked = () => $$('input[data-i]', sheet.el).filter((c) => c.checked).map((c) => items[+c.dataset.i]);
  const paint = () => {
    const n = checked().length;
    btn.textContent = `外す（${n}曲）`;
    btn.disabled = !n;
  };
  sheet.el.addEventListener('change', paint);
  sheet.el.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.act === 'close') {
      sheet.close();
      return;
    }
    if (b.dataset.act !== 'apply') return;
    // 一覧を開いたあとに曲名を変えた曲は変えない
    const list = checked().filter((x) => state.byId.get(x.id)?.title === x.from);
    for (const x of list) state.store.updateSong(x.id, { title: x.to });
    sheet.close();
    toast(`${list.length}曲の曲名から英語表記を外しました`);
    // 音域が未入力の曲は、曲名が変わったのを待ってから、追加機能で音域を補う
    const missing = list.filter((x) => isRangeMissing(state.byId.get(x.id) ?? {}));
    if (!missing.length || !rangeBatches().length) return;
    for (let t = 0; t < 30 && !missing.every((x) => state.byId.get(x.id)?.title === x.to); t++) await sleep(100);
    runRangeBatch(missing.map((x) => ({ id: x.id, artist: x.artist, title: x.to })));
  });
  paint();
}

function rangeBatchSettingsHTML() {
  const b = rangeBatches()[0];
  if (!b) return '';
  const n = state.songs.filter(isRangeMissing).length;
  return `<section class="set-sec">
        <h4>音域の取り込み</h4>
        <button type="button" class="btn wide" data-act="range-batch"${n ? '' : ' disabled'}>${icon('search')}${esc(b.label)}（${n}曲）</button>
        ${b.hint ? `<p class="hint">${esc(b.hint)}</p>` : ''}
      </section>`;
}

function artJobHTML() {
  if (artJob.running) {
    const pct = artJob.total ? Math.round((artJob.done / artJob.total) * 100) : 0;
    return `<div class="job">
      <div class="job-bar"><span style="width:${pct}%"></span></div>
      <div class="job-row"><span class="job-text">${artJob.done} / ${artJob.total} 曲を確認（${artJob.found}曲に設定）</span>
      <button type="button" class="btn sm" data-act="art-cancel">中止</button></div>
    </div>`;
  }
  const n = state.songs.filter((s) => !s.artwork).length;
  return `<button type="button" class="btn wide" data-act="art-run"${n ? '' : ' disabled'}>${icon('image')}未設定の曲の画像をまとめて探す（${n}曲）</button>`;
}

function paintArtJob() {
  const box = state.settings && $('[data-role="art-job"]', state.settings.el);
  if (box) box.innerHTML = artJobHTML();
}

// ---- 再生履歴から追加 -------------------------------------------------

async function importHistory(file) {
  toast('再生履歴を読み込んでいます…');
  let entries;
  try {
    entries = await readHistoryFile(await file.arrayBuffer());
  } catch (e) {
    console.error(e);
    await choiceDialog({ title: '読み込めませんでした', message: e.message, choices: [{ value: true, label: '閉じる', kind: 'primary' }] });
    return;
  }
  const all = aggregate(entries);
  if (!all.length) {
    toast('YouTube Music の再生記録が見つかりませんでした');
    return;
  }
  openHistory(all, entries.length);
}

function openHistory(all, plays) {
  const registered = new Set(state.songs.map(dupKey));
  const candidates = all.filter((c) => !registered.has(c.key));
  const selected = new Set();
  const LIMIT = 200;
  const sheet = openSheet(`<div class="history">
      <div class="sheet-head"><h3>再生履歴から追加</h3><button type="button" class="icon-btn" data-act="close" aria-label="閉じる">${icon('close')}</button></div>
      <div class="sheet-body">
        <p class="hint hist-sum">${plays.toLocaleString()}回分の再生から、まだ登録していない${candidates.length.toLocaleString()}曲を、よく聴いた順に並べています。</p>
        <label class="search sm">${icon('search')}<input type="search" data-role="q" placeholder="曲名・アーティストで絞り込み" autocomplete="off" aria-label="絞り込み"></label>
        <div class="hist-tools">
          <button type="button" class="pill" data-act="top">上位20曲を選ぶ</button>
          <button type="button" class="pill" data-act="none">選択を解除</button>
        </div>
        <ul class="hist-list" data-role="list"></ul>
      </div>
      <div class="sheet-foot">
        <button type="button" class="btn primary" data-act="add" disabled>選んだ曲を登録</button>
      </div>
    </div>`, {
    label: '再生履歴から追加',
    className: 'history-layer',
    onClose: () => { state.historySheet = null; },
  });
  state.historySheet = sheet;
  const q = $('[data-role="q"]', sheet.el);
  const listEl = $('[data-role="list"]', sheet.el);
  const addBtn = $('[data-act="add"]', sheet.el);
  let shown = [];
  const paint = () => {
    const words = normalize(q.value).split(' ').filter(Boolean);
    const filtered = words.length
      ? candidates.filter((c) => { const k = normalize(`${c.title} ${c.artist}`); return words.every((w) => k.includes(w)); })
      : candidates;
    shown = filtered.slice(0, LIMIT);
    listEl.innerHTML = shown.length
      ? shown.map((c, i) => `<li><label class="hist-row">
          <input type="checkbox" data-i="${i}"${selected.has(c.key) ? ' checked' : ''}>
          <span class="hist-art">${c.video ? `<img src="${thumbnailUrl(c.video)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : icon('music')}</span>
          <span class="hist-text"><span class="hist-t">${esc(c.title)}</span><span class="hist-a">${esc(c.artist)}</span></span>
          <span class="hist-n">${c.count}回</span>
        </label></li>`).join('') + (filtered.length > LIMIT ? `<li class="hist-more">ほか${filtered.length - LIMIT}曲（絞り込むと表示されます）</li>` : '')
      : '<li class="hist-more">該当する曲がありません</li>';
    addBtn.disabled = !selected.size;
    addBtn.textContent = selected.size ? `選んだ${selected.size}曲を登録` : '選んだ曲を登録';
  };
  q.addEventListener('input', paint);
  listEl.addEventListener('change', (e) => {
    const c = shown[+e.target.dataset.i];
    if (!c) return;
    if (e.target.checked) selected.add(c.key);
    else selected.delete(c.key);
    addBtn.disabled = !selected.size;
    addBtn.textContent = selected.size ? `選んだ${selected.size}曲を登録` : '選んだ曲を登録';
  });
  sheet.el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.act === 'close') sheet.close();
    else if (b.dataset.act === 'top') {
      candidates.slice(0, 20).forEach((c) => selected.add(c.key));
      paint();
    } else if (b.dataset.act === 'none') {
      selected.clear();
      paint();
    } else if (b.dataset.act === 'add') {
      const picks = candidates.filter((c) => selected.has(c.key));
      const now = Date.now();
      const entriesToAdd = picks.map((c, i) => ({
        id: null,
        // 公式音源のサムネイルはジャケット画像なのでそのまま使う。MV などは後で iTunes から探す
        data: toPayload(normalizeSong({ ...emptySong(), artist: c.artist, title: c.title, artwork: c.topic ? thumbnailUrl(c.video) : null, createdAt: now - i, updatedAt: now })),
      }));
      state.store.putSongs(entriesToAdd);
      const artists = [...new Set(picks.map((c) => c.artist))].filter((n) => !state.profile.artists.includes(n));
      if (artists.length) state.store.addArtists(artists);
      sheet.close();
      const noArt = entriesToAdd.filter((x) => !x.data.artwork).length;
      toast(`${picks.length}曲を登録しました${noArt ? `（画像なし${noArt}曲は、設定からまとめて探せます）` : ''}`, { duration: 6000 });
    }
  });
  paint();
}

// ---- テキストから追加 -------------------------------------------------

// iTunes で検索する。1 分あたりの回数の上限に達しているときは、空くまで待つ
async function searchWhenFree(term, alive) {
  for (let i = 0; i < 6; i++) {
    await waitForSlot();
    if (!alive()) return null;
    const res = await searchSongs(term, { limit: 25 });
    if (res) return res;
  }
  throw new Error('iTunes rate limited');
}

const TI_STATUS = {
  pending: { label: '待機中', cls: 'wait' },
  searching: { label: '調べています…', cls: 'wait' },
  check: { label: '要確認', cls: 'check' },
  none: { label: '見つかりません', cls: 'none' },
  error: { label: '調べられませんでした', cls: 'none' },
};
const TI_FILTERS = [['all', 'すべて'], ['check', '要確認'], ['none', '見つからない'], ['dup', '登録済み・重複']];
const TI_PER_MINUTE = 15;

function openTextImport() {
  const aliases = aliasMap(state.profile.aliases);
  const knownArtists = new Map([...state.profile.artists, ...state.songs.map((s) => s.artist)].filter(Boolean).map((n) => [looseKey(n), n]));
  // gen：調べている処理の世代。中止・やり直し・閉じたときに増やし、古い処理の結果を捨てる
  const job = { gen: 0, running: false, rows: [], filter: 'all', text: '' };
  const sheet = openSheet(`<div class="timport">
      <div class="sheet-head"><h3>テキストから追加</h3><button type="button" class="icon-btn" data-act="close" aria-label="閉じる">${icon('close')}</button></div>
      <div class="sheet-body" data-role="body"></div>
      <div class="sheet-foot" data-role="foot"></div>
    </div>`, {
    label: 'テキストから追加',
    className: 'history-layer',
    onClose: () => { job.gen++; },
  });
  const body = $('[data-role="body"]', sheet.el);
  const foot = $('[data-role="foot"]', sheet.el);

  let registered = null;
  const busy = (r) => r.status === 'pending' || r.status === 'searching';
  const dupOf = (r) => {
    if (busy(r) || !r.title) return null;
    const k = dupKey(r);
    registered ??= new Set(state.songs.map(dupKey));
    if (registered.has(k)) return 'registered';
    for (const o of job.rows) {
      if (o === r) break;
      if (o.checked && !busy(o) && o.title && dupKey(o) === k) return 'repeat';
    }
    return null;
  };
  const canAdd = (r) => !busy(r) && r.checked && !!r.title && !dupOf(r);
  const kindOf = (r) => {
    if (busy(r)) return 'wait';
    if (dupOf(r)) return 'dup';
    if (r.status === 'check') return 'check';
    if (r.status === 'none' || r.status === 'error') return 'none';
    return 'ok';
  };

  const showInput = () => {
    job.gen++;
    job.running = false;
    job.rows = [];
    sheet.dismissible = true;
    body.innerHTML = `<p class="hint ti-lead">メモなどを貼り付けると、1行を1曲として iTunes で調べ、アーティスト名・曲名・ジャケット画像を入れます。追加する前に確認・修正できます。</p>
      <textarea class="input ti-text" data-role="text" rows="10" placeholder="アーティスト名 - 曲名&#10;曲名 / アーティスト名&#10;アーティスト名 曲名" aria-label="追加する曲の一覧" autocomplete="off" autocapitalize="off" spellcheck="false">${esc(job.text)}</textarea>
      <p class="hint">アーティスト名と曲名の順番や区切り（- や / など）は、ばらばらでも構いません。曲名だけの行も調べます。一度に${MAX_LINES}行まで調べられます。</p>`;
    foot.className = 'sheet-foot';
    foot.innerHTML = `<button type="button" class="btn primary" data-act="run">${icon('search')}調べる</button>`;
  };

  const start = () => {
    const ta = $('[data-role="text"]', body);
    job.text = ta.value;
    let lines = parseLines(job.text);
    if (!lines.length) {
      toast('曲が書かれた行がありません');
      ta.focus();
      return;
    }
    if (lines.length > MAX_LINES) {
      toast(`一度に調べられるのは${MAX_LINES}行までです。最初の${MAX_LINES}行を調べます`, { duration: 6000 });
      lines = lines.slice(0, MAX_LINES);
    }
    job.rows = lines.map((line, i) => ({
      i, line, info: analyzeLine(line, { aliases, knownArtists }), status: 'pending', cands: [], pick: null, artist: '', title: '', artwork: null, checked: false,
    }));
    job.filter = 'all';
    sheet.dismissible = false;
    body.innerHTML = '<div class="ti-status" data-role="status"></div><div class="ti-filter" data-role="filter"></div><ul class="hist-list ti-list" data-role="list"></ul>';
    foot.className = 'sheet-foot ti-foot';
    body.scrollTop = 0;
    run();
  };

  const setPick = (r, s) => {
    r.pick = s;
    r.artist = s.artist;
    r.title = trimReading(s.title);
    r.artwork = s.artwork ?? null;
  };

  const resolveRow = async (r, alive) => {
    const info = r.info;
    try {
      let cands = mergeCandidates(scoreSongs(await searchWhenFree(info.term, alive), info));
      if (!alive()) return;
      let j = judge(cands, info);
      if (j.status === 'none') {
        for (const t of fallbackTerms(info)) {
          const more = await searchWhenFree(t, alive);
          if (!alive()) return;
          cands = mergeCandidates(cands, scoreSongs(more, info));
          j = judge(cands, info);
          if (j.status !== 'none') break;
        }
      }
      r.status = j.status;
      r.cands = j.candidates.map((c) => c.song);
      if (j.pick) setPick(r, j.pick.song);
      else Object.assign(r, guessSong(info), { pick: null, artwork: null });
    } catch (e) {
      if (!alive()) return;
      console.warn(e);
      r.status = 'error';
      Object.assign(r, guessSong(info), { pick: null, artwork: null });
    }
    // 要確認の行もチェックを付けておく。見つからない行・登録済みの曲は外しておく
    r.checked = r.status === 'sure' || r.status === 'check';
    if (dupOf(r)) r.checked = false;
  };

  const run = async () => {
    const gen = ++job.gen;
    const alive = () => gen === job.gen;
    job.running = true;
    registered = null;
    paintAll();
    for (const r of job.rows) {
      if (!alive()) return;
      if (r.status !== 'pending') continue;
      r.status = 'searching';
      paintRow(r);
      await resolveRow(r, alive);
      if (!alive()) return;
      paintRow(r);
      paintStatus();
      paintFilter();
      paintFoot();
    }
    job.running = false;
    paintAll();
  };

  const stop = () => {
    job.gen++;
    job.running = false;
    for (const r of job.rows) if (r.status === 'searching') r.status = 'pending';
    paintAll();
  };

  const rowHTML = (r) => {
    const dup = dupOf(r);
    const st = dup ? { label: dup === 'registered' ? '登録済み' : '重複', cls: 'dup' } : TI_STATUS[r.status];
    const wait = busy(r);
    const can = !wait && !dup && !!r.title;
    const art = r.artwork ? `<img src="${esc(r.artwork)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : icon('music');
    return `<li class="ti-row${st ? ` is-${st.cls}` : ''}" data-i="${r.i}">
        <input type="checkbox" data-check="${r.i}"${r.checked && can ? ' checked' : ''}${can ? '' : ' disabled'} aria-label="追加する">
        <span class="hist-art">${art}</span>
        <button type="button" class="ti-main" data-edit="${r.i}"${wait ? ' disabled' : ''}>
          ${wait
            ? `<span class="hist-t">${esc(r.line)}</span>`
            : `<span class="hist-t">${esc(r.title || '（曲名なし）')}</span><span class="hist-a">${esc(r.artist || '（アーティスト名なし）')}</span>`}
          <span class="ti-src">${st ? `<span class="ti-badge">${st.label}</span>` : ''}${wait ? '' : `<span class="ti-line">${esc(r.line)}</span>`}</span>
        </button>
        ${wait ? '' : `<button type="button" class="icon-btn ti-edit" data-edit="${r.i}" aria-label="選び直す・直す">${icon('pen')}</button>`}
      </li>`;
  };
  const shown = (r) => job.filter === 'all' || kindOf(r) === job.filter;
  const paintRow = (r) => {
    const el = $(`.ti-row[data-i="${r.i}"]`, body);
    if (!shown(r)) {
      el?.remove();
      return;
    }
    if (el) el.outerHTML = rowHTML(r);
    else paintList();
  };
  const paintList = () => {
    const list = $('[data-role="list"]', body);
    if (!list) return;
    registered = null;
    const rows = job.rows.filter(shown);
    list.innerHTML = rows.length ? rows.map(rowHTML).join('') : '<li class="hist-more">該当する行はありません</li>';
  };
  const paintFilter = () => {
    const el = $('[data-role="filter"]', body);
    if (!el) return;
    const counts = {};
    for (const r of job.rows) counts[kindOf(r)] = (counts[kindOf(r)] ?? 0) + 1;
    if (job.filter !== 'all' && !counts[job.filter]) {
      job.filter = 'all';
      paintList();
    }
    const items = TI_FILTERS.filter(([id]) => id === 'all' || counts[id]);
    el.innerHTML = items.length > 1
      ? items.map(([id, label]) => `<button type="button" class="pill" data-filter="${id}" aria-pressed="${job.filter === id}">${label}${id === 'all' ? '' : ` ${counts[id]}`}</button>`).join('')
      : '';
  };
  const paintStatus = () => {
    const el = $('[data-role="status"]', body);
    if (!el) return;
    const total = job.rows.length;
    const left = job.rows.filter(busy).length;
    const min = Math.ceil(left / TI_PER_MINUTE);
    if (job.running) {
      el.innerHTML = `<span>調べています（${total - left} / ${total}）${min >= 2 ? `・残り約${min}分` : ''}</span><button type="button" class="link-btn" data-act="stop">中止</button>`;
    } else if (left) {
      el.innerHTML = `<span>${left}行はまだ調べていません</span><button type="button" class="link-btn" data-act="resume">続きを調べる</button>`;
    } else {
      el.innerHTML = `<span>${total}行を調べました。違う曲は、行をタップして選び直せます。</span>`;
    }
  };
  const paintFoot = () => {
    if (!job.rows.length) return;
    const n = job.rows.filter(canAdd).length;
    foot.innerHTML = `<button type="button" class="btn" data-act="back">テキストに戻る</button>
      <button type="button" class="btn primary" data-act="add"${n ? '' : ' disabled'}>${n ? `${n}曲を追加` : '追加する曲がありません'}</button>`;
  };
  const paintAll = () => {
    paintStatus();
    paintFilter();
    paintList();
    paintFoot();
  };

  const editRow = (r) => {
    if (!r || busy(r)) return;
    const sub = openSheet(`<div class="ti-pick">
        <div class="sheet-head"><h3>曲を選ぶ・直す</h3><button type="button" class="icon-btn" data-act="close" aria-label="閉じる">${icon('close')}</button></div>
        <div class="sheet-body">
          <p class="ti-orig">元のテキスト：<span>${esc(r.line)}</span></p>
          <form class="ti-search" data-role="search"><input class="input" type="search" name="q" value="${esc(r.info.term)}" aria-label="検索する言葉" enterkeyhint="search" autocomplete="off"><button type="submit" class="btn sm">${icon('search')}検索</button></form>
          <ul class="hist-list" data-role="cands"></ul>
          <h4 class="ti-h">自分で入力する</h4>
          <form class="ti-manual" data-role="manual" novalidate>
            <label class="label" for="ti-artist">アーティスト</label>
            <input id="ti-artist" class="input" name="artist" value="${esc(r.artist)}" autocomplete="off">
            <label class="label" for="ti-title">曲名</label>
            <input id="ti-title" class="input" name="title" value="${esc(r.title)}" autocomplete="off">
            <button type="submit" class="btn wide">この内容にする</button>
          </form>
        </div>
      </div>`, { label: '曲を選ぶ・直す', className: 'history-layer' });
    let cands = r.cands;
    const list = $('[data-role="cands"]', sub.el);
    const same = (a, b) => !!a && !!b && a.artist === b.artist && a.title === b.title && a.album === b.album;
    const paintCands = (msg) => {
      if (msg) {
        list.innerHTML = `<li class="hist-more">${esc(msg)}</li>`;
        return;
      }
      list.innerHTML = cands.length
        ? cands.map((s, k) => {
          const on = same(s, r.pick);
          return `<li><button type="button" class="hist-row ti-cand${on ? ' on' : ''}" data-k="${k}"${on ? ' aria-current="true"' : ''}>
              <span class="hist-art">${s.artwork ? `<img src="${esc(s.artwork)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : icon('music')}</span>
              <span class="hist-text"><span class="hist-t">${esc(trimReading(s.title))}</span><span class="hist-a">${esc(s.artist)}${s.album ? ` · ${esc(s.album)}` : ''}</span></span>
              ${on ? icon('check') : ''}
            </button></li>`;
        }).join('')
        : '<li class="hist-more">候補がありません。検索する言葉を変えるか、下で入力してください。</li>';
    };
    const done = () => {
      r.status = 'ok';
      r.checked = true;
      sub.close();
      paintRow(r);
      paintList();
      paintFilter();
      paintFoot();
    };
    paintCands();
    sub.el.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const fd = new FormData(f);
      if (f.dataset.role === 'search') {
        const q = String(fd.get('q') ?? '').trim();
        if (!q) return;
        paintCands('探しています…');
        try {
          const res = await searchWhenFree(q, () => list.isConnected);
          if (!list.isConnected) return;
          cands = mergeCandidates(scoreSongs(res, r.info)).map((c) => c.song);
        } catch (err) {
          console.warn(err);
          paintCands('探せませんでした。通信を確認してください');
          return;
        }
        paintCands();
        return;
      }
      const artist = String(fd.get('artist') ?? '').trim();
      const title = String(fd.get('title') ?? '').trim();
      if (!title) {
        $('#ti-title', sub.el).focus();
        return;
      }
      const keep = r.pick && looseKey(r.pick.artist) === looseKey(artist) && looseKey(trimReading(r.pick.title)) === looseKey(title);
      if (!keep) {
        r.pick = null;
        r.artwork = null;
      }
      r.artist = artist;
      r.title = title;
      done();
    });
    sub.el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.act === 'close') sub.close();
      else if (b.dataset.k != null) {
        const s = cands[+b.dataset.k];
        if (!s) return;
        setPick(r, s);
        done();
      }
    });
  };

  const addPicked = async () => {
    const picks = job.rows.filter(canAdd);
    if (!picks.length) return;
    const left = job.rows.filter(busy).length;
    if (left && !(await confirmDialog({ title: `${picks.length}曲を追加しますか？`, message: `まだ調べていない${left}行は追加しません。`, ok: '追加する' }))) return;
    job.gen++;
    const now = Date.now();
    const entries = picks.map((r, i) => ({
      id: newSongId(),
      data: toPayload(normalizeSong({ ...emptySong(), artist: r.artist, title: r.title, artwork: r.artwork, createdAt: now - i, updatedAt: now })),
    }));
    state.store.putSongs(entries);
    runRangeBatch(entries.map((e) => ({ id: e.id, artist: e.data.artist, title: e.data.title })));
    const artists = [...new Set(picks.map((r) => r.artist).filter(Boolean))].filter((n) => !state.profile.artists.includes(n));
    if (artists.length) state.store.addArtists(artists);
    // 行に書いた略称と、選んだアーティスト名を覚えて、次から使う
    const learned = {};
    for (const r of picks) {
      const a = aliasToLearn(r.info, r.artist, r.title);
      if (a && aliases.get(a[0]) !== a[1]) learned[a[0]] = a[1];
    }
    if (Object.keys(learned).length) state.store.updateProfile({ aliases: sanitizeAliases({ ...state.profile.aliases, ...learned }) });
    sheet.close();
    toast(`${picks.length}曲を追加しました`);
  };

  sheet.el.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.edit != null) {
      editRow(job.rows[+b.dataset.edit]);
      return;
    }
    if (b.dataset.filter) {
      job.filter = b.dataset.filter;
      paintFilter();
      paintList();
      return;
    }
    switch (b.dataset.act) {
      case 'close':
        if (job.rows.length && !(await confirmDialog({ title: '閉じますか？', message: '調べた結果は消えます（まだ追加していません）。', ok: '閉じる' }))) return;
        sheet.close();
        break;
      case 'run': start(); break;
      case 'stop': stop(); break;
      case 'resume': run(); break;
      case 'back':
        if (await confirmDialog({ title: 'テキストに戻りますか？', message: '調べた結果は消えます。テキストはそのまま残ります。', ok: '戻る' })) showInput();
        break;
      case 'add': addPicked(); break;
      default:
    }
  });
  sheet.el.addEventListener('change', (e) => {
    const i = e.target.dataset.check;
    if (i == null) return;
    job.rows[+i].checked = e.target.checked;
    paintList();
    paintFilter();
    paintFoot();
  });
  showInput();
  setTimeout(() => $('[data-role="text"]', body)?.focus({ preventScroll: true }), 80);
}

// ---- 設定 -------------------------------------------------------------

function openSettings() {
  if (state.settings) return;
  const sheet = openSheet('<div class="settings"></div>', {
    label: '設定',
    onClose: () => { state.settings = null; },
  });
  state.settings = sheet;
  paintSettings();
  sheet.el.addEventListener('click', onSettingsClick);
  sheet.el.addEventListener('change', (e) => {
    if (e.target.dataset.role === 'show-art') {
      updateView({ showArt: e.target.checked });
      paintSettings();
    }
    if (e.target.dataset.role === 'swipe') setDevicePref({ swipe: e.target.checked });
    if (e.target.dataset.role === 'hap-on') setHaptics({ on: e.target.checked });
    if (e.target.dataset.hap) setHaptics({ [e.target.dataset.hap]: e.target.checked });
  });
}

// 触覚フィードバックの設定（この端末）。指で操作する端末で、振動できるときだけ出す
function hapticsSettingsHTML() {
  const mode = hapticMode();
  if (!mode) return '';
  const hp = devicePrefs.haptics;
  const off = hp.on ? '' : ' disabled';
  return `<section class="set-sec hap-sec${hp.on ? '' : ' off'}">
        <h4>触覚フィードバック（この端末）</h4>
        <label class="switch-row"><span>操作したときに振動する</span><input type="checkbox" class="switch" data-role="hap-on"${hp.on ? ' checked' : ''}></label>
        <span class="set-label">振動する操作</span>
        ${HAPTIC_EVENTS.map((ev) => `<label class="switch-row"><span>${ev.label}</span><input type="checkbox" class="switch" data-hap="${ev.id}"${hp[ev.id] ? ' checked' : ''}${off}></label>`).join('')}
        <p class="hint">キーの変更は、±1・原キー・オク下・オク上・おすすめキーへの変更です。${mode === 'ios' ? 'iPhone では iOS 18 以降で、本体の「設定」→「サウンドと触覚」→「システムの触覚」がオンのときに振動します。' : ''}</p>
      </section>`;
}

function setHaptics(patch) {
  setDevicePref({ haptics: sanitizeHaptics({ ...devicePrefs.haptics, ...patch }) });
}

function paintSettings() {
  const sheet = state.settings;
  if (!sheet) return;
  const vo = voice();
  const scrollTop = $('.settings .sheet-body', sheet.el)?.scrollTop ?? 0;
  const p = state.profile.prefs;
  const seg = (attr, options, current) => `<div class="seg full" role="group">${options.map(([v, l]) => `<button type="button" data-${attr}="${v}" aria-pressed="${String(v) === String(current)}">${l}</button>`).join('')}</div>`;
  $('.settings', sheet.el).innerHTML = `
    <div class="sheet-head"><h3>設定</h3><button type="button" class="icon-btn" data-act="close" aria-label="閉じる">${icon('close')}</button></div>
    <div class="sheet-body">
      ${accountSettingsHTML()}
      <section class="set-sec">
        <h4>表示（この端末）</h4>
        <span class="set-label">テーマ</span>
        ${seg('theme-set', [['system', '端末に合わせる'], ['light', 'ライト'], ['dark', 'ダーク']], devicePrefs.theme)}
        <span class="set-label">一覧の文字の大きさ</span>
        ${seg('density', [['compact', 'コンパクト'], ['normal', '標準'], ['large', '大きめ']], devicePrefs.density)}
        <label class="switch-row"><span>一覧にジャケット画像を表示</span><input type="checkbox" class="switch" data-role="show-art"${state.view.showArt ? ' checked' : ''}></label>
        <label class="switch-row"><span>一覧のスワイプ操作</span><input type="checkbox" class="switch" data-role="swipe"${devicePrefs.swipe ? ' checked' : ''}></label>
        <p class="hint">曲の行を右へスワイプすると「歌った！」を記録し、左へスワイプするとお気に入りを切り替えます（スマホなど指で操作するときだけ）。</p>
        <span class="set-label">ランダム選曲の演出</span>
        ${seg('random-fx', RANDOM_FX.map((f) => [f.id, f.label]), devicePrefs.randomFx)}
        <p class="hint">曲を選ぶときの演出です。演出の途中で画面をタップすると、すぐに結果を表示します。</p>
      </section>
      ${hapticsSettingsHTML()}
      <section class="set-sec">
        <h4>表示（すべての端末で共通）</h4>
        <span class="set-label">アクセントカラー</span>
        <div class="accent-set">${ACCENTS.map((a) => `<button type="button" class="swatch" style="background:${a.color}" data-accent-set="${a.id}" aria-pressed="${p.accent === a.id}" aria-label="${a.label}" title="${a.label}">${icon('check')}</button>`).join('')}</div>
        <span class="set-label">音域の表記</span>
        ${seg('note-style', NOTE_STYLES.map((s) => [s.id, s.label]), p.noteStyle)}
        <p class="hint">G4 形式は音楽で一般的な表記で、mid2G は G4、hiA は A4 です。「両方」では、詳細画面や入力欄に並べて表示します。</p>
      </section>
      <section class="set-sec">
        <h4>自分の音域</h4>
        <div class="note-fields">
          ${RANGE_FIELDS.map((f) => `<button type="button" class="note-field${isNote(vo[f.id]) ? ' set' : ''}" data-voice="${f.id}"><span class="nf-l">${f.label}</span><span class="nf-v">${isNote(vo[f.id]) ? fmtNoteHTML(vo[f.id]) : '未選択'}</span></button>`).join('')}
        </div>
        <p class="hint">登録すると、曲ごとに「おすすめキー」を表示します。</p>
        <span class="set-label">おすすめキーの余裕</span>
        ${seg('offset', REC_OFFSETS.map((m) => [m, m ? `−${m}半音` : 'ちょうど']), p.recOffset)}
        <p class="hint">おすすめキーは、曲の地声最高音が、自分の地声最高音よりこの分だけ低くなるキーです。そのキーでも最低音や裏声最高音が自分の音域を超えるときは、注意を表示します。</p>
      </section>
      <section class="set-sec">
        <h4>タグと入力補助</h4>
        <button type="button" class="row-btn" data-act="tags">
          <span class="row-l">${icon('tag')}タグの管理</span>
          <span class="row-r">${tagList().length}件${icon('chevron-right')}</span>
        </button>
        <button type="button" class="row-btn" data-act="artists" style="margin-top:8px">
          <span class="row-l">${icon('list')}アーティスト名の候補</span>
          <span class="row-r">${state.profile.artists.length}件${icon('chevron-right')}</span>
        </button>
      </section>
      ${readingSettingsHTML()}
      ${rangeBatchSettingsHTML()}
      <section class="set-sec">
        <h4>ジャケット画像</h4>
        <div data-role="art-job">${artJobHTML()}</div>
        <p class="hint">画像が未設定の曲を iTunes で探して入れます。1曲に数秒かかるので、曲数が多いときは時間がかかります。</p>
      </section>
      <section class="set-sec">
        <h4>まとめて追加</h4>
        <button type="button" class="btn wide" data-act="text-import">${icon('list')}テキストから追加</button>
        <p class="hint">メモなどに書いた曲の一覧（「アーティスト名 - 曲名」など）を貼り付けると、iTunes で調べて、確認してからまとめて追加できます。</p>
        <button type="button" class="btn wide" data-act="history">${icon('history')}YouTube Music の再生履歴を読み込む</button>
        <p class="hint">Google Takeout で書き出した watch-history.json（ZIP のままでも可）から、よく聴いている曲を候補に出します。履歴はこの端末の中だけで読み込み、どこにも保存しません。</p>
      </section>
      <section class="set-sec">
        <h4>バックアップ</h4>
        <div class="btn-row">
          <button type="button" class="btn" data-act="export">${icon('download')}CSVに書き出す</button>
          <button type="button" class="btn" data-act="import">${icon('upload')}CSVを読み込む</button>
        </div>
        <p class="hint">CSV は表計算ソフトで編集できます。読み込むと、まとめて登録・復元できます。</p>
      </section>
      ${previewSupported() ? `<section class="set-sec" data-role="pv-files" hidden>
        <h4>試聴の音楽ファイル（この端末）</h4>
        <div class="pv-files"><span data-role="pv-sum"></span><button type="button" class="btn sm danger-ghost" data-act="pv-clear">${icon('trash')}すべて削除</button></div>
        <p class="hint">曲の詳細画面の「試聴」で選んだファイルです。この端末にだけ保存しています。</p>
      </section>` : ''}
    </div>`;
  const body = $('.settings .sheet-body', sheet.el);
  if (body) body.scrollTop = scrollTop;
  paintAudioFiles();
}

function accountSettingsHTML() {
  const user = state.user;
  if (!state.store.canSignIn) {
    return `<section class="set-sec">
        <h4>アカウント</h4>
        <p class="hint">ローカルモード：データはこのブラウザだけに保存されています。</p>
      </section>`;
  }
  if (user?.local) {
    return `<section class="set-sec">
        <h4>アカウント</h4>
        <p class="hint">ログインしていません。データはこの端末のブラウザだけに保存しています。</p>
        <button type="button" class="btn primary wide" data-act="login"${state.signingIn ? ' disabled' : ''}>${icon('login')}Google でログイン</button>
        <p class="hint">ログインすると、スマホと PC など複数の端末で同じリストを使えます。この端末の曲は、ログインしたあとにアカウントへ移せます。</p>
      </section>`;
  }
  const n = state.store.localData().songs.length;
  return `<section class="set-sec">
      <h4>アカウント</h4>
      <div class="account"><span class="acc-name">${esc(user?.email ?? user?.name ?? '')}</span><button type="button" class="btn sm" data-act="logout">${icon('logout')}ログアウト</button></div>
      <p class="hint">ログインしている端末どうしで、同じリストを使えます。</p>
      ${n ? `<div class="acc-local">
        <span>ログインする前にこの端末に保存した曲が${n}曲あります。</span>
        <button type="button" class="btn sm" data-act="move-local"${state.moving ? ' disabled' : ''}>${icon('upload')}アカウントに移す</button>
      </div>` : ''}
    </section>`;
}

async function paintAudioFiles() {
  const sec = state.settings && $('[data-role="pv-files"]', state.settings.el);
  if (!sec) return;
  let sum = null;
  try {
    sum = await audioFiles.summary();
  } catch {
    return;
  }
  if (!sec.isConnected) return;
  sec.hidden = !sum.count;
  $('[data-role="pv-sum"]', sec).textContent = `${sum.count}曲（${formatBytes(sum.bytes)}）`;
}

async function onSettingsClick(e) {
  const b = e.target.closest('button');
  if (!b || !state.settings) return;
  if (b.dataset.voice) {
    const id = b.dataset.voice;
    const f = RANGE_FIELDS.find((x) => x.id === id);
    const v = await pickNote({ title: `自分の${f.label}`, value: voice()[id] ?? null, octave: DEFAULT_OCTAVE[id], clearLabel: '未選択に戻す' });
    if (v === undefined) return;
    state.store.updateProfile({ range: { ...voice(), [id]: v } });
    return;
  }
  if (b.dataset.themeSet) return setDevicePref({ theme: b.dataset.themeSet });
  if (b.dataset.density) return setDevicePref({ density: b.dataset.density });
  if (b.dataset.randomFx) return setDevicePref({ randomFx: b.dataset.randomFx });
  if (b.dataset.accentSet) return updateAccountPrefs({ accent: b.dataset.accentSet });
  if (b.dataset.noteStyle) return updateAccountPrefs({ noteStyle: b.dataset.noteStyle });
  if (b.dataset.offset != null) return updateAccountPrefs({ recOffset: +b.dataset.offset });
  switch (b.dataset.act) {
    case 'close': state.settings.close(); break;
    case 'artists': openArtists(); break;
    case 'tags': openTagManager(); break;
    case 'export': exportCSV(); break;
    case 'import': $('#csv-file').click(); break;
    case 'art-run': runArtJob(); break;
    case 'range-batch': {
      const targets = state.songs.filter(isRangeMissing);
      if (!targets.length) break;
      const ok = await confirmDialog({
        title: `${targets.length}曲の音域を取り込みますか？`,
        message: '1曲ずつ順に調べるので、曲数が多いと時間がかかります。調べている間も、ほかの操作はできます。',
        ok: '取り込む',
      });
      if (ok) runRangeBatch(targets.map((s) => ({ id: s.id, artist: s.artist, title: s.title })));
      break;
    }
    case 'reading': openReadingCleanup(); break;
    case 'art-cancel': artJob.cancel = true; break;
    case 'history': $('#history-file').click(); break;
    case 'text-import': openTextImport(); break;
    case 'pv-clear':
      if (await confirmDialog({ title: '試聴の音楽ファイルをすべて削除しますか？', message: 'この端末に保存したファイルを削除します。元のファイルは消えません。', ok: '削除する', danger: true })) {
        state.detail?.preview?.stop();
        await audioFiles.clear().catch(() => {});
        paintAudioFiles();
        toast('削除しました');
      }
      break;
    case 'login': signIn(); break;
    case 'move-local': offerLocalMove(); break;
    case 'logout':
      if (await confirmDialog({
        title: 'ログアウトしますか？',
        message: 'アカウントの曲は消えず、もう一度ログインすると表示されます。この端末では、ログインしていないときのリストに切り替わります。',
        ok: 'ログアウト',
      })) {
        state.settings?.close();
        state.store.signOut();
      }
      break;
    default:
  }
}

function openArtists() {
  const sheet = openSheet(`<div class="artists">
      <div class="sheet-head"><h3>アーティスト名の候補</h3><button type="button" class="icon-btn" data-act="close" aria-label="閉じる">${icon('close')}</button></div>
      <div class="sheet-body">
        <p class="hint">曲の登録時に候補として表示される名前です。候補から外しても、登録済みの曲は消えません。</p>
        <label class="search sm">${icon('search')}<input type="search" data-role="q" placeholder="絞り込み" autocomplete="off" aria-label="アーティスト名を絞り込む"></label>
        <ul class="artist-list" data-role="list"></ul>
      </div>
    </div>`, {
    label: 'アーティスト名の候補',
    onClose: () => { state.artistsSheet = null; },
  });
  state.artistsSheet = sheet;
  $('[data-role="q"]', sheet.el).addEventListener('input', paintArtists);
  sheet.el.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.act === 'close') sheet.close();
    if (b.dataset.remove != null) {
      const name = b.dataset.remove;
      const ok = await confirmDialog({
        title: '候補から外しますか？',
        message: `「${name}」を入力候補から外します。登録済みの曲は削除されません。`,
        ok: '候補から外す',
        danger: true,
      });
      if (ok) state.store.removeArtist(name);
    }
  });
  paintArtists();
}

function paintArtists() {
  const sheet = state.artistsSheet;
  if (!sheet) return;
  const q = $('[data-role="q"]', sheet.el).value.trim().toLowerCase();
  const counts = artistCounts(state.songs);
  const names = [...state.profile.artists].sort(collator.compare).filter((n) => !q || n.toLowerCase().includes(q));
  $('[data-role="list"]', sheet.el).innerHTML = names.length
    ? names.map((n) => `<li><span class="al-name">${esc(n)}</span><span class="al-count">${counts.get(n) ?? 0}曲</span>
        <button type="button" class="icon-btn sm" data-remove="${esc(n)}" aria-label="${esc(n)}を候補から外す">${icon('trash')}</button></li>`).join('')
    : `<li class="al-empty">${q ? '一致する名前がありません' : 'まだ候補がありません'}</li>`;
}

// ---- 表示の設定 -------------------------------------------------------
// テーマと一覧の文字の大きさは端末ごと（この端末に記憶）。
// アクセントカラー・音域の表記・おすすめキーの余裕はアカウントに保存し、全端末で共通にする。

function applyDevicePrefs() {
  const root = document.documentElement;
  if (devicePrefs.theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = devicePrefs.theme;
  if (devicePrefs.density === 'normal') delete root.dataset.density;
  else root.dataset.density = devicePrefs.density;
  // スマホのステータスバーの色もテーマに合わせる
  $$('meta[name="theme-color"]').forEach((m) => {
    const dark = devicePrefs.theme === 'system' ? m.media.includes('dark') : devicePrefs.theme === 'dark';
    m.content = dark ? '#0d0e11' : '#f4f5f7';
  });
}

function setDevicePref(patch) {
  Object.assign(devicePrefs, patch);
  saveDevicePrefs();
  applyDevicePrefs();
  paintSettings();
}

function applyAccountPrefs() {
  const p = state.profile.prefs;
  if (getNoteStyle() !== p.noteStyle) {
    setNoteStyle(p.noteStyle);
    // 表記が変わったら、一覧などを描き直す
    items.forEach((it) => { it.sig = ''; });
    fpSig = '';
    chipsSig = '';
    if (state.detail) state.detail.sig = '';
  }
  const root = document.documentElement;
  if (p.accent === 'indigo') delete root.dataset.accent;
  else root.dataset.accent = p.accent;
  if (devicePrefs.accent !== p.accent) {
    devicePrefs.accent = p.accent;
    saveDevicePrefs();
  }
}

function updateAccountPrefs(patch) {
  const next = { ...state.profile.prefs, ...patch };
  state.profile.prefs = next;
  applyAccountPrefs();
  render();
  paintDetail();
  paintKeyMenu();
  paintSettings();
  paintRandom();
  state.store.updateProfile({ prefs: next });
}

// ---- タグ -------------------------------------------------------------

// 設定のタグ一覧に足りないタグを足す（最初の 1 回は、今あるタグをすべて一覧として保存する）
function ensureTags(names) {
  const cur = tagList();
  const add = [...new Set(names.map((n) => String(n).trim()).filter((n) => n && !cur.includes(n)))];
  const saved = state.profile.tags;
  if (!add.length && Array.isArray(saved) && cur.every((t) => saved.includes(t))) return;
  const next = [...cur, ...add];
  state.profile.tags = next;
  state.store.updateProfile({ tags: next });
}

function replaceTagInConditions(oldName, newName) {
  const swap = (list) => [...new Set(list.flatMap((t) => (t === oldName ? (newName ? [newName] : []) : [t])))];
  if (state.view.tags.includes(oldName)) updateView({ tags: swap(state.view.tags) });
  const ro = state.random.opts;
  if (ro?.tags.includes(oldName)) {
    state.random.opts = { ...ro, tags: swap(ro.tags) };
    saveRandomOptions();
  }
}

function renameTag(oldName, newName) {
  const n = newName.trim();
  if (!n || n === oldName) return;
  const list = tagList();
  const next = list.includes(n) ? list.filter((t) => t !== oldName) : list.map((t) => (t === oldName ? n : t));
  state.profile.tags = next;
  state.store.updateProfile({ tags: next });
  const entries = state.songs
    .filter((s) => s.tags.includes(oldName))
    .map((s) => ({ id: s.id, data: { tags: [...new Set(s.tags.map((t) => (t === oldName ? n : t)))] } }));
  if (entries.length) state.store.putSongs(entries);
  const colors = new Map(state.profile.tagColors);
  if (colors.has(oldName)) {
    if (!colors.has(n)) colors.set(n, colors.get(oldName));
    colors.delete(oldName);
    saveTagColors(colors);
  }
  replaceTagInConditions(oldName, n);
  toast(`「${oldName}」を「${n}」に変えました${entries.length ? `（${entries.length}曲）` : ''}`);
}

async function deleteTag(name) {
  const count = tagCounts(state.songs).get(name) ?? 0;
  const ok = await confirmDialog({
    title: `タグ「${name}」を削除しますか？`,
    message: count ? `付いている ${count}曲 からも外れます。曲そのものは削除されません。` : '',
    ok: '削除する',
    danger: true,
  });
  if (!ok) return;
  const next = tagList().filter((t) => t !== name);
  state.profile.tags = next;
  state.store.updateProfile({ tags: next });
  const entries = state.songs.filter((s) => s.tags.includes(name)).map((s) => ({ id: s.id, data: { tags: s.tags.filter((t) => t !== name) } }));
  if (entries.length) state.store.putSongs(entries);
  if (state.profile.tagColors.has(name)) {
    const colors = new Map(state.profile.tagColors);
    colors.delete(name);
    saveTagColors(colors);
  }
  replaceTagInConditions(name, null);
  toast(`タグ「${name}」を削除しました`);
}

// タグの色（見た目用の属性）。標準の色のタグは何も付けない
function tagC(t) {
  const c = state.profile.tagColors.get(t);
  return c ? ` data-c="${c}"` : '';
}

function saveTagColors(map) {
  state.profile.tagColors = map;
  state.store.updateProfile({ tagColors: tagColorList(map) });
}

// color：TAG_COLORS の id。'' なら標準の色（アクセントカラー）に戻す
function setTagColor(name, color) {
  const map = new Map(state.profile.tagColors);
  if (color) map.set(name, color);
  else map.delete(name);
  saveTagColors(map);
  render();
  paintDetail();
}

// タグの色を選ぶ。戻り値：TAG_COLORS の id か ''（標準）。閉じたときは undefined
function pickTagColor(name) {
  const cur = state.profile.tagColors.get(name) ?? '';
  return new Promise((resolve) => {
    let picked;
    const sw = (id, label) => `<button type="button" class="tc-sw" data-color="${id}" aria-pressed="${cur === id}" aria-label="${esc(label)}"><span class="tag"${id ? ` data-c="${id}"` : ''}>${esc(name)}</span></button>`;
    const s = openSheet(`<div class="dlg">
        <h3 class="dlg-title">「${esc(name)}」の色</h3>
        <div class="tc-grid">${sw('', '標準（アクセントカラー）')}${TAG_COLORS.map((c) => sw(c.id, c.label)).join('')}</div>
        <div class="dlg-actions"><button type="button" class="btn" data-act="cancel">キャンセル</button></div>
      </div>`, { variant: 'dialog', label: `「${name}」の色`, onClose: () => resolve(picked) });
    s.el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.color != null) {
        picked = b.dataset.color;
        s.close();
      } else if (b.dataset.act === 'cancel') s.close();
    });
  });
}

function moveTag(name, dir) {
  const list = tagList();
  const i = list.indexOf(name);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  state.profile.tags = list;
  state.store.updateProfile({ tags: list });
  paintTagManager();
}

async function askNewTag() {
  const name = await promptDialog({ title: '新しいタグ', placeholder: '例：盛り上がる曲', ok: '追加', maxLength: 20 });
  if (!name) return null;
  ensureTags([name]);
  return name;
}

function openTagManager() {
  if (state.tagSheet) return;
  const sheet = openSheet(`<div class="tags-mgr">
      <div class="sheet-head"><h3>タグの管理</h3><button type="button" class="icon-btn" data-act="close" aria-label="閉じる">${icon('close')}</button></div>
      <div class="sheet-body">
        <p class="hint">作ったタグは、曲の登録・詳細画面、一覧の絞り込み、ランダム選曲で使えます。名前を変えると、付いている曲すべてに反映されます。左の丸をタップすると、タグの色を変えられます。</p>
        <form class="tag-new" data-role="new-form">
          <input class="input" data-role="new" placeholder="新しいタグ" maxlength="20" enterkeyhint="done" autocomplete="off" aria-label="新しいタグ">
          <button type="submit" class="btn">追加</button>
        </form>
        <ul class="tag-list" data-role="list"></ul>
      </div>
    </div>`, {
    label: 'タグの管理',
    onClose: () => { state.tagSheet = null; },
  });
  state.tagSheet = sheet;
  $('[data-role="new-form"]', sheet.el).addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('[data-role="new"]', sheet.el);
    const name = input.value.trim();
    if (!name) return;
    if (tagList().includes(name)) toast(`「${name}」はすでにあります`);
    else ensureTags([name]);
    input.value = '';
    paintTagManager();
  });
  sheet.el.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const name = b.closest('[data-tag-row]')?.dataset.tagRow;
    switch (b.dataset.act) {
      case 'close': sheet.close(); break;
      case 'up': moveTag(name, -1); break;
      case 'down': moveTag(name, 1); break;
      case 'rename': {
        const n = await promptDialog({ title: 'タグの名前を変える', value: name, ok: '変更', maxLength: 20 });
        if (n) renameTag(name, n);
        break;
      }
      case 'delete': await deleteTag(name); break;
      case 'color': {
        const c = await pickTagColor(name);
        if (c !== undefined) setTagColor(name, c);
        break;
      }
      default:
    }
    paintTagManager();
  });
  paintTagManager();
}

function paintTagManager() {
  const sheet = state.tagSheet;
  if (!sheet) return;
  const list = tagList();
  const counts = tagCounts(state.songs);
  $('[data-role="list"]', sheet.el).innerHTML = list.length
    ? list.map((t, i) => `<li class="tag-row" data-tag-row="${esc(t)}">
        <button type="button" class="tag-dot" data-act="color"${tagC(t)} aria-label="「${esc(t)}」の色を変える"></button>
        <span class="tag-name">${esc(t)}</span>
        <span class="tag-count">${counts.get(t) ?? 0}曲</span>
        <button type="button" class="icon-btn sm" data-act="up" aria-label="上へ"${i === 0 ? ' disabled' : ''}>${icon('arrow-up')}</button>
        <button type="button" class="icon-btn sm" data-act="down" aria-label="下へ"${i === list.length - 1 ? ' disabled' : ''}>${icon('arrow-down')}</button>
        <button type="button" class="icon-btn sm" data-act="rename" aria-label="名前を変える">${icon('pen')}</button>
        <button type="button" class="icon-btn sm" data-act="delete" aria-label="削除">${icon('trash')}</button>
      </li>`).join('')
    : '<li class="al-empty">まだタグがありません</li>';
}

// ---- 一覧で複数選択 ---------------------------------------------------

const selectedSongs = () => [...state.select.ids].map((id) => state.byId.get(id)).filter(Boolean);

function setSelectMode(on) {
  state.select.on = on;
  if (!on) state.select.ids.clear();
  $('#app').classList.toggle('selecting', on);
  $('#selbar').hidden = !on;
  $('#btn-select').setAttribute('aria-pressed', String(on));
  closePopover();
  render();
  paintSelbar();
}

function toggleSelect(id) {
  const ids = state.select.ids;
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  items.get(id)?.el.classList.toggle('selected', ids.has(id));
  paintSelbar();
}

function paintSelbar() {
  if (!state.select.on) return;
  for (const id of [...state.select.ids]) if (!state.byId.has(id)) state.select.ids.delete(id);
  const n = state.select.ids.size;
  $('#sel-count').textContent = `${n}曲を選択中`;
  $$('#selbar .selbar-actions .btn').forEach((b) => { b.disabled = !n; });
  paintBulkTags();
}

async function onSelbarClick(e) {
  const a = e.target.closest('[data-sel]')?.dataset.sel;
  if (!a) return;
  const sel = selectedSongs();
  if (a === 'done') setSelectMode(false);
  else if (a === 'all') {
    state.visible.forEach((s) => state.select.ids.add(s.id));
    render();
    paintSelbar();
  } else if (a === 'tag') openBulkTags();
  else if (a === 'fav') {
    const allFav = sel.every((s) => s.favorite);
    haptic('fav');
    state.store.putSongs(sel.map((s) => ({ id: s.id, data: { favorite: !allFav } })));
    toast(allFav ? `${sel.length}曲をお気に入りから外しました` : `${sel.length}曲をお気に入りにしました`);
  } else if (a === 'delete') {
    const ok = await confirmDialog({
      title: `${sel.length}曲を削除しますか？`,
      message: `${sel.slice(0, 3).map((s) => s.title).join('、')}${sel.length > 3 ? ' など' : ''}\n削除すると元に戻せません。`,
      ok: '削除する',
      danger: true,
    });
    if (!ok) return;
    state.store.putSongs([], sel.map((s) => s.id));
    removeAudioFiles(sel.map((s) => s.id));
    setSelectMode(false);
    toast(`${sel.length}曲を削除しました`);
  }
}

// 選んだ曲にまとめてタグを付け外しする。タップするたびにすぐ反映する
function openBulkTags() {
  if (state.bulkSheet) return;
  const sheet = openSheet(`<div class="bulk-tags">
      <div class="sheet-head"><h3>タグを付ける・外す</h3><button type="button" class="icon-btn" data-act="close" aria-label="閉じる">${icon('close')}</button></div>
      <div class="sheet-body">
        <p class="hint bulk-note" data-role="note"></p>
        <div class="chip-set" data-role="chips"></div>
      </div>
    </div>`, {
    label: 'タグを付ける・外す',
    onClose: () => { state.bulkSheet = null; },
  });
  state.bulkSheet = sheet;
  sheet.el.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.act === 'close') {
      sheet.close();
      return;
    }
    let tag = b.dataset.btag;
    if (b.dataset.act === 'new') tag = await askNewTag();
    if (!tag) return;
    const sel = selectedSongs();
    const all = sel.every((s) => s.tags.includes(tag));
    const remove = all && b.dataset.act !== 'new';
    state.store.putSongs(sel.map((s) => ({
      id: s.id,
      data: { tags: remove ? s.tags.filter((t) => t !== tag) : [...new Set([...s.tags, tag])] },
    })));
    toast(remove ? `${sel.length}曲から「${tag}」を外しました` : `${sel.length}曲に「${tag}」を付けました`);
  });
  paintBulkTags();
}

function paintBulkTags() {
  const sheet = state.bulkSheet;
  if (!sheet) return;
  const sel = selectedSongs();
  $('[data-role="note"]', sheet.el).textContent = `選んだ ${sel.length}曲 に対して、タップでタグを付けたり外したりします。点線のタグは、一部の曲にだけ付いています。`;
  $('[data-role="chips"]', sheet.el).innerHTML = tagList().map((t) => {
    const n = sel.filter((s) => s.tags.includes(t)).length;
    const cls = n && n === sel.length ? ' on' : n ? ' partial' : '';
    return `<button type="button" class="chip${cls}"${tagC(t)} data-btag="${esc(t)}" aria-pressed="${n === sel.length && n > 0}">${esc(t)}</button>`;
  }).join('') + `<button type="button" class="chip add" data-act="new">${icon('plus')}新しいタグ</button>`;
}

// ---- 一覧のスワイプ操作 -----------------------------------------------
// 右へスワイプ：「歌った！」を記録／左へスワイプ：お気に入りの切り替え。
// 指で触ったときだけ動かす（マウスでは動かさない）。縦のスクロールはブラウザに任せる。

const SWIPE_THRESHOLD = 72;

function toggleFavorite(id) {
  const s = state.byId.get(id);
  if (!s) return;
  const prev = s.favorite;
  haptic('fav');
  state.store.updateSong(id, { favorite: !prev });
  toast(prev ? `「${s.title}」をお気に入りから外しました` : `「${s.title}」をお気に入りにしました`, {
    action: '元に戻す',
    onAction: () => state.store.updateSong(id, { favorite: prev }),
  });
}

function setupSwipe(ul) {
  let st = null;
  let suppressClick = false;
  ul.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || state.select.on || !devicePrefs.swipe) return;
    const li = e.target.closest('.song');
    if (!li || li.classList.contains('skeleton')) return;
    st = { li, inner: $('.song-inner', li), id: li.dataset.id, x0: e.clientX, y0: e.clientY, dx: 0, active: false, armed: false, pid: e.pointerId };
  });
  ul.addEventListener('pointermove', (e) => {
    if (!st || e.pointerId !== st.pid) return;
    const dx = e.clientX - st.x0;
    const dy = e.clientY - st.y0;
    if (!st.active) {
      // 縦の動きが先に大きくなったら、スクロールとみなして何もしない
      if (Math.abs(dy) > 8 && Math.abs(dy) >= Math.abs(dx)) {
        st = null;
        return;
      }
      if (Math.abs(dx) < 12) return;
      st.active = true;
      closePopover();
      st.li.classList.remove('settling');
      st.li.classList.add('swiping');
      try {
        st.li.setPointerCapture(e.pointerId);
      } catch { /* 取れなくても動く */ }
    }
    const mag = Math.abs(dx);
    // しきい値を超えたら、指の動きより少し重く動かす
    const eased = mag <= SWIPE_THRESHOLD ? mag : SWIPE_THRESHOLD + (mag - SWIPE_THRESHOLD) * 0.35;
    const x = Math.sign(dx) * Math.min(eased, st.li.clientWidth * 0.45);
    st.dx = dx;
    st.inner.style.transform = `translateX(${x}px)`;
    st.li.dataset.swipe = dx > 0 ? 'right' : 'left';
    const armed = mag >= SWIPE_THRESHOLD;
    if (armed !== st.armed) {
      st.armed = armed;
      st.li.classList.toggle('armed', armed);
      if (armed) haptic('swipe');
    }
  });
  const end = (e) => {
    if (!st || (e && e.pointerId !== st.pid)) return;
    const { li, inner, active, armed, dx, id } = st;
    st = null;
    if (!active) return;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 350);
    li.classList.remove('swiping');
    li.classList.add('settling');
    inner.style.transform = '';
    setTimeout(() => {
      li.classList.remove('settling', 'armed');
      delete li.dataset.swipe;
    }, 240);
    if (!armed) return;
    if (dx > 0) markSung(id);
    else toggleFavorite(id);
  };
  ul.addEventListener('pointerup', end);
  ul.addEventListener('pointercancel', end);
  // スワイプした直後の「クリック」で詳細画面やキーの操作が動かないようにする
  ul.addEventListener('click', (e) => {
    if (!suppressClick) return;
    suppressClick = false;
    e.stopPropagation();
    e.preventDefault();
  }, true);
}

// ---- CSV --------------------------------------------------------------

function exportCSV() {
  if (!state.songs.length) {
    toast('書き出す曲がありません');
    return;
  }
  const list = [...state.songs].sort((a, b) => collator.compare(a.artist, b.artist) || collator.compare(a.title, b.title));
  const blob = new Blob(['\uFEFF', songsToCSV(list)], { type: 'text/csv;charset=utf-8' });
  const d = new Date();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `karaoke-list-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  toast(`${list.length}曲を書き出しました`);
}

async function importCSV(file) {
  let parsed;
  try {
    parsed = rowsToSongs(parseCSV(await file.text()));
  } catch (e) {
    console.error(e);
    toast('ファイルを読み込めませんでした');
    return;
  }
  const { songs, errors } = parsed;
  if (!songs.length) {
    await choiceDialog({ title: '読み込める曲がありませんでした', message: errors.slice(0, 5).join('\n'), choices: [{ value: true, label: '閉じる', kind: 'primary' }] });
    return;
  }
  const existing = new Map(state.songs.map((s) => [dupKey(s), s]));
  const overlap = songs.filter((s) => existing.has(dupKey({ artist: s.artist ?? '', title: s.title }))).length;
  const lines = [
    overlap ? `うち${overlap}曲は登録済みの曲と同じアーティスト・曲名です。` : '',
    errors.length ? `読み取れなかった値が${errors.length}件あります（空欄として扱います）。\n${errors.slice(0, 3).join('\n')}${errors.length > 3 ? '\n…' : ''}` : '',
  ].filter(Boolean);
  const choices = [{ value: null, label: 'キャンセル' }];
  if (state.songs.length) choices.push({ value: 'replace', label: '今のリストと置き換える', kind: 'danger-ghost' });
  choices.push({ value: 'merge', label: state.songs.length ? (overlap ? '追加（同じ曲は上書き）' : '追加する') : '読み込む', kind: 'primary' });
  const mode = await choiceDialog({ title: `${songs.length}曲を読み込みます`, message: lines.join('\n'), choices });
  if (!mode) return;
  if (mode === 'replace') {
    const ok = await confirmDialog({
      title: '今のリストを置き換えますか？',
      message: `登録済みの${state.songs.length}曲はすべて削除され、元に戻せません。`,
      ok: '置き換える',
      danger: true,
    });
    if (!ok) return;
  }
  const now = Date.now();
  const entries = songs.map((s, i) => {
    const ex = mode === 'merge' ? existing.get(dupKey({ artist: s.artist ?? '', title: s.title })) : null;
    const defined = Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined));
    const merged = normalizeSong({ ...emptySong(), ...(ex ?? {}), ...defined });
    merged.createdAt = defined.createdAt || ex?.createdAt || now - i;
    merged.updatedAt = now;
    return { id: ex?.id ?? null, data: toPayload(merged) };
  });
  state.store.putSongs(entries, mode === 'replace' ? state.songs.map((s) => s.id) : []);
  const artists = [...new Set(entries.map((e) => e.data.artist).filter(Boolean))].filter((n) => !state.profile.artists.includes(n));
  if (artists.length) state.store.addArtists(artists);
  toast(`${songs.length}曲を読み込みました`);
}
