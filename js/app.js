import { FIREBASE_CONFIG, YOUTUBE_API_KEY } from './config.js';
import {
  RANGE_FIELDS, KEY_MIN, KEY_MAX, isNote, noteName, formatKey, keyTone, clampKey, recommendKey, rangeIssues, songSpan, spanLevel, SPAN_LEVEL_MAX,
  splitRecKey, describeKey, toggleOctave,
} from './notes.js';
import { collator, normalize } from './text.js';
import {
  SORTS, emptySong, normalizeSong, toPayload, dupKey, sanitizeView, defaultView, applyView, hasRangeFilter,
  artistCounts, allTags, suggestArtists, tagCounts, ACCENTS, NOTE_STYLES, REC_OFFSETS, sanitizePrefs, planLocalMove,
  TAG_COLORS, tagColorMap, tagColorList, newSongId, isRangeMissing, orderTags,
} from './model.js';
import { setNoteStyle, getNoteStyle, fmtNote, fmtNoteHTML } from './display.js';
import { songsToCSV, parseCSV, rowsToSongs } from './csv.js';
import { openExternal, installExternalLinks } from './external.js';
import { suggestArtistsOnline, suggestSongsOnline, suggestSongsByTitle, songsOfArtist, searchTracks, findTrack, waitForSlot, searchSongs, trimReading } from './itunes.js';
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
import { sanitizeHaptics, hapticMode, playHaptic } from './haptics.js';
import { RANDOM_FX, sanitizeRandomFx, playRandomFx } from './random-fx.js';
import { previewSupported, createPreview, audioFiles, formatBytes, FILE_ACCEPT, MAX_FILE_BYTES } from './preview.js';
import { readTags, matchFile } from './audio-match.js';
import { MAX_TABLE_ROWS, decodeText, parseTable, detectColumns, tableToItems, sourceName } from './table-import.js';
import { findPlaylistIds, isPlaylistLine, fetchPlaylist, fetchVideos, videoToSong } from './youtube.js';
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
  random: { opts: null, sheet: null, picks: [], artistQuery: '', session: null },
  filterArtistQuery: '', // 絞り込みのアーティストの検索語
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
const recUp = () => state.profile.prefs?.recUp !== false;
const recommend = (s) => recommendKey(s, voice(), { offset: recOffset(), allowUp: recUp() });

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
// おすすめキーの表記（機械のキーが ±6 を超えるときはオク下・オク上で出す）。
// 「オク下」は下げる色、「オク上」は上げる色にし、機械のキーはその向きの色にする（例：オク下は青、+2 は赤）
function recKeyHTML(total) {
  const d = describeKey(total, splitRecKey(total).octave);
  const oct = d.oct ? `<span class="tone-${d.octave < 0 ? 'down' : 'up'}">${d.oct}</span> ` : '';
  return `<b class="rec-key">${oct}<span class="tone-${keyTone(d.machine)}">${d.main}</span></b>`;
}
// 今のキーの設定が、おすすめキーの設定（実際のキーとオク下・オク上）と同じか
const isRecSetting = (s, total) => s.key === total && (s.octave || 0) === splitRecKey(total).octave;

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

installExternalLinks();
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
      <span class="song-sub"><span class="a"></span><span class="cnt" hidden><span class="vh">歌った回数</span>${icon('mic')}<span class="cn"></span><span class="vh">回</span></span></span>
      <span class="song-tags" hidden></span>
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
    tags: $('.song-tags', el),
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

