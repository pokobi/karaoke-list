// iTunes の試聴に使う曲の選び方
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toSong, rankPreviews, releaseYear } from '../js/itunes.js';

const track = (id, title, { artist = 'LUMINA', album = '', released = '2020-01-01T08:00:00Z', preview = true } = {}) => toSong({
  wrapperType: 'track', kind: 'song', trackId: id, artistName: artist, trackName: title, collectionName: album,
  releaseDate: released, previewUrl: preview ? `https://example.test/${id}.m4a` : undefined,
  trackViewUrl: `https://music.example.test/${id}`, artworkUrl100: 'https://example.test/a/100x100bb.jpg',
});

test('検索結果に、試聴の URL と曲の ID を残す', () => {
  const s = track(1, 'つきあかり');
  assert.equal(s.trackId, 1);
  assert.equal(s.previewUrl, 'https://example.test/1.m4a');
  assert.equal(s.trackUrl, 'https://music.example.test/1');
  assert.equal(releaseYear(s), '2020');
  assert.equal(track(2, 'x', { preview: false }).previewUrl, null);
});

test('試聴に使う曲は、ライブ版より元の版を、同じなら発売が早いものを先にする', () => {
  const list = [
    track(1, 'つきあかり', { album: 'LUMINA DOME LIVE 2024', released: '2024-05-01T00:00:00Z' }),
    track(2, 'つきあかり', { album: 'FIRST ALBUM', released: '2021-01-06T00:00:00Z' }),
    track(3, 'つきあかり', { album: 'つきあかり - Single', released: '2019-12-15T00:00:00Z' }),
    track(4, 'つきあかり (Live)', { album: 'X', released: '2018-01-01T00:00:00Z' }),
    track(5, 'つきあかり', { artist: 'カバー歌手', released: '2010-01-01T00:00:00Z' }),
    track(6, '花火の夜', { released: '2010-01-01T00:00:00Z' }),
    track(7, 'つきあかり', { preview: false, released: '2000-01-01T00:00:00Z' }),
  ];
  assert.deepEqual(rankPreviews(list, 'LUMINA', 'つきあかり').map((s) => s.trackId), [3, 2, 1, 4, 5, 6]);
});

test('登録した曲名がライブ版なら、ライブ版を下げない', () => {
  const list = [
    track(1, 'つきあかり', { album: 'FIRST ALBUM', released: '2021-01-06T00:00:00Z' }),
    track(2, 'つきあかり (Live)', { album: 'LIVE', released: '2024-01-01T00:00:00Z' }),
  ];
  assert.equal(rankPreviews(list, 'LUMINA', 'つきあかり (Live)')[0].trackId, 2);
  assert.deepEqual(rankPreviews(null, 'a', 'b'), []);
});
