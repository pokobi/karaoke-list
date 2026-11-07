// マイクの音から、歌っている音の高さを調べる（自分の音域をマイクで測るときに使う）。
// 音の高さの検出は YIN 法（波形を少しずらして重ね、いちばんよく重なるずれ＝1 周期を探す）。

import { NOTE_MIN, NOTE_MAX } from './notes.js';

// 調べる高さの範囲（Hz）。人の声の最低音（2 オクターブ下のド付近）から、裏声の高い音までを含める
export const MIN_HZ = 60;
export const MAX_HZ = 1400;

// 波形 buf（-1〜1）から音の高さを調べる。戻り値：{ hz, clarity（0〜1。1 に近いほどはっきりした音） } か、
// 声が小さい・音の高さがはっきりしないときは null
export function detectPitch(buf, sampleRate, { minHz = MIN_HZ, maxHz = MAX_HZ, threshold = 0.15, minRms = 0.01 } = {}) {
  const n = buf.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += buf[i] * buf[i];
  if (Math.sqrt(sum / n) < minRms) return null;
  const tauMin = Math.max(2, Math.floor(sampleRate / maxHz));
  const tauMax = Math.min(Math.floor(n / 2), Math.ceil(sampleRate / minHz));
  const w = n - tauMax;
  if (tauMax <= tauMin || w <= 0) return null;
  // 差分関数と、その累積平均で割った値（cmnd）
  const cmnd = new Float32Array(tauMax + 1);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    let d = 0;
    for (let i = 0; i < w; i++) {
      const diff = buf[i] - buf[i + tau];
      d += diff * diff;
    }
    running += d;
    cmnd[tau] = running ? (d * tau) / running : 1;
  }
  // しきい値を下回った最初の谷（いちばん短い周期）を選ぶ。1 オクターブ下と取り違えにくい
  let tau = -1;
  for (let t = tauMin; t <= tauMax; t++) {
    if (cmnd[t] < threshold) {
      while (t + 1 <= tauMax && cmnd[t + 1] < cmnd[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) return null;
  // 前後の値から放物線で補間して、周期を細かく求める
  let better = tau;
  if (tau > 1 && tau < tauMax) {
    const a = cmnd[tau - 1];
    const b = cmnd[tau];
    const c = cmnd[tau + 1];
    const den = a + c - 2 * b;
    if (den) better = tau + (a - c) / (2 * den);
  }
  const hz = sampleRate / better;
  if (hz < minHz || hz > maxHz) return null;
  return { hz, clarity: 1 - cmnd[tau] };
}

// 周波数を、アプリの音階の値（lowA = 0 から半音ごとに 1）にする。小数のまま返す（四捨五入はしない）。
// lowA は A1（55Hz）
export function hzToNoteValue(hz) {
  return 12 * Math.log2(hz / 55);
}

// 音階の値が、アプリで扱える範囲（lowA〜hihiG#）に入っているか
export const inNoteRange = (v) => Number.isFinite(v) && Math.round(v) >= NOTE_MIN && Math.round(v) <= NOTE_MAX;

// 同じ高さで holdMs 以上伸ばした音のうち、いちばん低い（mode: 'low'）／高い（'high'）音を記録する。
// ・ビブラートで少し揺れても同じ音とみなす（いまの音から ±0.7 半音以内）
// ・短い途切れ（gapMs 以内）は続いているとみなす
// feed(v, t)：v は音階の値（小数）か null（声がない）、t はミリ秒。戻り値：{ note（いま伸ばしている音）, held（伸ばした割合 0〜1）, best（記録） }
export function createRangeTracker({ mode = 'high', holdMs = 400, gapMs = 150, wobble = 0.7 } = {}) {
  let run = null; // { note, start, last }
  let best = null;
  const better = (a, b) => (b == null ? true : mode === 'low' ? a < b : a > b);
  return {
    feed(v, t) {
      if (v == null || !Number.isFinite(v)) {
        if (run && t - run.last > gapMs) run = null;
      } else if (run && Math.abs(v - run.note) <= wobble) {
        run.last = t;
      } else {
        run = { note: Math.round(v), start: t, last: t };
      }
      const held = run ? Math.min(1, (run.last - run.start) / holdMs) : 0;
      if (run && held >= 1 && better(run.note, best)) best = run.note;
      return { note: run ? run.note : null, held, best };
    },
    get best() { return best; },
    reset() {
      run = null;
      best = null;
    },
  };
}
