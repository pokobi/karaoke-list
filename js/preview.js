// 曲の詳細画面の「試聴」。音源を、今のキーに合わせて高さだけ変えて再生する（テンポは変えない）。
// 音源は、この端末に保存した音楽ファイルと、追加機能（plugins.js）が用意したもの。
// 音楽ファイルはこの端末の中（IndexedDB）にだけ保存し、ほかの端末には同期しない。
import { esc, icon, toast, confirmDialog } from './ui.js';
import { describeKey, machineKey, formatKey } from './notes.js';

export const MAX_FILE_BYTES = 200 * 1024 * 1024;
const FILE_ACCEPT = 'audio/*,.mp3,.m4a,.aac,.wav,.flac,.ogg,.oga,.opus';

export function previewSupported() {
  return typeof window !== 'undefined'
    && typeof window.AudioContext === 'function'
    && typeof window.AudioWorkletNode === 'function'
    && typeof indexedDB !== 'undefined';
}

// ---- 音楽ファイルの保存（この端末） -------------------------------------

const DB_NAME = 'karaoke-list-audio';
const STORE = 'files';
let dbPromise = null;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

async function run(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// 曲の ID ごとに { blob, name, type, size, addedAt } を保存する
export const audioFiles = {
  get: (id) => run('readonly', (st) => st.get(id)),
  put: (id, rec) => run('readwrite', (st) => st.put(rec, id)),
  remove: (id) => run('readwrite', (st) => st.delete(id)),
  clear: () => run('readwrite', (st) => st.clear()),
  async summary() {
    const recs = (await run('readonly', (st) => st.getAll())) ?? [];
    return { count: recs.length, bytes: recs.reduce((sum, r) => sum + (r?.size ?? 0), 0) };
  },
};

export function formatBytes(n) {
  if (!(n > 0)) return '0 KB';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---- 再生のしくみ（1 つだけ作って使い回す） -------------------------------

const engine = { ctx: null, audio: null, node: null, gain: null, ready: null, owner: null, unlocked: false };

// Apple Music の公式バッジ（Apple のマーケティングツールが配っている画像）
const APPLE_MUSIC_BADGE = 'https://toolbox.marketingtools.apple.com/api/v2/badges/listen-on-apple-music/badge/ja-jp?size=250x83';

function linkHTML(link) {
  if (!link) return '';
  if (link.badge === 'apple-music') {
    return `<a class="pv-badge" href="${esc(link.href)}" target="_blank" rel="noopener noreferrer"><img src="${APPLE_MUSIC_BADGE}" alt="${esc(link.label)}" width="105" height="35" referrerpolicy="no-referrer"></a>`;
  }
  return `<a class="pv-link" href="${esc(link.href)}" target="_blank" rel="noopener noreferrer">${esc(link.label)}</a>`;
}

// ---- 音量（PC など、マウスで操作する端末で表示する。この端末に保存する） ----------

const VOLUME_KEY = 'karaoke-list:preview-volume:v1';
const volume = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(VOLUME_KEY)) || {};
    const level = Number(v.level);
    return { level: Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 1, muted: v.muted === true };
  } catch {
    return { level: 1, muted: false };
  }
})();

// 音量つまみの位置（0〜1）から、音の大きさの倍率へ。耳の感じ方に近づけるため 2 乗する
export function volumeGain({ level, muted }) {
  return muted ? 0 : Math.min(1, Math.max(0, level)) ** 2;
}

function applyVolume() {
  const g = engine.gain?.gain;
  if (!g) return;
  const v = volumeGain(volume);
  // 急に変えると「プツッ」と鳴るので、少しだけなめらかに変える
  g.cancelScheduledValues(engine.ctx.currentTime);
  g.setTargetAtTime(v, engine.ctx.currentTime, 0.015);
}

function saveVolume() {
  try {
    localStorage.setItem(VOLUME_KEY, JSON.stringify(volume));
  } catch { /* 保存できなくても再生はできる */ }
}

