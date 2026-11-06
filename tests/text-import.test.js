import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLines, splitLine, analyzeLine, aliasMap, scoreSongs, mergeCandidates, judge, fallbackTerms,
  guessSong, aliasToLearn, sanitizeAliases, looseKey,
} from '../js/text-import.js';

const song = (artist, title, album = '') => ({ artist, title, album, artwork: 'https://example.com/a.jpg' });
const run = (line, results, opts) => {
  const info = analyzeLine(line, opts);
  return { info, ...judge(mergeCandidates(scoreSongs(results, info)), info) };
};

test('テキストを行に分け、箇条書きの記号・空行・同じ行を除く', () => {
  const text = '・ソラシド - サマーレター\n\n1. Blue Harbor - Lighthouse\n- sky lantern - 白い街\n　ソラシド　-　サマーレター　\n[ ] つきあかり / LUMINA\r\n★ミスチル 風の便り';
  assert.deepEqual(parseLines(text), ['ソラシド - サマーレター', 'Blue Harbor - Lighthouse', 'sky lantern - 白い街', 'つきあかり / LUMINA', 'ミスチル 風の便り']);
});

test('いろいろな区切りで 2 つに分ける', () => {
  assert.deepEqual(splitLine('ソラシド - サマーレター').parts, ['ソラシド', 'サマーレター']);
  assert.deepEqual(splitLine('ミスチル / 風の便り').parts, ['ミスチル', '風の便り']);
  assert.deepEqual(splitLine('ミスチル／風の便り').parts, ['ミスチル', '風の便り']);
  assert.deepEqual(splitLine('ソラシド\tサマーレター').parts, ['ソラシド', 'サマーレター']);
  assert.deepEqual(splitLine('ソラシド：サマーレター').parts, ['ソラシド', 'サマーレター']);
  assert.deepEqual(splitLine('ソラシド「サマーレター」'), { parts: ['ソラシド', 'サマーレター'], title: 1 });
  assert.deepEqual(splitLine('ASIAN KUNG-FU GENERATION - リライト').parts, ['ASIAN KUNG-FU GENERATION', 'リライト']);
  assert.deepEqual(splitLine('サマーレター（ソラシド）').parts, ['サマーレター', 'ソラシド']);
  assert.equal(splitLine('skylantern 白い街'), null);
});

test('「アーティスト - 曲名」はほぼ確実と判定する', () => {
  const r = run('ソラシド - サマーレター', [song('ソラシド', '花火の夜'), song('ソラシド', 'サマーレター'), song('ソラシド', 'サマーレター (Live)')]);
  assert.equal(r.status, 'sure');
  assert.equal(r.pick.song.title, 'サマーレター');
});

test('曲名とアーティスト名が逆でも判定できる', () => {
  const r = run('つきあかり - LUMINA', [song('LUMINA', 'つきあかり'), song('sky lantern', 'つきあかり')]);
  assert.equal(r.status, 'sure');
  assert.equal(r.pick.song.artist, 'LUMINA');
});

test('区切りがなく、空白のないアーティスト名でも判定できる', () => {
  const r = run('skylantern 白い街', [song('sky lantern', '白い街'), song('sky lantern', '雨の日')]);
  assert.equal(r.status, 'sure');
  assert.equal(r.pick.song.title, '白い街');
});

test('よく使われる略称は、正式な名前で検索して確実と判定する', () => {
  const r = run('ミスチル / 風の便り', [song('Mr.Children', '風の便り'), song('ミナト', '風の便り')]);
  assert.equal(r.info.term, 'Mr.Children 風の便り');
  assert.equal(r.status, 'sure');
  assert.equal(r.pick.song.artist, 'Mr.Children');
  assert.equal(run('ミスチル 風の便り', [song('Mr.Children', '風の便り')]).status, 'sure');
});

