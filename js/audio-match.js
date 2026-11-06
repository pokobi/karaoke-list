// 端末の音楽ファイルを、登録済みの曲に割り当てるための処理（画面に触らない部分）。
// ファイルの中の曲名・アーティスト名（MP3 の ID3、M4A の MP4 タグ、FLAC の Vorbis コメント）を読み、
// 読めなければファイル名を使って、登録済みの曲と照らし合わせる。
import { looseKey, analyzeLine } from './text-import.js';
import { baseTitle, trimReading } from './itunes.js';

// ---- 文字・数値の読み取り ----

const u32 = (b, p) => ((b[p] << 24) >>> 0) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3];
const syncsafe = (b, p) => ((b[p] & 0x7f) << 21) | ((b[p + 1] & 0x7f) << 14) | ((b[p + 2] & 0x7f) << 7) | (b[p + 3] & 0x7f);
const ascii = (b, p, n) => String.fromCharCode(...b.subarray(p, p + n));

function decode(label, bytes, fatal = false) {
  try {
    return new TextDecoder(label, { fatal }).decode(bytes);
  } catch {
    return null;
  }
}

// 文字コードの指定がない文字列：ASCII → UTF-8 → Shift_JIS（日本の古い MP3 に多い）→ Latin-1 の順に試す
function decodeLoose(bytes) {
  if (bytes.every((c) => c < 0x80)) return decode('latin1', bytes) ?? '';
  return decode('utf-8', bytes, true) ?? decode('shift_jis', bytes, true) ?? decode('latin1', bytes) ?? '';
}

const clean = (s) => String(s ?? '').replace(/\0.*$/s, '').trim();

// ---- MP3（ID3v2） ----

export const isId3 = (b) => b.length >= 10 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33;
export const id3Size = (b) => 10 + syncsafe(b, 6) + (b[5] & 0x10 ? 10 : 0);

function id3Text(bytes) {
  if (!bytes.length) return '';
  const enc = bytes[0];
  const body = bytes.subarray(1);
  if (enc === 1) {
    // UTF-16（先頭の BOM で並びを決める）
    if (body[0] === 0xfe && body[1] === 0xff) return clean(decode('utf-16be', body.subarray(2)));
    if (body[0] === 0xff && body[1] === 0xfe) return clean(decode('utf-16le', body.subarray(2)));
    return clean(decode('utf-16le', body));
  }
  if (enc === 2) return clean(decode('utf-16be', body));
  if (enc === 3) return clean(decode('utf-8', body));
  return clean(decodeLoose(body.subarray(0, body.indexOf(0) >= 0 ? body.indexOf(0) : body.length)));
}

// b：ファイルの先頭（タグ全体を含む）。戻り値：{ title, artist }
export function parseId3(b) {
  if (!isId3(b)) return {};
  const ver = b[3];
  const end = Math.min(b.length, id3Size(b));
  let pos = 10;
  if (b[5] & 0x40) pos += ver === 4 ? syncsafe(b, 10) : u32(b, 10) + 4;
  const idLen = ver === 2 ? 3 : 4;
  const hdr = ver === 2 ? 6 : 10;
  const out = {};
  while (pos + hdr <= end) {
    const id = ascii(b, pos, idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break;
    const size = ver === 2 ? (b[pos + 3] << 16) | (b[pos + 4] << 8) | b[pos + 5] : ver === 4 ? syncsafe(b, pos + 4) : u32(b, pos + 4);
    const start = pos + hdr;
    if (size <= 0 || start + size > end) break;
    if (id === 'TIT2' || id === 'TT2') out.title ??= id3Text(b.subarray(start, start + size));
    else if (id === 'TPE1' || id === 'TP1') out.artist ??= id3Text(b.subarray(start, start + size));
    pos = start + size;
  }
  return out;
}

// ---- M4A（MP4 の ilst） ----

function boxes(b, start, end) {
  const list = [];
  let p = start;
  while (p + 8 <= end) {
    let size = u32(b, p);
    const type = ascii(b, p + 4, 4);
    let hdr = 8;
    if (size === 1) {
      if (p + 16 > end) break;
      size = u32(b, p + 8) * 2 ** 32 + u32(b, p + 12);
      hdr = 16;
    } else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) break;
    list.push({ type, start: p + hdr, end: p + size });
    p += size;
  }
  return list;
}

// b：moov の箱の中身（箱の頭の 8 バイトを除く）。戻り値：{ title, artist }
export function parseMp4Moov(b) {
  const out = {};
  const find = (list, type) => list.find((x) => x.type === type);
  const udta = find(boxes(b, 0, b.length), 'udta');
  if (!udta) return out;
  const meta = find(boxes(b, udta.start, udta.end), 'meta');
  if (!meta) return out;
  // meta は、普通は先頭に 4 バイトの版・フラグがある（ないものもある）
  const offset = ascii(b, meta.start + 4, 4) === 'hdlr' ? 0 : 4;
  const ilst = find(boxes(b, meta.start + offset, meta.end), 'ilst');
  if (!ilst) return out;
  for (const item of boxes(b, ilst.start, ilst.end)) {
    const data = find(boxes(b, item.start, item.end), 'data');
    if (!data || data.end - data.start <= 8) continue;
    const text = clean(decode('utf-8', b.subarray(data.start + 8, data.end)));
    if (item.type === '©nam') out.title ??= text;
    else if (item.type === '©ART') out.artist ??= text;
    else if (item.type === 'aART') out.albumArtist ??= text;
  }
  if (!out.artist && out.albumArtist) out.artist = out.albumArtist;
  delete out.albumArtist;
  return out;
}

// ---- FLAC（Vorbis コメント） ----

