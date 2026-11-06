// メモなどのテキストから曲を読み取り、iTunes の検索結果と照らし合わせるための処理（画面に触らない部分）。
// 1 行に 1 曲。区切り（- / ／ ： タブ 「」 など）や、アーティスト名と曲名の順番はばらばらでもよい。
// 登録するアーティスト名・曲名は iTunes の検索結果から取り、行の文字は「どの結果が合うか」の判定に使う。
import { normalize } from './text.js';
import { baseTitle } from './itunes.js';

export const MAX_LINES = 300;

// 比べるときの形。記号・空白・全角半角・ひらがなカタカナの違いを無視する
export const looseKey = (s) => normalize(s).replace(/[\s・･.\-‐‑–—―_'’"“”!?,、。~〜♪☆★/|:;()[\]{}「」『』【】&+*#]/g, '');

// よく使われるアーティストの略称（ここにない略称は、確認画面で選び直すと覚える）
const BUILTIN_ALIASES = {
  'ミセス': 'Mrs. GREEN APPLE',
  'ミセグリ': 'Mrs. GREEN APPLE',
  'ミセスグリーンアップル': 'Mrs. GREEN APPLE',
  'ヒゲダン': 'Official髭男dism',
  '髭男': 'Official髭男dism',
  'セカオワ': 'SEKAI NO OWARI',
  'バンプ': 'BUMP OF CHICKEN',
  'ラッド': 'RADWIMPS',
  'ワンオク': 'ONE OK ROCK',
  'ミスチル': 'Mr.Children',
  'アジカン': 'ASIAN KUNG-FU GENERATION',
  'ドリカム': 'DREAMS COME TRUE',
  'サザン': 'サザンオールスターズ',
  'ポルノ': 'ポルノグラフィティ',
  'いきもの': 'いきものがかり',
  'ずとまよ': 'ずっと真夜中でいいのに。',
  'リョクシャカ': '緑黄色社会',
  'マイヘア': 'My Hair is Bad',
  'ヤバT': 'ヤバイTシャツ屋さん',
  'ゲス極': 'ゲスの極み乙女',
  'キンプリ': 'King & Prince',
  'ももクロ': 'ももいろクローバーZ',
  'ケツメ': 'ケツメイシ',
  'エレカシ': 'エレファントカシマシ',
  'クリープ': 'クリープハイプ',
  'フジファブ': 'フジファブリック',
  'ベボベ': 'Base Ball Bear',
  'ブルエン': 'BLUE ENCOUNT',
  'ナンバガ': 'NUMBER GIRL',
  'ビーズ': "B'z",
  'ラルク': "L'Arc~en~Ciel",
  'オーラル': 'THE ORAL CIGARETTES',
  'ドロス': '[Alexandros]',
  'スカパラ': '東京スカパラダイスオーケストラ',
  'ユニゾン': 'UNISON SQUARE GARDEN',
  'ハンブレ': 'ハンブレッダーズ',
  'フォーリミ': '04 Limited Sazabys',
  'ホルモン': 'マキシマム ザ ホルモン',
  'ブルーハーツ': 'THE BLUE HEARTS',
  'ハイスタ': 'Hi-STANDARD',
  'スキマ': 'スキマスイッチ',
};

// 略称の表（looseKey → アーティスト名）。覚えた略称（learned）を優先する
export function aliasMap(learned = {}) {
  const m = new Map();
  for (const [k, v] of Object.entries(BUILTIN_ALIASES)) m.set(looseKey(k), v);
  for (const [k, v] of Object.entries(learned ?? {})) if (typeof v === 'string' && v) m.set(k, v);
  return m;
}

// 覚えた略称を、保存できる形に整える
export function sanitizeAliases(v, limit = 500) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out = {};
  for (const [k, a] of Object.entries(v).slice(-limit)) {
    if (typeof a === 'string' && a.trim() && k && k === looseKey(k)) out[k] = a.trim();
  }
  return out;
}

// 行頭の箇条書きの記号・番号
const BULLET = /^(?:[-*+>]\s+|[・•●○◯◎□■◆◇☆★♪♫※]+\s*|\d{1,3}\s*[.)．）、]\s*|[①-⑳]\s*|\[[ xX]?\]\s*)/;

// テキストを 1 曲ずつの行に分ける（空行・同じ行は除く）
export function parseLines(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    let s = raw.replace(/[ 　]+/g, ' ').trim();
    for (let i = 0; i < 2; i++) s = s.replace(BULLET, '').trim();
    const k = looseKey(s);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(s.slice(0, 120));
  }
  return out;
}

