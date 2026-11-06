// 曲データの正規化と、絞り込み・並び替え。
import { RANGE_FIELDS, isNote, octaveOf } from './notes.js';
import { normalize, searchTerms, collator } from './text.js';

export const PRESET_TAGS = ['練習中'];

export const SORTS = [
  { id: 'createdAt', label: '登録日', dir: 'desc' },
  { id: 'artist', label: 'アーティスト', dir: 'asc' },
  { id: 'title', label: '曲名', dir: 'asc' },
  { id: 'low', label: '最低音', dir: 'asc' },
  { id: 'chestHigh', label: '地声最高音', dir: 'asc' },
  { id: 'falsettoHigh', label: '裏声最高音', dir: 'asc' },
  { id: 'singCount', label: '歌った回数', dir: 'desc' },
  { id: 'lastSungAt', label: '最終歌唱日', dir: 'desc' },
  { id: 'score', label: '採点', dir: 'desc' },
];

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const note = (v) => (isNote(v) ? v : null);

// ジャケット画像は https の URL だけを受け付ける
export function safeImageUrl(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return /^https:\/\/[^\s"'<>]+$/i.test(s) && s.length <= 1000 ? s : null;
}

// 追加機能が自由に使う保存欄。この画面では中身を表示も変更もしない
export function plainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

export const isRangeMissing = (song) => !isNote(song.low) || !isNote(song.chestHigh);

export function emptySong() {
  return {
    artist: '', title: '', low: null, chestHigh: null, falsettoHigh: null, key: 0, octave: 0,
    favorite: false, tags: [], score: null, memo: '', singCount: 0, lastSungAt: null,
    artwork: null, ext: null, createdAt: 0, updatedAt: 0,
  };
}

export function normalizeSong(raw) {
  const s = {
    id: raw.id,
    artist: String(raw.artist ?? '').trim(),
    title: String(raw.title ?? '').trim(),
    low: note(raw.low),
    chestHigh: note(raw.chestHigh),
    falsettoHigh: note(raw.falsettoHigh),
    key: Number.isInteger(raw.key) ? raw.key : 0,
    octave: octaveOf(raw.octave, raw.key),
    favorite: raw.favorite === true,
    tags: Array.isArray(raw.tags) ? [...new Set(raw.tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()))] : [],
    score: num(raw.score),
    memo: String(raw.memo ?? ''),
    singCount: Number.isInteger(raw.singCount) && raw.singCount > 0 ? raw.singCount : 0,
    lastSungAt: num(raw.lastSungAt),
    artwork: safeImageUrl(raw.artwork),
    ext: plainObject(raw.ext),
    createdAt: num(raw.createdAt) ?? 0,
    updatedAt: num(raw.updatedAt) ?? 0,
  };
  Object.defineProperty(s, '_search', {
    value: normalize([s.title, s.artist, s.tags.join(' '), s.memo].join(' ')),
    enumerable: false,
  });
  return s;
}

// DB に保存する形（id と内部用の値を除く）。
export function toPayload(song) {
  const out = {};
  for (const k of Object.keys(emptySong())) out[k] = song[k] === undefined ? emptySong()[k] : song[k];
  return out;
}

export function dupKey(song) {
  return `${normalize(song.artist)}\u0001${normalize(song.title)}`;
}

export function defaultView() {
  return {
    favoriteOnly: false,
    missingRange: false,
    artist: '',
    tags: [],
    range: { low: {}, chestHigh: {}, falsettoHigh: {} },
    basis: 'current',
    sortBy: 'createdAt',
    sortDir: 'desc',
    showArt: true,
  };
}

export function sanitizeView(v) {
  const d = defaultView();
  if (!v || typeof v !== 'object') return d;
  const range = {};
  for (const f of RANGE_FIELDS) {
    const r = v.range?.[f.id] ?? {};
    range[f.id] = { min: note(r.min) ?? undefined, max: note(r.max) ?? undefined };
  }
  return {
    favoriteOnly: v.favoriteOnly === true,
    missingRange: v.missingRange === true,
    artist: typeof v.artist === 'string' ? v.artist : '',
    tags: Array.isArray(v.tags) ? v.tags.filter((t) => typeof t === 'string') : [],
    range,
    basis: v.basis === 'original' ? 'original' : 'current',
    sortBy: SORTS.some((s) => s.id === v.sortBy) ? v.sortBy : d.sortBy,
    sortDir: v.sortDir === 'asc' ? 'asc' : 'desc',
    showArt: v.showArt !== false,
  };
}

export function rangeValue(song, field, basis) {
  const v = song[field];
  if (!isNote(v)) return null;
  return basis === 'original' ? v : v + song.key;
}

export function hasRangeFilter(view) {
  return RANGE_FIELDS.some((f) => isNote(view.range[f.id]?.min) || isNote(view.range[f.id]?.max));
}

