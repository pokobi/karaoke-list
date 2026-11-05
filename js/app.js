import { FIREBASE_CONFIG } from './config.js';
import { RANGE_FIELDS, KEY_MIN, KEY_MAX, OCTAVE_DOWN, isNote, noteName, formatKey, keyTone, clampKey, recommendKey } from './notes.js';
import { collator, normalize } from './text.js';
import {
  SORTS, emptySong, normalizeSong, toPayload, dupKey, sanitizeView, defaultView, applyView, hasRangeFilter,
  artistCounts, allTags, suggestArtists,
} from './model.js';
import { songsToCSV, parseCSV, rowsToSongs } from './csv.js';
import { suggestArtistsOnline, suggestSongsOnline, songsOfArtist, searchTracks, findTrack, waitForSlot } from './itunes.js';
import { readHistoryFile, aggregate, thumbnailUrl } from './history.js';
import { $, $$, h, esc, icon, openSheet, choiceDialog, confirmDialog, toast, openPopover, closePopover, popoverAnchor, pickNote } from './ui.js';
import { createLocalStore } from './store-local.js';

const VIEW_KEY = 'karaoke-list:view:v1';
const HOLD_MS = 1400;
const DEFAULT_OCTAVE = { low: 1, chestHigh: 2, falsettoHigh: 3 };
const wide = matchMedia('(min-width: 1024px)');

const state = {
  store: null,
  user: null,
  unsub: null,
  loaded: false,
  songs: [],
  byId: new Map(),
  profile: { range: {}, artists: [] },
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
};

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
const pad2 = (n) => String(n).padStart(2, '0');
const fmtDate = (ms) => {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
};
const fmtScore = (v) => (v == null ? '' : String(Math.round(v * 1000) / 1000));
const keyText = (k) => formatKey(k);

// ---- 起動 -------------------------------------------------------------

boot();

async function boot() {
  registerServiceWorker();
  bindStatic();
  try {
    const forceLocal = ['localhost', '127.0.0.1'].includes(location.hostname) && new URLSearchParams(location.search).has('local');
    if (FIREBASE_CONFIG && !forceLocal) {
      const { createFirebaseStore } = await import('./store-firebase.js');
      state.store = await createFirebaseStore(FIREBASE_CONFIG);
    } else {
      state.store = createLocalStore();
    }
  } catch (e) {
    console.error(e);
    showFatal('データベースに接続できませんでした。通信状況を確認して、ページを再読み込みしてください。');
    return;
  }
  state.store.onWriteError = (e) => {
    console.error(e);
    const code = errorCode(e);
    toast(code === 'permission-denied'
      ? '保存できませんでした（権限エラー：permission-denied）'
      : `保存に失敗しました（${code}）`, { duration: 7000 });
  };
  state.store.onAuth((user) => (user ? startSession(user) : showLogin()));
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
  $('#login').hidden = true;
  $('#app').hidden = true;
  const el = $('#fatal');
  el.innerHTML = `<p>${esc(msg)}</p><button type="button" class="btn primary" onclick="location.reload()">再読み込み</button>`;
  el.hidden = false;
}

function showLogin() {
  state.unsub?.();
  state.unsub = null;
  state.user = null;
  state.loaded = false;
  $('#boot').hidden = true;
  $('#app').hidden = true;
  $('#login').hidden = false;
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
  $('#login').hidden = true;
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
  };
  state.loaded = true;
  render();
  paintDetail();
  paintKeyMenu();
  paintSettings();
  paintArtists();
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
    <span class="art" aria-hidden="true">${icon('music')}<img alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" hidden></span>
    <button type="button" class="song-main">
      <span class="song-title">${icon('star-fill', 'fav')}<span class="t"></span></span>
      <span class="song-sub"><span class="a"></span><span class="tags"></span></span>
    </button>
    <div class="range" role="group" aria-label="音域">
      ${RANGE_FIELDS.map((f) => `<div class="rc"><span class="rl">${f.short}</span><span class="rv"></span></div>`).join('')}
    </div>
    <div class="keyctl" role="group" aria-label="キー">
      <button type="button" class="kb k-down" aria-label="キーを1下げる">${icon('minus')}</button>
      <button type="button" class="kv"></button>
      <button type="button" class="kb k-up" aria-label="キーを1上げる">${icon('plus')}</button>
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
    fav: $('.fav', el),
    rv: $$('.rv', el),
    kv: $('.kv', el),
    kd: $('.k-down', el),
    ku: $('.k-up', el),
    sig: '',
  };
}

