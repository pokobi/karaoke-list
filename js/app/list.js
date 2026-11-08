// 曲の一覧：一覧・絞り込み・並べ替えの描画と、最初から画面にある要素（検索欄・ボタンなど）の操作

import { RANGE_FIELDS, KEY_MIN, KEY_MAX, isNote, rangeIssues } from '../notes.js';
import { collator, normalize } from '../text.js';
import { SORTS, defaultView, applyView, artistCounts, orderTags } from '../model.js';
import { getNoteStyle, fmtNote } from '../display.js';
import { $, $$, h, esc, icon, openSheet, openPopover, closePopover, popoverAnchor, pickNote } from '../ui.js';
import { signIn } from '../app.js';
import {
  HOLD_MS, DEFAULT_OCTAVE, wide, state, saveView, voice, hasVoice, ISSUE_LABEL, warnColor, tagList, paintKv,
} from './core.js';
import { setKey, openKeyMenu, openDetail } from './detail.js';
import { openRandom } from './random-sheet.js';
import { openForm } from './form.js';
import { importHistory } from './add-history.js';
import { openSettings } from './settings.js';
import { tagC } from './tags.js';
import { setSelectMode, toggleSelect, onSelbarClick } from './select.js';
import { setupSwipe, setupLongPress } from './swipe.js';
import { importCSV } from './csv-file.js';

// ---- 一覧の描画 -------------------------------------------------------

export const items = new Map();
let holdTimer = 0;

export function render() {
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
export function holdOrder() {
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

// 表記が変わったときなどに、一覧と絞り込みを次の描画で描き直させる
export function invalidateList() {
  items.forEach((it) => { it.sig = ''; });
  fpSig = '';
  chipsSig = '';
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

export function updateView(patch) {
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
export const ARTIST_SEARCH_MIN = 12;
const ARTIST_CHIP_LIMIT = 40;
export function artistChipsHTML(selected, query) {
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
export function exTagChips(tags, exTags) {
  return tags.map((t) => `<button type="button" class="chip ex${exTags.includes(t) ? ' on' : ''}"${tagC(t)} data-extag="${esc(t)}" aria-pressed="${exTags.includes(t)}" aria-label="${esc(t)}を除く">${esc(t)}</button>`).join('');
}

// タグの条件を切り替える（cond：tags と exTags を持つ条件）。同じタグを「タグ」と「除くタグ」の両方では選べないので、
// 片方で選んだら、もう片方からは外す
export function toggleTagCondition(cond, t, ex) {
  const [key, other] = ex ? ['exTags', 'tags'] : ['tags', 'exTags'];
  const on = cond[key].includes(t);
  return { [key]: on ? cond[key].filter((x) => x !== t) : [...cond[key], t], [other]: on ? cond[other] : cond[other].filter((x) => x !== t) };
}

// ---- 固定の要素のイベント ---------------------------------------------

export function bindStatic() {
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