// 一瞬だけの無音（iPhone で、タップの中で 1 回再生しておくと、あとから再生できるようになる）
function silentUrl() {
  const n = 800;
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + n, true);
  str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true);
  v.setUint32(28, 8000, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  str(36, 'data');
  v.setUint32(40, n, true);
  new Uint8Array(buf, 44).fill(128);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

const MEDIA_EVENTS = ['play', 'playing', 'pause', 'waiting', 'timeupdate', 'durationchange', 'loadedmetadata', 'seeking', 'ended', 'error'];

// タップの処理の中で呼ぶ（iPhone では、タップの中でないと音を出す準備ができない）
function prepare() {
  if (!engine.ctx) {
    engine.ctx = new window.AudioContext({ latencyHint: 'playback' });
    const a = new Audio();
    a.preload = 'auto';
    a.crossOrigin = 'anonymous';
    engine.audio = a;
    for (const type of MEDIA_EVENTS) a.addEventListener(type, (e) => engine.owner?.onMedia(e));
    engine.ready = (async () => {
      await engine.ctx.audioWorklet.addModule(new URL('./pitch-worklet.js', import.meta.url));
      const node = new AudioWorkletNode(engine.ctx, 'pitch-shift', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
      });
      const gain = engine.ctx.createGain();
      gain.gain.value = volumeGain(volume);
      engine.ctx.createMediaElementSource(a).connect(node).connect(gain).connect(engine.ctx.destination);
      engine.node = node;
      engine.gain = gain;
    })();
    engine.ready.catch(() => {});
  }
  // iPhone：マナーモードでも音が出るようにする（対応している iOS のみ）
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
  } catch { /* 対応していない */ }
  engine.ctx.resume().catch(() => {});
  if (!engine.unlocked) {
    engine.unlocked = true;
    const a = engine.audio;
    const url = silentUrl();
    a.src = url;
    a.play().catch(() => {}).finally(() => URL.revokeObjectURL(url));
  }
}

const post = (msg) => engine.node?.port.postMessage(msg);
const setShift = (semis) => {
  const param = engine.node?.parameters.get('semitones');
  if (param && param.value !== semis) param.value = semis;
};

// ---- 詳細画面の試聴欄 -----------------------------------------------------

/**
 * 詳細画面を開くたびに作る。
 * getSong()：表示中の曲
 * sources：追加機能が用意した音源（plugins.js の previewSource）
 * ctx：追加機能に渡す窓口（ctx.saveExt(patch) で曲の保存欄 song.ext に足す）
 */
