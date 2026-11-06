import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNote as n } from '../js/notes.js';
import { normalizeSong } from '../js/model.js';
import { defaultRandomOptions, sanitizeRandomOptions, randomPool, pickRandom, fitsVoice } from '../js/random.js';

const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 6);
const songs = [
  { id: 'a', artist: 'ヨルシカ', title: 'A', tags: ['練習中'], favorite: true, low: n('mid1C'), chestHigh: n('mid2G'), key: 0, singCount: 10, lastSungAt: now - 2 * DAY },
  { id: 'b', artist: 'ヨルシカ', title: 'B', low: n('mid1C'), chestHigh: n('hiB'), key: -2, singCount: 0 },
  { id: 'c', artist: 'YOASOBI', title: 'C', tags: ['バラード'], low: n('mid1F'), chestHigh: n('hiD'), falsettoHigh: n('hiF'), key: 0 },
  { id: 'd', artist: 'スピッツ', title: 'D', key: 0, lastSungAt: now - 20 * DAY },
].map(normalizeSong);
const opts = (patch) => ({ ...defaultRandomOptions(), ...patch });
const ids = (list) => list.map((s) => s.id).sort().join('');
const voice = { low: n('lowG'), chestHigh: n('mid2G'), falsettoHigh: n('hiC') };

test('アーティスト・タグ・お気に入りで絞る', () => {
  assert.equal(ids(randomPool(songs, opts({ artists: ['ヨルシカ'] }))), 'ab');
  assert.equal(ids(randomPool(songs, opts({ artists: ['ヨルシカ', 'スピッツ'] }))), 'abd');
  assert.equal(ids(randomPool(songs, opts({ tags: ['練習中', 'バラード'] }))), 'ac');
  assert.equal(ids(randomPool(songs, opts({ favoriteOnly: true }))), 'a');
});

test('最近歌った曲を除く', () => {
  assert.equal(ids(randomPool(songs, opts({ excludeDays: 7 }), { now })), 'bcd');
  assert.equal(ids(randomPool(songs, opts({ excludeDays: 30 }), { now })), 'bc');
});

test('自分の音域で歌える曲だけ（今のキー／おすすめキー）', () => {
  // b は hiB を -2 して hiA。地声最高音 mid2G を超えるので今のキーでは歌えない
  assert.equal(fitsVoice(songs[1], voice, 'current'), false);
  // おすすめキーにすれば歌える（最低音 mid1C から lowG までは下げられる）
  assert.equal(fitsVoice(songs[1], voice, 'recommend'), true);
  assert.equal(ids(randomPool(songs, opts({ fitsVoice: true, fitsMode: 'current' }), { voice })), 'a');
  // c は最低音 mid1F〜裏声 hiF。おすすめキーにすると収まる
  assert.equal(ids(randomPool(songs, opts({ fitsVoice: true, fitsMode: 'recommend' }), { voice })), 'abc');
  // 音域が未入力の曲（d）は判断できないので含めない。自分の音域がなければ何も選ばない
  assert.equal(ids(randomPool(songs, opts({ fitsVoice: true }), { voice: {} })), '');
});

test('音域の高さで絞る（キー適用後の音で比べる）', () => {
  const range = { low: {}, chestHigh: { max: n('hiA') }, falsettoHigh: {} };
  assert.equal(ids(randomPool(songs, opts({ range }))), 'ab');
});

test('重複なしで指定した曲数を選び、足りなければあるだけ選ぶ', () => {
  const picked = pickRandom(songs, 3);
  assert.equal(picked.length, 3);
  assert.equal(new Set(picked.map((s) => s.id)).size, 3);
  assert.equal(pickRandom(songs, 10).length, 4);
  assert.deepEqual(pickRandom([], 3), []);
});

test('「もう一度」では、直前の曲をなるべく避ける', () => {
  for (let i = 0; i < 20; i++) {
    const p = pickRandom(songs, 2, { avoid: new Set(['a', 'b']) });
    assert.equal(ids(p), 'cd');
  }
  // 避けると足りないときは、避けた曲も使う
  assert.equal(pickRandom(songs, 4, { avoid: new Set(['a']) }).length, 4);
});

test('あまり歌っていない曲ほど選ばれやすい', () => {
  let rare = 0;
  let seq = 0;
  const rng = () => ((seq = (seq * 9301 + 49297) % 233280) / 233280);
  const pool = [songs[0], songs[1]]; // 10回歌った曲と、0回の曲
  for (let i = 0; i < 2000; i++) if (pickRandom(pool, 1, { weighted: true, rng })[0].id === 'b') rare++;
  assert.ok(rare > 1700, `0回の曲が選ばれた回数: ${rare}`);
});

test('保存された条件を、壊れていても安全に読み込む', () => {
  const o = sanitizeRandomOptions({ count: 7, excludeDays: 5, fitsMode: 'x', artists: ['A', 1] });
  assert.equal(o.count, 1);
  assert.equal(o.excludeDays, 0);
  assert.equal(o.fitsMode, 'recommend');
  assert.deepEqual(o.artists, ['A']);
});
