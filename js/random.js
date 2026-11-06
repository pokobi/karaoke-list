// ランダム選曲の条件と抽選。
import { RANGE_FIELDS, isNote, recommendKey } from './notes.js';

export const COUNTS = [1, 3, 5, 10];
export const EXCLUDE_DAYS = [0, 3, 7, 14, 30];
const DAY = 86_400_000;

export function defaultRandomOptions() {
  return {
    artists: [],
    tags: [],
    favoriteOnly: false,
    fitsVoice: false,
    fitsMode: 'recommend', // recommend：おすすめキーにすれば収まる / current：今のキーで収まる
    excludeDays: 0,
    preferLessSung: false,
    range: { low: {}, chestHigh: {}, falsettoHigh: {} },
    count: 1,
  };
}

const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
const note = (v) => (isNote(v) ? v : undefined);

export function sanitizeRandomOptions(o) {
  const d = defaultRandomOptions();
  if (!o || typeof o !== 'object') return d;
  const range = {};
  for (const f of RANGE_FIELDS) range[f.id] = { min: note(o.range?.[f.id]?.min), max: note(o.range?.[f.id]?.max) };
  return {
    artists: strings(o.artists),
    tags: strings(o.tags),
    favoriteOnly: o.favoriteOnly === true,
    fitsVoice: o.fitsVoice === true,
    fitsMode: o.fitsMode === 'current' ? 'current' : 'recommend',
    excludeDays: EXCLUDE_DAYS.includes(o.excludeDays) ? o.excludeDays : 0,
    preferLessSung: o.preferLessSung === true,
    range,
    count: COUNTS.includes(o.count) ? o.count : 1,
  };
}

export function hasVoiceRange(voice) {
  return RANGE_FIELDS.some((f) => isNote(voice?.[f.id]));
}

// 自分の音域に収まるか。音域が入力されていない曲は判断できないので、収まらない扱いにする
// margin を指定すると、自分の最高音を margin 半音だけ低く見積もる（おすすめキーの余裕と同じ）
export function fitsVoice(song, voice, mode, margin = 0) {
  if (!hasVoiceRange(voice)) return false;
  if (!isNote(song.low) && !isNote(song.chestHigh) && !isNote(song.falsettoHigh)) return false;
  if (mode === 'recommend') return recommendKey(song, voice, { margin })?.fits === true;
  const k = song.key ?? 0;
  if (isNote(song.low) && isNote(voice.low) && song.low + k < voice.low) return false;
  if (isNote(song.chestHigh) && isNote(voice.chestHigh) && song.chestHigh + k > voice.chestHigh - margin) return false;
  if (isNote(song.falsettoHigh)) {
    const top = isNote(voice.falsettoHigh) ? voice.falsettoHigh : voice.chestHigh;
    if (isNote(top) && song.falsettoHigh + k > top - margin) return false;
  }
  return true;
}

// 音域の高さの条件（キー適用後の音で比べる）
function inRange(song, range) {
  for (const f of RANGE_FIELDS) {
    const { min, max } = range?.[f.id] ?? {};
    const hasMin = isNote(min);
    const hasMax = isNote(max);
    if (!hasMin && !hasMax) continue;
    const v = isNote(song[f.id]) ? song[f.id] + (song.key ?? 0) : null;
    if (v == null) {
      // 裏声なしの曲は「裏声最高音が○○以下」には当てはまるものとする（一覧の絞り込みと同じ）
      if (f.id === 'falsettoHigh' && !hasMin) continue;
      return false;
    }
    if (hasMin && v < min) return false;
    if (hasMax && v > max) return false;
  }
  return true;
}

export function hasRandomRange(o) {
  return RANGE_FIELDS.some((f) => isNote(o.range?.[f.id]?.min) || isNote(o.range?.[f.id]?.max));
}

// 条件に合う曲
export function randomPool(songs, o, { voice, now = Date.now(), margin = 0 } = {}) {
  return songs.filter((s) => {
    if (o.favoriteOnly && !s.favorite) return false;
    if (o.artists.length && !o.artists.includes(s.artist)) return false;
    if (o.tags.length && !o.tags.some((t) => s.tags.includes(t))) return false;
    if (o.excludeDays && s.lastSungAt && now - s.lastSungAt < o.excludeDays * DAY) return false;
    if (o.fitsVoice && !fitsVoice(s, voice, o.fitsMode, margin)) return false;
    if (!inRange(s, o.range)) return false;
    return true;
  });
}

// 重複なしで count 曲を選ぶ。weighted のときは、歌った回数が少ない曲ほど選ばれやすい。
// avoid に入っている曲は、ほかに選べる曲が足りる限り選ばない（「もう一度」で同じ曲が続かないように）。
export function pickRandom(pool, count, { weighted = false, avoid = new Set(), rng = Math.random } = {}) {
  const n = Math.min(count, pool.length);
  const fresh = pool.filter((s) => !avoid.has(s.id));
  let candidates = fresh.length >= n ? fresh : pool;
  const picked = [];
  candidates = [...candidates];
  const weight = (s) => (weighted ? 1 / (1 + (s.singCount || 0)) : 1);
  while (picked.length < n && candidates.length) {
    const total = candidates.reduce((sum, s) => sum + weight(s), 0);
    let r = rng() * total;
    let i = 0;
    for (; i < candidates.length - 1; i++) {
      r -= weight(candidates[i]);
      if (r < 0) break;
    }
    picked.push(candidates[i]);
    candidates.splice(i, 1);
  }
  return picked;
}