function updateItem(it, s) {
  const sig = [s.title, s.artist, s.favorite, s.tags.join('|'), s.low, s.chestHigh, s.falsettoHigh, s.key, s.artwork].join('\u0001');
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
  it.fav.style.display = s.favorite ? '' : 'none';
  const shown = s.tags.slice(0, 2);
  it.tags.innerHTML = shown.map((t) => `<span class="tag">${esc(t)}</span>`).join('') + (s.tags.length > 2 ? `<span class="tag more">+${s.tags.length - 2}</span>` : '');
  RANGE_FIELDS.forEach((f, i) => {
    const v = s[f.id];
    const el = it.rv[i];
    const text = isNote(v) ? noteName(v + s.key) : '—';
    el.textContent = text;
    el.classList.toggle('none', !isNote(v));
    el.classList.toggle('long', text.length >= 7);
    el.classList.toggle('xlong', text.length >= 9);
  });
  it.kv.textContent = keyText(s.key);
  it.kv.dataset.tone = keyTone(s.key);
  it.kv.classList.toggle('oct', s.key === OCTAVE_DOWN);
  it.kv.setAttribute('aria-label', `キー ${keyText(s.key)}。リセットやオク下のメニューを開く`);
  it.kd.disabled = s.key <= KEY_MIN;
  it.ku.disabled = s.key >= KEY_MAX;
}