export function matches(song, view, terms) {
  if (view.favoriteOnly && !song.favorite) return false;
  if (view.missingRange && !isRangeMissing(song)) return false;
  if (view.artist && song.artist !== view.artist) return false;
  if (view.tags.length && !view.tags.some((t) => song.tags.includes(t))) return false;
  for (const f of RANGE_FIELDS) {
    const { min, max } = view.range[f.id] ?? {};
    const hasMin = isNote(min);
    const hasMax = isNote(max);
    if (!hasMin && !hasMax) continue;
    const v = rangeValue(song, f.id, view.basis);
    if (v == null) {
      // 裏声なしの曲は「裏声最高音が○○以下」の条件には当てはまるものとして扱う
      if (f.id === 'falsettoHigh' && !hasMin) continue;
      return false;
    }
    if (hasMin && v < min) return false;
    if (hasMax && v > max) return false;
  }
  if (terms.length) {
    const hay = song._search ?? normalize([song.title, song.artist, song.tags.join(' '), song.memo].join(' '));
    if (!terms.every((w) => hay.includes(w))) return false;
  }
  return true;
}

function sortValue(song, by, basis) {
  switch (by) {
    case 'low':
    case 'chestHigh':
    case 'falsettoHigh':
      return rangeValue(song, by, basis);
    case 'singCount':
      return song.singCount || null;
    default:
      return song[by] ?? null;
  }
}

export function compare(a, b, view) {
  const dir = view.sortDir === 'asc' ? 1 : -1;
  const by = view.sortBy;
  const va = sortValue(a, by, view.basis);
  const vb = sortValue(b, by, view.basis);
  // 値がない曲は並び順に関係なく最後
  if (va == null || va === '') {
    if (!(vb == null || vb === '')) return 1;
  } else if (vb == null || vb === '') {
    return -1;
  } else {
    const c = typeof va === 'string' ? collator.compare(va, vb) : va - vb;
    if (c) return c * dir;
  }
  if (by !== 'artist') {
    const c = collator.compare(a.artist, b.artist);
    if (c) return c;
  }
  const c = collator.compare(a.title, b.title);
  if (c) return c;
  return (b.createdAt - a.createdAt) || String(a.id).localeCompare(String(b.id));
}

export function applyView(songs, view, query) {
  const terms = searchTerms(query);
  return songs.filter((s) => matches(s, view, terms)).sort((a, b) => compare(a, b, view));
}

export function artistCounts(songs) {
  const m = new Map();
  for (const s of songs) if (s.artist) m.set(s.artist, (m.get(s.artist) ?? 0) + 1);
  return m;
}

// タグの一覧。設定で並べたタグ（まだなければ最初から用意しているタグ）を先に、
// 曲にだけ付いているタグをそのあとに名前順で並べる
export function allTags(songs, ordered = null) {
  const base = Array.isArray(ordered) ? ordered : PRESET_TAGS;
  const set = new Set(base);
  const rest = new Set();
  for (const s of songs) for (const t of s.tags) if (!set.has(t)) rest.add(t);
  return [...base, ...[...rest].sort(collator.compare)];
}

export function tagCounts(songs) {
  const m = new Map();
  for (const s of songs) for (const t of s.tags) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

// ---- タグの色 ----
// color はライトテーマで使う色。ダークテーマでは CSS で明るくして使う（css/style.css の [data-c] と合わせる）
export const TAG_COLORS = [
  { id: 'red', label: '赤', color: '#dc2626' },
  { id: 'orange', label: 'オレンジ', color: '#ea580c' },
  { id: 'amber', label: '黄', color: '#a16207' },
  { id: 'green', label: '緑', color: '#16a34a' },
  { id: 'teal', label: '青緑', color: '#0d9488' },
  { id: 'blue', label: '青', color: '#2563eb' },
  { id: 'violet', label: '紫', color: '#7c3aed' },
  { id: 'pink', label: 'ピンク', color: '#db2777' },
  { id: 'gray', label: 'グレー', color: '#4b5563' },
];

// タグの色は [{ tag, color }] の形で保存する（Firestore で丸ごと置き換わるよう、配列にしている）
export function tagColorMap(list) {
  const m = new Map();
  if (!Array.isArray(list)) return m;
  for (const x of list) {
    if (x && typeof x.tag === 'string' && x.tag.trim() && TAG_COLORS.some((c) => c.id === x.color)) m.set(x.tag, x.color);
  }
  return m;
}

export function tagColorList(map) {
  return [...map].map(([tag, color]) => ({ tag, color }));
}

// ---- アカウント共通の表示設定 ----
export const ACCENTS = [
  { id: 'indigo', label: 'インディゴ', color: '#4f46e5' },
  { id: 'violet', label: 'バイオレット', color: '#7c3aed' },
  { id: 'pink', label: 'ピンク', color: '#db2777' },
  { id: 'orange', label: 'オレンジ', color: '#ea580c' },
  { id: 'green', label: 'グリーン', color: '#16a34a' },
  { id: 'teal', label: 'ティール', color: '#0d9488' },
];
export const NOTE_STYLES = [
  { id: 'karaoke', label: 'カラオケ表記' },
  { id: 'both', label: '両方' },
  { id: 'scientific', label: 'G4 形式' },
];
export const REC_MARGINS = [0, 1, 2, 3];

export function sanitizePrefs(p) {
  const o = p && typeof p === 'object' ? p : {};
  return {
    accent: ACCENTS.some((a) => a.id === o.accent) ? o.accent : 'indigo',
    noteStyle: NOTE_STYLES.some((s) => s.id === o.noteStyle) ? o.noteStyle : 'karaoke',
    recMargin: REC_MARGINS.includes(o.recMargin) ? o.recMargin : 0,
  };
}

// アーティスト名の候補。前方一致を優先し、曲数の多い順。
export function suggestArtists(names, songs, input, limit = 8) {
  const q = normalize(input);
  const counts = artistCounts(songs);
  let items = [...new Set(names)].map((n) => ({ n, k: normalize(n), c: counts.get(n) ?? 0 }));
  if (q) items = items.filter((x) => x.k.includes(q) && x.n !== input.trim());
  items.sort((a, b) => {
    if (q) {
      const p = Number(b.k.startsWith(q)) - Number(a.k.startsWith(q));
      if (p) return p;
    }
    return b.c - a.c || collator.compare(a.n, b.n);
  });
  return items.slice(0, limit).map((x) => x.n);
}

// ---- ログインする前にこの端末に保存したデータを、アカウントへ移す ----

const randomId = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '').slice(0, 20) : Math.random().toString(36).slice(2) + Date.now().toString(36));

