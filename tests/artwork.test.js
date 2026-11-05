import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNote as n } from '../js/notes.js';
import { normalizeSong, toPayload, applyView, defaultView, sanitizeView, safeImageUrl, isRangeMissing } from '../js/model.js';
import { songsToCSV, parseCSV, rowsToSongs } from '../js/csv.js';

test('ジャケット画像は https の URL だけを受け付ける', () => {
  assert.equal(safeImageUrl('https://is1-ssl.mzstatic.com/a/300x300bb.jpg'), 'https://is1-ssl.mzstatic.com/a/300x300bb.jpg');
  assert.equal(safeImageUrl('http://example.com/a.jpg'), null);
  assert.equal(safeImageUrl('javascript:alert(1)'), null);
  assert.equal(safeImageUrl('https://x.com/a.jpg" onerror="x'), null);
  assert.equal(normalizeSong({ artwork: 'https://i.ytimg.com/vi/abc/mqdefault.jpg' }).artwork, 'https://i.ytimg.com/vi/abc/mqdefault.jpg');
  assert.equal('artwork' in toPayload(normalizeSong({})), true);
});

test('音域が未入力の曲だけに絞り込める', () => {
  const songs = [
    { id: 'a', title: 'A', artist: 'x', low: n('mid1C'), chestHigh: n('hiA') },
    { id: 'b', title: 'B', artist: 'x', low: null, chestHigh: n('hiA') },
    { id: 'c', title: 'C', artist: 'x' },
  ].map(normalizeSong);
  assert.equal(isRangeMissing(songs[0]), false);
  assert.deepEqual(applyView(songs, { ...defaultView(), missingRange: true, sortBy: 'title', sortDir: 'asc' }, '').map((s) => s.id), ['b', 'c']);
  assert.equal(sanitizeView({ missingRange: true }).missingRange, true);
  assert.equal(sanitizeView({}).showArt, true);
  assert.equal(sanitizeView({ showArt: false }).showArt, false);
});

test('CSV にジャケット画像の URL も書き出し・読み込みできる', () => {
  const src = [normalizeSong({ artist: 'YOASOBI', title: '夜に駆ける', artwork: 'https://is1-ssl.mzstatic.com/a/300x300bb.jpg' })];
  const { songs, errors } = rowsToSongs(parseCSV(songsToCSV(src)));
  assert.deepEqual(errors, []);
  assert.equal(songs[0].artwork, 'https://is1-ssl.mzstatic.com/a/300x300bb.jpg');
  const bad = rowsToSongs(parseCSV('曲名,ジャケット画像\nX,ftp://nope\n'));
  assert.equal(bad.songs[0].artwork, null);
  assert.equal(bad.errors.length, 1);
});
