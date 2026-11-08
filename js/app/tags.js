// タグの追加・名前の変更・削除・色・並べ替え

import { tagCounts, TAG_COLORS, tagColorList } from '../model.js';
import { $, esc, icon, openSheet, confirmDialog, toast, promptDialog } from '../ui.js';
import { state, tagList } from './core.js';
import { render, updateView } from './list.js';
import { paintDetail } from './detail.js';
import { saveRandomOptions } from './random-sheet.js';

// ---- タグ -------------------------------------------------------------

// 設定のタグ一覧に足りないタグを足す（最初の 1 回は、今あるタグをすべて一覧として保存する）
export function ensureTags(names) {
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
export function tagC(t) {
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

export async function askNewTag() {
  const name = await promptDialog({ title: '新しいタグ', placeholder: '例：盛り上がる曲', ok: '追加', maxLength: 20 });
  if (!name) return null;
  ensureTags([name]);
  return name;
}

export function openTagManager() {
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

export function paintTagManager() {
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
