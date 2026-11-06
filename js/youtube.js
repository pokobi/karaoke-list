// YouTube の公式 API（YouTube Data API v3）で、再生リストや動画の曲名を読む。
// 公開・限定公開の再生リストは、ログインなしで読める。使う量（1 日の上限 10,000）は、
// 再生リスト 50 曲ごとに 1、動画 50 本ごとに 1 と少ない。
import { guessSong } from './history.js';

const API = 'https://www.googleapis.com/youtube/v3';

// テキストの中の YouTube の再生リストのリンクから、再生リストの ID を取り出す（重複は除く）
export function findPlaylistIds(text) {
  const ids = [];
  for (const m of String(text ?? '').matchAll(/https?:\/\/(?:www\.|m\.|music\.)?youtube\.com\/[^\s]*?[?&]list=([\w-]{10,64})/g)) {
    if (!ids.includes(m[1])) ids.push(m[1]);
  }
  return ids;
}

// 行が YouTube の再生リストのリンクだけか（曲の行として読まないため）
export const isPlaylistLine = (line) => /^\s*https?:\/\/(?:www\.|m\.|music\.)?youtube\.com\/\S*[?&]list=[\w-]+\S*\s*$/.test(line);

function apiError(status, body) {
  const reason = body?.error?.errors?.[0]?.reason ?? '';
  const err = new Error(`YouTube API ${status} ${reason}`);
  if (/quota/i.test(reason)) err.userMessage = '今日の YouTube の読み込みの上限に達しました。明日もう一度試してください';
  else if (status === 404 || /notFound/i.test(reason)) err.userMessage = '再生リストが見つかりません（非公開の可能性があります。公開範囲を「限定公開」にすると読めます）';
  else if (status === 403) err.userMessage = 'YouTube から読み込めませんでした（このページからは使えない設定の可能性があります）';
  else err.userMessage = 'YouTube から読み込めませんでした。通信状況を確認してください';
  return err;
}

async function get(path, params, key) {
  const res = await fetch(`${API}/${path}?${new URLSearchParams({ ...params, key })}`);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw apiError(res.status, body);
  return body;
}

// 削除・非公開になった動画
const gone = (title) => /^(deleted video|private video|削除された動画|非公開動画)$/i.test(String(title ?? '').trim());

// 再生リストの名前と動画の一覧。戻り値：{ title, items: [{ videoId, title, channel }] }
export async function fetchPlaylist(id, key, { max = 2000 } = {}) {
  const info = await get('playlists', { part: 'snippet', id, fields: 'items(snippet/title)' }, key);
  if (!info?.items?.length) throw apiError(404, null);
  const items = [];
  let pageToken = '';
  do {
    const page = await get('playlistItems', {
      part: 'snippet',
      playlistId: id,
      maxResults: '50',
      fields: 'nextPageToken,items(snippet(title,videoOwnerChannelTitle,resourceId/videoId))',
      ...(pageToken ? { pageToken } : {}),
    }, key);
    for (const it of page.items ?? []) {
      const s = it.snippet ?? {};
      if (gone(s.title) || !s.resourceId?.videoId) continue;
      items.push({ videoId: s.resourceId.videoId, title: s.title ?? '', channel: s.videoOwnerChannelTitle ?? '' });
    }
    pageToken = page.nextPageToken ?? '';
  } while (pageToken && items.length < max);
  return { title: info.items[0].snippet?.title ?? '', items: items.slice(0, max) };
}

// 動画 ID から曲名・チャンネル名を読む（50 本ずつ）。戻り値：Map(videoId → { title, channel })
export async function fetchVideos(ids, key) {
  const out = new Map();
  const list = [...new Set(ids)];
  for (let i = 0; i < list.length; i += 50) {
    const page = await get('videos', { part: 'snippet', id: list.slice(i, i + 50).join(','), fields: 'items(id,snippet(title,channelTitle))' }, key);
    for (const v of page.items ?? []) out.set(v.id, { title: v.snippet?.title ?? '', channel: v.snippet?.channelTitle ?? '' });
  }
  return out;
}

// 動画を曲にする。YouTube Music の公式音源（「〇〇 - Topic」のチャンネル）は、タイトルがそのまま曲名なので確実
export function videoToSong({ title, channel }) {
  const g = guessSong(title, channel);
  return { artist: g.artist, title: g.title, sure: /\s-\sTopic$/.test(String(channel ?? '')) };
}
