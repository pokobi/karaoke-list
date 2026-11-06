// 音の高さだけを変える処理（テンポは変えない）。AudioWorklet として読み込み、再生中の音に順にかける。
// 1) WSOLA：波形を少しずつずらして重ね、長さを「高さの比」倍に伸び縮みさせる
// 2) それを「高さの比」倍の速さで読み直す（窓関数つき sinc 補間）。長さが元に戻り、高さだけが変わる
// 処理の中身（PitchShifter）はテストからも読み込めるよう、AudioWorklet の外でも使える形にしている。

const ZEROS = 8; // sinc の片側の山の数
const OS = 512; // sinc の表の細かさ（山 1 つあたり）
const KERNEL = (() => {
  const n = ZEROS * OS + 2;
  const k = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i / OS;
    if (x >= ZEROS) continue;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const t = x / ZEROS;
    k[i] = sinc * (0.42 + 0.5 * Math.cos(Math.PI * t) + 0.08 * Math.cos(2 * Math.PI * t));
  }
  return k;
})();
const KERNEL_END = ZEROS * OS;

const OVERLAP_MS = 8;
const SEEK_MAX_MS = 25;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// チャンネルごとの先入れ先出しの入れ物
class Fifo {
  constructor(channels, capacity = 16384) {
    this.data = Array.from({ length: channels }, () => new Float32Array(capacity));
    this.start = 0;
    this.end = 0;
  }

  get length() {
    return this.end - this.start;
  }

  // 末尾に n 個書けるようにする
  reserve(n) {
    const cap = this.data[0].length;
    if (this.end + n <= cap) return;
    const len = this.length;
    if (len + n <= cap) {
      for (const d of this.data) d.copyWithin(0, this.start, this.end);
    } else {
      let next = cap * 2;
      while (next < len + n) next *= 2;
      this.data = this.data.map((d) => {
        const a = new Float32Array(next);
        a.set(d.subarray(this.start, this.end));
        return a;
      });
    }
    this.start = 0;
    this.end = len;
  }

  drop(n) {
    this.start += Math.min(n, this.length);
    if (this.start === this.end) this.start = this.end = 0;
  }

  clear() {
    this.start = this.end = 0;
  }
}

export class PitchShifter {
  constructor(sampleRate, channels = 2) {
    this.sr = sampleRate;
    this.ch = channels;
    this.ov = Math.max(16, Math.round((sampleRate * OVERLAP_MS) / 1000));
    const seekMax = Math.round((sampleRate * SEEK_MAX_MS) / 1000);
    this.mid = Array.from({ length: channels }, () => new Float32Array(this.ov));
    this.refMono = new Float32Array(this.ov);
    this.winMono = new Float32Array(seekMax + this.ov + 1);
    this.energy = new Float64Array(seekMax + this.ov + 2);
    this.inp = new Fifo(channels);
    this.str = new Fifo(channels);
    this.out = new Fifo(channels);
    this.setRatio(1);
    this.reset();
  }

  setSemitones(n) {
    this.setRatio(2 ** ((Number(n) || 0) / 12));
  }

  // r：高さの比（2 で 1 オクターブ上）
  setRatio(r) {
    const ratio = clamp(Number(r) || 1, 0.25, 4);
    const tempo = 1 / ratio;
    // 伸び縮みの量に合わせて、1 回に扱う長さと、ずらして探す幅を決める（SoundTouch の自動設定と同じ考え方）
    const seqMs = clamp(150 - 50 * tempo, 50, 125);
    const seekMs = clamp(28.333 - 6.667 * tempo, 15, SEEK_MAX_MS);
    this.ratio = ratio;
    this.seq = Math.round((this.sr * seqMs) / 1000);
    this.seek = Math.round((this.sr * seekMs) / 1000);
    this.nominalSkip = tempo * (this.seq - this.ov);
    this.sampleReq = Math.max(Math.floor(this.nominalSkip + 0.5) + this.ov, this.seq) + this.seek;
    // 速く読むとき（高くするとき）は、折り返しの雑音が出ないよう高い音を切る
    this.cut = Math.min(1, 1 / ratio);
    this.half = Math.ceil(ZEROS / this.cut);
    // 出力をため始めてから鳴らし始めるまでの量（1 回分の出力が来るまで途切れないように）
    this.prefill = Math.ceil((this.seq - this.ov) / ratio) + this.half + 512;
  }

  reset() {
    this.inp.clear();
    this.str.clear();
    this.out.clear();
    for (const m of this.mid) m.fill(0);
    this.begin = true;
    this.skipFract = 0;
    this.pos = 0;
    this.running = false;
  }

  // input：チャンネルごとの Float32Array（足りないチャンネルは 1 つ目を使い、なければ無音）
  // output：チャンネルごとの Float32Array。n 個ずつ書く
  process(input, output, n = output[0]?.length ?? 128) {
    const { inp, ch } = this;
    inp.reserve(n);
    for (let c = 0; c < ch; c++) {
      const src = input[c] ?? input[0];
      const dst = inp.data[c];
      if (src && src.length >= n) dst.set(src.length === n ? src : src.subarray(0, n), inp.end);
      else dst.fill(0, inp.end, inp.end + n);
    }
    inp.end += n;
    this.stretch();
    // 読み直しは、鳴らすのに必要な分だけ（1 回の処理に時間がかかりすぎないよう、少しずつ進める）
    this.resample(this.prefill + n - this.out.length);

    const out = this.out;
    if (!this.running && out.length >= this.prefill) this.running = true;
    const m = this.running ? Math.min(n, out.length) : 0;
    for (let c = 0; c < output.length; c++) {
      const dst = output[c];
      const src = out.data[Math.min(c, ch - 1)];
      if (m) dst.set(src.subarray(out.start, out.start + m));
      if (m < n) dst.fill(0, m, n);
    }
    out.drop(m);
    // 足りなくなったら、またためてから鳴らす
    if (this.running && m < n) this.running = false;
  }

