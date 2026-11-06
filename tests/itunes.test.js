import { test } from 'node:test';
import assert from 'node:assert/strict';
import { artworkUrl, toSong, uniqueArtists, sameArtist, pickSongs, bestMatch, trimReading } from '../js/itunes.js';

const song = (artist, title, album = 'A', art = true) => toSong({
  wrapperType: 'track', kind: 'song', artistName: artist, trackName: title, collectionName: album,
  artworkUrl100: art ? `https://is1-ssl.mzstatic.com/image/thumb/x/${encodeURIComponent(title)}/100x100bb.jpg` : undefined,
});

test('ジャケット画像の URL を大きいサイズに書き換える', () => {
  assert.equal(artworkUrl('https://is1-ssl.mzstatic.com/image/thumb/a/b/100x100bb.jpg', 300), 'https://is1-ssl.mzstatic.com/image/thumb/a/b/300x300bb.jpg');
  assert.equal(artworkUrl(undefined), null);
});

test('アーティスト候補は本人名義を先に、コラボ名義を後に並べる', () => {
  const names = uniqueArtists([song('ミナト & ハルカ', '雨の日'), song('ミナト', 'Starlight'), song('ユイ×ミナト', '夏の終わり'), song('ミナト', '白い街')]);
  assert.deepEqual(names, ['ミナト', 'ミナト & ハルカ', 'ユイ×ミナト']);
});

test('アーティスト名の表記ゆれを同じとみなす', () => {
  assert.ok(sameArtist('Mr.Children', 'mr children'));
  assert.ok(sameArtist('ソラシド', 'そらしど'));
  assert.ok(sameArtist('aoi from ソラシド', 'ソラシド'));
  assert.ok(!sameArtist('LUMINA', 'ソラシド'));
});

test('曲名の候補はそのアーティストの曲だけ、同名は1つにまとめ、前方一致を先に', () => {
  const list = [song('ソラシド', '花火の夜'), song('ソラシド', '夜明けのワルツ'), song('ソラシド', '夜明けのワルツ', 'B'), song('LUMINA', 'つきあかり'), song('ソラシド', 'さよなら。')];
  assert.deepEqual(pickSongs(list, 'ソラシド').map((s) => s.title), ['花火の夜', '夜明けのワルツ', 'さよなら。']);
  assert.deepEqual(pickSongs(list, 'ソラシド', '夜明').map((s) => s.title), ['夜明けのワルツ']);
  assert.deepEqual(pickSongs(list, 'ソラシド', 'の').map((s) => s.title), ['花火の夜', '夜明けのワルツ']);
});

test('ライブ版やインスト版は、付記のない曲名にまとめる', () => {
  const list = [song('Blue Harbor', 'Daybreak (LIVE)'), song('Blue Harbor', 'Daybreak'), song('Blue Harbor', 'Daybreak (Instrumental)'), song('Blue Harbor', 'Lighthouse - TV Size'), song('Blue Harbor', 'Starlight')];
  assert.deepEqual(pickSongs(list, 'Blue Harbor').map((s) => s.title), ['Daybreak', 'Lighthouse - TV Size', 'Starlight']);
  assert.deepEqual(pickSongs(list, 'Blue Harbor', 'day').map((s) => s.title), ['Daybreak']);
});

test('ジャケット画像を自動で入れるのは、曲名とアーティストが合うときだけ', () => {
  const list = [song('LUMINA', 'つきあかり (Live)'), song('Cover Artist', 'つきあかり'), song('LUMINA', 'つきあかり')];
  assert.equal(bestMatch(list, 'LUMINA', 'つきあかり').artist, 'LUMINA');
  assert.equal(bestMatch([song('Cover Artist', 'つきあかり')], 'LUMINA', 'つきあかり'), null);
  // 括弧の付記は無視して比べる
  assert.equal(bestMatch([song('LUMINA', 'つきあかり (TV Size)')], 'LUMINA', 'つきあかり').title, 'つきあかり (TV Size)');
  // 画像がない結果は使わない
  assert.equal(bestMatch([song('LUMINA', 'つきあかり', 'A', false)], 'LUMINA', 'つきあかり'), null);
});

test('日本語の曲名の後ろに付いた英語表記だけを外す', () => {
  assert.equal(trimReading('さくら - Sakura'), 'さくら');
  assert.equal(trimReading('夜明けのワルツ - Yoake no Waltz'), '夜明けのワルツ');
  assert.equal(trimReading('白い街 – Shiroi Machi'), '白い街');
  assert.equal(trimReading('花火の夜 (feat. ユイ) - Hanabi no Yoru'), '花火の夜 (feat. ユイ)');
  // 英語だけの曲名は変えない
  assert.equal(trimReading('Daybreak - Sunrise'), 'Daybreak - Sunrise');
  assert.equal(trimReading('Starlight'), 'Starlight');
  // ライブ版などの付記は残す
  for (const t of ['さくら - Live', 'さくら - TV Size', 'さくら - From THE FIRST TAKE', 'さくら - Movie ver.', 'さくら - Acoustic Version', 'さくら - Instrumental', 'さくら - English Version', 'さくら - Remastered 2021']) {
    assert.equal(trimReading(t), t);
  }
  // 後ろが英字だけでないもの・区切りに空白がないものは変えない
  assert.equal(trimReading('さくら - 2021'), 'さくら - 2021');
  assert.equal(trimReading('さくら - サクラ'), 'さくら - サクラ');
  assert.equal(trimReading('さくら-Sakura'), 'さくら-Sakura');
  assert.equal(trimReading(''), '');
});
