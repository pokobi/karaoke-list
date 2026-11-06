// 音階・キーの計算。
// 音階は lowA = 0 から半音ごとに 1 ずつ増える整数で扱う（hihiG# = 59）。

export const NOTE_NAMES = ['A', 'A#', 'B', 'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#'];
export const OCTAVES = ['low', 'mid1', 'mid2', 'hi', 'hihi'];
export const NOTE_MIN = 0;
export const NOTE_MAX = OCTAVES.length * 12 - 1;

export const KEY_MIN = -24;
export const KEY_MAX = 24;
export const OCTAVE_DOWN = -12;

export const RANGE_FIELDS = [
  { id: 'low', label: '最低音', short: '最低' },
  { id: 'chestHigh', label: '地声最高音', short: '地声' },
  { id: 'falsettoHigh', label: '裏声最高音', short: '裏声' },
];

export function isNote(v) {
  return Number.isInteger(v);
}

// 選択肢の範囲外（キー変更で lowA より下や hihiG# より上になった音）は
// lowlow / hihihi のように接頭辞を伸ばして表記する。
export function octaveName(oct) {
  if (oct >= 0 && oct < OCTAVES.length) return OCTAVES[oct];
  if (oct < 0) return 'low'.repeat(1 - oct);
  return 'hi'.repeat(oct - 2);
}

export function noteName(index) {
  if (!isNote(index)) return '';
  const oct = Math.floor(index / 12);
  const n = ((index % 12) + 12) % 12;
  return octaveName(oct) + NOTE_NAMES[n];
}

export function parseNote(text) {
  if (text == null) return null;
  const s = String(text).normalize('NFKC').replace(/♯/g, '#').replace(/\s+/g, '');
  const m = s.match(/^((?:low)+|mid1|mid2|(?:hi)+)([A-G])(#?)$/i);
  if (!m) return null;
  const pre = m[1].toLowerCase();
  let oct;
  if (pre.startsWith('low')) oct = 1 - pre.length / 3;
  else if (pre === 'mid1') oct = 1;
  else if (pre === 'mid2') oct = 2;
  else oct = 2 + pre.length / 2;
  const n = NOTE_NAMES.indexOf(m[2].toUpperCase() + m[3]);
  if (n < 0) return null;
  return oct * 12 + n;
}

export function clampKey(k) {
  return Math.max(KEY_MIN, Math.min(KEY_MAX, Math.round(k)));
}

export function formatKey(k) {
  if (!k) return '±0';
  return k > 0 ? `+${k}` : `−${-k}`;
}

// ---- オク下・オク上 --------------------------------------------------------
// 曲の key は「原曲から実際に何半音ずらして歌うか」。octave は、1 オクターブ下（-1）・上（+1）で
// 歌っているか。カラオケ機で設定するキーは key - 12 × octave になる。
// 例：オク下で機械のキーを +4 にすると、key = -8、octave = -1。

export const MACHINE_KEY_MAX = 7;
export const OCTAVE_LABELS = { [-1]: 'オク下', 1: 'オク上' };

export function machineKey(key, octave = 0) {
  return key - 12 * (octave || 0);
}

// 実際のキーを、機械のキーとオクターブに分ける。機械で設定できる ±7 に収まるときはオクターブを使わない
export function splitKey(total) {
  if (total < -MACHINE_KEY_MAX) return { octave: -1, machine: total + 12 };
  if (total > MACHINE_KEY_MAX) return { octave: 1, machine: total - 12 };
  return { octave: 0, machine: total };
}

// 保存されたオクターブ。記録がない古いデータは、キーの値から推測する（例：−12 は「オク下 ±0」）
export function octaveOf(raw, key) {
  return raw === -1 || raw === 0 || raw === 1 ? raw : splitKey(Number.isInteger(key) ? key : 0).octave;
}

export function describeKey(key, octave = 0) {
  const machine = machineKey(key, octave);
  const oct = OCTAVE_LABELS[octave] ?? '';
  const main = formatKey(machine);
  return {
    octave,
    machine,
    oct,
    main,
    actual: formatKey(key),
    text: oct ? `${oct} ${main}` : main,
  };
}

// オク下・オク上を切り替える。機械のキーはそのままにする
export function toggleOctave(key, octave, target) {
  const next = octave === target ? 0 : target;
  return { key: clampKey(machineKey(key, octave) + 12 * next), octave: next };
}

export function keyTone(k) {
  if (k > 0) return 'up';
  if (k < 0) return 'down';
  return 'zero';
}

// 自分の音域に収まるキーのうち、原曲キーに最も近いものを返す。
// 収まるキーがない場合は、はみ出しが最小になるキー（その中で原曲に近いもの）を返す。
// 計算に使える音が揃っていなければ null。
export function recommendKey(song, voice) {
  if (!song || !voice) return null;
  let kmin = -Infinity;
  let kmax = Infinity;
  if (isNote(song.low) && isNote(voice.low)) kmin = voice.low - song.low;
  if (isNote(song.chestHigh) && isNote(voice.chestHigh)) kmax = Math.min(kmax, voice.chestHigh - song.chestHigh);
  if (isNote(song.falsettoHigh)) {
    const top = isNote(voice.falsettoHigh) ? voice.falsettoHigh : voice.chestHigh;
    if (isNote(top)) kmax = Math.min(kmax, top - song.falsettoHigh);
  }
  if (kmin === -Infinity && kmax === Infinity) return null;
  if (kmin <= kmax) {
    return { key: clampKey(Math.min(Math.max(0, kmin), kmax)), fits: true, short: 0 };
  }
  return { key: clampKey(Math.min(Math.max(0, kmax), kmin)), fits: false, short: kmin - kmax };
}