const BRACKET = /^(.*?)[「『【]([^」』】]+)[」』】](.*)$/;
// 区切りの候補（上ほど確か）。最初に見つかった区切りで 2 つに分ける
const SEPARATORS = [
  /\t+/,
  /\s+[-－‐‑–—―ー〜～~]+\s+/,
  /\s+[/／|｜:：]+\s+/,
  /\s*[/／|｜]\s*/,
  /\s*[:：]\s*/,
  /\s*[、，,]\s*/,
  /\s*[－–—―]\s*/,
  /\s*-\s*/,
  /\s+by\s+/i,
];

// 行を「どちらかがアーティスト名、どちらかが曲名」の 2 つに分ける。title は曲名だと分かっている側（0 か 1）
export function splitLine(line) {
  const m = BRACKET.exec(line);
  if (m) {
    const outside = `${m[1]} ${m[3]}`.trim();
    if (outside) return { parts: [outside, m[2].trim()], title: 1 };
  }
  for (const re of SEPARATORS) {
    const hit = re.exec(line);
    if (!hit || hit.index === 0) continue;
    const a = line.slice(0, hit.index).trim();
    const b = line.slice(hit.index + hit[0].length).trim();
    if (looseKey(a) && looseKey(b)) return { parts: [a, b], title: null };
  }
  const p = /^(.+?)\s*[(（]([^()（）]+)[)）]$/.exec(line);
  if (p) return { parts: [p[1].trim(), p[2].trim()], title: null };
  return null;
}

// 行を調べる準備：区切り・略称から、検索語とアーティスト名の手がかりを作る
// aliases：aliasMap() の戻り値。knownArtists：looseKey → 登録済みのアーティスト名
export function analyzeLine(line, { aliases = aliasMap(), knownArtists = new Map() } = {}) {
  const split = splitLine(line);
  const parts = split?.parts ?? null;
  let titleSide = split?.title ?? null;
  const tokens = parts ?? line.split(' ').filter(Boolean);
  const termTokens = [...tokens];
  let artistHint = null;
  let artistToken = -1;
  tokens.forEach((t, i) => {
    if (artistHint) return;
    const a = aliases.get(looseKey(t));
    if (a) {
      artistHint = a;
      artistToken = i;
      termTokens[i] = a;
    }
  });
  if (!artistHint && parts) {
    for (const i of [0, 1]) {
      const n = knownArtists.get(looseKey(parts[i]));
      if (n && i !== titleSide) {
        artistHint = n;
        artistToken = i;
        break;
      }
    }
  }
  if (parts && artistToken >= 0 && titleSide == null) titleSide = 1 - artistToken;
  const rest = tokens.filter((_, i) => i !== artistToken).join(' ');
  return {
    line,
    parts,
    tokens,
    titleSide,
    artistHint,
    artistToken,
    term: termTokens.join(' ').slice(0, 100),
    key: looseKey(line),
    restKey: artistToken >= 0 ? looseKey(rest) : '',
    runs: wordRuns(line),
  };
}

// 区切りで分けた語の、続いた並び（1 語・2 語…）。曲名・アーティスト名が「語のまとまり」として書かれているかを見る
const WORD_SEP = /[\t/／|｜:：、，,「」『』【】()（）]|\s[-－‐‑–—―ー〜～~]+\s/g;
function wordRuns(line) {
  const words = line.replace(WORD_SEP, ' ').split(/\s+/).map(looseKey).filter(Boolean).slice(0, 12);
  const runs = new Set();
  for (let i = 0; i < words.length; i++) {
    let k = '';
    for (let j = i; j < words.length; j++) runs.add(k += words[j]);
  }
  return runs;
}

// 最初の検索で見つからなかったときの検索語（曲名だけで探す。最大 2 つ）
export function fallbackTerms(info) {
  const list = [];
  if (info.parts) {
    const order = info.titleSide === 1 ? [1, 0] : [0, 1];
    for (const i of order) if (i !== info.artistToken) list.push(info.parts[i]);
  } else if (info.tokens.length >= 2) {
    list.push(info.tokens.slice(1).join(' '), info.tokens.slice(0, -1).join(' '));
  }
  return [...new Set(list.map((s) => s.trim()).filter((s) => looseKey(s) && s !== info.term))].slice(0, 2);
}

// ライブ版・インスト版などの印
const VARIANT = /live|ライブ|instrumental|インスト|off\s*vocal|karaoke|カラオケ|remix|リミックス|acoustic|アコースティック|tv\s*size|tv\s*ver|short\s*ver|cover|カバー|orchestra|オーケストラ|music\s*box|オルゴール/i;

const sameLoose = (a, b) => !!a && !!b && (a === b || (a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a))));

