// 試聴で飛ばす、音楽ファイルの頭の無音の見つけ方
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leadSilenceEnd, id3Size } from '../js/lead-silence.js';

const RATE = 8000;

// [秒, 大きさ（0〜1）] の並びから、音のデータを作る（大きさ 0 は完全な無音）
function wave(parts) {
  const out = [];
  for (const [sec, amp] of parts) {
    for (let i = 0; i < Math.round(sec * RATE); i++) out.push(amp * Math.sin((2 * Math.PI * 440 * out.length) / RATE));
  }
  return Float32Array.from(out);
}
const dB = (v) => 10 ** (v / 20);

test('頭の無音のあと、音が始まる少し前から再生する', () => {
  assert.equal(leadSilenceEnd([wave([[3, 0], [5, 0.5]])], RATE), 2.8);
  assert.equal(leadSilenceEnd([wave([[1.5, 0], [5, 0.5]])], RATE), 1.3);
});

test('曲よりずっと小さい雑音は、無音として扱う', () => {
  assert.equal(leadSilenceEnd([wave([[2, 0.5 * dB(-55)], [5, 0.5]])], RATE), 1.8);
});

test('小さい音で始まる曲（曲の中のいちばん大きい音の 1/100 より大きい）は、無音として扱わない', () => {
  assert.equal(leadSilenceEnd([wave([[4, 0.5 * dB(-30)], [5, 0.5]])], RATE), 0);
});

test('頭から音がある曲や、短い無音は飛ばさない', () => {
  assert.equal(leadSilenceEnd([wave([[5, 0.5]])], RATE), 0);
  assert.equal(leadSilenceEnd([wave([[0.6, 0], [5, 0.5]])], RATE), 0);
});

test('片方のチャンネルだけに音があっても、そこで音が始まったとみなす', () => {
  const left = wave([[5, 0]]);
  const right = wave([[2, 0], [3, 0.5]]);
  assert.equal(leadSilenceEnd([left, right], RATE), 1.8);
});

test('最後まで音がないときは null', () => {
  assert.equal(leadSilenceEnd([wave([[3, 0]])], RATE), null);
  assert.equal(leadSilenceEnd([wave([[3, dB(-80)]])], RATE), null);
});

test('MP3 の頭にある曲の情報（ID3v2）の大きさを読む', () => {
  // 大きさは 7 ビットずつ 4 バイトに分けて書いてある：0x01 0x00 0x02 0x05 → 2^21 + 2*128 + 5
  const head = [0x49, 0x44, 0x33, 4, 0, 0, 0x01, 0x00, 0x02, 0x05];
  assert.equal(id3Size(Uint8Array.from(head)), 10 + 2 ** 21 + 256 + 5);
  // 後ろにもう 10 バイトある印（フッター）
  assert.equal(id3Size(Uint8Array.from([0x49, 0x44, 0x33, 4, 0, 0x10, 0, 0, 0, 0x10])), 10 + 16 + 10);
  assert.equal(id3Size(Uint8Array.from([0xff, 0xfb, 0x90, 0, 0, 0, 0, 0, 0, 0])), 0);
  assert.equal(id3Size(new Uint8Array(3)), 0);
});
