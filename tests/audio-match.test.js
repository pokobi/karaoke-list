import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseId3, parseMp4Moov, parseVorbisComment, fileNameText, matchFile } from '../js/audio-match.js';

const enc = new TextEncoder();
const bytes = (...parts) => {
  const arr = parts.flatMap((p) => (typeof p === 'string' ? [...enc.encode(p)] : p instanceof Uint8Array ? [...p] : p));
  return new Uint8Array(arr);
};
const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const syncsafe = (n) => [(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127];

// ID3v2 のタグを作る。frames：[[id, 文字コード, 中身のバイト列]]
function id3(ver, frames) {
  const body = bytes(...frames.map(([id, e, data]) => {
    const payload = bytes([e], data);
    return bytes(id, ver === 4 ? syncsafe(payload.length) : be32(payload.length), [0, 0], payload);
  }));
  return bytes('ID3', [ver, 0, 0], syncsafe(body.length), body);
}
const utf16le = (s) => bytes([0xff, 0xfe], [...s].flatMap((c) => [c.charCodeAt(0) & 255, c.charCodeAt(0) >> 8]));

test('MP3 の ID3 タグから曲名・アーティスト名を読む', () => {
  assert.deepEqual(parseId3(id3(3, [['TIT2', 1, utf16le('夜明けのワルツ')], ['TPE1', 1, utf16le('ソラシド')]])), { title: '夜明けのワルツ', artist: 'ソラシド' });
  assert.deepEqual(parseId3(id3(4, [['TPE1', 3, enc.encode('LUMINA')], ['TIT2', 3, enc.encode('つきあかり')]])), { title: 'つきあかり', artist: 'LUMINA' });
  // 文字コードの指定がないもの（ASCII）
  assert.deepEqual(parseId3(id3(3, [['TIT2', 0, enc.encode('Daybreak\0')]])), { title: 'Daybreak' });
  assert.deepEqual(parseId3(bytes('not a tag')), {});
});

test('文字コードの指定がない日本語（Shift_JIS）も読む', (t) => {
  let sjis;
  try {
    sjis = new TextDecoder('shift_jis', { fatal: true });
  } catch {
    t.skip('この環境は Shift_JIS に対応していない');
    return;
  }
  assert.ok(sjis);
  // 「白い街」の Shift_JIS
  const shiroi = [0x94, 0x92, 0x82, 0xa2, 0x8a, 0x58];
  assert.equal(parseId3(id3(3, [['TIT2', 0, shiroi]])).title, '白い街');
});

test('M4A の MP4 タグから曲名・アーティスト名を読む', () => {
  // 箱：[大きさ 4 バイト][種類 4 バイト][中身]。曲名の箱の種類の © は 1 バイト（0xA9）
  const box = (type, ...payload) => {
    const body = bytes(...payload);
    return bytes(be32(8 + body.length), type, body);
  };
  const item = (name, s) => box([0xa9, ...enc.encode(name)], box('data', [0, 0, 0, 1, 0, 0, 0, 0], s));
  const ilst = box('ilst', item('nam', '花火の夜'), item('ART', 'ソラシド'));
  const udta = box('udta', box('meta', [0, 0, 0, 0], box('hdlr', [0, 0, 0, 0, 0, 0, 0, 0]), ilst));
  assert.deepEqual(parseMp4Moov(udta), { title: '花火の夜', artist: 'ソラシド' });
});

test('FLAC の Vorbis コメントから曲名・アーティスト名を読む', () => {
  const comments = ['TITLE=雨の日', 'ARTIST=ミナト', 'ALBUM=x'].map((s) => bytes(le32(enc.encode(s).length), s));
  const b = bytes(le32(6), 'vendor', le32(comments.length), ...comments);
  assert.deepEqual(parseVorbisComment(b), { title: '雨の日', artist: 'ミナト' });
});

test('ファイル名から、拡張子とトラック番号を除く', () => {
  assert.equal(fileNameText('01 夜明けのワルツ.mp3'), '夜明けのワルツ');
  assert.equal(fileNameText('1-03 ソラシド - 花火の夜.m4a'), 'ソラシド - 花火の夜');
  assert.equal(fileNameText('02. Daybreak.flac'), 'Daybreak');
  assert.equal(fileNameText('ソラシド_白い街.mp3'), 'ソラシド 白い街');
  assert.equal(fileNameText('Lighthouse.mp3'), 'Lighthouse');
});

const songs = [
  { id: 'a', title: '夜明けのワルツ', artist: 'ソラシド' },
  { id: 'b', title: '白い街', artist: 'sky lantern' },
  { id: 'c', title: '白い街', artist: 'ミナト' },
  { id: 'd', title: 'つきあかり', artist: 'LUMINA' },
];

test('タグの曲名とアーティスト名が合えば確実とする', () => {
  const r = matchFile({ title: '白い街', artist: 'ミナト', name: 'track01.mp3' }, songs);
  assert.equal(r.status, 'sure');
  assert.equal(r.pick.id, 'c');
  // 英語表記や付記が付いていても合う
  assert.equal(matchFile({ title: 'つきあかり - Tsukiakari', artist: 'LUMINA', name: 'x.m4a' }, songs).pick.id, 'd');
});

test('タグがなくても、ファイル名から合う曲を探す', () => {
  assert.equal(matchFile({ name: 'ソラシド - 夜明けのワルツ.mp3' }, songs).status, 'sure');
  // 曲名だけのファイル名でも、その曲名の曲が 1 つだけなら確実
  const only = matchFile({ name: '03 つきあかり.mp3' }, songs);
  assert.deepEqual([only.status, only.pick.id], ['sure', 'd']);
  // 同じ曲名の曲が 2 つあって、アーティストが分からなければ要確認
  const two = matchFile({ name: '白い街.mp3' }, songs);
  assert.equal(two.status, 'check');
  assert.equal(two.candidates.length, 2);
});

test('合う曲がなければ見つからないとする', () => {
  const r = matchFile({ title: 'まぼろしの曲', artist: 'だれか', name: 'まぼろしの曲.mp3' }, songs);
  assert.deepEqual([r.status, r.pick], ['none', null]);
});
