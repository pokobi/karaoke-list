// ランダム選曲の画面

import { RANGE_FIELDS, isNote, keyTone, describeKey } from '../notes.js';
import { artistCounts } from '../model.js';
import { fmtNote } from '../display.js';
import { $, $$, esc, icon, openSheet, toast, pickNote } from '../ui.js';
import {
  COUNTS, EXCLUDE_DAYS, defaultRandomOptions, sanitizeRandomOptions, randomPool, pickRandom, hasRandomRange,
} from '../random.js';
import { playRandomFx } from '../random-fx.js';
import {
  DEFAULT_OCTAVE, devicePrefs, haptic, state, voice, hasVoice, recOffset, recUp, recommend, tagList, recKeyHTML,
  isRecSetting,
} from './core.js';
import { ARTIST_SEARCH_MIN, artistChipsHTML, exTagChips, toggleTagCondition } from './list.js';
import { openDetail, markSung } from './detail.js';
import { tagC } from './tags.js';

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

export function saveRandomOptions() {
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
export function paintRandom() {
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

export function openRandom() {
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
