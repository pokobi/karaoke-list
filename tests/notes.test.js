import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteName, parseNote, formatKey, keyTone, clampKey, recommendKey, rangeIssues, NOTE_MAX } from '../js/notes.js';

test('音階の表記と番号を相互に変換できる', () => {
  assert.equal(noteName(0), 'lowA');
  assert.equal(noteName(3), 'lowC');
  assert.equal(noteName(11), 'lowG#');
  assert.equal(noteName(12), 'mid1A');
  assert.equal(noteName(24), 'mid2A');
  assert.equal(noteName(36), 'hiA');
  assert.equal(noteName(NOTE_MAX), 'hihiG#');
  for (let i = -24; i <= NOTE_MAX + 24; i++) assert.equal(parseNote(noteName(i)), i, noteName(i));
});

test('選択肢の範囲外は lowlow / hihihi と表記する', () => {
  assert.equal(noteName(-1), 'lowlowG#');
  assert.equal(noteName(-12), 'lowlowA');
  assert.equal(noteName(-13), 'lowlowlowG#');
  assert.equal(noteName(60), 'hihihiA');
});

test('入力の揺れを吸収して音階を読み取る', () => {
  assert.equal(parseNote(' ｈｉＡ＃ '), parseNote('hiA#'));
  assert.equal(parseNote('mid2g'), parseNote('mid2G'));
  assert.equal(parseNote('hiC♯'), parseNote('hiC#'));
  assert.equal(parseNote('hiB#'), null);
  assert.equal(parseNote('mid3A'), null);
  assert.equal(parseNote(''), null);
});

test('キーの表記と色', () => {
  assert.equal(formatKey(0), '±0');
  assert.equal(formatKey(3), '+3');
  assert.equal(formatKey(-2), '−2');
  assert.equal(formatKey(-12), '−12');
  assert.equal(formatKey(-13), '−13');
  assert.equal(keyTone(1), 'up');
  assert.equal(keyTone(-12), 'down');
  assert.equal(keyTone(0), 'zero');
  assert.equal(clampKey(99), 24);
  assert.equal(clampKey(-99), -24);
});

test('上げるおすすめを出さない設定では、原曲より高くするおすすめは原キーにする', () => {
  const n = parseNote;
  const voice = { low: n('lowG'), chestHigh: n('mid2G'), falsettoHigh: n('hiC') };
  // 本来は +5 → 原キー。そのキーで超える音は原キーで調べ直す
  const r = recommendKey({ low: n('lowE'), chestHigh: n('mid2C'), falsettoHigh: null }, voice, { allowUp: false });
  assert.equal(r.key, 0);
  assert.deepEqual(r.issues, [{ field: 'low', by: 3 }]);
  // 下げるおすすめ（オク下で歌うものも含む）は、そのまま
  assert.equal(recommendKey({ low: n('mid1C'), chestHigh: n('hiA'), falsettoHigh: null }, voice, { allowUp: false }).key, -4);
  const male = { low: n('lowF'), chestHigh: n('mid2F'), falsettoHigh: n('hiA') };
  assert.equal(recommendKey({ low: n('mid1F'), chestHigh: n('hiD'), falsettoHigh: n('hiF') }, male, { allowUp: false }).key, -11);
});

test('おすすめキーは、曲の地声最高音を自分の地声最高音の2半音下に合わせる', () => {
  const n = parseNote;
  const voice = { low: n('lowG'), chestHigh: n('mid2G'), falsettoHigh: n('hiC') };
  // 地声最高音 mid2E を mid2F（mid2G の2半音下）へ → +1
  assert.deepEqual(recommendKey({ low: n('mid1C'), chestHigh: n('mid2E'), falsettoHigh: null }, voice), { key: 1, basis: 'chestHigh', issues: [], fits: true });
  // hiA は mid2G の2半音上 → -4。余裕を 0 にすると -2
  assert.equal(recommendKey({ low: n('mid1C'), chestHigh: n('hiA'), falsettoHigh: null }, voice).key, -4);
  assert.equal(recommendKey({ low: n('mid1C'), chestHigh: n('hiA'), falsettoHigh: null }, voice, { offset: 0 }).key, -2);
  // 低い曲は上げる（mid2C を mid2F へ）
  assert.equal(recommendKey({ low: n('lowE'), chestHigh: n('mid2C'), falsettoHigh: null }, voice).key, 5);
  // そのキーで裏声最高音や最低音が自分の音域を超えるときは、その音と半音数を返す
  const f = recommendKey({ low: n('mid1C'), chestHigh: n('mid2E'), falsettoHigh: n('hiE') }, voice);
  assert.equal(f.key, 1);
  assert.equal(f.fits, false);
  assert.deepEqual(f.issues, [{ field: 'falsettoHigh', by: 5 }]);
  assert.deepEqual(recommendKey({ low: n('lowE'), chestHigh: n('hiA'), falsettoHigh: null }, voice).issues, [{ field: 'low', by: 7 }]);
  // 音域が未入力
  assert.equal(recommendKey({ low: null, chestHigh: null, falsettoHigh: null }, voice), null);
  // 地声最高音がなければ裏声最高音で合わせる（自分の裏声が未登録なら地声最高音と比べる）
  assert.equal(recommendKey({ low: null, chestHigh: null, falsettoHigh: n('hiA') }, { chestHigh: n('mid2G') }).key, -4);
  // 最低音しか分からなければ、最低音が出る範囲で原曲に近いキー
  assert.equal(recommendKey({ low: n('lowE'), chestHigh: null, falsettoHigh: null }, { low: n('lowG') }).key, 3);
  assert.equal(recommendKey({ low: n('mid1C'), chestHigh: null, falsettoHigh: null }, { low: n('lowG') }).key, 0);
  // 女性曲を男性の音域で
  const male = { low: n('lowF'), chestHigh: n('mid2F'), falsettoHigh: n('hiA') };
  assert.equal(recommendKey({ low: n('mid1F'), chestHigh: n('hiD'), falsettoHigh: n('hiF') }, male).key, -11);
});

test('今のキーで自分の音域を超える音', () => {
  const n = parseNote;
  const voice = { low: n('lowG'), chestHigh: n('mid2G') };
  const song = { low: n('lowE'), chestHigh: n('hiA'), falsettoHigh: n('hiC') };
  assert.deepEqual(rangeIssues(song, voice, 0), [{ field: 'low', by: 3 }, { field: 'chestHigh', by: 2 }, { field: 'falsettoHigh', by: 5 }]);
  assert.deepEqual(rangeIssues(song, voice, 3), [{ field: 'chestHigh', by: 5 }, { field: 'falsettoHigh', by: 8 }]);
  assert.deepEqual(rangeIssues(song, {}, 0), []);
});
