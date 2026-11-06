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
  const text = '・優里 - メリーゴーランド\n\n1. SEKAI NO OWARI - RPG\n- back number - ヒロイン\n　優里　-　メリーゴーランド　\n[ ] アンコール / YOASOBI\r\n★ミセス ライラック';
  assert.deepEqual(parseLines(text), ['優里 - メリーゴーランド', 'SEKAI NO OWARI - RPG', 'back number - ヒロイン', 'アンコール / YOASOBI', 'ミセス ライラック']);
});

test('いろいろな区切りで 2 つに分ける', () => {
  assert.deepEqual(splitLine('優里 - メリーゴーランド').parts, ['優里', 'メリーゴーランド']);
  assert.deepEqual(splitLine('ミセス / ライラック').parts, ['ミセス', 'ライラック']);
  assert.deepEqual(splitLine('ミセス／ライラック').parts, ['ミセス', 'ライラック']);
  assert.deepEqual(splitLine('優里\tメリーゴーランド').parts, ['優里', 'メリーゴーランド']);
  assert.deepEqual(splitLine('優里：メリーゴーランド').parts, ['優里', 'メリーゴーランド']);
  assert.deepEqual(splitLine('優里「メリーゴーランド」'), { parts: ['優里', 'メリーゴーランド'], title: 1 });
  assert.deepEqual(splitLine('ASIAN KUNG-FU GENERATION - リライト').parts, ['ASIAN KUNG-FU GENERATION', 'リライト']);
  assert.deepEqual(splitLine('メリーゴーランド（優里）').parts, ['メリーゴーランド', '優里']);
  assert.equal(splitLine('backnumber ヒロイン'), null);
});

test('「アーティスト - 曲名」はほぼ確実と判定する', () => {
  const r = run('優里 - メリーゴーランド', [song('優里', 'ドライフラワー'), song('優里', 'メリーゴーランド'), song('優里', 'メリーゴーランド (Live)')]);
  assert.equal(r.status, 'sure');
  assert.equal(r.pick.song.title, 'メリーゴーランド');
});

test('曲名とアーティスト名が逆でも判定できる', () => {
  const r = run('アンコール - YOASOBI', [song('YOASOBI', 'アンコール'), song('back number', 'アンコール')]);
  assert.equal(r.status, 'sure');
  assert.equal(r.pick.song.artist, 'YOASOBI');
});

test('区切りがなく、空白のないアーティスト名でも判定できる', () => {
  const r = run('backnumber ヒロイン', [song('back number', 'ヒロイン'), song('back number', 'HAPPY BIRTHDAY')]);
  assert.equal(r.status, 'sure');
  assert.equal(r.pick.song.title, 'ヒロイン');
});

test('よく使われる略称は、正式な名前で検索して確実と判定する', () => {
  const r = run('ミセス / ライラック', [song('Mrs. GREEN APPLE', 'ライラック'), song('美波', 'ライラック')]);
  assert.equal(r.info.term, 'Mrs. GREEN APPLE ライラック');
  assert.equal(r.status, 'sure');
  assert.equal(r.pick.song.artist, 'Mrs. GREEN APPLE');
  assert.equal(run('ミセス ライラック', [song('Mrs. GREEN APPLE', 'ライラック')]).status, 'sure');
});

test('曲名だけの行や、知らない略称は要確認にする', () => {
  const only = run('ヒロイン', [song('back number', 'ヒロイン'), song('絢香', 'ヒロイン')]);
  assert.equal(only.status, 'check');
  assert.equal(only.pick.song.artist, 'back number');
  assert.equal(only.candidates.length, 2);
  const unknown = run('ばくなん / ヒロイン', [song('back number', 'ヒロイン'), song('絢香', 'ヒロイン')]);
  assert.equal(unknown.status, 'check');
});

test('同じくらい合う別のアーティストの曲があれば要確認にする', () => {
  const r = run('ヒロイン', [song('A', 'ヒロイン'), song('B', 'ヒロイン')]);
  assert.equal(r.status, 'check');
});

test('合う曲がなければ見つからないとし、行から見当を付ける', () => {
  const r = run('てすとあーてぃすと - まぼろしの曲', [song('優里', 'ドライフラワー')]);
  assert.equal(r.status, 'none');
  assert.equal(r.pick, null);
  assert.deepEqual(guessSong(r.info), { artist: 'てすとあーてぃすと', title: 'まぼろしの曲' });
  assert.deepEqual(fallbackTerms(r.info), ['てすとあーてぃすと', 'まぼろしの曲']);
  assert.deepEqual(fallbackTerms(analyzeLine('ばくなん ヒロイン')), ['ヒロイン', 'ばくなん']);
  // 曲名の一部が同じだけの曲は採らない
  assert.equal(run('てすとあーてぃすと - まぼろしの曲', [song('吉野裕行', 'まぼろし')]).status, 'none');
  assert.equal(run('てすとあーてぃすと まぼろしの曲', [song('吉野裕行', 'まぼろし')]).status, 'none');
});

test('区切りがなくても、語のまとまりで曲名・アーティスト名を見分ける', () => {
  assert.equal(run('米津玄師 Lemon', [song('米津玄師', 'Lemon')]).status, 'sure');
  assert.equal(run('SEKAI NO OWARI RPG', [song('SEKAI NO OWARI', 'RPG')]).status, 'sure');
  // 「KUNG-FU」のハイフンで分けてしまっても当たる
  assert.equal(run('ASIAN KUNG-FU GENERATION リライト', [song('ASIAN KUNG-FU GENERATION', 'リライト')]).status, 'sure');
  assert.equal(run('中島みゆき 糸', [song('中島みゆき', '糸'), song('中島みゆき', '時代')]).pick.song.title, '糸');
  assert.equal(run('ばくなん ヒロイン', [song('back number', 'ヒロイン')]).status, 'check');
});

test('ライブ版・インスト版より、元の版を選ぶ', () => {
  const r = run('back number ヒロイン', [song('back number', 'ヒロイン (instrumental)'), song('back number', 'ヒロイン', 'アンコール')]);
  assert.equal(r.pick.song.title, 'ヒロイン');
});

test('選び直したアーティスト名から略称を覚える。覚えた略称は次から使う', () => {
  const info = analyzeLine('ばくなん / ヒロイン');
  assert.deepEqual(aliasToLearn(info, 'back number', 'ヒロイン'), [looseKey('ばくなん'), 'back number']);
  // 行に書いたアーティスト名どおりなら覚えない
  assert.equal(aliasToLearn(analyzeLine('back number / ヒロイン'), 'back number', 'ヒロイン'), null);
  const learned = sanitizeAliases({ [looseKey('ばくなん')]: 'back number', 'Bad Key': 'x', [looseKey('a')]: '' });
  assert.deepEqual(Object.keys(learned), [looseKey('ばくなん')]);
  const r = run('ばくなん ヒロイン', [song('back number', 'ヒロイン'), song('絢香', 'ヒロイン')], { aliases: aliasMap(learned) });
  assert.equal(r.info.term, 'back number ヒロイン');
  assert.equal(r.status, 'sure');
});

test('登録済みのアーティスト名を手がかりに、見つからない行の向きを決める', () => {
  const info = analyzeLine('まぼろしの曲 - 優里', { knownArtists: new Map([[looseKey('優里'), '優里']]) });
  assert.deepEqual(guessSong(info), { artist: '優里', title: 'まぼろしの曲' });
});
