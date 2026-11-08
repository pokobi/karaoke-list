// キーの操作と、曲の詳細画面

import {
  RANGE_FIELDS, KEY_MIN, KEY_MAX, isNote, keyTone, clampKey, rangeIssues, songSpan, spanLevel, SPAN_LEVEL_MAX, splitRecKey,
  describeKey, toggleOctave,
} from '../notes.js';
import { isRangeMissing } from '../model.js';
import { getNoteStyle, fmtNoteHTML } from '../display.js';
import { $, $$, esc, icon, openSheet, confirmDialog, toast, openPopover, closePopover, popoverAnchor } from '../ui.js';
import { previewSupported, createPreview } from '../preview.js';
import {
  haptic, state, voice, hasVoice, recOffset, recUp, recommend, ISSUE_LABEL, issueText, warnColor, tagList, fmtDate,
  fmtScore, recKeyHTML, isRecSetting, paintKv,
} from './core.js';
import { render, holdOrder, updateView } from './list.js';
import { openForm } from './form.js';
import {
  rangeActions, rangeActionsHTML, openRangeSearch, runRangeAction, songPluginCtx, previewSources, previewCtx,
  removeAudioFiles, pluginDetailHTML,
} from './plugin-host.js';
import { openSettings } from './settings.js';
import { tagC, askNewTag } from './tags.js';

// ---- キー -------------------------------------------------------------

export function setKey(id, key, octave) {
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

export function openKeyMenu(id, anchor) {
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

export function paintKeyMenu() {
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

export function openDetail(id) {
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

export function paintDetail() {
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
  // 音域の出典と「音域を調べる」：音域が未入力のときは表のすぐ下に出す。入力済みのときは、
  // スマホで試聴の再生ボタンまで 1 画面に入るよう、試聴の下に回す
  const missing = isRangeMissing(s);
  const rangeInfo = `${pluginDetailHTML(s)}${rangeActionsHTML('d-ractions', missing)}`;
  const rangeInfoFirst = missing || !d.preview;
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
      ${rangeInfoFirst ? rangeInfo : ''}
      ${d.preview ? '<section class="d-sec d-pv" data-role="preview"></section>' : ''}
      ${rangeInfoFirst ? '' : `<div class="d-rinfo-after">${rangeInfo}</div>`}
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

export function markSung(id) {
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

export async function removeSong(id) {
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
