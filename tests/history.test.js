import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guessSong, parseHistoryText, aggregate, thumbnailUrl, cleanChannel } from '../js/history.js';

test('公式音源（- Topic）はタイトルがそのまま曲名', () => {
  assert.deepEqual(guessSong('夜明けのワルツ', 'ソラシド - Topic'), { artist: 'ソラシド', title: '夜明けのワルツ' });
});

test('MV のタイトルから曲名とアーティストを推測する', () => {
  assert.deepEqual(guessSong('LUMINA「つきあかり」 Official Music Video', 'Kei / LUMINA'), { artist: 'LUMINA', title: 'つきあかり' });
  assert.deepEqual(guessSong('ソラシド - 花火の夜（OFFICIAL VIDEO）', 'ソラシド / aoi Official'), { artist: 'ソラシド', title: '花火の夜' });
  assert.deepEqual(guessSong('Official空模様 - Daybreak［Official Video］', 'Official空模様'), { artist: 'Official空模様', title: 'Daybreak' });
  assert.deepEqual(guessSong('Starlight', 'ミナト'), { artist: 'ミナト', title: 'Starlight' });
  assert.deepEqual(guessSong('マリーゴールド / あいみょん', 'あいみょん'), { artist: 'あいみょん', title: 'マリーゴールド' });
  assert.equal(cleanChannel('King Gnu Official YouTube Channel'), 'King Gnu');
});

const takeout = JSON.stringify([
  { header: 'YouTube Music', title: '夜明けのワルツ を視聴しました', titleUrl: 'https://music.youtube.com/watch?v=aaaaaaaaaaa', subtitles: [{ name: 'ソラシド - Topic' }], time: '2026-11-01T10:00:00Z' },
  { header: 'YouTube Music', title: 'Watched 夜明けのワルツ', titleUrl: 'https://music.youtube.com/watch?v=aaaaaaaaaaa', subtitles: [{ name: 'ソラシド - Topic' }], time: '2026-11-02T10:00:00Z' },
  { header: 'YouTube Music', title: 'Starlight を視聴しました', titleUrl: 'https://music.youtube.com/watch?v=bbbbbbbbbbb', subtitles: [{ name: 'ミナト - Topic' }], time: '2026-11-03T10:00:00Z' },
  { header: 'YouTube', title: '関係ない動画 を視聴しました', titleUrl: 'https://www.youtube.com/watch?v=ccccccccccc', subtitles: [{ name: 'someone' }], time: '2026-11-03T10:00:00Z' },
]);

test('Takeout の履歴から YouTube Music の再生だけを取り出し、曲ごとに数える', () => {
  const entries = parseHistoryText(takeout);
  assert.equal(entries.length, 3);
  const agg = aggregate(entries);
  assert.deepEqual(agg.map((s) => [s.artist, s.title, s.count, s.topic]), [['ソラシド', '夜明けのワルツ', 2, true], ['ミナト', 'Starlight', 1, true]]);
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
