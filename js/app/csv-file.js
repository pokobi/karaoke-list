// CSV ファイルへの書き出しと読み込み

import { collator } from '../text.js';
import { emptySong, normalizeSong, toPayload, dupKey } from '../model.js';
import { songsToCSV, parseCSV, rowsToSongs } from '../csv.js';
import { choiceDialog, confirmDialog, toast } from '../ui.js';
import { state, pad2 } from './core.js';

// ---- CSV --------------------------------------------------------------

export function exportCSV() {
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

export async function importCSV(file) {
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
