import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNote as n } from '../js/notes.js';
import { normalizeSong, applyView, defaultView, sanitizeView, suggestArtists, allTags, toPayload, dupKey } from '../js/model.js';

const songs = [
  { id: 'a', artist: 'ソラシド', title: '夜明けのワルツ', low: n('mid1C'), chestHigh: n('hiA'), falsettoHigh: n('hiC'), key: -3, tags: ['バラード'], createdAt: 3, singCount: 4 },
  { id: 'b', artist: 'Blue Harbor', title: 'Daybreak', low: n('mid1A'), chestHigh: n('hiB'), falsettoHigh: null, key: 0, favorite: true, createdAt: 2 },
  { id: 'c', artist: 'ソラシド', title: '花火の夜', low: n('lowG'), chestHigh: n('mid2G'), falsettoHigh: n('hiD'), key: 0, createdAt: 1, memo: 'サビ注意' },
  { id: 'd', artist: 'スピッツ', title: 'チェリー', low: null, chestHigh: null, falsettoHigh: null, key: 2, createdAt: 4 },
].map(normalizeSong);

const view = (patch = {}) => ({ ...defaultView(), ...patch });
const ids = (list) => list.map((s) => s.id).join(',');

test('検索はひらがな・カタカナや全角半角の違いを吸収する', () => {
  assert.deepEqual(applyView(songs, view(), 'そらしど').map((s) => s.id).sort(), ['a', 'c']);
  assert.deepEqual(applyView(songs, view(), 'ＤＡＹＢＲＥＡＫ').map((s) => s.id), ['b']);
  assert.deepEqual(applyView(songs, view(), 'サビ').map((s) => s.id), ['c']);
  assert.deepEqual(applyView(songs, view(), 'ソラシド 花').map((s) => s.id), ['c']);
});

test('アーティスト・タグ・お気に入りで絞り込める', () => {
  assert.deepEqual(applyView(songs, view({ artists: ['ソラシド'] }), '').map((s) => s.id).sort(), ['a', 'c']);
  // アーティストは何組でも選べる（どれかの曲を出す）
  assert.deepEqual(applyView(songs, view({ artists: ['ソラシド', 'スピッツ'] }), '').map((s) => s.id).sort(), ['a', 'c', 'd']);
  // 以前の版で保存した 1 組だけの絞り込み（artist）も引き継ぐ
  assert.deepEqual(sanitizeView({ artist: 'ソラシド' }).artists, ['ソラシド']);
  assert.deepEqual(sanitizeView({ artists: ['A', 'A', 1, ''] }).artists, ['A']);
  assert.deepEqual(sanitizeView({}).artists, []);
  assert.deepEqual(applyView(songs, view({ tags: ['バラード'] }), '').map((s) => s.id), ['a']);
  assert.deepEqual(applyView(songs, view({ favoriteOnly: true }), '').map((s) => s.id), ['b']);
});

test('除くタグが付いている曲は一覧に出さない', () => {
  assert.deepEqual(applyView(songs, view({ exTags: ['バラード'] }), '').map((s) => s.id).sort(), ['b', 'c', 'd']);
  assert.deepEqual(applyView(songs, view({ artists: ['ソラシド'], exTags: ['バラード'] }), '').map((s) => s.id), ['c']);
  assert.deepEqual(sanitizeView({ exTags: ['バラード', 1] }).exTags, ['バラード']);
  assert.deepEqual(sanitizeView({}).exTags, []);
});

test('音域の絞り込みはキー適用後と原曲を切り替えられる', () => {
  const range = { low: {}, chestHigh: { max: n('mid2G#') }, falsettoHigh: {} };
  // a は hiA だが -3 で mid2F# になる
  assert.deepEqual(applyView(songs, view({ range }), '').map((s) => s.id).sort(), ['a', 'c']);
  assert.deepEqual(applyView(songs, view({ range, basis: 'original' }), '').map((s) => s.id), ['c']);
  // 裏声なしの曲は「裏声最高音が○○以下」に含まれる
  const fr = { low: {}, chestHigh: {}, falsettoHigh: { max: n('hiC') } };
  assert.deepEqual(applyView(songs, view({ range: fr, basis: 'original' }), '').map((s) => s.id).sort(), ['a', 'b', 'd']);
  // 下限を指定すると裏声なしの曲は外れる
  const fr2 = { low: {}, chestHigh: {}, falsettoHigh: { min: n('hiC') } };
  assert.deepEqual(applyView(songs, view({ range: fr2, basis: 'original' }), '').map((s) => s.id).sort(), ['a', 'c']);
});

test('並び替え：値のない曲は常に最後', () => {
  assert.equal(ids(applyView(songs, view({ sortBy: 'createdAt', sortDir: 'desc' }), '')), 'd,a,b,c');
  assert.equal(ids(applyView(songs, view({ sortBy: 'chestHigh', sortDir: 'asc', basis: 'original' }), '')), 'c,a,b,d');
  assert.equal(ids(applyView(songs, view({ sortBy: 'chestHigh', sortDir: 'desc', basis: 'original' }), '')), 'b,a,c,d');
  // キー適用後：a は hiA-3 = mid2F#
  assert.equal(ids(applyView(songs, view({ sortBy: 'chestHigh', sortDir: 'asc' }), '')), 'a,c,b,d');
  assert.equal(ids(applyView(songs, view({ sortBy: 'singCount', sortDir: 'desc' }), '')).split(',')[0], 'a');
});

test('壊れた保存値から表示設定を復元する', () => {
  const v = sanitizeView({ sortBy: 'nope', basis: 'x', tags: 'a', range: { low: { min: 'x' } } });
  assert.equal(v.sortBy, 'createdAt');
  assert.equal(v.basis, 'current');
  assert.deepEqual(v.tags, []);
  assert.equal(v.range.low.min, undefined);
});

test('アーティスト候補は前方一致を優先し、曲数の多い順', () => {
  const names = ['ソラシド', 'Blue Harbor', 'スピッツ', 'ソラマメ'];
  assert.deepEqual(suggestArtists(names, songs, 'そ'), ['ソラシド', 'ソラマメ']);
  assert.deepEqual(suggestArtists(names, songs, 'harbor'), ['Blue Harbor']);
  assert.equal(suggestArtists(names, songs, '')[0], 'ソラシド');
  assert.deepEqual(suggestArtists(names, songs, 'ソラシド'), []);
});

test('保存用データと重複判定', () => {
  const p = toPayload(songs[0]);
  assert.equal('id' in p, false);
  assert.equal('_search' in p, false);
  assert.equal(p.key, -3);
  assert.equal(dupKey({ artist: 'ｿﾗｼﾄﾞ', title: '夜明けのワルツ ' }), dupKey(songs[0]));
  assert.deepEqual(allTags(songs), ['練習中', 'バラード']);
});

test('曲のタグを、タグの管理の並びの順に並べる（並びにないタグは後ろ）', async () => {
  const { orderTags } = await import('../js/model.js');
  const order = new Map(['練習中', 'A', 'B', 'C'].map((t, i) => [t, i]));
  assert.deepEqual(orderTags(['C', '練習中', 'その他', 'A'], order), ['練習中', 'A', 'C', 'その他']);
  assert.deepEqual(orderTags(['x', 'y'], order), ['x', 'y']);
});
