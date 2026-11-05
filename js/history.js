// Google Takeout の YouTube 再生履歴（watch-history.json / ZIP）から、
// YouTube Music でよく聴いている曲を集計する。
// 読み込みは端末の中だけで行い、履歴そのものはどこにも保存しない。
// 解析の考え方は YouTube-Music-History-Analyzer の parser.js と同じ。
import { normalize } from './text.js';

const WATCHED_PATTERNS = [
  /^Watched\s+/,
  /\s*を視聴しました$/,
  /\s*を再生しました$/,
];
const TOPIC_RE = /\s+-\s+Topic$/i;
const NOISE_RE = new RegExp([
  String.raw`\s*[(（[［【〔<＜]\s*(?:official|オフィシャル|公式|music\s*video|mv|m\/v|pv|lyric|lyrics|歌詞|audio|video|visualizer|full|short|ver\.?|version|live|ライブ|teaser|trailer|4k|hd)[^)）\]］】〕>＞]*[)）\]］】〕>＞]`,
  String.raw`\s+(?:official\s+)?(?:music\s+video|mv|m\/v|lyric\s+video|official\s+video|official\s+audio)\s*$`,
].join('|'), 'gi');
const CHANNEL_NOISE_RE = /\s*(?:official\s*(?:youtube\s*)?(?:channel)?|公式\s*(?:youtube\s*)?チャンネル|オフィシャル\s*チャンネル|vevo|channel)\s*$/i;

export function stripWatched(title) {
  let t = String(title || '').trim();
  for (const re of WATCHED_PATTERNS) t = t.replace(re, '');
  return t.trim();
}

export function extractVideoId(url) {
  if (!url) return null;
  const m = /[?&]v=([\w-]{6,})/.exec(url);
  return m ? m[1] : null;
}

export function thumbnailUrl(videoId) {
  return videoId ? `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg` : null;
}

export function cleanChannel(name) {
  return String(name ?? '').replace(TOPIC_RE, '').replace(CHANNEL_NOISE_RE, '').trim();
}

// 動画タイトルとチャンネル名から、アーティスト名と曲名を推測する。
// YouTube Music の公式音源（「〇〇 - Topic」チャンネル）は、タイトルがそのまま曲名。
export function guessSong(rawTitle, channel) {
  const title = String(rawTitle ?? '').trim();
  const ch = String(channel ?? '').trim();
  if (TOPIC_RE.test(ch)) return { artist: cleanChannel(ch), title };
  let artist = cleanChannel(ch);
  let t = title.replace(NOISE_RE, '').trim();
  // 「アーティスト『曲名』」「アーティスト「曲名」」
  const quoted = t.match(/^(.*?)\s*[「『](.+?)[」』]/);
  if (quoted) {
    if (quoted[1].trim()) artist = quoted[1].replace(/[\s/／|｜:：-]+$/, '').trim() || artist;
    return { artist, title: quoted[2].trim() };
  }
  // 「アーティスト - 曲名」「曲名 / アーティスト」
  const parts = t.split(/\s+[-–—/／|｜]\s+/);
  if (parts.length >= 2) {
    const [a, b] = parts;
    const ka = normalize(a).replace(/\s/g, '');
    const kb = normalize(b).replace(/\s/g, '');
    const kc = normalize(artist).replace(/\s/g, '');
    if (kc && (ka.includes(kc) || kc.includes(ka))) return { artist: a.trim(), title: parts.slice(1).join(' - ').trim() };
    if (kc && (kb.includes(kc) || kc.includes(kb))) return { artist: b.trim(), title: a.trim() };
    return { artist: a.trim(), title: parts.slice(1).join(' - ').trim() };
  }
  return { artist, title: t };
}

function isZip(bytes) {
  return bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

// ファイルの中身から YouTube Music の再生記録を取り出す
export async function readHistoryFile(buffer) {
  const bytes = new Uint8Array(buffer);
  const decoder = new TextDecoder('utf-8');
  if (isZip(bytes)) {
    const { unzipSync } = await import('./vendor/fflate.js');
    const files = unzipSync(bytes, { filter: (f) => /(^|\/)watch-history\.(json|html)$/i.test(f.name) });
    const names = Object.keys(files);
    const jsonNames = names.filter((n) => /\.json$/i.test(n));
    if (!jsonNames.length) {
      throw new Error(names.length
        ? 'ZIP 内の履歴が HTML 形式です。Google Takeout で履歴の形式を JSON にして書き出してください。'
        : 'ZIP 内に watch-history.json が見つかりません。');
    }
    return jsonNames.flatMap((n) => parseHistoryText(decoder.decode(files[n])));
  }
  return parseHistoryText(decoder.decode(bytes));
}

export function parseHistoryText(text) {
  const body = String(text).replace(/^﻿/, '').trim();
  if (body.startsWith('<')) throw new Error('HTML 形式のファイルです。Google Takeout で履歴の形式を JSON にして書き出してください。');
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error('JSON として読み込めませんでした。watch-history.json を選んでください。');
  }
  // YouTube-Music-History-Analyzer のバックアップ
  if (json && !Array.isArray(json) && json.format === 'ytm-history-analyzer') {
    const tracks = Array.isArray(json.tracks) ? json.tracks : [];
    const times = Array.isArray(json.times) ? json.times : [];
    const idx = Array.isArray(json.trackIdx) ? json.trackIdx : [];
    const out = [];
    for (let i = 0; i < times.length; i++) {
      const tr = tracks[idx[i]];
      if (tr && typeof times[i] === 'number') out.push({ t: times[i], v: tr[0] || null, title: tr[1] || null, channel: tr[2] || null });
    }
    return out;
  }
  if (!Array.isArray(json)) throw new Error('対応していない形式です。watch-history.json を選んでください。');
  const out = [];
  for (const it of json) {
    if (!it || typeof it.time !== 'string') continue;
    const url = typeof it.titleUrl === 'string' ? it.titleUrl : '';
    if (!(it.header === 'YouTube Music' || url.includes('music.youtube.com'))) continue;
    const t = Date.parse(it.time);
    if (Number.isNaN(t)) continue;
    let title = stripWatched(it.title);
    if (!title || /^https?:\/\//.test(title)) title = null;
    const sub = Array.isArray(it.subtitles) ? it.subtitles[0] : null;
    out.push({ t, v: extractVideoId(url), title, channel: sub?.name ? String(sub.name) : null });
  }
  return out;
}

// 曲ごとに再生回数をまとめ、多い順に並べる
export function aggregate(entries) {
  const map = new Map();
  for (const e of entries) {
    if (!e.title || !e.channel) continue;
    const g = guessSong(e.title, e.channel);
    if (!g.title || !g.artist) continue;
    const key = `${normalize(g.artist)}\u0001${normalize(g.title)}`;
    let s = map.get(key);
    if (!s) {
      s = { key, artist: g.artist, title: g.title, count: 0, last: 0, videos: new Map(), topic: false };
      map.set(key, s);
    }
    s.count++;
    s.last = Math.max(s.last, e.t);
    if (TOPIC_RE.test(e.channel)) s.topic = true;
    if (e.v) s.videos.set(e.v, (s.videos.get(e.v) ?? 0) + 1);
  }
  return [...map.values()]
    .map((s) => {
      const video = [...s.videos.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      return { key: s.key, artist: s.artist, title: s.title, count: s.count, last: s.last, video, topic: s.topic };
    })
    .sort((a, b) => b.count - a.count || b.last - a.last);
}
