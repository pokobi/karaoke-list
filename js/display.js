// 音域の表記の切り替え（カラオケ表記・G4 形式・両方）。画面のどこからでも同じ書式で表示する。
import { noteName, scientificName, isNote } from './notes.js';

let style = 'karaoke';

export function setNoteStyle(s) {
  style = s === 'scientific' || s === 'both' ? s : 'karaoke';
}

export function getNoteStyle() {
  return style;
}

// 一覧などの狭い場所：どちらか一方だけ（「両方」のときはカラオケ表記）
export function fmtNote(i) {
  if (!isNote(i)) return '';
  return style === 'scientific' ? scientificName(i) : noteName(i);
}

// 詳細画面などの広い場所：「両方」のときは小さく併記する（HTML）
export function fmtNoteHTML(i) {
  if (!isNote(i)) return '';
  if (style === 'both') return `${noteName(i)}<small class="sci">${scientificName(i)}</small>`;
  return fmtNote(i);
}

// 文字だけで両方を出す（読み上げ用など）
export function fmtNoteText(i) {
  if (!isNote(i)) return '';
  if (style === 'both') return `${noteName(i)}（${scientificName(i)}）`;
  return fmtNote(i);
}