  // 1) 長さを ratio 倍にする（WSOLA）
  stretch() {
    const { inp, str, ov, ch } = this;
    while (inp.length >= this.sampleReq) {
      let offset = 0;
      if (this.begin) {
        for (let c = 0; c < ch; c++) this.mid[c].set(inp.data[c].subarray(inp.start, inp.start + ov));
        this.begin = false;
      } else {
        offset = this.bestOffset();
      }
      const count = this.seq - ov;
      str.reserve(count);
      for (let c = 0; c < ch; c++) {
        const src = inp.data[c];
        const s0 = inp.start + offset;
        const dst = str.data[c];
        const m = this.mid[c];
        let d = str.end;
        for (let i = 0; i < ov; i++) {
          const t = i / ov;
          dst[d++] = src[s0 + i] * t + m[i] * (1 - t);
        }
        dst.set(src.subarray(s0 + ov, s0 + this.seq - ov), d);
        m.set(src.subarray(s0 + this.seq - ov, s0 + this.seq));
      }
      str.end += count;
      this.skipFract += this.nominalSkip;
      const skip = Math.floor(this.skipFract);
      this.skipFract -= skip;
      inp.drop(skip);
    }
  }

  // 前の区間の終わりと、いちばん自然につながる位置を探す（粗く探してから、近くを細かく）
  bestOffset() {
    const { inp, ov, seek, ch, refMono: ref, winMono: win, energy: P } = this;
    const len = seek + ov;
    const s = inp.start;
    for (let i = 0; i < len; i++) {
      let v = 0;
      for (let c = 0; c < ch; c++) v += inp.data[c][s + i];
      win[i] = v;
    }
    for (let i = 0; i < ov; i++) {
      let v = 0;
      for (let c = 0; c < ch; c++) v += this.mid[c][i];
      ref[i] = v;
    }
    P[0] = 0;
    for (let i = 0; i < len; i++) P[i + 1] = P[i] + win[i] * win[i];
    const score = (k) => {
      let corr = 0;
      for (let i = 0; i < ov; i++) corr += ref[i] * win[k + i];
      const norm = P[k + ov] - P[k];
      const v = corr / Math.sqrt(norm > 1e-9 ? norm : 1e-9);
      const t = (2 * k - seek) / seek;
      return (v + 0.1) * (1 - 0.25 * t * t);
    };
    let best = 0;
    let bestScore = -Infinity;
    for (let k = 0; k < seek; k += 4) {
      const v = score(k);
      if (v > bestScore) {
        bestScore = v;
        best = k;
      }
    }
    const lo = Math.max(0, best - 3);
    const hi = Math.min(seek - 1, best + 3);
    for (let k = lo; k <= hi; k++) {
      if (k === best) continue;
      const v = score(k);
      if (v > bestScore) {
        bestScore = v;
        best = k;
      }
    }
    return best;
  }

  // 2) ratio 倍の速さで読み直す（最大 limit 個）
  resample(limit) {
    const { str, out, ch, ratio, half, cut } = this;
    const avail = str.length;
    let pos = this.pos;
    if (limit <= 0 || Math.floor(pos) + half >= avail) return;
    const count = Math.min(limit, Math.ceil((avail - pos) / ratio) + 2);
    out.reserve(count);
    const base = str.start;
    const s0 = str.data[0];
    const s1 = ch > 1 ? str.data[1] : null;
    const o0 = out.data[0];
    const o1 = ch > 1 ? out.data[1] : null;
    const scale = OS * cut;
    let oe = out.end;
    const stop = oe + count;
    while (oe < stop) {
      const ip = Math.floor(pos);
      if (ip + half >= avail) break;
      let a0 = 0;
      let a1 = 0;
      const j0 = Math.max(0, ip - half + 1);
      for (let j = j0; j <= ip + half; j++) {
        const u = Math.abs(pos - j) * scale;
        const i = u | 0;
        if (i >= KERNEL_END) continue;
        const w = KERNEL[i] + (u - i) * (KERNEL[i + 1] - KERNEL[i]);
        a0 += s0[base + j] * w;
        if (s1) a1 += s1[base + j] * w;
      }
      o0[oe] = a0 * cut;
      if (o1) o1[oe] = a1 * cut;
      oe++;
      pos += ratio;
    }
    out.end = oe;
    const drop = Math.floor(pos) - half;
    if (drop > 0) {
      str.drop(drop);
      pos -= drop;
    }
    this.pos = pos;
  }
}

if (typeof registerProcessor === 'function') {
  // キー（半音）は AudioParam の semitones で受け取る。ためた音を捨てるときは port に { type: 'reset' } を送る
  registerProcessor('pitch-shift', class extends AudioWorkletProcessor {
    static get parameterDescriptors() {
      return [{ name: 'semitones', defaultValue: 0, minValue: -24, maxValue: 24, automationRate: 'k-rate' }];
    }

    constructor() {
      super();
      this.shifter = new PitchShifter(sampleRate, 2);
      this.semitones = 0;
      this.port.onmessage = (e) => {
        if (e.data?.type === 'reset') this.shifter.reset();
      };
    }

    process(inputs, outputs, parameters) {
      const semis = Math.round(parameters.semitones?.[0] ?? 0);
      if (semis !== this.semitones) {
        this.semitones = semis;
        this.shifter.setSemitones(semis);
      }
      const out = outputs[0];
      if (out?.length) this.shifter.process(inputs[0] ?? [], out, out[0].length);
      return true;
    }
  });
}
