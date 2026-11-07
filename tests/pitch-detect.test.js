import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPitch, hzToNoteValue, inNoteRange, createRangeTracker } from '../js/pitch-detect.js';
import { parseNote as n } from '../js/notes.js';

const SR = 48000;
// 声に近いよう、倍音を含んだ波（基音＋2倍音＋3倍音）
function wave(hz, len = 2048, amp = 0.4) {
  const buf = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const p = (2 * Math.PI * hz * i) / SR;
    buf[i] = amp * (Math.sin(p) + 0.5 * Math.sin(2 * p) + 0.3 * Math.sin(3 * p)) / 1.8;
  }
  return buf;
}
const noteOf = (hz) => Math.round(hzToNoteValue(detectPitch(wave(hz), SR).hz));

test('倍音を含んだ音でも、基音の高さを調べられる', () => {
  // 低い男声〜高い裏声まで（lowG＝G2、mid1A＝A2、mid2C＝C4、hiA＝A4、hiE＝E5、hihiC＝C6）
  const cases = [['lowG', 98], ['mid1A', 110], ['mid2C', 261.63], ['hiA', 440], ['hiE', 659.26], ['hihiC', 1046.5]];
  for (const [name, hz] of cases) assert.equal(noteOf(hz), n(name), name);
  const r = detectPitch(wave(220), SR);
  assert.ok(Math.abs(r.hz - 220) < 1);
  assert.ok(r.clarity > 0.8);
});

test('声が小さいとき・音の高さがはっきりしないときは null', () => {
  assert.equal(detectPitch(new Float32Array(2048), SR), null);
  assert.equal(detectPitch(wave(220, 2048, 0.001), SR), null);
  // ざらざらした音（雑音）
  let seed = 1;
  const noise = Float32Array.from({ length: 2048 }, () => { seed = (seed * 16807) % 2147483647; return (seed / 2147483647 - 0.5) * 0.8; });
  assert.equal(detectPitch(noise, SR), null);
});

test('周波数をアプリの音階の値にする（lowA = A1 = 55Hz が 0）', () => {
  assert.equal(hzToNoteValue(55), 0);
  assert.equal(Math.round(hzToNoteValue(440)), n('hiA'));
  assert.equal(inNoteRange(hzToNoteValue(440)), true);
  assert.equal(inNoteRange(hzToNoteValue(40)), false);
});

test('同じ高さで伸ばした音だけを、いちばん低い／高い音として記録する', () => {
  const hi = createRangeTracker({ mode: 'high', holdMs: 400 });
  // 一瞬だけ出た高い音（100ms）は記録しない
  for (let t = 0; t <= 100; t += 20) hi.feed(30, t);
  for (let t = 120; t <= 600; t += 20) hi.feed(24.2, t); // 少し揺れても同じ音（24）
  assert.equal(hi.best, 24);
  // もっと高い音を伸ばすと更新、低い音では更新しない
  for (let t = 620; t <= 1100; t += 20) hi.feed(27 + (t % 40 ? 0.3 : -0.3), t);
  assert.equal(hi.best, 27);
  for (let t = 1120; t <= 1700; t += 20) hi.feed(20, t);
  assert.equal(hi.best, 27);
  // 短い途切れは続いているとみなす
  const lo = createRangeTracker({ mode: 'low', holdMs: 400, gapMs: 150 });
  for (let t = 0; t <= 200; t += 20) lo.feed(10, t);
  lo.feed(null, 300);
  for (let t = 320; t <= 420; t += 20) lo.feed(10, t);
  assert.equal(lo.best, 10);
  lo.reset();
  assert.equal(lo.best, null);
});
