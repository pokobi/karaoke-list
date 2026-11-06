// 曲の一覧のファイル（CSV・タブ区切り）を読む処理（画面に触らない部分）。
// 音楽サービスの書き出し（Apple Music のプレイリスト、Spotify の Exportify、YouTube Music の Takeout、
// TuneMyMusic・Soundiiz など）や、表計算ソフトからのコピーを、見出しから曲名・アーティストの列を見つけて読む。
import { trimReading } from './itunes.js';

export const MAX_TABLE_ROWS = 2000;

function decode(label, bytes, fatal = false) {
  try {
    return new TextDecoder(label, { fatal }).decode(bytes);
  } catch {
    return null;
  }
}

// ファイルの中身（バイト列）を文字列にする。BOM → UTF-8 → Shift_JIS（Excel で保存した CSV に多い）の順に試す。
// Apple Music・iTunes の書き出しは UTF-16
export function decodeText(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b[0] === 0xff && b[1] === 0xfe) return decode('utf-16le', b.subarray(2)) ?? '';
  if (b[0] === 0xfe && b[1] === 0xff) return decode('utf-16be', b.subarray(2)) ?? '';
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return decode('utf-8', b.subarray(3)) ?? '';
  return decode('utf-8', b, true) ?? decode('shift_jis', b, true) ?? decode('utf-8', b) ?? '';
}

// 1 行目から区切り文字を決める（タブがあればタブ、なければカンマ）。区切りがなければ null
export function detectDelimiter(text) {
  const first = String(text ?? '').split(/\r?\n/).find((l) => l.trim()) ?? '';
  if (first.includes('\t')) return '\t';
  if (first.includes(',')) return ',';
  return null;
}

// CSV を行と列に分ける（ダブルクオートで囲んだ中のカンマ・改行・"" を扱う）
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === '') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// 表を行と列に分ける。空の行は除く。区切りがなければ null
export function parseTable(text) {
  const t = String(text ?? '').replace(/^﻿/, '');
  const d = detectDelimiter(t);
  if (!d) return null;
  // タブ区切り（Apple Music の書き出し・表計算からのコピー）は、ダブルクオートを特別扱いしない
  const rows = d === '\t' ? t.split(/\r?\n/).map((l) => l.split('\t')) : parseCsv(t);
  return rows.map((r) => r.map((f) => f.trim())).filter((r) => r.some(Boolean));
}

const head = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const TITLE_HEADS = ['track name', 'song title', 'song name', 'track title', 'title', 'name', 'track', '曲名', '曲', '名前', 'タイトル', '楽曲名', 'トラック名'];
const ARTIST_HEADS = ['artist name(s)', 'artist names', 'artist name', 'artist name 1', 'artist', 'artists', 'アーティスト', 'アーティスト名', 'アーティスト名 1', '歌手', '歌手名'];
const VIDEO_HEADS = ['video id', '動画 id', '動画id', 'videoid'];
const PLAYLIST_HEADS = ['playlist name', 'playlist', 'プレイリスト名', 'プレイリスト', '再生リスト'];

// 見出しの行から、曲名・アーティスト・動画 ID・再生リスト名の列を見つける（ないものは -1）。
// 曲名も動画 ID も見つからなければ null
export function detectColumns(header) {
  const h = (header ?? []).map(head);
  const find = (list) => {
    for (const want of list) {
      const i = h.indexOf(want);
      if (i >= 0) return i;
    }
    return -1;
  };
  let title = find(TITLE_HEADS);
  if (title < 0) title = h.findIndex((x) => /(song|track) (title|name)|曲名|タイトル/.test(x));
  let artist = find(ARTIST_HEADS);
  if (artist < 0) artist = h.findIndex((x) => /artist|アーティスト/.test(x) && !/album|アルバム/.test(x));
  const videoId = find(VIDEO_HEADS);
  const playlist = find(PLAYLIST_HEADS);
  if (title < 0 && videoId < 0) return null;
  return { title, artist, videoId, playlist };
}

// 表の行（見出しの行は除く）を、曲の候補 [{ title, artist, videoId, source }] にする。
// cols：detectColumns の戻り値か、自分で選んだ列。source：ファイル名など（再生リスト名の列があればそちら）
export function tableToItems(rows, cols, source = '') {
  const get = (r, i) => (i >= 0 ? String(r[i] ?? '').trim() : '');
  const out = [];
  for (const r of rows) {
    const title = trimReading(get(r, cols.title)).trim();
    const videoId = /^[\w-]{11}$/.test(get(r, cols.videoId)) ? get(r, cols.videoId) : '';
    if (!title && !videoId) continue;
    // 複数のアーティストが「;」でまとめて入っているときは、最初の 1 組
    const artist = get(r, cols.artist).split(';')[0].trim();
    out.push({ title, artist, videoId, source: get(r, cols.playlist) || source });
  }
  return out;
}

// ファイル名から、まとめの名前（再生リスト名など）を作る
export function sourceName(fileName) {
  return String(fileName ?? '')
    .split(/[\\/]/).pop()
    .replace(/\.(csv|tsv|txt)$/i, '')
    .replace(/-(videos|動画)$/i, '')
    .trim();
}
