// 追加機能（js/plugins.js）とのつなぎ：音域欄のボタン、音域のまとめての取り込み、試聴の音源、詳細画面に足す表示

import { RANGE_FIELDS, isNote } from '../notes.js';
import { openExternal } from '../external.js';
import { esc, icon, toast } from '../ui.js';
import { plugins } from '../plugins.js';
import { previewSupported, audioFiles } from '../preview.js';
import { itunesPreviewSource } from '../itunes-preview.js';
import { state } from './core.js';
import { openDetail } from './detail.js';

// 追加機能が用意した、音域欄のボタン
export const rangeActions = () => plugins.flatMap((p) => (p.rangeAction ? [p.rangeAction] : []));

// 音域を入れるためのボタン。追加機能の「音域を調べる」は目立たせ、音域が未入力（missing）なら色を付ける。
// 追加機能があるときの「Webで音域を検索」は、最後の手段として控えめにする
export function rangeActionsHTML(extraClass = '', missing = false) {
  const actions = rangeActions();
  const web = actions.length
    ? `<button type="button" class="range-web" data-act="range-web">${icon('external')}Webで音域を検索</button>`
    : `<button type="button" class="pill" data-act="range-web">${icon('external')}Webで音域を検索</button>`;
  return `<div class="range-actions${extraClass ? ` ${extraClass}` : ''}">${actions.map((a, i) => `<button type="button" class="pill pill-lookup${missing ? ' urgent' : ''}" data-plugin="${i}">${icon(a.icon ?? 'search')}${esc(a.label)}</button>`).join('')}${web}</div>`;
}

// 「アーティスト名 曲名 音域」で Web 検索する。Google のアカウントの履歴に残らないよう、DuckDuckGo（日本の検索結果）を使う
const WEB_SEARCH_URL = 'https://duckduckgo.com/?kl=jp-jp&q=';
export function openRangeSearch(artist, title) {
  const t = String(title ?? '').trim();
  if (!t) {
    toast('曲名を入れてから検索してください');
    return;
  }
  const q = [String(artist ?? '').trim(), t, '音域'].filter(Boolean).join(' ');
  openExternal(WEB_SEARCH_URL + encodeURIComponent(q));
}

// 追加機能が、まとめて追加した曲などの音域を補う（rangeBatch）。items：[{ id, artist, title }]
export const rangeBatches = () => plugins.flatMap((p) => (p.rangeBatch ? [p.rangeBatch] : []));
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
// opts.quiet：始めたことをトーストで知らせない（1曲だけ登録したときなど）
export function runRangeBatch(items, opts = {}) {
  if (!items.length) return;
  for (const b of rangeBatches()) {
    try {
      b.run(items, rangeBatchCtx, opts);
    } catch (err) {
      console.error(err);
    }
  }
}

export async function runRangeAction(index, ctx) {
  const action = rangeActions()[index];
  try {
    await action?.run(ctx);
  } catch (err) {
    console.error(err);
    toast('うまく動きませんでした');
  }
}

// 追加機能に渡す、登録済みの曲を操作するための窓口。音域を入れたら、その場で保存する
export function songPluginCtx(id) {
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
export const previewSources = () => [itunesPreviewSource, ...plugins.flatMap((p) => (p.previewSource ? [p.previewSource] : []))];

// 試聴の音源を選んだときなどに、曲の保存欄 song.ext に書く
export function previewCtx(id) {
  return {
    saveExt: (patch) => {
      const s = state.byId.get(id);
      if (!s) return;
      state.store.updateSong(id, { ext: { ...(s.ext ?? {}), ...patch } });
    },
  };
}

export function removeAudioFiles(ids) {
  if (!previewSupported()) return;
  for (const id of ids) audioFiles.remove(id).catch(() => {});
}

// 追加機能が詳細画面に足す表示
export function pluginDetailHTML(song) {
  return plugins.map((p) => {
    try {
      return p.detailHTML?.(song) ?? '';
    } catch (e) {
      console.error(e);
      return '';
    }
  }).join('');
}
