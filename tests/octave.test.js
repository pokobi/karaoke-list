import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeKey, splitKey, toggleOctave, octaveOf, machineKey, parseNote as n } from '../js/notes.js';
import { normalizeSong } from '../js/model.js';
import { songsToCSV, parseCSV, rowsToSongs } from '../js/csv.js';

test('オク下で機械のキーを +4 にしたときは「オク下 +4（実際 −8）」', () => {
  const d = describeKey(-8, -1);
  assert.equal(d.machine, 4);
  assert.equal(d.oct, 'オク下');
  assert.equal(d.text, 'オク下 +4');
  assert.equal(d.actual, '−8');
  assert.equal(describeKey(-12, -1).text, 'オク下 ±0');
  assert.equal(describeKey(9, 1).text, 'オク上 −3');
  assert.equal(describeKey(-3, 0).text, '−3');
});

test('オク下・オク上は、機械のキーを保ったまま切り替える', () => {
  assert.deepEqual(toggleOctave(-3, 0, -1), { key: -15, octave: -1 });
  assert.deepEqual(toggleOctave(-15, -1, -1), { key: -3, octave: 0 });
  assert.deepEqual(toggleOctave(0, 0, -1), { key: -12, octave: -1 });
  // オク下からオク上へ
  assert.deepEqual(toggleOctave(-8, -1, 1), { key: 16, octave: 1 });
  assert.equal(machineKey(16, 1), 4);
});

test('実際のキーは、機械で設定できる ±7 を超える分だけオクターブに回す', () => {
  assert.deepEqual(splitKey(-7), { octave: 0, machine: -7 });
  assert.deepEqual(splitKey(-8), { octave: -1, machine: 4 });
  assert.deepEqual(splitKey(-12), { octave: -1, machine: 0 });
  assert.deepEqual(splitKey(9), { octave: 1, machine: -3 });
});

test('オクターブの記録がない古いデータは、キーの値から推測する', () => {
  assert.equal(octaveOf(undefined, -12), -1);
  assert.equal(octaveOf(undefined, -8), -1);
  assert.equal(octaveOf(undefined, -3), 0);
  assert.equal(octaveOf(0, -12), 0); // 記録があればそれを使う
  assert.equal(normalizeSong({ key: -12 }).octave, -1);
  assert.equal(normalizeSong({ key: -8, octave: -1 }).octave, -1);
});

test('CSV の「キー」はカラオケ機のキー、「オクターブ」はオク下・オク上で書き出す', () => {
  const src = [normalizeSong({ artist: 'A', title: 'B', low: n('mid1C'), key: -8, octave: -1 })];
  const csv = songsToCSV(src);
  const [head, row] = parseCSV(csv);
  assert.equal(row[head.indexOf('キー')], '4');
  assert.equal(row[head.indexOf('オクターブ')], 'オク下');
  const { songs } = rowsToSongs(parseCSV(csv));
  assert.equal(songs[0].key, -8);
  assert.equal(songs[0].octave, -1);
  // 「オクターブ」の列がない古い CSV は、キーを実際のキーとして読む
  const old = rowsToSongs(parseCSV('曲名,キー\nX,-12\n'));
  assert.equal(old.songs[0].key, -12);
  assert.equal(normalizeSong(old.songs[0]).octave, -1);
});
