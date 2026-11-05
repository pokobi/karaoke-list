import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNote as n } from '../js/notes.js';
import { normalizeSong } from '../js/model.js';
import { songsToCSV, parseCSV, rowsToSongs } from '../js/csv.js';

test('書き出した CSV を読み込むと同じ内容に戻る', () => {
  const src = [normalizeSong({
    id: 'x', artist: 'A, "B"', title: '改行\nあり', low: n('lowG#'), chestHigh: n('hiA'), falsettoHigh: null, key: -12,
    favorite: true, tags: ['バラード', '練習中'], score: 92.345, memo: 'メモ', singCount: 3,
    lastSungAt: new Date(2026, 10, 6, 21, 30).getTime(), createdAt: new Date(2026, 0, 2, 3, 4).getTime(),
  })];
  const { songs, errors } = rowsToSongs(parseCSV('\uFEFF' + songsToCSV(src)));
  assert.deepEqual(errors, []);
  assert.equal(songs.length, 1);
  const s = songs[0];
  for (const k of ['artist', 'title', 'low', 'chestHigh', 'falsettoHigh', 'key', 'favorite', 'tags', 'score', 'memo', 'singCount', 'lastSungAt', 'createdAt']) {
    assert.deepEqual(s[k], src[0][k], k);
  }
});

test('最低限の列だけの CSV も読める。存在しない列は undefined のまま', () => {
  const { songs, errors } = rowsToSongs(parseCSV('曲名,歌手,最低音,地声\r\nチェリー,スピッツ,mid1C,ｈｉＡ\r\n,空行扱い,,\r\n'));
  assert.equal(songs.length, 1);
  assert.equal(songs[0].artist, 'スピッツ');
  assert.equal(songs[0].chestHigh, n('hiA'));
  assert.equal(songs[0].key, undefined);
  assert.equal(errors.length, 1);
});

test('読めない値はエラーに数えて空欄にする', () => {
  const { songs, errors } = rowsToSongs(parseCSV('アーティスト,曲名,最低音,キー\nX,Y,mid9A,abc\n'));
  assert.equal(songs[0].low, null);
  assert.equal(songs[0].key, 0);
  assert.equal(errors.length, 2);
});

test('曲名の列がなければ読み込まない', () => {
  const { songs, errors } = rowsToSongs(parseCSV('a,b\n1,2\n'));
  assert.equal(songs.length, 0);
  assert.equal(errors.length, 1);
});