function renderList(list) {
  const ul = $('#list');
  ul.classList.toggle('no-art', !state.view.showArt);
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
    const text = isNote(min) && isNote(max) ? `${noteName(min)}〜${noteName(max)}` : isNote(min) ? `${noteName(min)}以上` : `${noteName(max)}以下`;
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
  const tags = allTags(state.songs);
  const sig = JSON.stringify([state.view, [...counts], tags]);
  if (sig === fpSig) return;
  fpSig = sig;
  const v = state.view;
  $('#f-fav').checked = v.favoriteOnly;
  $('#f-missing').checked = v.missingRange;
  const names = [...counts.keys()].sort(collator.compare);
  if (v.artist && !counts.has(v.artist)) names.unshift(v.artist);
  $('#f-artist').innerHTML = `<option value="">すべてのアーティスト</option>`
    + names.map((n) => `<option value="${esc(n)}"${n === v.artist ? ' selected' : ''}>${esc(n)}（${counts.get(n) ?? 0}）</option>`).join('');
  $('#f-tags').innerHTML = tags.map((t) => `<button type="button" class="chip${v.tags.includes(t) ? ' on' : ''}" data-tag="${esc(t)}" aria-pressed="${v.tags.includes(t)}">${esc(t)}</button>`).join('');
  $$('#f-basis button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === v.basis)));
  $('#f-range').innerHTML = RANGE_FIELDS.map((f) => {
    const { min, max } = v.range[f.id] ?? {};
    return `<div class="rf-row" data-field="${f.id}">
      <span class="rf-label">${f.label}</span>
      <button type="button" class="rf-btn${isNote(min) ? ' set' : ''}" data-bound="min">${isNote(min) ? noteName(min) : '下限なし'}</button>
      <span class="rf-sep">〜</span>
      <button type="button" class="rf-btn${isNote(max) ? ' set' : ''}" data-bound="max">${isNote(max) ? noteName(max) : '上限なし'}</button>
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
      <div class="empty-actions"><button type="button" class="btn primary" data-act="add">${icon('plus')}曲を登録</button><button type="button" class="btn" data-act="import">${icon('upload')}CSVを読み込む</button></div>`;
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
  $('#btn-login').addEventListener('click', signIn);

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
  $('#btn-random').addEventListener('click', () => randomPick());
  $('#fab').addEventListener('click', () => openForm());

  $('#list').addEventListener('click', (e) => {
    const li = e.target.closest('.song');
    if (!li || li.classList.contains('skeleton')) return;
    const id = li.dataset.id;
    const s = state.byId.get(id);
    if (!s) return;
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

async function signIn() {
  const err = $('#login-error');
  err.hidden = true;
  const btn = $('#btn-login');
  btn.disabled = true;
  try {
    await state.store.signIn();
  } catch (e) {
    if (['auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/user-cancelled'].includes(e?.code)) return;
    console.error(e);
    err.textContent = e?.code === 'auth/unauthorized-domain'
      ? 'このURLからのログインが許可されていません。Firebase の承認済みドメインを確認してください。'
      : `ログインできませんでした（${e?.code ?? e?.message ?? '不明なエラー'}）`;
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
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

function setKey(id, key) {
  const s = state.byId.get(id);
  if (!s) return;
  const k = clampKey(key);
  if (k === s.key) return;
  s.key = k;
  holdOrder();
  render();
  paintDetail();
  paintKeyMenu();
  state.store.updateSong(id, { key: k });
}

function recommendHTML(s, { compact = false } = {}) {
  if (!hasVoice()) {
    return `<button type="button" class="rec-link" data-act="voice">${icon('mic')}<span>自分の音域を登録すると、おすすめキーを表示します</span></button>`;
  }
  const rec = recommendKey(s, voice());
  if (!rec) return '<p class="rec-note">音域が未入力のため、おすすめキーを計算できません</p>';
  const note = rec.fits ? '' : `<p class="rec-note warn">音域に収まりません（${rec.short}半音分）。一番近いキーです</p>`;
  if (rec.key === s.key) {
    return `<div class="rec-ok">${icon('check')}<span>おすすめキー（<b class="tone-${keyTone(rec.key)}">${keyText(rec.key)}</b>）です</span></div>${note}`;
  }
  return `<button type="button" class="rec-btn" data-k="${rec.key}">
      <span class="rec-l">おすすめ</span><b class="tone-${keyTone(rec.key)}">${keyText(rec.key)}</b><span class="rec-go">${compact ? '' : 'に変更'}${icon('chevron-right')}</span>
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
      setKey(s.id, +b.dataset.k);
      closePopover();
    } else if (b.dataset.act === 'voice') {
      closePopover();
      openSettings();
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
  $('.keymenu', kp.el).innerHTML = `
    <div class="km-head"><span class="km-title">キー</span><b class="km-cur tone-${keyTone(s.key)}">${keyText(s.key)}</b></div>
    <div class="km-row">
      <button type="button" class="km-btn" data-k="0"${s.key === 0 ? ' aria-pressed="true"' : ''}>${icon('reset')}<span>原キー</span></button>
      <button type="button" class="km-btn" data-k="${OCTAVE_DOWN}"${s.key === OCTAVE_DOWN ? ' aria-pressed="true"' : ''}>${icon('octave')}<span>オク下</span></button>
    </div>
    <div class="km-rec">${recommendHTML(s, { compact: true })}</div>`;
}

// ---- 曲の詳細 ---------------------------------------------------------

function openDetail(id, { random = false } = {}) {
  const sheet = openSheet('<div class="detail"></div>', {
    label: '曲の詳細',
    className: 'detail-layer',
    onClose: () => {
      if (state.detail?.sheet === sheet) state.detail = null;
    },
  });
  state.detail = { id, sheet, random, sig: '' };
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
  const sig = JSON.stringify([d.id, s.title, s.artist, s.favorite, s.tags, s.memo, s.score, s.singCount, s.lastSungAt, s.low, s.chestHigh, s.falsettoHigh, s.artwork, d.random, voice()]);
  if (sig !== d.sig) {
    d.sig = sig;
    root.innerHTML = detailHTML(s, d);
  }
  const kv = $('[data-role="kv"]', root);
  kv.textContent = keyText(s.key);
  kv.dataset.tone = keyTone(s.key);
  kv.classList.toggle('oct', s.key === OCTAVE_DOWN);
  $('[data-act="k-down"]', root).disabled = s.key <= KEY_MIN;
  $('[data-act="k-up"]', root).disabled = s.key >= KEY_MAX;
  $('[data-act="k-reset"]', root).setAttribute('aria-pressed', String(s.key === 0));
  $('[data-act="k-oct"]', root).setAttribute('aria-pressed', String(s.key === OCTAVE_DOWN));
  for (const f of RANGE_FIELDS) {
    const td = $(`[data-role="cur-${f.id}"]`, root);
    const v = s[f.id];
    td.textContent = isNote(v) ? noteName(v + s.key) : '—';
    td.dataset.tone = isNote(v) ? keyTone(s.key) : 'zero';
  }
  $('[data-role="rec"]', root).innerHTML = recommendHTML(s);
}

function detailHTML(s, d) {
  const vo = voice();
  const showVoice = hasVoice();
  const rows = RANGE_FIELDS.map((f) => {
    const v = s[f.id];
    return `<tr>
      <th scope="row">${f.label}</th>
      <td class="orig">${isNote(v) ? noteName(v) : '<span class="none">—</span>'}</td>
      <td class="cur" data-role="cur-${f.id}"></td>
      ${showVoice ? `<td class="mine">${isNote(vo[f.id]) ? noteName(vo[f.id]) : '—'}</td>` : ''}
    </tr>`;
  }).join('');
  return `
    ${d.random ? `<div class="rand-bar">${icon('dice')}<span>ランダム選曲</span><button type="button" class="btn sm" data-act="reroll">${icon('refresh')}もう一度</button></div>` : ''}
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
            <button type="button" class="pill" data-act="k-oct">${icon('octave')}オク下</button>
          </div>
        </div>
        <div class="d-rec" data-role="rec"></div>
      </section>
      <table class="d-range">
        <thead><tr><th></th><th scope="col">原曲</th><th scope="col">キー適用後</th>${showVoice ? '<th scope="col">自分</th>' : ''}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="d-stats">
        <div class="stat"><span class="sl">歌った回数</span><span class="sv">${s.singCount}<small>回</small></span></div>
        <div class="stat"><span class="sl">最終歌唱日</span><span class="sv">${s.lastSungAt ? fmtDate(s.lastSungAt) : '—'}</span></div>
        <div class="stat"><span class="sl">採点</span><span class="sv">${s.score != null ? `${fmtScore(s.score)}<small>点</small>` : '—'}</span></div>
      </div>
      <button type="button" class="btn primary wide sung" data-act="sung">${icon('mic')}歌った！</button>
      ${s.tags.length ? `<div class="d-tags chip-set">${s.tags.map((t) => `<span class="chip static">${esc(t)}</span>`).join('')}</div>` : ''}
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
  const s = state.byId.get(d.id);
  if (!s) return;
  if (b.dataset.k != null) {
    setKey(s.id, +b.dataset.k);
    return;
  }
  switch (b.dataset.act) {
    case 'close': d.sheet.close(); break;
    case 'k-down': setKey(s.id, s.key - 1); break;
    case 'k-up': setKey(s.id, s.key + 1); break;
    case 'k-reset': setKey(s.id, 0); break;
    case 'k-oct': setKey(s.id, OCTAVE_DOWN); break;
    case 'fav': state.store.updateSong(s.id, { favorite: !s.favorite }); break;
    case 'sung': markSung(s.id); break;
    case 'reroll': randomPick(s.id); break;
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
  state.store.updateSong(id, next);
  toast(`${next.singCount}回目を記録しました`, {
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
  toast('削除しました');
}

function randomPick(excludeId) {
  const base = state.visible;
  if (!base.length) {
    toast('表示中の曲がありません');
    return;
  }
  const pool = base.length > 1 ? base.filter((s) => s.id !== excludeId) : base;
  const s = pool[Math.floor(Math.random() * pool.length)];
  if (state.detail) {
    state.detail.id = s.id;
    state.detail.random = true;
    state.detail.sig = '';
    paintDetail();
    state.detail.sheet.el.scrollTop = 0;
  } else {
    openDetail(s.id, { random: true });
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
          <button type="button" class="pill" data-act="k-oct">${icon('octave')}オク下</button>
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
      $('.nf-v', b).textContent = isNote(v) ? noteName(v) : f.id === 'falsettoHigh' ? 'なし' : '未選択';
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
    const kv = el('[data-role="kv"]');
    kv.textContent = keyText(draft.key);
    kv.dataset.tone = keyTone(draft.key);
    kv.classList.toggle('oct', draft.key === OCTAVE_DOWN);
    el('[data-act="k-down"]').disabled = draft.key <= KEY_MIN;
    el('[data-act="k-up"]').disabled = draft.key >= KEY_MAX;
    el('[data-act="k-reset"]').setAttribute('aria-pressed', String(draft.key === 0));
    el('[data-act="k-oct"]').setAttribute('aria-pressed', String(draft.key === OCTAVE_DOWN));
  };

  const paintTags = () => {
    const tags = [...new Set([...allTags(state.songs), ...extraTags, ...draft.tags])];
    el('[data-role="tags"]').innerHTML = tags.map((t) => {
      const on = draft.tags.includes(t);
      return `<button type="button" class="chip${on ? ' on' : ''}" data-tag="${esc(t)}" aria-pressed="${on}">${esc(t)}</button>`;
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
  setupArtistSuggest(form.artist, el('#fm-artist-list'), () => {
    prefetchSongs();
    form.title.focus();
  });
  setupTitleSuggest(form.title, el('#fm-title-list'), () => form.artist.value, (s) => {
    if (s.artwork) {
      draft.artwork = s.artwork;
      paintArt();
    }
  });

  form.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.tagName === 'TEXTAREA' || e.isComposing) return;
    if (e.target.matches('[data-role="tag-input"]')) {
      e.preventDefault();
      addTag();
    } else if (e.target === form.artist) {
      if (!e.defaultPrevented) {
        e.preventDefault();
        form.title.focus();
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
      case 'k-reset': draft.key = 0; paintKey(); break;
      case 'k-oct': draft.key = OCTAVE_DOWN; paintKey(); break;
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
    if (dv) {
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
    toast(isNew ? `登録しました：${title}` : '保存しました');
    if (next) {
      draft = { ...emptySong(), artist, tags: [] };
      fill();
      el('.sheet-body').scrollTop = 0;
      form.title.focus();
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
  const hide = () => {
    list.hidden = true;
    active = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };
  const show = (next, render) => {
    items = next;
    renderFn = render;
    if (document.activeElement !== input || !items.length) return hide();
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
  input.addEventListener('blur', () => setTimeout(hide, 120));
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
  const message = (text) => {
    if (document.activeElement !== input) return hide();
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
      input.value = s.title;
      onPick?.(s);
    },
  });
  const render = (items, active, pre) => {
    const artist = getArtist().trim();
    const registered = new Set(state.songs.map(dupKey));
    return '<li class="ac-head" role="presentation">iTunes の候補</li>' + items.map((s, i) => {
      const done = registered.has(dupKey({ artist, title: s.title }));
      return `<li role="option" id="${pre}-${i}" data-i="${i}" class="song-opt${i === active ? ' active' : ''}" aria-selected="${i === active}">
        <span class="ac-art">${s.artwork ? `<img src="${esc(s.artwork)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : icon('music')}</span>
        <span class="ac-text"><span class="ac-name">${highlight(s.title, input.value)}</span>${s.album ? `<span class="ac-sub">${esc(s.album)}</span>` : ''}</span>
        ${done ? '<span class="ac-count">登録済み</span>' : ''}</li>`;
    }).join('');
  };
  const load = () => {
    clearTimeout(timer);
    const artist = getArtist().trim();
    const q = input.value.trim();
    if (!artist || !navigator.onLine) return cb.hide();
    const key = `${artist}\u0001${q}`;
    if (key === loadedKey) return cb.show(songs, render);
    if (!songs.length) cb.message('iTunes で曲を探しています…');
    timer = setTimeout(async () => {
      ctrl?.abort();
      ctrl = new AbortController();
      try {
        const found = await suggestSongsOnline(artist, q, { signal: ctrl.signal });
        if (`${getArtist().trim()}\u0001${input.value.trim()}` !== key) return;
        if (found.length) loadedKey = key;
        songs = found.slice(0, 8);
        cb.reset();
        cb.show(songs, render);
      } catch (e) {
        if (e.name !== 'AbortError') console.warn('title suggest', e);
      }
    }, q ? 300 : 30);
  };
  input.addEventListener('focus', load);
  input.addEventListener('input', () => {
    cb.reset();
    load();
  });
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
    if (e.target.dataset.role === 'show-art') updateView({ showArt: e.target.checked });
  });
}

function paintSettings() {
  const sheet = state.settings;
  if (!sheet) return;
  const vo = voice();
  const user = state.user;
  const local = state.store.mode === 'local';
  const scrollTop = $('.settings .sheet-body', sheet.el)?.scrollTop ?? 0;
  $('.settings', sheet.el).innerHTML = `
    <div class="sheet-head"><h3>設定</h3><button type="button" class="icon-btn" data-act="close" aria-label="閉じる">${icon('close')}</button></div>
    <div class="sheet-body">
      <section class="set-sec">
        <h4>自分の音域</h4>
        <div class="note-fields">
          ${RANGE_FIELDS.map((f) => `<button type="button" class="note-field${isNote(vo[f.id]) ? ' set' : ''}" data-voice="${f.id}"><span class="nf-l">${f.label}</span><span class="nf-v">${isNote(vo[f.id]) ? noteName(vo[f.id]) : '未選択'}</span></button>`).join('')}
        </div>
        <p class="hint">登録すると、曲ごとに音域に収まるキーを計算して「おすすめキー」として表示します。</p>
      </section>
      <section class="set-sec">
        <h4>入力補助</h4>
        <button type="button" class="row-btn" data-act="artists">
          <span class="row-l">${icon('list')}アーティスト名の候補</span>
          <span class="row-r">${state.profile.artists.length}件${icon('chevron-right')}</span>
        </button>
      </section>
      <section class="set-sec">
        <h4>ジャケット画像</h4>
        <label class="switch-row"><span>一覧に表示する</span><input type="checkbox" class="switch" data-role="show-art"${state.view.showArt ? ' checked' : ''}></label>
        <div data-role="art-job">${artJobHTML()}</div>
        <p class="hint">画像が未設定の曲を iTunes で探して入れます。1曲に数秒かかるので、曲数が多いときは時間がかかります。</p>
      </section>
      <section class="set-sec">
        <h4>再生履歴から追加</h4>
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
      <section class="set-sec">
        <h4>アカウント</h4>
        ${local
          ? '<p class="hint">ローカルモード：データはこのブラウザだけに保存されています。</p>'
          : `<div class="account"><span class="acc-name">${esc(user?.email ?? user?.name ?? '')}</span><button type="button" class="btn sm" data-act="logout">${icon('logout')}ログアウト</button></div>`}
      </section>
    </div>`;
  const body = $('.settings .sheet-body', sheet.el);
  if (body) body.scrollTop = scrollTop;
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
  switch (b.dataset.act) {
    case 'close': state.settings.close(); break;
    case 'artists': openArtists(); break;
    case 'export': exportCSV(); break;
    case 'import': $('#csv-file').click(); break;
    case 'art-run': runArtJob(); break;
    case 'art-cancel': artJob.cancel = true; break;
    case 'history': $('#history-file').click(); break;
    case 'logout':
      if (await confirmDialog({ title: 'ログアウトしますか？', ok: 'ログアウト' })) {
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
