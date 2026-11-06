import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RANDOM_FX, sanitizeRandomFx, stopTimes, slotInterval, pickDecoy, FX_DURATION } from '../js/random-fx.js';

test('演出の種類は、知らない値ならスロットに戻す', () => {
  assert.deepEqual(RANDOM_FX.map((f) => f.id), ['slot', 'reel', 'cards', 'none']);
  assert.equal(sanitizeRandomFx('reel'), 'reel');
  assert.equal(sanitizeRandomFx('none'), 'none');
  assert.equal(sanitizeRandomFx('x'), 'slot');
  assert.equal(sanitizeRandomFx(), 'slot');
});

test('1 曲ならちょうど演出の長さで止まり、複数なら上から順に止まって最後は演出の長さで止まる', () => {
  assert.deepEqual(stopTimes(1), [FX_DURATION]);
  const t = stopTimes(5, 1500);
  assert.equal(t.length, 5);
  assert.equal(t[0], 900);
  assert.equal(t.at(-1), 1500);
  for (let i = 1; i < t.length; i++) assert.ok(t[i] > t[i - 1]);
});

test('スロットの入れ替えは、止まる直前ほどゆっくりになる', () => {
  assert.ok(slotInterval(0) < slotInterval(0.5));
  assert.ok(slotInterval(0.5) < slotInterval(1));
  assert.equal(slotInterval(-1), slotInterval(0));
  assert.equal(slotInterval(2), slotInterval(1));
});

test('演出で流す曲は、なるべく直前と同じ曲を避ける', () => {
  const a = { id: 'a' };
  const b = { id: 'b' };
  assert.equal(pickDecoy([], null), null);
  assert.equal(pickDecoy([a], a), a);
  // 乱数が最初に直前と同じ曲を指しても、引き直す
  const seq = [0, 0.9];
  assert.equal(pickDecoy([a, b], a, () => seq.shift() ?? 0.9), b);
});