export function createPreview({ getSong, sources = [], ctx = {} }) {
  const song0 = getSong();
  const id = song0?.id;
  const p = {
    el: null,
    sig: '',
    file: undefined, // undefined：読み込み中／null：なし
    fileUrl: null,
    srcId: 'file',
    chosen: false,
    original: false,
    status: 'idle', // idle | loading | playing | paused | error
    message: '',
    loaded: null, // 読み込んだ音源（ファイルの日時か URL）
    urls: {}, // 追加機能の音源の URL
    retried: false,
    dragging: false,
    destroyed: false,
  };
  if (sources.length) p.srcId = sources[0].id;

  const isOwner = () => engine.owner === api;
  const source = () => sources.find((s) => s.id === p.srcId) ?? null;
  // 再生するキー。オク下・オク上の分（±12）は入れず、カラオケ機で設定するキーだけ動かす（大きく動かすと音が歪むため）
  const playKey = (s) => (s ? machineKey(s.key ?? 0, s.octave) : 0);
  const semitones = () => (p.original ? 0 : playKey(getSong()));

  audioFiles.get(id).then((rec) => {
    if (p.destroyed) return;
    p.file = rec?.blob ? rec : null;
    if (p.file && !p.chosen) p.srcId = 'file';
    paint();
  }).catch(() => {
    p.file = null;
    paint();
  });

  function setStatus(status, message = '') {
    p.status = status;
    p.message = message;
    paint();
  }

  function stop() {
    if (!isOwner()) return;
    const a = engine.audio;
    a.pause();
    a.removeAttribute('src');
    a.load();
    post({ type: 'reset' });
    engine.ctx.suspend().catch(() => {});
    engine.owner = null;
    p.loaded = null;
  }

  function pause() {
    if (!isOwner()) return;
    engine.audio.pause();
    engine.ctx.suspend().catch(() => {});
  }

  async function urlFor(src, opts = {}) {
    if (!src) {
      if (!p.file) return null;
      p.fileUrl ??= URL.createObjectURL(p.file.blob);
      return { url: p.fileUrl, key: `file:${p.file.addedAt}` };
    }
    let url = opts.refresh ? null : p.urls[src.id];
    if (!url) {
      url = await src.resolve(getSong(), ctx, opts);
      if (!url) return null;
      p.urls[src.id] = url;
    }
    return { url, key: `${src.id}:${url}` };
  }

  async function play(opts = {}) {
    prepare();
    if (engine.owner && engine.owner !== api) engine.owner.stop();
    engine.owner = api;
    const src = source();
    setStatus('loading', src ? '音源を探しています…' : '');
    try {
      const target = await urlFor(src, opts);
      if (p.destroyed || !isOwner()) return;
      if (!target) {
        setStatus('error', src ? `${src.label}が見つかりませんでした` : '音楽ファイルがありません');
        return;
      }
      await engine.ready;
      if (p.destroyed || !isOwner()) return;
      setStatus('loading', '読み込んでいます…');
      setShift(semitones());
      const a = engine.audio;
      if (p.loaded !== target.key) {
        post({ type: 'reset' });
        a.src = target.url;
        p.loaded = target.key;
      }
      await engine.ctx.resume();
      await a.play();
    } catch (err) {
      if (p.destroyed || !isOwner()) return;
      console.error(err);
      if (err?.name === 'NotAllowedError') setStatus('paused', 'もう一度 ▶ を押してください');
      // 読み込めなかったとき（NotSupportedError）は、audio の error の処理（onError）に任せる
      else if (err?.name !== 'AbortError' && err?.name !== 'NotSupportedError') setStatus('error', err?.userMessage ?? '再生できませんでした');
    }
  }

  // 音源の読み込みに失敗したとき。追加機能の音源は、URL を取り直して 1 回だけやり直す
  function onError() {
    const src = source();
    if (src && !p.retried) {
      p.retried = true;
      p.loaded = null;
      play({ refresh: true });
      return;
    }
    p.loaded = null;
    setStatus('error', src ? '再生できませんでした' : '再生できませんでした（この形式のファイルには対応していない可能性があります）');
  }

  function onMedia(e) {
    const a = engine.audio;
    // 音源を読み込む前（準備のための無音など）の出来事は扱わない
    if (!p.loaded) return;
    switch (e.type) {
      case 'play':
        if (engine.ctx.state !== 'running') engine.ctx.resume().catch(() => {});
        break;
      case 'playing': setStatus('playing'); break;
      case 'waiting': if (p.status === 'playing') setStatus('loading', '読み込んでいます…'); break;
      case 'pause':
        if (p.status !== 'error') setStatus('paused');
        break;
      case 'ended':
        setStatus('paused');
        break;
      case 'seeking': post({ type: 'reset' }); break;
      case 'error': onError(); break;
      default:
    }
    if (e.type === 'timeupdate' || e.type === 'durationchange' || e.type === 'loadedmetadata' || e.type === 'seeking') paintTime(a);
  }

  function paintTime(a = engine.audio) {
    const el = p.el;
    if (!el) return;
    const mine = isOwner() && p.loaded;
    const dur = mine && Number.isFinite(a?.duration) ? a.duration : 0;
    const cur = mine ? a.currentTime : 0;
    const seek = el.querySelector('.pv-seek');
    if (seek) {
      seek.disabled = !dur;
      if (!p.dragging) seek.value = dur ? String(Math.round((cur / dur) * 1000)) : '0';
      seek.style.setProperty('--pv-p', `${(Number(seek.value) / 10).toFixed(1)}%`);
    }
    const c = el.querySelector('[data-pv-time="cur"]');
    const d = el.querySelector('[data-pv-time="dur"]');
    if (c && !p.dragging) c.textContent = formatTime(cur);
    if (d) d.textContent = dur ? formatTime(dur) : '-:--';
  }

  async function pickFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = FILE_ACCEPT;
    input.hidden = true;
    document.body.append(input);
    const done = () => input.remove();
    input.addEventListener('cancel', done, { once: true });
    input.addEventListener('change', async () => {
      const f = input.files?.[0];
      done();
      if (!f) return;
      if (f.size > MAX_FILE_BYTES) {
        toast(`ファイルが大きすぎます（${formatBytes(MAX_FILE_BYTES)} まで）`);
        return;
      }
      const rec = { blob: f, name: f.name, type: f.type, size: f.size, addedAt: Date.now() };
      try {
        await audioFiles.put(id, rec);
      } catch (err) {
        console.error(err);
        toast('保存できませんでした（端末の空き容量が足りない可能性があります）');
        return;
      }
      navigator.storage?.persist?.().catch(() => {});
      if (p.srcId === 'file' && isOwner()) stop();
      if (p.fileUrl) URL.revokeObjectURL(p.fileUrl);
      p.fileUrl = null;
      p.file = rec;
      p.srcId = 'file';
      p.chosen = true;
      setStatus('idle');
      toast('音楽ファイルを保存しました（この端末だけ）');
    }, { once: true });
    input.click();
  }

  async function removeFile() {
    const ok = await confirmDialog({
      title: '音楽ファイルを外しますか？',
      message: 'この端末に保存したファイルを削除します。元のファイルは消えません。',
      ok: '外す',
      danger: true,
    });
    if (!ok || p.destroyed) return;
    if (p.srcId === 'file') stop();
    await audioFiles.remove(id).catch(() => {});
    if (p.fileUrl) URL.revokeObjectURL(p.fileUrl);
    p.fileUrl = null;
    p.file = null;
    setStatus('idle');
  }

  async function pickSource(src) {
    const wasPlaying = isOwner() && p.status === 'playing';
    let changed = false;
    try {
      changed = await src.pick.run(getSong(), ctx);
    } catch (err) {
      console.error(err);
      toast('うまく動きませんでした');
    }
    if (!changed || p.destroyed) return;
    delete p.urls[src.id];
    p.retried = false;
    if (p.srcId === src.id && isOwner()) {
      // 再生中なら、そのまま新しい音源に切り替える（音を出すしくみは止めない）
      p.loaded = null;
      if (wasPlaying) play();
      else {
        stop();
        setStatus('idle');
      }
    } else {
      paint();
    }
  }

  function onClick(e) {
    const b = e.target.closest('[data-pv]');
    if (!b || p.destroyed) return;
    const act = b.dataset.pv;
    if (act === 'toggle') {
      if (isOwner() && (p.status === 'playing' || p.status === 'loading')) pause();
      else {
        p.retried = false;
        play();
      }
    } else if (act === 'src') {
      if (b.dataset.src === p.srcId) return;
      if (isOwner()) stop();
      p.srcId = b.dataset.src;
      p.chosen = true;
      p.retried = false;
      setStatus('idle');
    } else if (act === 'cur' || act === 'orig') {
      p.original = act === 'orig';
      if (isOwner()) setShift(semitones());
      paint();
    } else if (act === 'mute') {
      volume.muted = !volume.muted;
      if (!volume.muted && volume.level === 0) volume.level = 0.5;
      applyVolume();
      saveVolume();
      paintVolume();
    } else if (act === 'pick') pickFile();
    else if (act === 'remove') removeFile();
    else if (act === 'pick-src') {
      const src = source();
      if (src?.pick) pickSource(src);
    }
  }

  function onInput(e) {
    if (e.target.classList.contains('pv-vol-range')) {
      volume.level = Number(e.target.value) / 100;
      if (volume.level > 0) volume.muted = false;
      applyVolume();
      if (e.type === 'change') saveVolume();
      paintVolume(e.target);
      return;
    }
    if (!e.target.classList.contains('pv-seek')) return;
    p.dragging = true;
    const a = engine.audio;
    const dur = isOwner() && Number.isFinite(a?.duration) ? a.duration : 0;
    const c = p.el?.querySelector('[data-pv-time="cur"]');
    if (c) c.textContent = formatTime((Number(e.target.value) / 1000) * dur);
    e.target.style.setProperty('--pv-p', `${(Number(e.target.value) / 10).toFixed(1)}%`);
    if (e.type === 'change') {
      p.dragging = false;
      if (dur) a.currentTime = (Number(e.target.value) / 1000) * dur;
    }
  }

  function volumeHTML() {
    const off = volume.muted || volume.level === 0;
    const pct = Math.round(volume.level * 100);
    return `<div class="pv-vol">
        <button type="button" class="pv-mute" data-pv="mute" aria-pressed="${volume.muted}" aria-label="${volume.muted ? '消音を解除' : '消音'}" title="${volume.muted ? '消音を解除' : '消音'}">${icon(off ? 'volume-off' : 'volume')}</button>
        <input type="range" class="pv-vol-range" min="0" max="100" step="1" value="${volume.muted ? 0 : pct}" aria-label="音量" style="--pv-p:${volume.muted ? 0 : pct}%">
      </div>`;
  }

  // 音量の表示だけを描き直す（つまみを動かしている最中は、つまみ自体は描き直さない）
  function paintVolume(range = null) {
    const box = p.el?.querySelector('.pv-vol');
    if (!box) return;
    if (range) {
      range.style.setProperty('--pv-p', `${range.value}%`);
      const btn = box.querySelector('.pv-mute');
      const off = volume.muted || volume.level === 0;
      btn.innerHTML = icon(off ? 'volume-off' : 'volume');
      btn.setAttribute('aria-pressed', String(volume.muted));
      return;
    }
    box.outerHTML = volumeHTML();
  }

  function sourceInfoHTML() {
    const src = source();
    if (!src) {
      if (!p.file) return '';
      return `<div class="pv-meta">
          <span class="pv-name">${icon('music')}<span class="pv-fname">${esc(p.file.name || '音楽ファイル')}</span><small>${formatBytes(p.file.size)}</small></span>
          <span class="pv-acts">
            <button type="button" class="pv-link" data-pv="pick">変更</button>
            <button type="button" class="pv-link" data-pv="remove">外す</button>
          </span>
        </div>`;
    }
    let info = null;
    try {
      info = src.info?.(getSong()) ?? null;
    } catch (err) {
      console.error(err);
    }
    return `<div class="pv-meta">
        <span class="pv-name">${icon('music')}<span class="pv-fname">${info?.text ? esc(info.text) : esc(src.hint ?? '')}</span></span>
        <span class="pv-acts">
          ${linkHTML(info?.link)}
          ${src.pick ? `<button type="button" class="pv-link" data-pv="pick-src">${esc(src.pick.label)}</button>` : ''}
        </span>
      </div>`;
  }

  function bodyHTML(s) {
    const src = source();
    if (!src && p.file === undefined) return '<p class="hint">読み込んでいます…</p>';
    if (!src && !p.file) {
      return `<button type="button" class="pill" data-pv="pick">${icon('music')}音楽ファイルを選ぶ</button>
        <p class="hint">この端末にある曲のファイルを、今のキーに合わせて再生します（テンポは変わりません）。ファイルはこの端末にだけ保存します。</p>`;
    }
    const playing = isOwner() && (p.status === 'playing' || p.status === 'loading');
    const kd = describeKey(s.key, s.octave);
    const shift = playKey(s);
    const keyLabel = shift === 0 ? '' : `<div class="seg seg-sm pv-keys" role="group" aria-label="再生するキー">
        <button type="button" data-pv="cur" aria-pressed="${!p.original}">今のキー（${esc(formatKey(shift))}）</button>
        <button type="button" data-pv="orig" aria-pressed="${p.original}">原曲キー</button>
      </div>`;
    // オク下・オク上のときは、その分を入れずに再生していることを書いておく
    const octNote = kd.oct && !p.original
      ? `<p class="pv-msg pv-oct">${icon('alert')}<span>${esc(kd.text)} のうち、${esc(kd.oct)}の分は試聴に入れず、${shift === 0 ? '原曲キー' : esc(formatKey(shift))}で再生します（大きく変えると音が歪むため）。</span></p>`
      : '';
    return `<div class="pv-player">
        <button type="button" class="pv-play${playing ? ' on' : ''}" data-pv="toggle" aria-label="${playing ? '一時停止' : '再生'}">${icon(playing ? 'pause' : 'play')}</button>
        <div class="pv-bar">
          <input type="range" class="pv-seek" min="0" max="1000" step="1" value="0" aria-label="再生位置" disabled>
          <div class="pv-time"><span data-pv-time="cur">0:00</span><span data-pv-time="dur">-:--</span></div>
        </div>
        ${volumeHTML()}
      </div>
      ${keyLabel}
      ${octNote}
      ${p.message ?`<p class="pv-msg${p.status === 'error' ? ' err' : ''}">${esc(p.message)}</p>` : ''}
      ${sourceInfoHTML()}`;
  }

  function sectionHTML(s) {
    const tabs = sources.length
      ? `<div class="seg seg-sm pv-srcs" role="group" aria-label="音源">
          ${sources.map((src) => `<button type="button" data-pv="src" data-src="${esc(src.id)}" aria-pressed="${p.srcId === src.id}">${esc(src.label)}</button>`).join('')}
          <button type="button" data-pv="src" data-src="file" aria-pressed="${p.srcId === 'file'}">音楽ファイル</button>
        </div>`
      : '';
    return `<div class="pv-head"><span class="label">試聴</span>${tabs}</div>${bodyHTML(s)}`;
  }

  // 詳細画面を描くたびに呼ぶ（el は詳細画面の試聴欄）
  function paint(el = p.el) {
    if (p.destroyed || !el) return;
    const s = getSong();
    if (!s) return;
    if (el !== p.el) {
      p.el = el;
      p.sig = '';
      el.addEventListener('click', onClick);
      el.addEventListener('input', onInput);
      el.addEventListener('change', onInput);
      el.addEventListener('pointerup', () => { p.dragging = false; });
    }
    let info = '';
    try {
      info = JSON.stringify(source()?.info?.(s) ?? null);
    } catch { /* 表示のときに扱う */ }
    const fileSig = p.file === undefined ? 'loading' : p.file && [p.file.name, p.file.addedAt];
    const sig = JSON.stringify([p.srcId, fileSig, p.status, p.message, p.original, isOwner(), s.key, s.octave, info]);
    if (sig !== p.sig) {
      p.sig = sig;
      el.innerHTML = sectionHTML(s);
    }
    if (isOwner()) setShift(semitones());
    paintTime();
  }

  const api = {
    paint,
    onMedia,
    stop,
    destroy() {
      if (p.destroyed) return;
      stop();
      p.destroyed = true;
      if (p.fileUrl) URL.revokeObjectURL(p.fileUrl);
      p.fileUrl = null;
    },
  };
  return api;
}