// tagOrder：タグ名 → タグの管理での順番。曲のタグは、この順に左から並べる
function updateItem(it, s, tagOrder) {
  const vo = voice();
  const tags = orderTags(s.tags, tagOrder);
  const sig = [s.title, s.artist, s.favorite, s.singCount, tags.map((t) => `${t}:${state.profile.tagColors.get(t) ?? ''}`).join('|'), s.low, s.chestHigh, s.falsettoHigh, s.key, s.octave, s.artwork, vo.low, vo.chestHigh, vo.falsettoHigh].join('\u0001');
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
  // タグはアーティスト名の下の行に並べる（入りきらない分は右端で薄く消える）
  it.tags.hidden = !tags.length;
  it.tags.innerHTML = tags.map((t) => `<span class="tag"${tagC(t)}>${esc(t)}</span>`).join('');
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
  const tagOrder = new Map(tagList().map((t, i) => [t, i]));
  for (const s of list) {
    let it = items.get(s.id);
    if (!it) {
      it = createItem(s.id);
      items.set(s.id, it);
    }
    // 最初に見える範囲の画像はすぐ読み込み、それより下は画面に近づいてから読み込む
    const loading = index++ < 16 ? 'eager' : 'lazy';
    if (it.art.loading !== loading) it.art.loading = loading;
    updateItem(it, s, tagOrder);
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
  return (v.favoriteOnly ? 1 : 0) + (v.missingRange ? 1 : 0) + v.artists.length + v.tags.length + v.exTags.length
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
  for (const a of v.artists) chips.push({ k: `artist:${a}`, label: esc(a) });
  for (const t of v.tags) chips.push({ k: `tag:${t}`, label: `${icon('tag')}${esc(t)}` });
  for (const t of v.exTags) chips.push({ k: `extag:${t}`, label: `${icon('tag')}${esc(t)}を除く` });
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
  paintFilterArtists();
  $('#f-tags').innerHTML = tags.map((t) => `<button type="button" class="chip${v.tags.includes(t) ? ' on' : ''}"${tagC(t)} data-tag="${esc(t)}" aria-pressed="${v.tags.includes(t)}">${esc(t)}</button>`).join('');
  $('#f-extags').innerHTML = exTagChips(tags, v.exTags);
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
  updateView({ favoriteOnly: false, missingRange: false, artists: [], tags: [], exTags: [], range: d.range });
}

// 絞り込みのアーティスト。ランダム選曲と同じく、検索欄とボタンで何組でも選べる
function paintFilterArtists() {
  const v = state.view;
  $('#f-artist-label').textContent = v.artists.length ? `アーティスト（${v.artists.length}組を選択中）` : 'アーティスト';
  $('#filter-panel [data-act="artists-clear"]').hidden = !v.artists.length;
  $('#f-artist-search').hidden = artistCounts(state.songs).size <= ARTIST_SEARCH_MIN;
  $('#f-artists').innerHTML = artistChipsHTML(v.artists, state.filterArtistQuery);
}

// アーティストのボタン（絞り込み・ランダム選曲で共通）。選んだものを先に、そのあと曲数の多い順。
// 多いときは上から LIMIT 組だけ出し、残りは検索で探してもらう
const ARTIST_SEARCH_MIN = 12;
const ARTIST_CHIP_LIMIT = 40;
function artistChipsHTML(selected, query) {
  const counts = artistCounts(state.songs);
  const q = normalize(query);
  const names = [...new Set([...selected, ...counts.keys()])]
    .filter((n) => selected.includes(n) || !q || normalize(n).includes(q))
    .sort((a, b) => Number(selected.includes(b)) - Number(selected.includes(a)) || (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || collator.compare(a, b));
  return names.slice(0, ARTIST_CHIP_LIMIT).map((n) => {
    const on = selected.includes(n);
    return `<button type="button" class="chip${on ? ' on' : ''}" data-artist="${esc(n)}" aria-pressed="${on}">${esc(n)}<span class="chip-n">${counts.get(n) ?? 0}</span></button>`;
  }).join('') + (names.length > ARTIST_CHIP_LIMIT ? `<span class="hint">ほか${names.length - ARTIST_CHIP_LIMIT}組（検索で絞り込めます）</span>` : '')
    + (!names.length ? '<span class="hint">見つかりません</span>' : '');
}

// 「除くタグ」のボタン。選ぶと取り消し線を引いた見た目になる
function exTagChips(tags, exTags) {
  return tags.map((t) => `<button type="button" class="chip ex${exTags.includes(t) ? ' on' : ''}"${tagC(t)} data-extag="${esc(t)}" aria-pressed="${exTags.includes(t)}" aria-label="${esc(t)}を除く">${esc(t)}</button>`).join('');
}

// タグの条件を切り替える（cond：tags と exTags を持つ条件）。同じタグを「タグ」と「除くタグ」の両方では選べないので、
// 片方で選んだら、もう片方からは外す
function toggleTagCondition(cond, t, ex) {
  const [key, other] = ex ? ['exTags', 'tags'] : ['tags', 'exTags'];
  const on = cond[key].includes(t);
  return { [key]: on ? cond[key].filter((x) => x !== t) : [...cond[key], t], [other]: on ? cond[other] : cond[other].filter((x) => x !== t) };
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
  setupLongPress($('#list'));
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
    else if (k.startsWith('artist:')) updateView({ artists: state.view.artists.filter((a) => a !== k.slice(7)) });
    else if (k.startsWith('tag:')) updateView({ tags: state.view.tags.filter((t) => t !== k.slice(4)) });
    else if (k.startsWith('extag:')) updateView({ exTags: state.view.exTags.filter((t) => t !== k.slice(6)) });
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
  });
  fp.addEventListener('input', (e) => {
    if (e.target.id !== 'f-artist-q') return;
    state.filterArtistQuery = e.target.value;
    paintFilterArtists();
  });
  fp.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.tag != null || b.dataset.extag != null) {
      updateView(toggleTagCondition(state.view, b.dataset.tag ?? b.dataset.extag, b.dataset.extag != null));
    } else if (b.dataset.artist != null) {
      const a = b.dataset.artist;
      const cur = state.view.artists;
      updateView({ artists: cur.includes(a) ? cur.filter((x) => x !== a) : [...cur, a] });
    } else if (b.dataset.act === 'artists-clear') {
      updateView({ artists: [] });
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
// 実際のキーで設定する（おすすめキー・原キー）。オク下・オク上はおすすめキーと同じ分け方にする
function setTotalKey(id, total) {
  const k = clampKey(total);
  setKey(id, k, splitRecKey(k).octave);
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
  if (isRecSetting(s, rec.key)) {
    return `<div class="rec-ok">${icon('check')}<span>おすすめキー（${recKeyHTML(rec.key)}）です</span></div>${note}`;
  }
  return `<button type="button" class="rec-btn" data-k="${rec.key}">
      <span class="rec-l">おすすめ</span>${recKeyHTML(rec.key)}<span class="rec-go">${compact ? '' : 'に変更'}${icon('chevron-right')}</span>
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
  // 中身を入れてから置き直す（画面の下のほうの行では、上に出す）
  p.place();
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
  const sig = JSON.stringify([d.id, s.title, s.artist, s.favorite, s.tags, s.memo, s.score, s.singCount, s.lastSungAt, s.low, s.chestHigh, s.falsettoHigh, s.artwork, s.ext, voice(), state.profile.tags, getNoteStyle(), recOffset(), recUp()]);
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
  // 原キーのときは「原曲」と「キー適用後」が同じなので、1 列だけ（原曲として）出す
  const sameKey = s.key === 0;
  $('.d-range', root).classList.toggle('same-key', sameKey);
  $('[data-role="cur-head"]', root).textContent = sameKey ? '原曲' : 'キー適用後';
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

// 難易度のゲージの色。1（緑）から 10（赤）へ、高いほど赤くする（色相 140 → 0）
const levelHue = (i) => Math.round(140 - ((i - 1) * 140) / (SPAN_LEVEL_MAX - 1));

// 曲の音域の広さ（最低音から一番高い音まで）と、それをもとにした難易度（10 段階のゲージ）。キーを変えても変わらない
function rangeSpanHTML(s) {
  const n = songSpan(s);
  if (n == null) return '';
  const oct = Math.floor(n / 12);
  const rest = n % 12;
  const o = oct ? `${oct}オクターブ${rest ? `＋${rest}` : ''}` : '';
  const lv = spanLevel(n);
  const cells = Array.from({ length: SPAN_LEVEL_MAX }, (_, i) => `<span class="d-gauge-c${i < lv ? ' on' : ''}" style="--h:${levelHue(i + 1)}"></span>`).join('');
  return `<p class="d-span">
      <span class="d-span-g"><span class="d-span-l">音域の広さ</span><span class="d-span-v"><b>${n}半音</b>${o ? `<span class="d-span-o">（${o}）</span>` : ''}</span></span>
      <span class="d-span-g"><span class="d-span-l">難易度</span><span class="d-gauge" role="meter" aria-label="難易度" aria-valuemin="1" aria-valuemax="${SPAN_LEVEL_MAX}" aria-valuenow="${lv}" aria-valuetext="10段階中${lv}">${cells}</span><b class="d-gauge-n" style="--h:${levelHue(lv)}">${lv}</b></span>
    </p>`;
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
        <thead><tr><th></th><th scope="col" class="orig">原曲</th><th scope="col" data-role="cur-head">キー適用後</th>${showVoice ? '<th scope="col">自分</th>' : ''}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${rangeSpanHTML(s)}
      ${pluginDetailHTML(s)}
      ${rangeActionsHTML('d-ractions', isRangeMissing(s))}
      ${d.preview ? '<section class="d-sec d-pv" data-role="preview"></section>' : ''}
      <div class="d-stats">
        <div class="stat"><span class="sl">歌った回数</span><span class="sv">${s.singCount}<small>回</small></span>${s.singCount || s.lastSungAt ? `<button type="button" class="stat-reset" data-act="sung-reset" aria-label="歌った回数をリセット" title="歌った回数をリセット">${icon('reset')}</button>` : ''}</div>
        <div class="stat"><span class="sl">最終歌唱日</span><span class="sv">${s.lastSungAt ? fmtDate(s.lastSungAt) : '—'}</span></div>
        <div class="stat"><span class="sl">採点</span><span class="sv">${s.score != null ? `${fmtScore(s.score)}<small>点</small>` : '—'}</span></div>
      </div>
      <button type="button" class="btn primary wide sung btn-sung" data-act="sung">${icon('mic')}歌った！</button>
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
      updateView({ artists: [s.artist] });
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

const randomPoolNow = () => randomPool(state.songs, state.random.opts, { voice: voice(), offset: recOffset(), allowUp: recUp() });

function hasRandomCondition() {
  const o = state.random.opts;
  return o.favoriteOnly || o.artists.length > 0 || o.tags.length > 0 || o.exTags.length > 0 || o.fitsVoice || o.excludeDays > 0 || o.preferLessSung || hasRandomRange(o);
}

function reroll() {
  const r = state.random;
  stopRandomFx();
  // ランダム選曲を開いている間に一度出た曲は、もう出さない（条件に合う曲が足りないときだけ、また出す）
  const shown = r.session?.shown ?? [];
  r.picks = pickRandom(randomPoolNow(), r.opts.count, { weighted: r.opts.preferLessSung, avoid: new Set([...shown, ...r.picks]) }).map((s) => s.id);
  if (r.session) for (const id of r.picks) if (!shown.includes(id)) shown.push(id);
  r.step = 'result';
  paintRandom();
  $('.sheet-body', r.sheet.el).scrollTop = 0;
  startRandomFx();
}

// この回のランダム選曲で出た曲のうち、「歌った！」を記録していない曲（新しく出た順）
function unrecordedRandomSongs() {
  const se = state.random.session;
  if (!se) return [];
  return se.shown.map((id) => state.byId.get(id)).filter((s) => s && !(s.lastSungAt >= se.since)).reverse();
}

// ランダム選曲を閉じたあと、記録していない曲から、歌った曲をまとめて記録してもらう
// （記録し忘れると「最近歌った曲を除く」が効かず、同じ曲がまた出るため）
function askSungAfterRandom(songs) {
  const sheet = openSheet(`<div class="rdg">
      <div class="sheet-head"><h3>歌った曲を記録</h3><button type="button" class="icon-btn" data-act="close" aria-label="閉じる">${icon('close')}</button></div>
      <div class="sheet-body">
        <p class="hint">ランダム選曲で出た曲のうち、「歌った！」を記録していない曲です。歌った曲にチェックを付けてください。</p>
        <ul class="rdg-list">${songs.map((s, i) => `<li><label class="rdg-row">
            <input type="checkbox" data-i="${i}">
            ${randomArt(s, 'rnd-art sm')}
            <span class="rdg-text"><span class="rdg-to">${esc(s.title)}</span><span class="rdg-from">${esc(s.artist)}</span></span>
          </label></li>`).join('')}</ul>
      </div>
      <div class="sheet-foot"><button type="button" class="btn" data-act="close">記録しない</button><button type="button" class="btn primary" data-act="apply"></button></div>
    </div>`, { label: '歌った曲を記録', className: 'sung-check-layer' });
  const btn = $('[data-act="apply"]', sheet.el);
  const checked = () => $$('input[data-i]', sheet.el).filter((c) => c.checked).map((c) => songs[+c.dataset.i]);
  const paint = () => {
    const n = checked().length;
    btn.innerHTML = `${icon('mic')}${n ? `記録する（${n}曲）` : '記録する'}`;
    btn.disabled = !n;
  };
  sheet.el.addEventListener('change', paint);
  sheet.el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.act === 'close') sheet.close();
    else if (b.dataset.act === 'apply') {
      markSungMany(checked().map((s) => s.id));
      sheet.close();
    }
  });
  paint();
}

// 何曲かまとめて「歌った！」を記録する（あとから元に戻せる）
function markSungMany(ids) {
  const list = ids.map((id) => state.byId.get(id)).filter(Boolean);
  if (!list.length) return;
  const now = Date.now();
  const prev = list.map((s) => ({ id: s.id, data: { singCount: s.singCount, lastSungAt: s.lastSungAt } }));
  haptic('sung');
  state.store.putSongs(list.map((s) => ({ id: s.id, data: { singCount: s.singCount + 1, lastSungAt: now } })));
  toast(`${list.length}曲を記録しました`, { action: '元に戻す', onAction: () => state.store.putSongs(prev) });
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
      const missed = unrecordedRandomSongs();
      state.random.session = null;
      // 閉じる動き（履歴を戻す処理）が終わってから開く
      if (missed.length) setTimeout(() => askSungAfterRandom(missed), 360);
    },
  });
  state.random.sheet = sheet;
  // since：開いた時刻（これより後に記録した曲は「歌った」とみなす）、shown：この回で出た曲（出た順）
  state.random.session = { since: Date.now(), shown: [] };
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

// おすすめキーは、押し間違えないようにボタンにはせず、文字だけで出す（変えるときは詳細画面から）
function randomRecText(s) {
  if (!hasVoice()) return '';
  const rec = recommend(s);
  if (!rec || isRecSetting(s, rec.key)) return '';
  return `<span class="rnd-rec-t">おすすめ ${recKeyHTML(rec.key)}</span>`;
}

// ランダム選曲を開いてから「歌った！」を記録した曲か
const sungInRandom = (s) => !!state.random.session && s.lastSungAt >= state.random.session.since;
const rndSungBtn = (s, cls = '') => (sungInRandom(s)
  ? `<span class="btn-sung-done${cls}">${icon('check')}記録しました</span>`
  : `<button type="button" class="btn primary btn-sung${cls}" data-sung="${esc(s.id)}">${icon('mic')}歌った！</button>`);

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
      <div class="rnd-info"><span class="rnd-key" data-tone="${keyTone(describeKey(s.key, s.octave).machine)}">キー ${randomKeyText(s)}</span>${randomRecText(s)}<span class="rnd-range">${rangeText(s)}</span></div>
      <div class="rnd-actions">
        <button type="button" class="btn" data-open="${esc(s.id)}">詳細を見る</button>
        ${rndSungBtn(s)}
      </div>
    </div>`;
  } else {
    box.innerHTML = `<ol class="rnd-list">${picks.map((s, i) => `<li>
      <button type="button" class="rnd-row" data-open="${esc(s.id)}">${rndRowHTML(s, i)}</button>
      ${rndSungBtn(s, ' sm')}
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
  if (o.exTags.length) parts.push(`${o.exTags.join('・')}を除く`);
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
      ${artistCount > ARTIST_SEARCH_MIN ? `<label class="search sm">${icon('search')}<input type="search" data-role="artist-q" placeholder="アーティストを探す" autocomplete="off" aria-label="アーティストを探す" value="${esc(state.random.artistQuery)}"></label>` : ''}
      <div class="chip-set" data-role="artist-chips"></div>
    </div>
    <div class="fp-sec">
      <span class="label">タグ</span>
      <div class="chip-set">${tags.map((t) => `<button type="button" class="chip${o.tags.includes(t) ? ' on' : ''}"${tagC(t)} data-tag="${esc(t)}" aria-pressed="${o.tags.includes(t)}">${esc(t)}</button>`).join('')}</div>
    </div>
    <div class="fp-sec">
      <span class="label">除くタグ</span>
      <div class="chip-set">${exTagChips(tags, o.exTags)}</div>
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
  box.innerHTML = artistChipsHTML(state.random.opts.artists, state.random.artistQuery);
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
  } else if (b.dataset.tag != null || b.dataset.extag != null) {
    updateRandom(toggleTagCondition(o, b.dataset.tag ?? b.dataset.extag, b.dataset.extag != null));
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

// 音域を入れるためのボタン。追加機能の「音域を調べる」は目立たせ、音域が未入力（missing）なら色を付ける。
// 追加機能があるときの「Webで音域を検索」は、最後の手段として控えめにする
function rangeActionsHTML(extraClass = '', missing = false) {
  const actions = rangeActions();
  const web = actions.length
    ? `<button type="button" class="range-web" data-act="range-web">${icon('external')}Webで音域を検索</button>`
    : `<button type="button" class="pill" data-act="range-web">${icon('external')}Webで音域を検索</button>`;
  return `<div class="range-actions${extraClass ? ` ${extraClass}` : ''}">${actions.map((a, i) => `<button type="button" class="pill pill-lookup${missing ? ' urgent' : ''}" data-plugin="${i}">${icon(a.icon ?? 'search')}${esc(a.label)}</button>`).join('')}${web}</div>`;
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
  openExternal(WEB_SEARCH_URL + encodeURIComponent(q));
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
    // 「アーティスト名 曲名 音域」で Web 検索する（追加機能で見つからなかったとき用）
    searchWeb: () => openRangeSearch(get()?.artist, get()?.title),
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
    searchWeb: () => openRangeSearch(form.artist.value, form.title.value),
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
    // 最低音か地声最高音が未入力なら、「音域を調べる」に色を付ける
    const missing = !isNote(draft.low) || !isNote(draft.chestHigh);
    for (const b of form.querySelectorAll('.pill-lookup')) b.classList.toggle('urgent', missing);
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
    // 曲名だけで探して選んだときは、アーティスト名も入れる
    if (!form.artist.value.trim() && s.artist) {
      form.artist.value = s.artist;
      prefetchSongs();
    }
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
    // アーティストが未入力のときは曲名だけで探すので、候補にアーティスト名も出す
    const sub = (s) => [artist ? '' : s.artist, s.album].filter(Boolean).map(esc).join(' · ');
    return `<li class="ac-head" role="presentation">${artist ? 'iTunes の候補' : 'iTunes の候補（曲名で検索）'}</li>` + items.map((s, i) => {
      const title = trimReading(s.title);
      const done = registered.has(dupKey({ artist: artist || s.artist, title }));
      return `<li role="option" id="${pre}-${i}" data-i="${i}" class="song-opt${i === active ? ' active' : ''}" aria-selected="${i === active}">
        <span class="ac-art">${s.artwork ? `<img src="${esc(s.artwork)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : icon('music')}</span>
        <span class="ac-text"><span class="ac-name">${highlight(title, input.value)}</span>${sub(s) ? `<span class="ac-sub">${sub(s)}</span>` : ''}</span>
        ${done ? '<span class="ac-count">登録済み</span>' : ''}</li>`;
    }).join('');
  };
  const load = ({ pin = false } = {}) => {
    clearTimeout(timer);
    const artist = getArtist().trim();
    const q = input.value.trim();
    // アーティストが決まっていればその曲から、未入力なら曲名だけで探す
    if (!navigator.onLine || (!artist && !q)) return cb.hide();
    const key = `${artist}\u0001${q}`;
    if (key === loadedKey) return cb.show(songs, render, { pin });
    if (!songs.length || pin) cb.message('iTunes で曲を探しています…', { pin });
    timer = setTimeout(async () => {
      ctrl?.abort();
      ctrl = new AbortController();
      try {
        const found = artist
          ? await suggestSongsOnline(artist, q, { signal: ctrl.signal })
          : await suggestSongsByTitle(q, { signal: ctrl.signal });
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

async function runArtJob({ quiet = false } = {}) {
  if (artJob.running) return;
  const targets = state.songs.filter((s) => !s.artwork && s.title);
  if (!targets.length) {
    if (!quiet) toast('ジャケット画像が未設定の曲はありません');
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

// ---- 音楽ファイルをまとめて割り当てる -------------------------------------
// 端末の音楽ファイルを複数選ぶと、ファイルの中の曲名・アーティスト名（なければファイル名）から登録済みの曲を探し、
// 確認・修正してから、試聴用にこの端末へ保存する（テキストから追加と同じ流れ）。

const AM_STATUS = {
  reading: { label: '読んでいます…', cls: 'wait' },
  sure: null,
  check: { label: '要確認', cls: 'check' },
  none: { label: '合う曲が見つかりません', cls: 'none' },
  has: { label: 'ファイルあり', cls: 'dup' },
  replace: { label: '今のファイルと置き換え', cls: 'check' },
  dup: { label: 'ほかのファイルと同じ曲', cls: 'dup' },
  big: { label: `大きすぎます（${formatBytes(MAX_FILE_BYTES)} まで）`, cls: 'none' },
};
const AM_FILTERS = [['all', 'すべて'], ['check', '要確認'], ['none', '見つからない'], ['has', 'ファイルあり・重複']];

function pickAudioFiles() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = FILE_ACCEPT;
  input.multiple = true;
  input.hidden = true;
  document.body.append(input);
  const done = () => input.remove();
  input.addEventListener('cancel', done, { once: true });
  input.addEventListener('change', () => {
    const files = [...(input.files ?? [])];
    done();
    if (files.length) openAudioImport(files);
  }, { once: true });
  input.click();
}

async function openAudioImport(files) {
  const job = { gen: 1, rows: [], filter: 'all', reading: true, saving: false, has: new Set() };
  const sheet = openSheet(`<div class="timport">
      <div class="sheet-head"><h3>音楽ファイルを割り当てる</h3><button type="button" class="icon-btn" data-act="close" aria-label="閉じる">${icon('close')}</button></div>
      <div class="sheet-body" data-role="body">
        <div class="ti-status" data-role="status"></div><div class="ti-filter" data-role="filter"></div><ul class="hist-list ti-list" data-role="list"></ul>
      </div>
      <div class="sheet-foot" data-role="foot"></div>
    </div>`, {
    label: '音楽ファイルを割り当てる',
    className: 'history-layer',
    onClose: () => { job.gen++; },
  });
  const body = $('[data-role="body"]', sheet.el);
  const foot = $('[data-role="foot"]', sheet.el);
  const songOf = (r) => (r.songId ? state.byId.get(r.songId) ?? null : null);
  const kindOf = (r) => {
    if (r.status === 'reading') return 'wait';
    if (r.status === 'big' || r.status === 'none') return 'none';
    if (r.status === 'has' || r.status === 'dup') return 'has';
    if (r.status === 'check' || r.status === 'replace') return 'check';
    return 'ok';
  };
  const canSave = (r) => !!songOf(r) && r.status !== 'big' && r.status !== 'reading';

  // 同じ曲に合ったファイルが複数あるときは、いちばん確かなもの（自分で選んだもの → 確実 → 要確認 の順、同じなら先のもの）
  // 以外を「ほかのファイルと同じ曲」にして、チェックを外す
  const rank = (r) => (r.manual ? 3 : r.base === 'sure' ? 2 : r.base === 'check' ? 1 : 0);
  const ownStatus = (r) => (r.manual ? (job.has.has(r.songId) ? 'replace' : 'sure') : r.base);
  const markDuplicates = () => {
    const best = new Map();
    for (const r of job.rows) {
      if (!r.songId || !rank(r)) continue;
      const cur = best.get(r.songId);
      if (!cur || rank(r) > rank(cur)) best.set(r.songId, r);
    }
    for (const r of job.rows) {
      if (!r.songId || !rank(r)) continue;
      const isBest = best.get(r.songId) === r;
      if (!isBest && r.status !== 'dup') {
        r.status = 'dup';
        r.checked = false;
      } else if (isBest && r.status === 'dup') {
        r.status = ownStatus(r);
        r.checked = true;
      }
    }
  };

  const rowHTML = (r) => {
    const s = songOf(r);
    const st = AM_STATUS[r.status];
    const can = canSave(r);
    return `<li class="ti-row${st ? ` is-${st.cls}` : ''}" data-i="${r.i}">
        <input type="checkbox" data-check="${r.i}"${r.checked && can ? ' checked' : ''}${can ? '' : ' disabled'} aria-label="割り当てる">
        <span class="hist-art">${s?.artwork ? `<img src="${esc(s.artwork)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : icon('music')}</span>
        <button type="button" class="ti-main" data-edit="${r.i}"${r.status === 'reading' ? ' disabled' : ''}>
          <span class="hist-t">${esc(s ? s.title : r.status === 'reading' ? r.file.name : '（曲を選んでください）')}</span>
          ${s ? `<span class="hist-a">${esc(s.artist)}</span>` : ''}
          <span class="ti-src">${st ? `<span class="ti-badge">${esc(st.label)}</span>` : ''}<span class="ti-line">${esc(r.file.name)}</span></span>
        </button>
        ${r.status === 'reading' ? '' : `<button type="button" class="icon-btn ti-edit" data-edit="${r.i}" aria-label="曲を選び直す">${icon('pen')}</button>`}
      </li>`;
  };
  const shown = (r) => job.filter === 'all' || kindOf(r) === job.filter;
  const paintList = () => {
    const rows = job.rows.filter(shown);
    $('[data-role="list"]', body).innerHTML = rows.length ? rows.map(rowHTML).join('') : '<li class="hist-more">該当するファイルはありません</li>';
  };
  const paintFilter = () => {
    const counts = { check: 0, none: 0, has: 0 };
    for (const r of job.rows) {
      const k = kindOf(r);
      if (k in counts) counts[k]++;
    }
    const items = AM_FILTERS.filter(([id]) => id === 'all' || counts[id]);
    if (!items.some(([id]) => id === job.filter)) job.filter = 'all';
    $('[data-role="filter"]', body).innerHTML = items.length > 1
      ? items.map(([id, label]) => `<button type="button" class="pill" data-filter="${id}" aria-pressed="${job.filter === id}">${label}${id === 'all' ? '' : ` ${counts[id]}`}</button>`).join('')
      : '';
  };
  const paintStatus = () => {
    const el = $('[data-role="status"]', body);
    const total = job.rows.length;
    const read = job.rows.filter((r) => r.status !== 'reading').length;
    if (job.reading || job.saving) {
      const n = job.saving ? job.savedCount : read;
      const all = job.saving ? job.saveTotal : total;
      const pct = all ? Math.round((n / all) * 100) : 0;
      el.innerHTML = `<span>${job.saving ? `保存しています（${n} / ${all}）` : `ファイルを読んでいます（${n} / ${all}）`}</span>
        <div class="job-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${all}" aria-valuenow="${n}"><span style="width:${pct}%"></span></div>`;
    } else {
      el.innerHTML = `<span>${total}個のファイルを調べました。違う曲は、行をタップして選び直せます。</span>`;
    }
  };
  const paintFoot = () => {
    const n = job.rows.filter((r) => r.checked && canSave(r)).length;
    foot.innerHTML = `<button type="button" class="btn primary" data-act="save"${n && !job.reading && !job.saving ? '' : ' disabled'}>${icon('music')}${n ? `${n}曲に割り当てる` : '割り当てる'}</button>`;
  };
  const paintAll = () => {
    paintStatus();
    paintFilter();
    paintList();
    paintFoot();
  };

  // 曲を選び直す
  const editRow = (r) => {
    if (!r || r.status === 'reading') return;
    const sub = openSheet(`<div class="ti-pick">
        <div class="sheet-head"><h3>曲を選ぶ</h3><button type="button" class="icon-btn" data-act="close" aria-label="閉じる">${icon('close')}</button></div>
        <div class="sheet-body">
          <p class="ti-orig">ファイル：<span>${esc(r.file.name)}</span>${r.tags.title ? `<br>ファイルの中の曲名：<span>${esc(r.tags.title)}${r.tags.artist ? ` / ${esc(r.tags.artist)}` : ''}</span>` : ''}</p>
          <label class="search sm">${icon('search')}<input type="search" data-role="q" placeholder="曲名・アーティストで絞り込み" autocomplete="off" aria-label="絞り込み"></label>
          <ul class="hist-list" data-role="cands"></ul>
          <button type="button" class="btn wide" data-act="unset" style="margin-top:12px">この曲には割り当てない</button>
        </div>
      </div>`, { label: '曲を選ぶ', className: 'history-layer' });
    const list = $('[data-role="cands"]', sub.el);
    const q = $('[data-role="q"]', sub.el);
    const all = [...state.songs].sort((a, b) => collator.compare(a.title, b.title));
    const paintCands = () => {
      const key = looseKey(q.value);
      const base = key ? all.filter((s) => looseKey(`${s.title}${s.artist}`).includes(key)) : [...r.cands.map((id) => state.byId.get(id)).filter(Boolean), ...all.filter((s) => !r.cands.includes(s.id))];
      const items = base.slice(0, 60);
      list.innerHTML = items.length
        ? items.map((s) => `<li><button type="button" class="hist-row ti-cand${s.id === r.songId ? ' on' : ''}" data-song="${esc(s.id)}">
            <span class="hist-art">${s.artwork ? `<img src="${esc(s.artwork)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : icon('music')}</span>
            <span class="hist-text"><span class="hist-t">${esc(s.title)}</span><span class="hist-a">${esc(s.artist)}${job.has.has(s.id) ? ' · ファイルあり' : ''}</span></span>
            ${s.id === r.songId ? icon('check') : ''}
          </button></li>`).join('') + (base.length > items.length ? `<li class="hist-more">ほか${base.length - items.length}曲（絞り込むと表示されます）</li>` : '')
        : '<li class="hist-more">該当する曲がありません</li>';
    };
    q.addEventListener('input', paintCands);
    sub.el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.act === 'close') sub.close();
      else if (b.dataset.act === 'unset') {
        r.songId = null;
        r.status = 'none';
        r.manual = true;
        r.checked = false;
        sub.close();
        markDuplicates();
        paintAll();
      } else if (b.dataset.song) {
        r.songId = b.dataset.song;
        r.manual = true;
        r.status = r.big ? 'big' : ownStatus(r);
        r.checked = !r.big;
        sub.close();
        markDuplicates();
        paintAll();
      }
    });
    paintCands();
  };

  const save = async () => {
    const targets = job.rows.filter((r) => r.checked && canSave(r));
    if (!targets.length) return;
    job.saving = true;
    job.saveTotal = targets.length;
    job.savedCount = 0;
    paintAll();
    let ok = 0;
    let failed = 0;
    for (const r of targets) {
      try {
        await audioFiles.put(r.songId, { blob: r.file, name: r.file.name, type: r.file.type, size: r.file.size, addedAt: Date.now() });
        ok++;
      } catch (err) {
        console.error(err);
        failed++;
      }
      job.savedCount++;
      paintStatus();
    }
    navigator.storage?.persist?.().catch(() => {});
    job.saving = false;
    sheet.close();
    paintAudioFiles();
    toast(failed
      ? `${ok}曲に保存し、${failed}曲は保存できませんでした（端末の空き容量が足りない可能性があります）`
      : `${ok}曲に音楽ファイルを保存しました（この端末だけ）`, { duration: 5000 });
  };

  sheet.el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.act === 'close') sheet.close();
    else if (b.dataset.act === 'save') save();
    else if (b.dataset.filter) {
      job.filter = b.dataset.filter;
      paintFilter();
      paintList();
    } else if (b.dataset.edit != null) editRow(job.rows[+b.dataset.edit]);
  });
  sheet.el.addEventListener('change', (e) => {
    const c = e.target.closest('[data-check]');
    if (!c) return;
    const r = job.rows[+c.dataset.check];
    if (r) r.checked = c.checked;
    paintFoot();
  });

  // ファイルを順に読み、曲と照らし合わせる
  job.rows = files.map((file, i) => ({ i, file, tags: {}, status: 'reading', songId: null, cands: [], checked: false, manual: false, big: file.size > MAX_FILE_BYTES }));
  paintAll();
  try {
    job.has = new Set(await audioFiles.keys());
  } catch {
    job.has = new Set();
  }
  const songs = state.songs.map((s) => ({ id: s.id, title: s.title, artist: s.artist }));
  const gen = job.gen;
  for (const r of job.rows) {
    r.tags = await readTags(r.file);
    if (gen !== job.gen) return;
    const m = matchFile({ ...r.tags, name: r.file.name }, songs);
    r.songId = m.pick?.id ?? null;
    r.cands = m.candidates.map((s) => s.id);
    if (r.big) r.status = 'big';
    else if (!r.songId) r.status = 'none';
    else if (job.has.has(r.songId)) r.status = 'has';
    else r.status = m.status;
    r.base = r.status;
    // 確実・要確認はチェックを付けておく。見つからない・ファイルあり・大きすぎるものは外しておく
    r.checked = r.status === 'sure' || r.status === 'check';
    paintStatus();
    const el = $(`.ti-row[data-i="${r.i}"]`, body);
    if (el && shown(r)) el.outerHTML = rowHTML(r);
  }
  job.reading = false;
  markDuplicates();
  paintAll();
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

// YouTube の公式 API のキー。追加機能（plugins.js）が別のキーを持っていれば、そちらを使う
const ytApiKey = () => plugins.find((p) => p.youtubeApiKey)?.youtubeApiKey ?? YOUTUBE_API_KEY;
const TI_FILE_ACCEPT = '.csv,.tsv,.txt,.zip,text/csv,text/tab-separated-values,text/plain,application/zip';
// Takeout の ZIP の中で読む CSV（再生リスト・ライブラリの曲）。コメントや登録チャンネルなどは読まない
const TAKEOUT_CSV = /(playlist|再生リスト|music|ミュージック|音楽|library|ライブラリ)/i;
const TAKEOUT_SKIP = /(comment|コメント|subscription|登録チャンネル|channel|チャンネル)/i;

// テキスト（メモ）・曲の一覧のファイル（CSV など）・YouTube の再生リストのリンクから、曲をまとめて追加する
function openTextImport() {
  const aliases = aliasMap(state.profile.aliases);
  const knownArtists = new Map([...state.profile.artists, ...state.songs.map((s) => s.artist)].filter(Boolean).map((n) => [looseKey(n), n]));
  // gen：調べている処理の世代。中止・やり直し・閉じたときに増やし、古い処理の結果を捨てる
  const job = { gen: 0, running: false, rows: [], filter: 'all', source: '', qk: '', text: '', files: [], fileSeq: 0, pending: null };
  const sheet = openSheet(`<div class="timport">
      <div class="sheet-head"><h3>まとめて追加</h3><button type="button" class="icon-btn" data-act="close" aria-label="閉じる">${icon('close')}</button></div>
      <div class="sheet-body" data-role="body"></div>
      <div class="sheet-foot" data-role="foot"></div>
    </div>`, {
    label: 'まとめて追加',
    className: 'history-layer',
    onClose: () => { job.gen++; },
  });
  const body = $('[data-role="body"]', sheet.el);
  const foot = $('[data-role="foot"]', sheet.el);

  // 登録済み・重複の判定は、行が多くても速いように、描くたびに 1 回だけまとめて求める
  let dupCache = null;
  const busy = (r) => r.status === 'pending' || r.status === 'searching';
  const dupOf = (r) => {
    if (busy(r) || !r.title) return null;
    if (!dupCache) {
      dupCache = new Map();
      const registered = new Set(state.songs.map(dupKey));
      const seen = new Set();
      for (const o of job.rows) {
        if (busy(o) || !o.title) continue;
        const k = dupKey(o);
        if (registered.has(k)) dupCache.set(o.i, 'registered');
        else if (seen.has(k)) dupCache.set(o.i, 'repeat');
        else if (o.checked) seen.add(k);
      }
    }
    return dupCache.get(r.i) ?? null;
  };
  const canAdd = (r) => !busy(r) && r.checked && !!r.title && !dupOf(r);
  const kindOf = (r) => {
    if (busy(r)) return 'wait';
    if (dupOf(r)) return 'dup';
    if (r.status === 'check') return 'check';
    if (r.status === 'none' || r.status === 'error') return 'none';
    return 'ok';
  };

  // ---- 入力 ----

  const filesHTML = () => job.files.map((f) => {
    const note = f.kind === 'cols'
      ? `<button type="button" class="link-btn" data-cols="${f.id}">列を選ぶ</button>`
      : f.kind === 'error'
        ? `<span class="ti-fnote err">${esc(f.error)}</span>`
        : `<span class="ti-fnote">${f.kind === 'lines' ? `${f.lines.length}行` : `${f.items.length}曲`}</span>`;
    return `<li class="ti-file">${icon('list')}<span class="ti-fname">${esc(f.name)}</span>${note}<button type="button" class="icon-btn sm" data-unfile="${f.id}" aria-label="${esc(f.name)}を外す">${icon('close')}</button></li>`;
  }).join('');
  const paintFiles = () => {
    const el = $('[data-role="files"]', body);
    if (el) el.innerHTML = filesHTML();
  };

  const showInput = () => {
    job.gen++;
    job.running = false;
    job.rows = [];
    job.pending = null;
    sheet.dismissible = true;
    body.innerHTML = `<p class="hint ti-lead">メモ・音楽サービスから書き出した曲の一覧（CSV など）・YouTube の再生リストのリンクから、曲をまとめて追加します。追加する前に確認・修正できます。</p>
      <textarea class="input ti-text" data-role="text" rows="8" placeholder="アーティスト名 - 曲名&#10;曲名 / アーティスト名&#10;https://music.youtube.com/playlist?list=…" aria-label="追加する曲の一覧" autocomplete="off" autocapitalize="off" spellcheck="false">${esc(job.text)}</textarea>
      <div class="ti-tools">
        <button type="button" class="pill" data-act="pick-files">${icon('upload')}ファイルを選ぶ</button>
        <button type="button" class="link-btn" data-act="guide">書き出し方のガイド</button>
      </div>
      <ul class="ti-files" data-role="files"></ul>
      <p class="hint">テキストは、1行を1曲として iTunes で調べます。アーティスト名と曲名の順番や区切り（- や / など）は、ばらばらでも構いません（${MAX_LINES}行まで）。ファイルは、CSV・タブ区切りのテキストと、YouTube Music の Takeout の ZIP を読めます（${MAX_TABLE_ROWS}曲まで）。YouTube の再生リストのリンク（公開・限定公開）を貼ると、その中の曲を読み込みます。</p>`;
    paintFiles();
    foot.className = 'sheet-foot';
    foot.innerHTML = `<button type="button" class="btn primary" data-act="run">${icon('search')}読み込む</button>`;
  };

  // 読み込んだファイルを、表（曲名・アーティストの列が分かるもの）・列を選ぶ表・1行1曲のテキストのどれかにする
  const addEntry = (name, text) => {
    const id = ++job.fileSeq;
    const table = parseTable(text);
    if (table && table.length >= 2 && table[0].length >= 2) {
      const cols = detectColumns(table[0]);
      if (!cols) {
        job.files.push({ id, name, kind: 'cols', table });
        return;
      }
      const items = tableToItems(table.slice(1), cols, sourceName(name));
      job.files.push(items.length ? { id, name, kind: 'table', items } : { id, name, kind: 'error', error: '曲が見つかりませんでした' });
      return;
    }
    const lines = parseLines(text);
    job.files.push(lines.length ? { id, name, kind: 'lines', lines } : { id, name, kind: 'error', error: '曲が見つかりませんでした' });
  };
  const readZip = async (file) => {
    const { unzipSync } = await import('./vendor/fflate.js');
    const files = unzipSync(new Uint8Array(await file.arrayBuffer()), {
      filter: (f) => /\.csv$/i.test(f.name) && TAKEOUT_CSV.test(f.name) && !TAKEOUT_SKIP.test(f.name),
    });
    let n = 0;
    for (const [path, data] of Object.entries(files)) {
      const table = parseTable(decodeText(data));
      const cols = table && table.length >= 2 ? detectColumns(table[0]) : null;
      if (!cols) continue;
      const items = tableToItems(table.slice(1), cols, sourceName(path));
      if (!items.length) continue;
      job.files.push({ id: ++job.fileSeq, name: sourceName(path), kind: 'table', items });
      n++;
    }
    if (!n) job.files.push({ id: ++job.fileSeq, name: file.name, kind: 'error', error: '曲の一覧（CSV）が見つかりませんでした' });
  };
  const pickFiles = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = TI_FILE_ACCEPT;
    input.multiple = true;
    input.hidden = true;
    document.body.append(input);
    const done = () => input.remove();
    input.addEventListener('cancel', done, { once: true });
    input.addEventListener('change', async () => {
      const files = [...(input.files ?? [])];
      done();
      for (const f of files) {
        try {
          if (/\.zip$/i.test(f.name)) await readZip(f);
          else addEntry(f.name, decodeText(new Uint8Array(await f.arrayBuffer())));
        } catch (err) {
          console.warn(err);
          job.files.push({ id: ++job.fileSeq, name: f.name, kind: 'error', error: '読み込めませんでした' });
        }
      }
      paintFiles();
      const need = job.files.find((f) => f.kind === 'cols');
      if (need) pickColumns(need);
    }, { once: true });
    input.click();
  };

  // 見出しで曲名・アーティストの列が分からない表は、最初の数行を見せて列を選んでもらう
  const pickColumns = (f) => {
    const rows = f.table;
    const width = Math.max(...rows.slice(0, 20).map((r) => r.length));
    const label = (i) => `${i + 1}列目${rows[0][i] ? `（${rows[0][i].slice(0, 20)}）` : ''}`;
    const opts = (sel) => Array.from({ length: width }, (_, i) => `<option value="${i}"${i === sel ? ' selected' : ''}>${esc(label(i))}</option>`).join('');
    const sub = openSheet(`<div class="ti-pick">
        <div class="sheet-head"><h3>列を選ぶ</h3><button type="button" class="icon-btn" data-act="close" aria-label="閉じる">${icon('close')}</button></div>
        <div class="sheet-body">
          <p class="hint">「${esc(f.name)}」の、曲名とアーティストの列を選んでください。</p>
          <div class="ti-colprev"><table>${rows.slice(0, 5).map((r) => `<tr>${Array.from({ length: width }, (_, i) => `<td>${esc(r[i] ?? '')}</td>`).join('')}</tr>`).join('')}</table></div>
          <label class="label" for="ti-col-title">曲名の列</label>
          <select class="input" id="ti-col-title" data-role="title">${opts(0)}</select>
          <label class="label" for="ti-col-artist">アーティストの列</label>
          <select class="input" id="ti-col-artist" data-role="artist"><option value="-1">なし</option>${opts(width > 1 ? 1 : -1)}</select>
          <label class="switch-row ti-colhead"><span>1行目は見出し（曲ではない）</span><input type="checkbox" class="switch" data-role="header" checked></label>
        </div>
        <div class="sheet-foot"><button type="button" class="btn primary" data-act="ok">この列で読む</button></div>
      </div>`, { label: '列を選ぶ', className: 'history-layer' });
    sub.el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.act === 'close') sub.close();
      else if (b.dataset.act === 'ok') {
        const cols = { title: +$('[data-role="title"]', sub.el).value, artist: +$('[data-role="artist"]', sub.el).value, videoId: -1, playlist: -1 };
        const items = tableToItems($('[data-role="header"]', sub.el).checked ? rows.slice(1) : rows, cols, sourceName(f.name));
        Object.assign(f, items.length ? { kind: 'table', items } : { kind: 'error', error: '曲が見つかりませんでした' });
        delete f.table;
        sub.close();
        paintFiles();
      }
    });
  };

  // ---- 読み込む ----

  const start = async () => {
    const ta = $('[data-role="text"]', body);
    job.text = ta.value;
    const need = job.files.find((f) => f.kind === 'cols');
    if (need) {
      toast(`「${need.name}」の曲名・アーティストの列を選んでください`);
      pickColumns(need);
      return;
    }
    const ytIds = findPlaylistIds(job.text);
    const rest = job.text.split(/\r?\n/).filter((l) => !isPlaylistLine(l)).join('\n');
    let structured = [];
    let lines = [];
    // 貼り付けた表（見出しから列が分かるもの）は、ファイルと同じように読む
    const pasted = parseTable(rest);
    const pastedCols = pasted && pasted.length >= 2 ? detectColumns(pasted[0]) : null;
    if (pastedCols) structured.push(...tableToItems(pasted.slice(1), pastedCols, '貼り付けた表'));
    else lines.push(...parseLines(rest).map((line) => ({ line, source: '' })));
    for (const f of job.files) {
      if (f.kind === 'table') structured.push(...f.items.map((it) => ({ ...it })));
      else if (f.kind === 'lines') lines.push(...f.lines.map((line) => ({ line, source: f.name })));
    }
    if (!structured.length && !lines.length && !ytIds.length) {
      toast('曲が書かれた行がありません');
      ta.focus();
      return;
    }
    const gen = ++job.gen;
    const alive = () => gen === job.gen;
    sheet.dismissible = false;
    foot.innerHTML = '';
    body.innerHTML = '<div class="ti-status" data-role="status"></div>';
    const say = (msg) => {
      const el = $('[data-role="status"]', body);
      if (el) el.innerHTML = `<span>${esc(msg)}</span>`;
    };
    say('読み込んでいます…');
    const errors = [];
    const key = ytApiKey();
    const idOnly = () => structured.filter((it) => it.videoId && !it.title);
    if ((ytIds.length || idOnly().length) && !key) errors.push('YouTube の読み込みは、このページでは使えません');
    else {
      for (const [k, id] of ytIds.entries()) {
        say(`YouTube の再生リストを読んでいます（${k + 1} / ${ytIds.length}）…`);
        try {
          const p = await fetchPlaylist(id, key, { max: MAX_TABLE_ROWS });
          if (!alive()) return;
          for (const v of p.items) {
            const s = videoToSong(v);
            structured.push({ title: trimReading(s.title), artist: s.artist, sure: s.sure, source: p.title || 'YouTube の再生リスト' });
          }
        } catch (err) {
          if (!alive()) return;
          console.warn(err);
          errors.push(`YouTube の再生リスト：${err.userMessage ?? '読み込めませんでした'}`);
        }
      }
      const ids = idOnly();
      if (ids.length) {
        say(`YouTube の動画の曲名を読んでいます（${ids.length}本）…`);
        try {
          const map = await fetchVideos(ids.slice(0, MAX_TABLE_ROWS).map((it) => it.videoId), key);
          if (!alive()) return;
          for (const it of ids) {
            const v = map.get(it.videoId);
            if (!v) continue;
            const s = videoToSong(v);
            Object.assign(it, { title: trimReading(s.title), artist: s.artist, sure: s.sure });
          }
        } catch (err) {
          if (!alive()) return;
          console.warn(err);
          errors.push(`YouTube の動画：${err.userMessage ?? '読み込めませんでした'}`);
        }
      }
    }
    if (!alive()) return;
    structured = structured.filter((it) => it.title);
    if (errors.length) toast(errors.join('\n'), { duration: 8000 });
    if (structured.length > MAX_TABLE_ROWS) {
      toast(`一度に読めるのは${MAX_TABLE_ROWS}曲までです。最初の${MAX_TABLE_ROWS}曲を読みます`, { duration: 6000 });
      structured = structured.slice(0, MAX_TABLE_ROWS);
    }
    if (lines.length > MAX_LINES) {
      toast(`テキストは一度に${MAX_LINES}行までです。最初の${MAX_LINES}行を調べます`, { duration: 6000 });
      lines = lines.slice(0, MAX_LINES);
    }
    if (!structured.length && !lines.length) {
      showInput();
      return;
    }
    if (structured.length) chooseMode(structured, lines);
    else buildRows([], lines, 'itunes');
  };

  // 表や再生リストから読んだ曲の、登録の仕方を選ぶ
  const chooseMode = (structured, lines) => {
    job.pending = { structured, lines };
    sheet.dismissible = true;
    const min = Math.ceil((structured.length + lines.length) / TI_PER_MINUTE);
    body.innerHTML = `<p class="ti-mode-lead">${structured.length}曲を読み込みました。${lines.length ? `テキストの${lines.length}行は、どちらを選んでも iTunes で調べます。` : ''}登録の仕方を選んでください。</p>
      <button type="button" class="ti-mode" data-mode="as-is"><b>${icon('check')}そのまま登録する（おすすめ）</b><span>書いてある曲名・アーティストのまま、すぐ確認画面に進みます。ジャケット画像は、追加したあとに裏で探します。</span></button>
      <button type="button" class="ti-mode" data-mode="itunes"><b>${icon('search')}iTunes で確かめる</b><span>1曲ずつ iTunes で調べて、正しい表記とジャケット画像を入れます。${min >= 2 ? `約${min}分かかります。` : ''}</span></button>`;
    foot.className = 'sheet-foot';
    foot.innerHTML = '<button type="button" class="btn" data-act="back-input">戻る</button>';
  };

  const buildRows = (structured, lines, mode) => {
    job.pending = null;
    const rows = [];
    for (const it of structured) {
      const info = analyzeLine(it.artist ? `${it.artist}\t${it.title}` : it.title, { aliases, knownArtists });
      if (it.artist) info.titleSide = 1;
      const r = {
        i: rows.length, line: `${it.artist ? `${it.artist} - ` : ''}${it.title}`, source: it.source || '', info, structured: true,
        cands: [], pick: null, artist: it.artist, title: it.title, artwork: null,
      };
      if (mode === 'as-is') {
        r.status = it.sure === false || !it.artist ? 'check' : 'sure';
        r.checked = true;
      } else {
        r.status = 'pending';
        r.checked = false;
      }
      rows.push(r);
    }
    for (const { line, source } of lines) {
      rows.push({ i: rows.length, line, source, info: analyzeLine(line, { aliases, knownArtists }), status: 'pending', cands: [], pick: null, artist: '', title: '', artwork: null, checked: false });
    }
    job.rows = rows;
    job.filter = 'all';
    job.source = '';
    job.qk = '';
    // 登録済みの曲と、同じ曲の 2 つ目以降は、チェックを外しておく
    dupCache = null;
    const marks = rows.map((r) => dupOf(r));
    rows.forEach((r, k) => { if (marks[k]) r.checked = false; });
    dupCache = null;
    sheet.dismissible = false;
    const sources = [...new Set(rows.map((r) => r.source).filter(Boolean))];
    body.innerHTML = `<div class="ti-status" data-role="status"></div>
      <div class="ti-tools2">
        <label class="search sm">${icon('search')}<input type="search" data-role="q" placeholder="曲名・アーティストで絞り込み" autocomplete="off" aria-label="曲名・アーティストで絞り込み"></label>
        ${sources.length > 1 ? `<select class="input ti-source" data-role="source" aria-label="ファイル・再生リストで絞り込み"><option value="">すべてのファイル・再生リスト</option>${sources.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('')}</select>` : ''}
      </div>
      <div class="ti-filter" data-role="filter"></div>
      <div class="ti-bulk"><button type="button" class="link-btn" data-act="check-shown">表示中をすべてチェック</button><button type="button" class="link-btn" data-act="uncheck-shown">表示中のチェックを外す</button></div>
      <ul class="hist-list ti-list" data-role="list"></ul>`;
    foot.className = 'sheet-foot ti-foot';
    body.scrollTop = 0;
    if (rows.some(busy)) run();
    else paintAll();
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
      else if (r.structured) Object.assign(r, { pick: null, artwork: null });
      else Object.assign(r, guessSong(info), { pick: null, artwork: null });
    } catch (e) {
      if (!alive()) return;
      console.warn(e);
      r.status = 'error';
      if (!r.structured) Object.assign(r, guessSong(info), { pick: null, artwork: null });
    }
    // 要確認の行もチェックを付けておく。見つからない行・登録済みの曲は外しておく。
    // 表から読んだ曲は、iTunes で見つからなくても、書いてあるとおりに入れられるようチェックを付けておく
    r.checked = r.status === 'sure' || r.status === 'check' || (r.structured && !!r.title);
    dupCache = null;
    if (dupOf(r)) r.checked = false;
  };

  const run = async () => {
    const gen = ++job.gen;
    const alive = () => gen === job.gen;
    job.running = true;
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

  // ---- 確認画面 ----

  const rowHTML = (r) => {
    const dup = dupOf(r);
    const st = dup ? { label: dup === 'registered' ? '登録済み' : '重複', cls: 'dup' } : TI_STATUS[r.status];
    const wait = busy(r);
    const can = !wait && !dup && !!r.title;
    const art = r.artwork ? `<img src="${esc(r.artwork)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : icon('music');
    const src = r.structured ? r.source : r.source ? `${r.source}・${r.line}` : r.line;
    return `<li class="ti-row${st ? ` is-${st.cls}` : ''}" data-i="${r.i}">
        <input type="checkbox" data-check="${r.i}"${r.checked && can ? ' checked' : ''}${can ? '' : ' disabled'} aria-label="追加する">
        <span class="hist-art">${art}</span>
        <button type="button" class="ti-main" data-edit="${r.i}"${wait ? ' disabled' : ''}>
          ${wait && !r.structured
            ? `<span class="hist-t">${esc(r.line)}</span>`
            : `<span class="hist-t">${esc(r.title || '（曲名なし）')}</span><span class="hist-a">${esc(r.artist || '（アーティスト名なし）')}</span>`}
          <span class="ti-src">${st ? `<span class="ti-badge">${st.label}</span>` : ''}${src && !(wait && !r.structured) ? `<span class="ti-line">${esc(src)}</span>` : ''}</span>
        </button>
        ${wait ? '' : `<button type="button" class="icon-btn ti-edit" data-edit="${r.i}" aria-label="選び直す・直す">${icon('pen')}</button>`}
      </li>`;
  };
  const shown = (r) => (job.filter === 'all' || kindOf(r) === job.filter)
    && (!job.source || r.source === job.source)
    && (!job.qk || looseKey(`${r.title} ${r.artist} ${r.line}`).includes(job.qk));
  const paintRow = (r) => {
    dupCache = null;
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
    dupCache = null;
    const rows = job.rows.filter(shown);
    list.innerHTML = rows.length ? rows.map(rowHTML).join('') : '<li class="hist-more">該当する曲はありません</li>';
  };
  const paintFilter = () => {
    const el = $('[data-role="filter"]', body);
    if (!el) return;
    dupCache = null;
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
      const pct = total ? Math.round(((total - left) / total) * 100) : 0;
      el.innerHTML = `<span>調べています（${total - left} / ${total}）${min >= 2 ? `・残り約${min}分` : ''}</span><button type="button" class="link-btn" data-act="stop">中止</button>
        <div class="job-bar" role="progressbar" aria-label="調べた曲" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${total - left}"><span style="width:${pct}%"></span></div>`;
    } else if (left) {
      el.innerHTML = `<span>${left}曲はまだ調べていません</span><button type="button" class="link-btn" data-act="resume">続きを調べる</button>`;
    } else {
      el.innerHTML = `<span>${total}曲を読み込みました。違う曲は、行をタップして選び直せます。</span>`;
    }
  };
  const paintFoot = () => {
    if (!job.rows.length) return;
    dupCache = null;
    const n = job.rows.filter(canAdd).length;
    foot.innerHTML = `<button type="button" class="btn" data-act="back">最初に戻る</button>
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
          <p class="ti-orig">${r.structured ? '読み込んだ内容' : '元のテキスト'}：<span>${esc(r.source ? `${r.source}・${r.line}` : r.line)}</span></p>
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
    if (left && !(await confirmDialog({ title: `${picks.length}曲を追加しますか？`, message: `まだ調べていない${left}曲は追加しません。`, ok: '追加する' }))) return;
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
    // ジャケット画像がない曲は、追加されたのを待ってから、裏でまとめて探す
    const noArt = entries.filter((e) => !e.data.artwork).map((e) => e.id);
    if (!noArt.length) {
      toast(`${picks.length}曲を追加しました`);
      return;
    }
    toast(`${picks.length}曲を追加しました。ジャケット画像は裏で探します（進み具合は設定に出ます）`, { duration: 6000 });
    for (let t = 0; t < 50 && !noArt.every((id) => state.byId.has(id)); t++) await sleep(100);
    runArtJob({ quiet: true });
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
    if (b.dataset.unfile) {
      job.files = job.files.filter((f) => f.id !== +b.dataset.unfile);
      paintFiles();
      return;
    }
    if (b.dataset.cols) {
      const f = job.files.find((x) => x.id === +b.dataset.cols);
      if (f) pickColumns(f);
      return;
    }
    if (b.dataset.mode && job.pending) {
      buildRows(job.pending.structured, job.pending.lines, b.dataset.mode);
      return;
    }
    switch (b.dataset.act) {
      case 'close':
        if (job.rows.length && !(await confirmDialog({ title: '閉じますか？', message: '読み込んだ結果は消えます（まだ追加していません）。', ok: '閉じる' }))) return;
        sheet.close();
        break;
      case 'run': start(); break;
      case 'pick-files': job.text = $('[data-role="text"]', body)?.value ?? job.text; pickFiles(); break;
      case 'guide': openImportGuide(); break;
      case 'back-input': showInput(); break;
      case 'stop': stop(); break;
      case 'resume': run(); break;
      case 'check-shown':
      case 'uncheck-shown':
        for (const r of job.rows) if (shown(r) && !busy(r) && r.title) r.checked = b.dataset.act === 'check-shown';
        paintList();
        paintFilter();
        paintFoot();
        break;
      case 'back':
        if (await confirmDialog({ title: '最初に戻りますか？', message: '読み込んだ結果は消えます。テキストと選んだファイルはそのまま残ります。', ok: '戻る' })) showInput();
        break;
      case 'add': addPicked(); break;
      default:
    }
  });
  let qTimer = 0;
  sheet.el.addEventListener('input', (e) => {
    if (e.target.dataset.role !== 'q') return;
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      job.qk = looseKey(e.target.value);
      paintList();
    }, 150);
  });
  sheet.el.addEventListener('change', (e) => {
    if (e.target.dataset.role === 'source') {
      job.source = e.target.value;
      paintList();
      return;
    }
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

// 音楽サービスから曲の一覧を書き出す方法
function openImportGuide() {
  const ext = (href, label) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${esc(label)}${icon('external')}</a>`;
  const sheet = openSheet(`<div class="ti-guide">
      <div class="sheet-head"><h3>書き出し方のガイド</h3><button type="button" class="icon-btn" data-act="close" aria-label="閉じる">${icon('close')}</button></div>
      <div class="sheet-body">
        <p class="hint">音楽サービスの再生リストを、曲の一覧のファイル（CSV など）にしてから、「ファイルを選ぶ」で読み込みます。外部のサイトの画面や文言は、変わることがあります。</p>
        <details open><summary>Spotify</summary>
          <ol>
            <li>${ext('https://exportify.app/', 'Exportify')}を開き、「開始する」から Spotify でログインする</li>
            <li>書き出したい再生リストの「Export」を押す（全部なら「Export All」）。「Liked Songs」はお気に入りの曲</li>
            <li>保存された CSV（全部のときは ZIP の中の CSV）を、このアプリの「ファイルを選ぶ」で選ぶ</li>
          </ol>
        </details>
        <details><summary>Apple Music</summary>
          <ol>
            <li>PC の「ミュージック」（Mac）か「iTunes」（Windows）で、書き出したい再生リストを選ぶ</li>
            <li>メニューの「ファイル」→「ライブラリ」→「プレイリストを書き出す」を選び、形式を「テキストファイル」にして保存する</li>
            <li>保存したファイルを、このアプリの「ファイルを選ぶ」で選ぶ（いくつかまとめて選べます）</li>
          </ol>
          <p class="hint">スマホのアプリだけでは書き出せません。PC がないときは、下の TuneMyMusic を使います。</p>
        </details>
        <details><summary>YouTube Music（再生リストのリンク）</summary>
          <ol>
            <li>YouTube Music で再生リストを開き、「共有」→「リンクをコピー」を押す</li>
            <li>このアプリのテキスト欄に、コピーしたリンクを貼る（いくつ貼っても大丈夫です）</li>
          </ol>
          <p class="hint">読めるのは「公開」か「限定公開」の再生リストです。「非公開」のときは、再生リストの公開範囲を一時的に「限定公開」にしてください。「高く評価した曲」は読めません。</p>
        </details>
        <details><summary>YouTube Music（Google Takeout）</summary>
          <ol>
            <li>${ext('https://takeout.google.com/', 'Google Takeout')}を開き、「選択をすべて解除」を押してから「YouTube と YouTube Music」にだけチェックを付ける</li>
            <li>「YouTube のすべてのデータが含まれます」を押し、「ミュージック ライブラリの曲」と「再生リスト」だけを選ぶ</li>
            <li>「次のステップ」→「エクスポートを作成」を押し、届いたメールのリンクから ZIP をダウンロードする（準備に数分〜数時間かかります）</li>
            <li>ZIP のまま、このアプリの「ファイルを選ぶ」で選ぶ</li>
          </ol>
          <p class="hint">再生リストのリンクより手間はかかりますが、非公開の再生リストやライブラリの曲もまとめて読めます。</p>
        </details>
        <details><summary>Amazon Music・KKBOX など</summary>
          <ol>
            <li>${ext('https://www.tunemymusic.com/', 'TuneMyMusic')}を開き、移行元に使っているサービスを選んでログインする</li>
            <li>書き出したい再生リストを選び、移行先に「ファイルにエクスポート」を選んで、CSV で保存する</li>
            <li>保存した CSV を、このアプリの「ファイルを選ぶ」で選ぶ</li>
          </ol>
          <p class="hint">無料では 500 曲まで（TuneMyMusic の説明による）。LINE MUSIC・AWA には対応していません。</p>
        </details>
        <details><summary>表計算ソフト・メモ</summary>
          <p class="hint">曲名とアーティストの列をコピーして、テキスト欄に貼れます。1行目に「曲名」「アーティスト」の見出しを入れると、列を確実に見分けます。メモは、1行に1曲ずつ書いて貼ります。</p>
        </details>
      </div>
    </div>`, { label: '書き出し方のガイド', className: 'history-layer' });
  sheet.el.addEventListener('click', (e) => {
    if (e.target.closest('[data-act="close"]')) sheet.close();
  });
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
    if (e.target.dataset.role === 'rec-up') updateAccountPrefs({ recUp: e.target.checked });
    if (e.target.dataset.role === 'hap-on') setHaptics({ on: e.target.checked });
  });
}

// 触覚フィードバックの設定（この端末）。指で操作する端末で、振動できるときだけ出す
function hapticsSettingsHTML() {
  const mode = hapticMode();
  if (!mode) return '';
  const hp = devicePrefs.haptics;
  return `<section class="set-sec">
        <h4>触覚フィードバック（この端末）</h4>
        <label class="switch-row"><span>操作したときに振動する</span><input type="checkbox" class="switch" data-role="hap-on"${hp.on ? ' checked' : ''}></label>
        ${mode === 'ios' ? '<p class="hint">iPhone では iOS 18 以降で、本体の「設定」→「サウンドと触覚」→「システムの触覚」がオンのときに振動します。</p>' : ''}
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
        <label class="switch-row"><span>キーを上げるおすすめも出す</span><input type="checkbox" class="switch" data-role="rec-up"${p.recUp !== false ? ' checked' : ''}></label>
        <p class="hint">オフにすると、原曲より高く歌うおすすめキーは出さず、代わりに原キーをすすめます。オク下で歌うおすすめ（オク下 +5 など）は、オフでも出します。</p>
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
        <button type="button" class="btn wide" data-act="text-import">${icon('list')}テキスト・ファイルから追加</button>
        <p class="hint">メモに書いた曲の一覧、音楽サービスから書き出した曲の一覧（CSV など）、YouTube の再生リストのリンクから、確認してからまとめて追加できます。</p>
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
      ${previewSupported() ? `<section class="set-sec" data-role="pv-files">
        <h4>試聴の音楽ファイル（この端末）</h4>
        <div class="pv-files" data-role="pv-sum-row" hidden><span data-role="pv-sum"></span><button type="button" class="btn sm danger-ghost" data-act="pv-clear">${icon('trash')}すべて削除</button></div>
        <button type="button" class="btn wide" data-act="audio-import">${icon('music')}音楽ファイルをまとめて割り当てる</button>
        <p class="hint">端末にある曲のファイルを複数選ぶと、ファイルの中の曲名・アーティスト名（なければファイル名）から登録済みの曲を探して、試聴に使えるようにします。割り当てる前に確認・修正できます。ファイルはこの端末にだけ保存し、元のファイルと同じだけ容量を使います。</p>
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
  $('[data-role="pv-sum-row"]', sec).hidden = !sum.count;
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
    case 'audio-import': pickAudioFiles(); break;
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
  const v = state.view;
  if (v.tags.includes(oldName) || v.exTags.includes(oldName)) updateView({ tags: swap(v.tags), exTags: swap(v.exTags) });
  const ro = state.random.opts;
  if (ro?.tags.includes(oldName) || ro?.exTags.includes(oldName)) {
    state.random.opts = { ...ro, tags: swap(ro.tags), exTags: swap(ro.exTags) };
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

// 一覧の曲を長押し（PC は右クリック）すると、削除するか確かめる。
// 指が動いたら（スクロール・スワイプ）やめる。選択中・キーのボタンの上では使わない
const LONG_PRESS_MS = 550;
function setupLongPress(ul) {
  let lp = null;
  let firedAt = 0;
  const targetRow = (e) => {
    if (state.select.on || e.target.closest('.keyctl')) return null;
    const li = e.target.closest('.song');
    return li && !li.classList.contains('skeleton') ? li : null;
  };
  const cancel = () => {
    if (!lp) return;
    clearTimeout(lp.timer);
    lp.li.classList.remove('pressing');
    lp = null;
  };
  const fire = () => {
    const { id } = lp;
    cancel();
    firedAt = Date.now();
    haptic('swipe');
    removeSong(id);
  };
  ul.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    const li = targetRow(e);
    if (!li) return;
    cancel();
    lp = { li, id: li.dataset.id, x0: e.clientX, y0: e.clientY, pid: e.pointerId, timer: setTimeout(fire, LONG_PRESS_MS) };
    li.classList.add('pressing');
  });
  ul.addEventListener('pointermove', (e) => {
    if (lp && e.pointerId === lp.pid && Math.hypot(e.clientX - lp.x0, e.clientY - lp.y0) > 10) cancel();
  });
  ul.addEventListener('pointerup', cancel);
  ul.addEventListener('pointercancel', cancel);
  // スマホのブラウザが長押しで出すメニューは出さない。PC の右クリックは、ここで削除を確かめる
  ul.addEventListener('contextmenu', (e) => {
    const li = targetRow(e);
    if (!li) return;
    e.preventDefault();
    if (lp) fire();
    else if (Date.now() - firedAt > 800) removeSong(li.dataset.id);
  });
  // 長押しのあとに続く「クリック」で、詳細画面が開かないようにする
  ul.addEventListener('click', (e) => {
    if (Date.now() - firedAt > 800) return;
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
