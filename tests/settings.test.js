import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNote as n, scientificName, recommendKey } from '../js/notes.js';
import { normalizeSong, allTags, tagCounts, sanitizePrefs } from '../js/model.js';
import { fitsVoice } from '../js/random.js';
import { setNoteStyle, fmtNote, fmtNoteHTML } from '../js/display.js';

test('G4 形式の表記（中央のドが C4。A・A#・B は 1 つ下の番号）', () => {
  assert.equal(scientificName(n('mid1G')), 'G3');
  assert.equal(scientificName(n('mid2C')), 'C4');
  assert.equal(scientificName(n('mid2G')), 'G4');
  assert.equal(scientificName(n('hiA')), 'A4');
  assert.equal(scientificName(n('hiF')), 'F5');
  assert.equal(scientificName(n('lowG')), 'G2');
  assert.equal(scientificName(n('mid1A')), 'A2');
  assert.equal(scientificName(n('hihiC')), 'C6');
});

test('音域の表記の切り替え', () => {
  setNoteStyle('scientific');
  assert.equal(fmtNote(n('mid2G')), 'G4');
  setNoteStyle('both');
  assert.equal(fmtNote(n('mid2G')), 'mid2G');
  assert.equal(fmtNoteHTML(n('mid2G')), 'mid2G<small class="sci">G4</small>');
  setNoteStyle('karaoke');
  assert.equal(fmtNoteHTML(n('mid2G')), 'mid2G');
});

test('おすすめキーの余裕（既定は2半音）を変えると、その分だけキーが変わる', () => {
  const voice = { low: n('lowG'), chestHigh: n('mid2G'), falsettoHigh: n('hiC') };
  const song = { low: n('mid1C'), chestHigh: n('hiA'), falsettoHigh: null };
  assert.equal(recommendKey(song, voice).key, -4);
  assert.equal(recommendKey(song, voice, { offset: 0 }).key, -2);
  assert.equal(recommendKey(song, voice, { offset: 3 }).key, -5);
  // 今のキーで歌えるかは、自分の音域そのもので判定する
  assert.equal(fitsVoice(normalizeSong({ ...song, key: -2 }), voice, 'current'), true);
  assert.equal(fitsVoice(normalizeSong({ ...song, key: -1 }), voice, 'current'), false);
});

test('タグの一覧は、設定で並べた順を先に、曲にだけ付いているタグを後に並べる', () => {
  const songs = [{ tags: ['バラード', '練習中'] }, { tags: ['アニソン'] }].map(normalizeSong);
  assert.deepEqual(allTags(songs), ['練習中', 'アニソン', 'バラード']);
  assert.deepEqual(allTags(songs, ['バラード', '盛り上がる']), ['バラード', '盛り上がる', 'アニソン', '練習中']);
  assert.deepEqual(allTags(songs, []), ['アニソン', 'バラード', '練習中']);
  assert.deepEqual([...tagCounts(songs)], [['バラード', 1], ['練習中', 1], ['アニソン', 1]]);
});

test('アカウント共通の表示設定を、壊れていても安全に読み込む', () => {
  assert.deepEqual(sanitizePrefs(undefined), { accent: 'indigo', noteStyle: 'karaoke', recOffset: 2, recUp: true, rangeAuto: true });
  assert.deepEqual(sanitizePrefs({ accent: 'teal', noteStyle: 'both', recOffset: 3, recUp: false, rangeAuto: false }), { accent: 'teal', noteStyle: 'both', recOffset: 3, recUp: false, rangeAuto: false });
  assert.deepEqual(sanitizePrefs({ accent: 'black', noteStyle: 'x', recOffset: 9, rangeAuto: 'no' }), { accent: 'indigo', noteStyle: 'karaoke', recOffset: 2, recUp: true, rangeAuto: true });
  // 以前の「余裕」（意味が違う）は引き継がない
  assert.equal(sanitizePrefs({ recMargin: 0 }).recOffset, 2);
});