// 移す中身を決める。アカウントにある曲には手を加えず、同じアーティスト・曲名の曲は追加しない。
// 曲の ID はそのまま使う（試聴の音楽ファイルが曲の ID で結び付いているため）。アカウントの曲と ID が重なるときだけ新しくする。
// 音域・タグ（色を含む）・アーティスト名の候補・表示の設定・覚えた略称は、アカウントにないものだけを足す。
// 戻り値：add（[{ id, from, data }]）、skipped（追加しない曲 [{ from, to }]）、profile（updateProfile に渡す値）、artists（addArtists に渡す値）
export function planLocalMove(local, account, newId = randomId) {
  const accSongs = (account?.songs ?? []).map(normalizeSong);
  const byKey = new Map(accSongs.map((s) => [dupKey(s), s]));
  const ids = new Set(accSongs.map((s) => s.id));
  const add = [];
  const skipped = [];
  for (const raw of local?.songs ?? []) {
    const s = normalizeSong(raw);
    const hit = byKey.get(dupKey(s));
    if (hit) {
      skipped.push({ from: s.id, to: hit.id });
      continue;
    }
    let id = s.id;
    if (typeof id !== 'string' || !id || id.includes('/') || ids.has(id)) id = newId();
    ids.add(id);
    add.push({ id, from: s.id, data: toPayload(s) });
  }

  const ap = account?.profile ?? {};
  const lp = local?.profile ?? {};
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
  const profile = {};
  const ar = obj(ap.range) ?? {};
  const lr = obj(lp.range) ?? {};
  const range = { ...ar };
  let rangeChanged = false;
  for (const f of RANGE_FIELDS) {
    if (isNote(lr[f.id]) && !isNote(ar[f.id])) {
      range[f.id] = lr[f.id];
      rangeChanged = true;
    }
  }
  if (rangeChanged) profile.range = range;
  if (Array.isArray(lp.tags)) {
    const base = Array.isArray(ap.tags) ? ap.tags : PRESET_TAGS;
    const extra = [...new Set(lp.tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()))].filter((t) => !base.includes(t));
    if (extra.length) profile.tags = [...base, ...extra];
  }
  if (!obj(ap.prefs) && obj(lp.prefs)) profile.prefs = sanitizePrefs(lp.prefs);
  const ac = tagColorMap(ap.tagColors);
  const lc = [...tagColorMap(lp.tagColors)].filter(([t]) => !ac.has(t));
  if (lc.length) profile.tagColors = tagColorList(new Map([...ac, ...lc]));
  const la = obj(lp.aliases);
  if (la) {
    const aa = obj(ap.aliases) ?? {};
    const add = Object.entries(la).filter(([k, v]) => !(k in aa) && typeof v === 'string' && v);
    if (add.length) profile.aliases = { ...aa, ...Object.fromEntries(add) };
  }
  const have = new Set(Array.isArray(ap.artists) ? ap.artists : []);
  const artists = [...new Set((Array.isArray(lp.artists) ? lp.artists : []).filter((n) => typeof n === 'string' && n && !have.has(n)))];
  return { add, skipped, profile, artists };
}
