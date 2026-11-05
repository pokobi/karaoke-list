// iTunes Search API で、アーティスト名・曲名の候補とジャケット画像を探す。
// 登録不要・無料。目安として 1 分あたり 20 回程度までにとどめる。
import { normalize } from './text.js';

const ENDPOINT = 'https://itunes.apple.com/search';
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 18;
const cache = new Map();
const calls = [];

const squash = (s) => normalize(s).replace(/[\s・･.\-‐_]/g, '');

// 100x100 の画像 URL を、指定サイズの URL に書き換える
export function artworkUrl(url, size = 300) {
  if (typeof url !== 'string' || !url) return null;
  return url.replace(/\/(\d+)x(\d+)(bb|cc|-\d+)?\.(jpg|png|webp)$/i, `/${size}x${size}bb.jpg`);
}

function canCall() {
  const now = Date.now();
  while (calls.length && now - calls[0] > WINDOW_MS) calls.shift();
  return calls.length < MAX_PER_WINDOW;
}

export function waitForSlot() {
  if (canCall()) return Promise.resolve();
  const wait = WINDOW_MS - (Date.now() - calls[0]) + 50;
  return new Promise((r) => setTimeout(r, wait));
}

async function search(params, { signal } = {}) {
  const q = new URLSearchParams({ country: 'JP', lang: 'ja_jp', media: 'music', entity: 'song', ...params });
  const key = q.toString();
  if (cache.has(key)) return cache.get(key);
  if (!canCall()) return null;
  calls.push(Date.now());
  const res = await fetch(`${ENDPOINT}?${key}`, { signal });
  if (!res.ok) throw new Error(`itunes ${res.status}`);
  const json = await res.json();
  const results = (json.results ?? []).filter((r) => r.wrapperType === 'track' && r.kind === 'song');
  const songs = results.map(toSong);
  cache.set(key, songs);
  return songs;
}

export function toSong(r) {
  return {
    artist: String(r.artistName ?? ''),
    title: String(r.trackName ?? ''),
    album: String(r.collectionName ?? ''),
    artwork: artworkUrl(r.artworkUrl100),
  };
}

// アーティスト名の候補。曲の検索結果からアーティスト名を集める
// （アーティスト自体の検索は名前がローマ字表記で返るため使わない）。
// 本人名義を先に、コラボ名義（&・feat. など）を後に並べる。
export async function suggestArtistsOnline(term, opts) {
  const t = term.trim();
  if (t.length < 2) return [];
  const songs = await search({ term: t, attribute: 'artistTerm', limit: '50' }, opts);
  if (!songs) return [];
  return uniqueArtists(songs);
}

export function uniqueArtists(songs) {
  const seen = new Map();
  for (const s of songs) {
    if (!s.artist || seen.has(s.artist)) continue;
    seen.set(s.artist, seen.size);
  }
  const isCollab = (n) => /\s(&|×|x|feat\.?|ft\.?|with)\s|×|、/i.test(n);
  return [...seen.keys()].sort((a, b) => Number(isCollab(a)) - Number(isCollab(b)) || seen.get(a) - seen.get(b));
}

export function sameArtist(a, b) {
  const x = squash(a);
  const y = squash(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

// そのアーティストの曲（関連の強い順に最大 200 曲）。同じアーティストなら 1 回の問い合わせで済む
export async function songsOfArtist(artist, opts) {
  const a = artist.trim();
  if (!a) return [];
  const songs = await search({ term: a, attribute: 'artistTerm', limit: '200' }, opts);
  return songs ? pickSongs(songs, a) : null;
}

// 曲名の候補。アーティストの曲一覧を入力で絞り込み、少なければ曲名でも検索する
export async function suggestSongsOnline(artist, titleInput = '', opts) {
  const a = artist.trim();
  if (!a) return [];
  const all = (await songsOfArtist(a, opts)) ?? [];
  const q = titleInput.trim();
  if (!q) return all;
  let list = pickSongs(all, a, q);
  if (list.length < 3 && q.length >= 2) {
    const more = await search({ term: `${a} ${q}`, limit: '50' }, opts);
    if (more) {
      const seen = new Set(list.map((s) => squash(s.title)));
      list = [...list, ...pickSongs(more, a, q).filter((s) => !seen.has(squash(s.title)))];
    }
  }
  return list;
}

// 検索語でジャケット画像の候補を探す（同じ画像は 1 つにまとめる）
export async function searchTracks(term, opts) {
  const t = term.trim();
  if (!t) return [];
  const songs = await search({ term: t, limit: '30' }, opts);
  if (!songs) return null;
  const seen = new Set();
  return songs.filter((s) => s.artwork && !seen.has(s.artwork) && seen.add(s.artwork));
}

// 「(Live)」「(Instrumental)」「- TV Size」などの付記を除いた曲名
const VARIANT_RE = /\s*(?:[(（[［【][^)）\]］】]*[)）\]］】]|\s[-–]\s.*)$/;
export function baseTitle(title) {
  let s = String(title ?? '');
  for (let i = 0; i < 3; i++) {
    const next = s.replace(VARIANT_RE, '');
    if (next === s) break;
    s = next;
  }
  return s.trim() || String(title ?? '').trim();
}

// アーティストの曲だけを残し、同じ曲の別バージョン（ライブ版・インスト版など）は 1 つにまとめる。
// まとめるときは付記のない曲名を優先する。
export function pickSongs(songs, artist, titleInput = '') {
  const q = squash(titleInput);
  const out = [];
  const index = new Map();
  for (const s of songs) {
    if (!sameArtist(s.artist, artist)) continue;
    const base = baseTitle(s.title);
    const k = squash(base);
    if (!k) continue;
    if (q && !squash(s.title).includes(q)) continue;
    const plain = base === s.title.trim();
    if (index.has(k)) {
      const i = index.get(k);
      if (plain && out[i].title.trim() !== baseTitle(out[i].title)) out[i] = s;
      continue;
    }
    index.set(k, out.length);
    out.push(s);
  }
  if (q) out.sort((x, y) => Number(squash(y.title).startsWith(q)) - Number(squash(x.title).startsWith(q)));
  return out;
}

// アーティスト名と曲名から、いちばん合いそうな曲（ジャケット画像つき）を探す
export async function findTrack(artist, title, opts) {
  if (!title.trim()) return { match: null, candidates: [] };
  const songs = await search({ term: `${artist} ${title}`.trim(), limit: '25' }, opts);
  if (!songs) return null;
  return { match: bestMatch(songs, artist, title), candidates: songs.filter((s) => s.artwork) };
}

export function bestMatch(songs, artist, title) {
  const t = squash(title);
  const base = (s) => squash(s.replace(/\s*[(（[［].*?[)）\]］]\s*/g, ''));
  let fallback = null;
  for (const s of songs) {
    if (!s.artwork) continue;
    const st = squash(s.title);
    const titleOk = st === t || base(s.title) === base(title);
    if (!titleOk) continue;
    if (!artist || sameArtist(s.artist, artist)) return s;
    fallback ??= s;
  }
  return artist ? null : fallback;
}
