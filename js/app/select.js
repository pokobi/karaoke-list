// 一覧で曲を複数選んで、まとめて操作する

import { $, $$, esc, icon, openSheet, confirmDialog, toast, closePopover } from '../ui.js';
import { haptic, state, tagList } from './core.js';
import { items, render } from './list.js';
import { removeAudioFiles } from './plugin-host.js';
import { tagC, askNewTag } from './tags.js';

// ---- 一覧で複数選択 ---------------------------------------------------

const selectedSongs = () => [...state.select.ids].map((id) => state.byId.get(id)).filter(Boolean);

export function setSelectMode(on) {
  state.select.on = on;
  if (!on) state.select.ids.clear();
  $('#app').classList.toggle('selecting', on);
  $('#selbar').hidden = !on;
  $('#btn-select').setAttribute('aria-pressed', String(on));
  closePopover();
  render();
  paintSelbar();
}

export function toggleSelect(id) {
  const ids = state.select.ids;
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  items.get(id)?.el.classList.toggle('selected', ids.has(id));
  paintSelbar();
}

export function paintSelbar() {
  if (!state.select.on) return;
  for (const id of [...state.select.ids]) if (!state.byId.has(id)) state.select.ids.delete(id);
  const n = state.select.ids.size;
  $('#sel-count').textContent = `${n}曲を選択中`;
  $$('#selbar .selbar-actions .btn').forEach((b) => { b.disabled = !n; });
  paintBulkTags();
}

export async function onSelbarClick(e) {
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
