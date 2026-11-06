import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeHaptics, defaultHaptics, vibratePattern, tickCount, hapticMode, playHaptic } from '../js/haptics.js';

const coarse = (yes) => () => ({ matches: yes });

test('触覚フィードバックの設定は、壊れた値を既定値に戻す', () => {
  assert.deepEqual(sanitizeHaptics(), defaultHaptics());
  assert.deepEqual(sanitizeHaptics({ on: false, level: 'strong', key: false }), { on: false, level: 'strong', key: false, sung: true, fav: true });
  assert.equal(sanitizeHaptics({ level: 'max' }).level, 'medium');
  assert.equal(sanitizeHaptics('x').on, true);
});

test('強いほど、Android では長く、iPhone では多く振動する', () => {
  assert.ok(vibratePattern('tap', 'weak')[0] < vibratePattern('tap', 'medium')[0]);
  assert.ok(vibratePattern('tap', 'medium')[0] < vibratePattern('tap', 'strong')[0]);
  assert.equal(vibratePattern('success', 'medium').length, 3);
  assert.deepEqual(['weak', 'medium', 'strong'].map((l) => tickCount('tap', l)), [1, 2, 3]);
  assert.equal(tickCount('success', 'weak'), 2);
});

test('振動のしかたは端末で決める', () => {
  const android = { userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/140', vibrate() {} };
  const iphone = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' };
  const ipad = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5 };
  assert.equal(hapticMode(android, coarse(true)), 'vibrate');
  assert.equal(hapticMode(iphone, coarse(true)), 'ios');
  assert.equal(hapticMode({ ...iphone, vibrate() {} }, coarse(true)), 'ios');
  assert.equal(hapticMode(ipad, coarse(true)), 'ios');
  // マウスで操作する端末では振動させない
  assert.equal(hapticMode(android, coarse(false)), null);
  assert.equal(hapticMode({ userAgent: 'Firefox' }, coarse(true)), null);
});

function fakeEnv(mode) {
  const calls = { vibrate: [], ticks: 0, later: [] };
  return {
    calls,
    env: {
      mode,
      vibrate: (p) => calls.vibrate.push(p),
      tick: () => { calls.ticks++; },
      later: (fn, ms) => { calls.later.push(ms); fn(); },
    },
  };
}

test('設定でオフの操作や、全体がオフのときは振動しない', () => {
  const { calls, env } = fakeEnv('vibrate');
  assert.equal(playHaptic('key', { key: false }, env), false);
  assert.equal(playHaptic('sung', { on: false }, env), false);
  assert.equal(playHaptic('swipe', { on: false }, env), false);
  assert.equal(playHaptic('key', {}, { ...env, mode: null }), false);
  assert.equal(calls.vibrate.length, 0);
  assert.equal(playHaptic('fav', { key: false }, env), true);
  assert.deepEqual(calls.vibrate, [vibratePattern('tap', 'medium')]);
});

test('Android は強さに合わせた長さで振動する', () => {
  const { calls, env } = fakeEnv('vibrate');
  playHaptic('sung', { level: 'strong' }, env);
  playHaptic('swipe', { level: 'strong' }, env);
  assert.deepEqual(calls.vibrate, [vibratePattern('success', 'strong'), [8]]);
});

test('iPhone は強さに合わせた回数だけ鳴らし、スワイプの途中では鳴らさない', () => {
  const { calls, env } = fakeEnv('ios');
  playHaptic('key', { level: 'strong' }, env);
  assert.equal(calls.ticks, 3);
  assert.equal(calls.later.length, 2);
  assert.equal(playHaptic('swipe', {}, env), false);
  assert.equal(calls.ticks, 3);
  playHaptic('test', { level: 'weak', key: false }, env);
  assert.equal(calls.ticks, 4);
});
