import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeHaptics, defaultHaptics, vibratePattern, tickCount, hapticMode, playHaptic } from '../js/haptics.js';

const coarse = (yes) => () => ({ matches: yes });

test('触覚フィードバックの設定は、オン・オフだけを残し、壊れた値を既定値に戻す', () => {
  assert.deepEqual(sanitizeHaptics(), defaultHaptics());
  assert.deepEqual(sanitizeHaptics({ on: false, key: false }), { on: false, key: false, sung: true, fav: true, random: true });
  // 以前の版で保存した強さ・種類は捨てる
  assert.deepEqual(sanitizeHaptics({ level: 'strong', type: 'pop' }), defaultHaptics());
  assert.equal(sanitizeHaptics('x').on, true);
});

test('振動は弱で固定。「歌った！」だけ 2 回', () => {
  assert.equal(vibratePattern('tap').length, 1);
  assert.ok(vibratePattern('tap')[0] <= 12);
  assert.equal(vibratePattern('success').length, 3);
  assert.equal(tickCount('tap'), 1);
  assert.equal(tickCount('success'), 2);
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
  assert.deepEqual(calls.vibrate, [vibratePattern('tap')]);
});

test('Android は操作に合わせた回数だけ短く振動する', () => {
  const { calls, env } = fakeEnv('vibrate');
  playHaptic('sung', {}, env);
  playHaptic('swipe', {}, env);
  playHaptic('key', {}, env);
  assert.deepEqual(calls.vibrate, [vibratePattern('success'), vibratePattern('tap'), vibratePattern('tap')]);
});

test('iPhone は操作に合わせた回数だけ鳴らし、スワイプの途中では鳴らさない', () => {
  const { calls, env } = fakeEnv('ios');
  playHaptic('key', {}, env);
  assert.equal(calls.ticks, 1);
  playHaptic('sung', {}, env);
  assert.equal(calls.ticks, 3);
  assert.equal(calls.later.length, 1);
  assert.equal(playHaptic('swipe', {}, env), false);
  assert.equal(calls.ticks, 3);
});
