import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guessSong, parseHistoryText, aggregate, thumbnailUrl, cleanChannel } from '../js/history.js';

test('公式音源（- Topic）はタイトルがそのまま曲名', () => {
  assert.deepEqual(guessSong('ただ君に晴れ', 'ヨルシカ - Topic'), { artist: 'ヨルシカ', title: 'ただ君に晴れ' });
});

test('MV のタイトルから曲名とアーティストを推測する', () => {
  assert.deepEqual(guessSong('YOASOBI「夜に駆ける」 Official Music Video', 'Ayase / YOASOBI'), { artist: 'YOASOBI', title: '夜に駆ける' });
  assert.deepEqual(guessSong('ヨルシカ - 花に亡霊（OFFICIAL VIDEO）', 'ヨルシカ / n-buna Official'), { artist: 'ヨルシカ', title: '花に亡霊' });
  assert.deepEqual(guessSong('Official髭男dism - Pretender［Official Video］', 'Official髭男dism'), { artist: 'Official髭男dism', title: 'Pretender' });
  assert.deepEqual(guessSong('Lemon', '米津玄師'), { artist: '米津玄師', title: 'Lemon' });
  assert.deepEqual(guessSong('マリーゴールド / あいみょん', 'あいみょん'), { artist: 'あいみょん', title: 'マリーゴールド' });
  assert.equal(cleanChannel('King Gnu Official YouTube Channel'), 'King Gnu');
});

const takeout = JSON.stringify([
  { header: 'YouTube Music', title: 'ただ君に晴れ を視聴しました', titleUrl: 'https://music.youtube.com/watch?v=aaaaaaaaaaa', subtitles: [{ name: 'ヨルシカ - Topic' }], time: '2026-11-01T10:00:00Z' },
  { header: 'YouTube Music', title: 'Watched ただ君に晴れ', titleUrl: 'https://music.youtube.com/watch?v=aaaaaaaaaaa', subtitles: [{ name: 'ヨルシカ - Topic' }], time: '2026-11-02T10:00:00Z' },
  { header: 'YouTube Music', title: 'Lemon を視聴しました', titleUrl: 'https://music.youtube.com/watch?v=bbbbbbbbbbb', subtitles: [{ name: '米津玄師 - Topic' }], time: '2026-11-03T10:00:00Z' },
  { header: 'YouTube', title: '関係ない動画 を視聴しました', titleUrl: 'https://www.youtube.com/watch?v=ccccccccccc', subtitles: [{ name: 'someone' }], time: '2026-11-03T10:00:00Z' },
]);

test('Takeout の履歴から YouTube Music の再生だけを取り出し、曲ごとに数える', () => {
  const entries = parseHistoryText(takeout);
  assert.equal(entries.length, 3);
  const agg = aggregate(entries);
  assert.deepEqual(agg.map((s) => [s.artist, s.title, s.count, s.topic]), [['ヨルシカ', 'ただ君に晴れ', 2, true], ['米津玄師', 'Lemon', 1, true]]);
  assert.equal(agg[0].video, 'aaaaaaaaaaa');
  assert.equal(thumbnailUrl('aaaaaaaaaaa'), 'https://i.ytimg.com/vi/aaaaaaaaaaa/mqdefault.jpg');
});

test('YouTube-Music-History-Analyzer のバックアップも読める', () => {
  const backup = JSON.stringify({ format: 'ytm-history-analyzer', tracks: [['vid1234567', 'チェリー', 'スピッツ - Topic', null]], times: [1, 2, 3], trackIdx: [0, 0, 0] });
  const agg = aggregate(parseHistoryText(backup));
  assert.deepEqual(agg.map((s) => [s.artist, s.title, s.count]), [['スピッツ', 'チェリー', 3]]);
});

test('対応していないファイルはわかるメッセージで止める', () => {
  assert.throws(() => parseHistoryText('<html></html>'), /HTML 形式/);
  assert.throws(() => parseHistoryText('{bad json'), /JSON として読み込めません/);
  assert.throws(() => parseHistoryText('{"a":1}'), /対応していない形式/);
});
