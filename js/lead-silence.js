// 音楽ファイルの頭の無音を見つける。試聴で、そこを飛ばして再生するために使う（preview.js）。
// 完全な無音だけでなく、録音や動画から取った音によくある小さな雑音も、曲の中の大きな音よりずっと小さければ無音として扱う。

const WINDOW_SEC = 0.01; // この長さごとに音の大きさを測る
const QUIET_DB = -40; // その範囲でいちばん大きい所より、これだけ小さい音は無音として扱う
const FLOOR = 10 ** (-70 / 20); // これより小さい音は、いつでも無音として扱う
export const LEAD_MARGIN_SEC = 0.2; // 最初の音が欠けないよう、音が始まる少し前から再生する
export const LEAD_MIN_SEC = 0.5; // 飛ばす長さがこれより短いときは、飛ばさない

const SCAN_SEC = 60; // 頭のこの長さの中だけを調べる
const HEAD_BYTES = 3 * 1024 * 1024; // まずファイルの頭のこれだけを読む
const FULL_MAX_BYTES = 60 * 1024 * 1024; // 頭だけで分からなかったとき、ファイル全体を読むのはこの大きさまで
const DECODE_RATE = 22050; // 音の大きさを測るだけなので、細かさを落として読む（使うメモリを減らす）

/**
 * 頭の無音のあと、再生を始める位置（秒）を返す。飛ばさないときは 0、最後まで音がないときは null。
 * channels：チャンネル（左右など）ごとの音のデータ（Float32Array）
 */
export function leadSilenceEnd(channels, sampleRate) {
  const n = Math.min(...channels.map((c) => c.length));
  const win = Math.max(1, Math.round(sampleRate * WINDOW_SEC));
  const levels = [];
  for (let i = 0; i + win <= n; i += win) {
    let sum = 0;
    for (const c of channels) for (let k = i; k < i + win; k++) sum += c[k] * c[k];
    levels.push(Math.sqrt(sum / (win * channels.length)));
  }
  const peak = levels.reduce((a, b) => Math.max(a, b), 0);
  if (peak <= FLOOR) return null;
  const quiet = Math.max(FLOOR, peak * 10 ** (QUIET_DB / 20));
  const first = levels.findIndex((v) => v > quiet);
  const start = (first * win) / sampleRate - LEAD_MARGIN_SEC;
  return start < LEAD_MIN_SEC ? 0 : Math.round(start * 100) / 100;
}

// MP3 の頭にある曲の情報（ID3v2。ジャケット画像が入っていると大きい）のバイト数。ないときは 0
export function id3Size(bytes) {
  if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0;
  const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
  return 10 + size + (bytes[5] & 0x10 ? 10 : 0);
}

async function decodeStart(blob) {
  const ctx = new OfflineAudioContext(1, 1, DECODE_RATE);
  const ab = await ctx.decodeAudioData(await blob.arrayBuffer());
  const len = Math.min(ab.length, Math.round(SCAN_SEC * ab.sampleRate));
  const channels = [];
  for (let c = 0; c < ab.numberOfChannels; c++) channels.push(ab.getChannelData(c).subarray(0, len));
  return leadSilenceEnd(channels, ab.sampleRate);
}

/**
 * ファイル（Blob）の頭の無音のあと、再生を始める位置（秒）を調べる。飛ばさないとき・調べられなかったときは 0。
 * まずファイルの頭だけを読む（MP3 などはこれで分かる）。読めない形式（m4a など）や、その中に音がないときは、全体を読む。
 */
export async function findLeadSilence(blob) {
  if (typeof OfflineAudioContext !== 'function') return 0;
  const head = id3Size(new Uint8Array(await blob.slice(0, 10).arrayBuffer())) + HEAD_BYTES;
  if (blob.size > head) {
    try {
      const start = await decodeStart(blob.slice(0, head));
      if (start !== null) return start;
    } catch { /* 頭だけでは読めない形式。全体を読む */ }
  }
  if (blob.size > FULL_MAX_BYTES) return 0;
  try {
    return (await decodeStart(blob)) ?? 0;
  } catch {
    return 0;
  }
}
