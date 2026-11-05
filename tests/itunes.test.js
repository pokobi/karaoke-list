import { test } from 'node:test';
import assert from 'node:assert/strict';
import { artworkUrl, toSong, uniqueArtists, sameArtist, pickSongs, bestMatch } from '../js/itunes.js';

const song = (artist, title, album = 'A', art = true) => toSong({
  wrapperType: 'track', kind: 'song', artistName: artist, trackName: title, collectionName: album,
  artworkUrl100: art ? `https://is1-ssl.mzstatic.com/image/thumb/x/${encodeURIComponent(title)}/100x100bb.jpg` : undefined,
});

test('ジャケット画像の URL を大きいサイズに書き換える', () => {
  assert.equal(artworkUrl('https://is1-ssl.mzstatic.com/image/thumb/a/b/100x100bb.jpg', 300), 'https://is1-ssl.mzstatic.com/image/thumb/a/b/300x300bb.jpg');
  assert.equal(artworkUrl(undefined), null);
});

test('アーティスト候補は本人名義を先に、コラボ名義を後に並べる', () => {
  const names = uniqueArtists([song('米津玄師 & 菅田将暉', 'まちがいさがし'), song('米津玄師', 'Lemon'), song('DAOKO×米津玄師', '打上花火'), song('米津玄師', '馬と鹿')]);
  assert.deepEqual(names, ['米津玄師', '米津玄師 & 菅田将暉', 'DAOKO×米津玄師']);
});

test('アーティスト名の表記ゆれを同じとみなす', () => {
  assert.ok(sameArtist('Mrs. GREEN APPLE', 'mrs green apple'));
  assert.ok(sameArtist('ヨルシカ', 'よるしか'));
  assert.ok(sameArtist('suis from ヨルシカ', 'ヨルシカ'));
  assert.ok(!sameArtist('YOASOBI', 'ヨルシカ'));
});

test('曲名の候補はそのアーティストの曲だけ、同名は1つにまとめ、前方一致を先に', () => {
  const list = [song('ヨルシカ', '花に亡霊'), song('ヨルシカ', 'ただ君に晴れ'), song('ヨルシカ', 'ただ君に晴れ', 'B'), song('YOASOBI', '夜に駆ける'), song('ヨルシカ', '言って。')];
  assert.deepEqual(pickSongs(list, 'ヨルシカ').map((s) => s.title), ['花に亡霊', 'ただ君に晴れ', '言って。']);
  assert.deepEqual(pickSongs(list, 'ヨルシカ', 'ただ').map((s) => s.title), ['ただ君に晴れ']);
  assert.deepEqual(pickSongs(list, 'ヨルシカ', 'に').map((s) => s.title), ['花に亡霊', 'ただ君に晴れ']);
});

test('ライブ版やインスト版は、付記のない曲名にまとめる', () => {
  const list = [song('Official髭男dism', 'Pretender (LIVE)'), song('Official髭男dism', 'Pretender'), song('Official髭男dism', 'Pretender (Instrumental)'), song('Official髭男dism', 'Subtitle - TV Size'), song('Official髭男dism', 'Cry Baby')];
  assert.deepEqual(pickSongs(list, 'Official髭男dism').map((s) => s.title), ['Pretender', 'Subtitle - TV Size', 'Cry Baby']);
  assert.deepEqual(pickSongs(list, 'Official髭男dism', 'pre').map((s) => s.title), ['Pretender']);
});

test('ジャケット画像を自動で入れるのは、曲名とアーティストが合うときだけ', () => {
  const list = [song('YOASOBI', '夜に駆ける (Live)'), song('Cover Artist', '夜に駆ける'), song('YOASOBI', '夜に駆ける')];
  assert.equal(bestMatch(list, 'YOASOBI', '夜に駆ける').artist, 'YOASOBI');
  assert.equal(bestMatch([song('Cover Artist', '夜に駆ける')], 'YOASOBI', '夜に駆ける'), null);
  // 括弧の付記は無視して比べる
  assert.equal(bestMatch([song('YOASOBI', '夜に駆ける (TV Size)')], 'YOASOBI', '夜に駆ける').title, '夜に駆ける (TV Size)');
  // 画像がない結果は使わない
  assert.equal(bestMatch([song('YOASOBI', '夜に駆ける', 'A', false)], 'YOASOBI', '夜に駆ける'), null);
});
