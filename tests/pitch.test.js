import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PitchShifter } from '../js/pitch-worklet.js';

const SR = 48000;
const BLOCK = 128;

// 入力を 128 個ずつ流して、出力をつなげて返す
function run(shifter, input, { onBlock } = {}) {
  const ch = input.length;
  const n = input[0].length;
  const out = Array.from({ length: ch }, () => new Float32Array(n));
  const block = Array.from({ length: ch }, () => new Float32Array(BLOCK));
  for (let i = 0, b = 0; i + BLOCK <= n; i += BLOCK, b++) {
    onBlock?.(b, shifter);
    const src = input.map((x) => x.subarray(i, i + BLOCK));
    shifter.process(src, block, BLOCK);
    for (let c = 0; c < ch; c++) out[c].set(block[c], i);
  }
  return out;
}

const sine = (freq, seconds, amp = 0.5) => {
  const a = new Float32Array(Math.round(SR * seconds));
  for (let i = 0; i < a.length; i++) a[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return a;
};

// ゼロをまたいだ回数から周波数を求める
function frequency(x, from, to) {
  let crossings = 0;
  for (let i = from + 1; i < to; i++) if (x[i - 1] < 0 && x[i] >= 0) crossings++;
  return (crossings * SR) / (to - from);
}

const rms = (x, from, to) => {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / (to - from));
};

test('キーを変えると、テンポはそのままで音の高さが変わる', () => {
  const input = sine(440, 4);
  for (const semis of [2, -3, 5, -5, 12, -12]) {
    const sh = new PitchShifter(SR, 1);
    sh.setSemitones(semis);
    const [out] = run(sh, [input]);
    const f = frequency(out, SR * 1, SR * 3.5);
    const want = 440 * 2 ** (semis / 12);
    assert.ok(Math.abs(f - want) / want < 0.01, `${semis}: ${f.toFixed(1)}Hz（期待 ${want.toFixed(1)}Hz）`);
    const level = rms(out, SR * 1, SR * 3.5);
    assert.ok(level > 0.3 && level < 0.42, `${semis}: 音量 ${level.toFixed(3)}`);
  }
});

test('原曲キーでは、少し遅れるだけで元の音のまま出る', () => {
  // いろいろな高さが混ざった音
  const n = SR * 3;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    x[i] = 0.3 * Math.sin(2 * Math.PI * 220 * t) + 0.2 * Math.sin(2 * Math.PI * 587.3 * t + 1) + 0.1 * Math.sin(2 * Math.PI * 1830 * t);
  }
  const sh = new PitchShifter(SR, 1);
  const [out] = run(sh, [x]);
  // 遅れを探す
  let lag = -1;
  for (let d = 0; d < SR * 0.6; d++) {
    if (Math.abs(out[SR + d] - x[SR]) < 1e-4 && Math.abs(out[SR + d + 37] - x[SR + 37]) < 1e-4 && Math.abs(out[SR + d + 501] - x[SR + 501]) < 1e-4) {
      lag = d;
      break;
    }
  }
  assert.ok(lag > 0, '元の音と同じ並びが見つからない');
  assert.ok(lag < SR * 0.5, `遅れが大きすぎる：${lag}`);
  let maxErr = 0;
  for (let i = SR; i < SR * 2.4; i++) maxErr = Math.max(maxErr, Math.abs(out[i + lag] - x[i]));
  assert.ok(maxErr < 1e-3, `ずれ ${maxErr}`);
});

test('長く流しても、途切れず、ためる量も増え続けない', () => {
  const n = SR * 20;
  const x = new Float32Array(n);
  let seed = 1;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    x[i] = (seed / 2 ** 32 - 0.5) * 0.5;
  }
  const sh = new PitchShifter(SR, 2);
  sh.setSemitones(4);
  let starts = 0;
  let wasRunning = false;
  let maxBuffered = 0;
  run(sh, [x, x], {
    onBlock: (b, s) => {
      if (s.running && !wasRunning) starts++;
      wasRunning = s.running;
      if (b > 200) maxBuffered = Math.max(maxBuffered, s.inp.length + s.str.length + s.out.length);
      // 途中でキーを変えても止まらない
      if (b === 3000) s.setSemitones(-2);
      if (b === 5000) s.setSemitones(7);
    },
  });
  assert.equal(starts, 1, '途中で途切れた');
  assert.ok(maxBuffered < SR * 0.8, `ためている量 ${maxBuffered}`);
});

test('最初からやり直すと、ためた音を捨てる', () => {
  const sh = new PitchShifter(SR, 2);
  const x = sine(300, 1);
  run(sh, [x, x]);
  assert.ok(sh.running);
  sh.reset();
  assert.equal(sh.running, false);
  assert.equal(sh.inp.length + sh.str.length + sh.out.length, 0);
  const outL = new Float32Array(BLOCK);
  const outR = new Float32Array(BLOCK);
  sh.process([], [outL, outR], BLOCK);
  assert.ok(outL.every((v) => v === 0));
});