test('曲名だけの行や、知らない略称は要確認にする', () => {
  const only = run('白い街', [song('sky lantern', '白い街'), song('ミナト', '白い街')]);
  assert.equal(only.status, 'check');
  assert.equal(only.pick.song.artist, 'sky lantern');
  assert.equal(only.candidates.length, 2);
  const unknown = run('スカラン / 白い街', [song('sky lantern', '白い街'), song('ミナト', '白い街')]);
  assert.equal(unknown.status, 'check');
});

test('同じくらい合う別のアーティストの曲があれば要確認にする', () => {
  const r = run('白い街', [song('A', '白い街'), song('B', '白い街')]);
  assert.equal(r.status, 'check');
});

test('合う曲がなければ見つからないとし、行から見当を付ける', () => {
  const r = run('てすとあーてぃすと - まぼろしの曲', [song('ソラシド', '花火の夜')]);
  assert.equal(r.status, 'none');
  assert.equal(r.pick, null);
  assert.deepEqual(guessSong(r.info), { artist: 'てすとあーてぃすと', title: 'まぼろしの曲' });
  assert.deepEqual(fallbackTerms(r.info), ['てすとあーてぃすと', 'まぼろしの曲']);
  assert.deepEqual(fallbackTerms(analyzeLine('スカラン 白い街')), ['白い街', 'スカラン']);
  // 曲名の一部が同じだけの曲は採らない
  assert.equal(run('てすとあーてぃすと - まぼろしの曲', [song('吉野裕行', 'まぼろし')]).status, 'none');
  assert.equal(run('てすとあーてぃすと まぼろしの曲', [song('吉野裕行', 'まぼろし')]).status, 'none');
});

test('区切りがなくても、語のまとまりで曲名・アーティスト名を見分ける', () => {
  assert.equal(run('ソラシド 花火の夜', [song('ソラシド', '花火の夜')]).status, 'sure');
  assert.equal(run('Blue Harbor Lighthouse', [song('Blue Harbor', 'Lighthouse')]).status, 'sure');
  // 「KUNG-FU」のハイフンで分けてしまっても当たる
  assert.equal(run('ASIAN KUNG-FU GENERATION リライト', [song('ASIAN KUNG-FU GENERATION', 'リライト')]).status, 'sure');
  assert.equal(run('中島みゆき 糸', [song('中島みゆき', '糸'), song('中島みゆき', '時代')]).pick.song.title, '糸');
  assert.equal(run('スカラン 白い街', [song('sky lantern', '白い街')]).status, 'check');
});

test('ライブ版・インスト版より、元の版を選ぶ', () => {
  const r = run('sky lantern 白い街', [song('sky lantern', '白い街 (instrumental)'), song('sky lantern', '白い街', 'ベスト')]);
  assert.equal(r.pick.song.title, '白い街');
});

test('選び直したアーティスト名から略称を覚える。覚えた略称は次から使う', () => {
  const info = analyzeLine('スカラン / 白い街');
  assert.deepEqual(aliasToLearn(info, 'sky lantern', '白い街'), [looseKey('スカラン'), 'sky lantern']);
  // 行に書いたアーティスト名どおりなら覚えない
  assert.equal(aliasToLearn(analyzeLine('sky lantern / 白い街'), 'sky lantern', '白い街'), null);
  const learned = sanitizeAliases({ [looseKey('スカラン')]: 'sky lantern', 'Bad Key': 'x', [looseKey('a')]: '' });
  assert.deepEqual(Object.keys(learned), [looseKey('スカラン')]);
  const r = run('スカラン 白い街', [song('sky lantern', '白い街'), song('ミナト', '白い街')], { aliases: aliasMap(learned) });
  assert.equal(r.info.term, 'sky lantern 白い街');
  assert.equal(r.status, 'sure');
});

test('登録済みのアーティスト名を手がかりに、見つからない行の向きを決める', () => {
  const info = analyzeLine('まぼろしの曲 - ソラシド', { knownArtists: new Map([[looseKey('ソラシド'), 'ソラシド']]) });
  assert.deepEqual(guessSong(info), { artist: 'ソラシド', title: 'まぼろしの曲' });
});
