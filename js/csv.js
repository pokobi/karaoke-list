// バックアップ用 CSV の書き出し・読み込み。
import { noteName, parseNote, isNote } from './notes.js';

export const COLUMNS = [
  { id: 'artist', label: 'アーティスト' },
  { id: 'title', label: '曲名' },
  { id: 'low', label: '最低音', type: 'note' },
  { id: 'chestHigh', label: '地声最高音', type: 'note' },
  { id: 'falsettoHigh', label: '裏声最高音', type: 'note' },
  { id: 'key', label: 'キー', type: 'int' },
  { id: 'favorite', label: 'お気に入り', type: 'bool' },
  { id: 'tags', label: 'タグ', type: 'tags' },
  { id: 'score', label: '採点', type: 'num' },
  { id: 'singCount', label: '歌った回数', type: 'int' },
  { id: 'lastSungAt', label: '最終歌唱日', type: 'date' },
  { id: 'memo', label: 'メモ' },
  { id: 'createdAt', label: '登録日', type: 'date' },
];

const pad = (n) => String(n).padStart(2, '0');

export function formatDateTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function parseDateTime(text) {
  const s = String(text ?? '').normalize('NFKC').trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return undefined;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  return Number.isNaN(d.getTime()) ? undefined : d.getTime();
}

function quote(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function cell(song, col) {
  const v = song[col.id];
  switch (col.type) {
    case 'note': return isNote(v) ? noteName(v) : '';
    case 'bool': return v ? '1' : '';
    case 'tags': return (v ?? []).join('|');
    case 'date': return formatDateTime(v);
    case 'int': return col.id === 'singCount' && !v ? '' : String(v ?? '');
    default: return v ?? '';
  }
}

export function songsToCSV(songs) {
  const lines = [COLUMNS.map((c) => c.label).join(',')];
  for (const s of songs) lines.push(COLUMNS.map((c) => quote(cell(s, c))).join(','));
  return lines.join('\r\n') + '\r\n';
}

export function parseCSV(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  while (i < src.length) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r' || c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
      i += c === '\r' && src[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

const HEADER_ALIASES = new Map();
for (const c of COLUMNS) {
  HEADER_ALIASES.set(c.label, c);
  HEADER_ALIASES.set(c.id.toLowerCase(), c);
}
HEADER_ALIASES.set('アーティスト名', HEADER_ALIASES.get('アーティスト'));
HEADER_ALIASES.set('歌手', HEADER_ALIASES.get('アーティスト'));
HEADER_ALIASES.set('曲', HEADER_ALIASES.get('曲名'));
HEADER_ALIASES.set('タイトル', HEADER_ALIASES.get('曲名'));
HEADER_ALIASES.set('地声', HEADER_ALIASES.get('地声最高音'));
HEADER_ALIASES.set('裏声', HEADER_ALIASES.get('裏声最高音'));

// 行の配列から曲を作る。列が存在しない項目は undefined のままにする
// （既存の曲に上書きするとき、その項目を変えないため）。
export function rowsToSongs(rows) {
  const errors = [];
  if (!rows.length) return { songs: [], errors: ['空のファイルです'] };
  const header = rows[0].map((h) => HEADER_ALIASES.get(h.normalize('NFKC').trim()) ?? HEADER_ALIASES.get(h.trim().toLowerCase()) ?? null);
  const titleIdx = header.findIndex((c) => c?.id === 'title');
  if (titleIdx < 0) return { songs: [], errors: ['「曲名」の列が見つかりません'] };
  const songs = [];
  rows.slice(1).forEach((r, ri) => {
    const line = ri + 2;
    const s = {};
    header.forEach((col, ci) => {
      if (!col) return;
      const raw = (r[ci] ?? '').trim();
      switch (col.type) {
        case 'note': {
          if (!raw) { s[col.id] = null; break; }
          const v = parseNote(raw);
          if (v == null) { errors.push(`${line}行目: ${col.label}「${raw}」を読み取れません`); s[col.id] = null; } else s[col.id] = v;
          break;
        }
        case 'int': {
          const v = raw === '' ? 0 : Number(raw.normalize('NFKC').replace(/^\+/, ''));
          if (!Number.isInteger(v)) { errors.push(`${line}行目: ${col.label}「${raw}」を読み取れません`); s[col.id] = 0; } else s[col.id] = v;
          break;
        }
        case 'num': {
          if (!raw) { s[col.id] = null; break; }
          const v = Number(raw.normalize('NFKC'));
          if (!Number.isFinite(v)) { errors.push(`${line}行目: ${col.label}「${raw}」を読み取れません`); s[col.id] = null; } else s[col.id] = v;
          break;
        }
        case 'bool':
          s[col.id] = /^(1|true|yes|はい|○|◯|★)$/i.test(raw);
          break;
        case 'tags':
          s[col.id] = raw ? raw.split(/[|｜]/).map((t) => t.trim()).filter(Boolean) : [];
          break;
        case 'date': {
          const v = parseDateTime(raw);
          if (v === undefined) { errors.push(`${line}行目: ${col.label}「${raw}」を読み取れません`); s[col.id] = null; } else s[col.id] = v;
          break;
        }
        default:
          s[col.id] = raw;
      }
    });
    if (!s.title) { errors.push(`${line}行目: 曲名が空のため読み飛ばしました`); return; }
    s.artist = s.artist ?? '';
    songs.push(s);
  });
  return { songs, errors };
}
