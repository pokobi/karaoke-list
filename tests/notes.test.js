import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteName, parseNote, formatKey, keyTone, clampKey, recommendKey, NOTE_MAX } from '../js/notes.js';

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

test('おすすめキーは音域に収まる範囲で原曲キーに最も近いもの', () => {
  const n = parseNote;
  const voice = { low: n('lowG'), chestHigh: n('mid2G'), falsettoHigh: n('hiC') };
  // そのまま収まる
  assert.deepEqual(recommendKey({ low: n('mid1C'), chestHigh: n('mid2E'), falsettoHigh: null }, voice), { key: 0, fits: true, short: 0 });
  // 地声最高音が2つ高い（hiA は mid2G の半音2つ上）→ -2
  assert.equal(recommendKey({ low: n('mid1C'), chestHigh: n('hiA'), falsettoHigh: null }, voice).key, -2);
  // 裏声が高い → 裏声で決まる
  assert.equal(recommendKey({ low: n('mid1C'), chestHigh: n('mid2E'), falsettoHigh: n('hiE') }, voice).key, -4);
  // 低すぎる → 上げる
  assert.equal(recommendKey({ low: n('lowE'), chestHigh: n('mid1A'), falsettoHigh: null }, voice).key, 3);
  // 音域が広すぎて収まらない
  const r = recommendKey({ low: n('lowE'), chestHigh: n('hiA'), falsettoHigh: null }, voice);
  assert.equal(r.fits, false);
  assert.equal(r.short, 3 + 2);
  // 音域が未入力
  assert.equal(recommendKey({ low: null, chestHigh: null, falsettoHigh: null }, voice), null);
  // 自分の裏声が未登録なら、曲の裏声は地声最高音と比べる
  assert.equal(recommendKey({ low: null, chestHigh: null, falsettoHigh: n('hiA') }, { chestHigh: n('mid2G') }).key, -2);
  // 女性曲を男性の音域で：オク下付近まで下げる
  const male = { low: n('lowF'), chestHigh: n('mid2F'), falsettoHigh: n('hiA') };
  assert.equal(recommendKey({ low: n('mid1F'), chestHigh: n('hiD'), falsettoHigh: n('hiF') }, male).key, -9);
});
