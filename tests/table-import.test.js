import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeText, parseTable, detectColumns, tableToItems, sourceName, detectDelimiter } from '../js/table-import.js';
import { findPlaylistIds, isPlaylistLine, fetchPlaylist, fetchVideos, videoToSong } from '../js/youtube.js';

const utf16le = (s) => {
  const out = [0xff, 0xfe];
  for (const c of s) out.push(c.charCodeAt(0) & 255, c.charCodeAt(0) >> 8);
  return new Uint8Array(out);
};

test('ファイルの文字コードを見分けて読む', () => {
  assert.equal(decodeText(utf16le('名前\tアーティスト')), '名前\tアーティスト');
  assert.equal(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('曲名,歌手')])), '曲名,歌手');
  assert.equal(decodeText(new TextEncoder().encode('Track Name,Artist')), 'Track Name,Artist');
});

test('CSV とタブ区切りを行と列に分ける', () => {
  assert.equal(detectDelimiter('a\tb\nc'), '\t');
  assert.equal(detectDelimiter('a,b'), ',');
  assert.equal(detectDelimiter('ソラシド - 白い街'), null);
  assert.deepEqual(parseTable('"Track Name","Artist Name(s)"\n"白い街","ソラシド"\n"A, B ""C""","x"\n\n'), [
    ['Track Name', 'Artist Name(s)'], ['白い街', 'ソラシド'], ['A, B "C"', 'x'],
  ]);
  // タブ区切りでは、ダブルクオートをそのまま文字として扱う
  assert.deepEqual(parseTable('名前\tアーティスト\r\n"夜明け"のうた\tLUMINA\r\n'), [['名前', 'アーティスト'], ['"夜明け"のうた', 'LUMINA']]);
  assert.equal(parseTable('区切りのない行'), null);
});

test('いろいろな書き出し形式の見出しから、曲名・アーティストの列を見つける', () => {
  // Spotify（Exportify）
  assert.deepEqual(detectColumns(['Track URI', 'Track Name', 'Album Name', 'Artist Name(s)']), { title: 1, artist: 3, videoId: -1, playlist: -1 });
  // Apple Music（日本語・英語）
  assert.deepEqual(detectColumns(['名前', 'アーティスト', '作曲者', 'アルバム']), { title: 0, artist: 1, videoId: -1, playlist: -1 });
  assert.deepEqual(detectColumns(['Name', 'Artist', 'Composer', 'Album', 'Album Artist']), { title: 0, artist: 1, videoId: -1, playlist: -1 });
  // TuneMyMusic（再生リスト名の列あり）
  assert.deepEqual(detectColumns(['Track name', 'Artist name', 'Album', 'Playlist name', 'Type', 'ISRC']), { title: 0, artist: 1, videoId: -1, playlist: 3 });
  // YouTube Music の Takeout（ライブラリの曲・再生リスト）
  assert.deepEqual(detectColumns(['Video ID', 'Song Title', 'Album Title', 'Artist Name 1', 'Artist Name 2']), { title: 1, artist: 3, videoId: 0, playlist: -1 });
  assert.deepEqual(detectColumns(['Video ID', 'Playlist Video Creation Timestamp']), { title: -1, artist: -1, videoId: 0, playlist: -1 });
  // 見分けられない表
  assert.equal(detectColumns(['列1', '列2']), null);
  // アルバムアーティストしかないときは、それは使わない
  assert.equal(detectColumns(['Title', 'Album Artist']).artist, -1);
});

test('表の行を曲の候補にする', () => {
  const rows = [['白い街 - Shiroi Machi', 'ソラシド;ミナト', '', 'お気に入り'], ['', '', '', ''], ['', 'x', 'dQw4w9WgXcQ', '']];
  assert.deepEqual(tableToItems(rows, { title: 0, artist: 1, videoId: 2, playlist: 3 }, 'file'), [
    { title: '白い街', artist: 'ソラシド', videoId: '', source: 'お気に入り' },
    { title: '', artist: 'x', videoId: 'dQw4w9WgXcQ', source: 'file' },
  ]);
  assert.equal(sourceName('YouTube と YouTube Music/再生リスト/練習曲-動画.csv'), '練習曲');
  assert.equal(sourceName('Spotify.tsv'), 'Spotify');
});

test('YouTube の再生リストのリンクを見つける', () => {
  const text = 'ソラシド - 白い街\nhttps://music.youtube.com/playlist?list=PLabcdefghij12345&si=xyz\nhttps://youtube.com/playlist?list=OLAK5uy_abcdefghijk\nhttps://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabcdefghij12345';
  assert.deepEqual(findPlaylistIds(text), ['PLabcdefghij12345', 'OLAK5uy_abcdefghijk']);
  assert.equal(isPlaylistLine('https://music.youtube.com/playlist?list=PLabcdefghij12345&si=xyz'), true);
  assert.equal(isPlaylistLine('ソラシド - 白い街'), false);
});

test('YouTube の動画を曲にする（公式音源は確実）', () => {
  assert.deepEqual(videoToSong({ title: '夜明けのワルツ', channel: 'ソラシド - Topic' }), { artist: 'ソラシド', title: '夜明けのワルツ', sure: true });
  assert.deepEqual(videoToSong({ title: 'LUMINA「つきあかり」 Official Music Video', channel: 'LUMINA' }), { artist: 'LUMINA', title: 'つきあかり', sure: false });
});

test('YouTube の再生リストを、ページを分けて全部読む（通信は差し替え）', async () => {
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    asked.push(`${u.pathname.split('/').pop()}:${u.searchParams.get('pageToken') ?? ''}`);
    let body;
    if (u.pathname.endsWith('/playlists')) body = { items: [{ snippet: { title: '練習曲' } }] };
    else if (u.pathname.endsWith('/playlistItems')) {
      body = u.searchParams.get('pageToken')
        ? { items: [{ snippet: { title: 'Deleted video', resourceId: { videoId: 'aaaaaaaaaaa' } } }, { snippet: { title: '白い街', videoOwnerChannelTitle: 'ミナト - Topic', resourceId: { videoId: 'bbbbbbbbbbb' } } }] }
        : { nextPageToken: 'P2', items: [{ snippet: { title: '夜明けのワルツ', videoOwnerChannelTitle: 'ソラシド - Topic', resourceId: { videoId: 'ccccccccccc' } } }] };
    } else body = { items: [{ id: 'ccccccccccc', snippet: { title: '夜明けのワルツ', channelTitle: 'ソラシド - Topic' } }] };
    return { ok: true, status: 200, json: async () => body };
  };
  try {
    const p = await fetchPlaylist('PLabcdefghij12345', 'KEY');
    assert.equal(p.title, '練習曲');
    assert.deepEqual(p.items.map((x) => x.title), ['夜明けのワルツ', '白い街']);
    assert.deepEqual(asked, ['playlists:', 'playlistItems:', 'playlistItems:P2']);
    const v = await fetchVideos(['ccccccccccc'], 'KEY');
    assert.equal(v.get('ccccccccccc').channel, 'ソラシド - Topic');
    // 上限に達したときは、分かる文言を付けて止める
    globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({ error: { errors: [{ reason: 'quotaExceeded' }] } }) });
    await assert.rejects(fetchPlaylist('PLabcdefghij12345', 'KEY'), (e) => /上限/.test(e.userMessage));
  } finally {
    globalThis.fetch = realFetch;
  }
});