// 検索結果の 1 曲が、行とどのくらい合うか
function scoreSong(s, rank, info) {
  const tb = looseKey(baseTitle(s.title));
  const tf = looseKey(s.title);
  const ak = looseKey(s.artist);
  if (!tb || !ak) return null;
  const pk = (info.parts ?? []).map(looseKey);
  const runs = info.runs ?? new Set();
  let as = 0;
  if (info.artistHint && sameLoose(ak, looseKey(info.artistHint))) as = 5;
  else if (pk.includes(ak) || runs.has(ak)) as = 5;
  else if (pk.some((p, i) => i !== info.titleSide && p !== tb && sameLoose(p, ak))) as = 4;
  else if (ak.length >= 4 && info.key.replace(tb, '').includes(ak)) as = 4;

  // 曲名は、区切った片側・語のまとまりと一致するときだけ確かとする（ほかの語の一部と一致しても採らない）
  let ts = 0;
  if (pk.includes(tb) || pk.includes(tf) || runs.has(tb) || runs.has(tf) || info.key === tb || info.restKey === tb) ts = 6;
  else if (as >= 4 && info.key.includes(tb) && info.key.replace(tb, '').replace(ak, '') === '') ts = 4;
  else if (pk.some((p) => p.length >= 3 && tb.includes(p)) || (info.restKey.length >= 3 && tb.includes(info.restKey))) ts = 2;

  const variant = !VARIANT.test(info.line) && (VARIANT.test(s.title.slice(baseTitle(s.title).length)) || VARIANT.test(s.album ?? ''));
  const total = ts + as - (variant ? 3 : 0) - rank * 0.04;
  return { song: s, ts, as, variant, total, group: `${ak}|${tb}` };
}

export function scoreSongs(songs, info) {
  return (songs ?? []).map((s, i) => scoreSong(s, i, info)).filter(Boolean);
}

// 何回かの検索結果をまとめる。同じアーティストの同じ曲（別の版）は、いちばん合うものだけ残す
export function mergeCandidates(...lists) {
  const best = new Map();
  for (const c of lists.flat()) {
    const cur = best.get(c.group);
    if (!cur || c.total > cur.total) best.set(c.group, c);
  }
  return [...best.values()].sort((a, b) => b.total - a.total);
}

// 判定。status：sure（ほぼ確実）・check（要確認）・none（見つからない）
export function judge(cands, info) {
  const good = cands.filter((c) => c.ts >= 4);
  if (!good.length) {
    const weak = cands.filter((c) => c.ts >= 2 && c.as >= 4);
    const others = cands.filter((c) => c.as >= 4 && !weak.includes(c));
    if (weak.length) return { status: 'check', pick: weak[0], candidates: [...weak, ...others].slice(0, 12) };
    return { status: 'none', pick: null, candidates: [...others, ...cands.filter((c) => c.ts >= 2 && !others.includes(c))].slice(0, 12) };
  }
  const best = good[0];
  let status = best.as >= 4 ? 'sure' : 'check';
  // 同じくらい合う、ほかのアーティストの曲があるとき
  if (status === 'sure' && good.some((c) => c !== best && c.as >= best.as && c.total >= best.total - 0.3 && looseKey(c.song.artist) !== looseKey(best.song.artist))) status = 'check';
  const rest = cands.filter((c) => !good.includes(c) && c.as >= 4);
  return { status, pick: best, candidates: [...good, ...rest].slice(0, 12) };
}

// 見つからなかった行の、アーティスト名・曲名の見当
export function guessSong(info) {
  if (info.parts) {
    const [a, b] = info.parts;
    if (info.titleSide === 0) return { artist: info.artistHint ?? b, title: a };
    if (info.titleSide === 1) return { artist: info.artistHint ?? a, title: b };
    return { artist: a, title: b };
  }
  if (info.artistHint) return { artist: info.artistHint, title: info.tokens.filter((_, i) => i !== info.artistToken).join(' ') };
  return { artist: '', title: info.line };
}

// 行の中で、曲名以外の部分（アーティスト名のつもりで書いた部分）。略称を覚えるのに使う
export function leftoverText(info, title) {
  const tk = looseKey(baseTitle(title));
  if (!tk) return '';
  let rest;
  if (info.parts) {
    const k = info.parts.map(looseKey);
    if (k[0] === tk || tk.includes(k[0])) rest = info.parts[1];
    else if (k[1] === tk || tk.includes(k[1])) rest = info.parts[0];
    else return '';
  } else {
    const left = info.tokens.filter((t) => !tk.includes(looseKey(t)));
    if (left.length === info.tokens.length) return '';
    rest = left.join(' ');
  }
  rest = rest.trim();
  return rest.length <= 20 && !/\s/.test(rest) ? rest : '';
}

// 確認画面で決めたアーティスト名から、覚える略称（looseKey → アーティスト名）。覚えないときは null
export function aliasToLearn(info, artist, title) {
  const left = leftoverText(info, title);
  const k = looseKey(left);
  const ak = looseKey(artist);
  if (!k || !ak || sameLoose(k, ak) || k === looseKey(title)) return null;
  return [k, artist];
}
