import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSong, toPayload } from '../js/model.js';
import { songsToCSV, COLUMNS } from '../js/csv.js';
import { plugins } from '../js/plugins.js';

test('追加機能の保存欄は、中身に手を加えずに引き継ぐ', () => {
  const s = normalizeSong({ title: 'A', ext: { foo: { bar: 1 } } });
  assert.deepEqual(toPayload(s).ext, { foo: { bar: 1 } });
  assert.equal(normalizeSong({ ext: 'x' }).ext, null);
  assert.equal(normalizeSong({ ext: [1] }).ext, null);
});

test('追加機能の保存欄は CSV に書き出さない', () => {
  assert.equal(COLUMNS.some((c) => c.id === 'ext'), false);
  assert.ok(!songsToCSV([normalizeSong({ title: 'A', ext: { secret: 'value' } })]).includes('value'));
});

test('このリポジトリには追加機能を入れない', () => {
  assert.deepEqual(plugins, []);
});