export function parseVorbisComment(b) {
  const le = (p) => b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | ((b[p + 3] << 24) >>> 0);
  const out = {};
  let p = 4 + le(0);
  const n = le(p);
  p += 4;
  for (let i = 0; i < n && p + 4 <= b.length; i++) {
    const len = le(p);
    p += 4;
    const s = decode('utf-8', b.subarray(p, p + len)) ?? '';
    p += len;
    const eq = s.indexOf('=');
    if (eq < 0) continue;
    const k = s.slice(0, eq).toUpperCase();
    if (k === 'TITLE') out.title ??= clean(s.slice(eq + 1));
    else if (k === 'ARTIST') out.artist ??= clean(s.slice(eq + 1));
  }
  return out;
}

// ---- ファイルから読む（ブラウザで使う） ----

const MAX_TAG_BYTES = 16 * 1024 * 1024;
const read = async (file, start, len) => new Uint8Array(await file.slice(start, start + len).arrayBuffer());

async function readMp4(file) {
  let p = 0;
  for (let i = 0; i < 64 && p + 8 <= file.size; i++) {
    const h = await read(file, p, 16);
    let size = u32(h, 0);
    let hdr = 8;
    if (size === 1) {
      size = u32(h, 8) * 2 ** 32 + u32(h, 12);
      hdr = 16;
    } else if (size === 0) size = file.size - p;
    if (size < hdr) break;
    if (ascii(h, 4, 4) === 'moov') return size - hdr > MAX_TAG_BYTES ? {} : parseMp4Moov(await read(file, p + hdr, size - hdr));
    p += size;
  }
  return {};
}

async function readFlac(file) {
  let p = 4;
  for (let i = 0; i < 32 && p + 4 <= file.size; i++) {
    const h = await read(file, p, 4);
    const last = h[0] & 0x80;
    const type = h[0] & 0x7f;
    const len = (h[1] << 16) | (h[2] << 8) | h[3];
    if (type === 4) return len > MAX_TAG_BYTES ? {} : parseVorbisComment(await read(file, p + 4, len));
    if (last) break;
    p += 4 + len;
  }
  return {};
}

// ファイルの中の曲名・アーティスト名。読めないときは {}
export async function readTags(file) {
  try {
    const head = await read(file, 0, 64 * 1024);
    if (isId3(head)) {
      const size = id3Size(head);
      return parseId3(size <= head.length ? head : await read(file, 0, Math.min(size, MAX_TAG_BYTES)));
    }
    if (ascii(head, 0, 4) === 'fLaC') return await readFlac(file);
    if (ascii(head, 4, 4) === 'ftyp') return await readMp4(file);
  } catch (err) {
    console.warn('tags', err);
  }
  return {};
}

// ---- 登録済みの曲と照らし合わせる ----

// ファイル名から、拡張子と先頭のトラック番号（「01 」「1-01 」「01. 」など）を除いた文字
export function fileNameText(name) {
  return String(name ?? '')
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/^\s*(?:\d{1,2}-)?\d{1,3}(?:\s*[.\-_)）]\s*|\s+)(?=\S)/, '')
    .replace(/_/g, ' ')
    .trim();
}

// 曲名を比べるときの形（付記・英語表記・記号・空白の違いを無視する）
const titleKey = (s) => looseKey(baseTitle(trimReading(String(s ?? ''))));
const sameLoose = (a, b) => !!a && !!b && (a === b || (a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a))));

// info：{ title, artist }（ファイルの中のタグ）と name（ファイル名）。songs：[{ id, title, artist }]
// 戻り値：{ status: 'sure' | 'check' | 'none', pick, candidates }（候補は合う順）
export function matchFile({ title, artist, name }, songs) {
  const tagTitle = titleKey(title);
  const tagTitleRaw = looseKey(title ?? '');
  const tagArtist = looseKey(artist ?? '');
  const line = fileNameText(name);
  const info = line ? analyzeLine(line) : null;
  const parts = (info?.parts ?? []).map(looseKey);
  const cands = [];
  for (const s of songs) {
    const sk = titleKey(s.title);
    if (!sk) continue;
    // 曲名：タグが同じなら 10、ファイル名の語のまとまりと同じなら 8、一部だけ同じなら 4
    let ts = 0;
    if (tagTitle && (tagTitle === sk || tagTitleRaw === looseKey(s.title))) ts = 10;
    else if (info && (info.runs.has(sk) || parts.includes(sk) || info.key === sk)) ts = 8;
    else if ((tagTitle && sameLoose(tagTitle, sk)) || (info && sk.length >= 3 && info.key.includes(sk))) ts = 4;
    if (!ts) continue;
    const ak = looseKey(s.artist ?? '');
    let as = 0;
    if (ak && tagArtist && sameLoose(tagArtist, ak)) as = 5;
    else if (ak && info && (info.runs.has(ak) || parts.includes(ak) || (ak.length >= 3 && info.key.includes(ak)))) as = 5;
    cands.push({ song: s, ts, as, total: ts + as });
  }
  cands.sort((a, b) => b.total - a.total);
  if (!cands.length) return { status: 'none', pick: null, candidates: [] };
  const best = cands[0];
  // ファイルに曲名以外の手がかり（アーティスト名）がないか
  const noArtistInfo = !tagArtist && (!info || info.key === titleKey(best.song.title) || info.key === looseKey(best.song.title));
  const rivals = cands.filter((c) => c !== best && c.total >= best.total);
  const sameTitle = cands.filter((c) => c.ts >= 8);
  let status = 'check';
  if (best.ts >= 8 && best.as === 5 && !rivals.length) status = 'sure';
  else if (best.ts >= 8 && noArtistInfo && sameTitle.length === 1) status = 'sure';
  return { status, pick: best.song, candidates: cands.slice(0, 12).map((c) => c.song) };
}
