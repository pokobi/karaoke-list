// テキスト・ファイル・再生リストから曲をまとめて追加する画面と、書き出し方のガイド

import { YOUTUBE_API_KEY } from '../config.js';
import { emptySong, normalizeSong, toPayload, dupKey, newSongId } from '../model.js';
import { waitForSlot, searchSongs, trimReading } from '../itunes.js';
import {
  MAX_LINES, parseLines, analyzeLine, aliasMap, sanitizeAliases, scoreSongs, mergeCandidates, judge, fallbackTerms,
  guessSong, aliasToLearn, looseKey,
} from '../text-import.js';
import { $, esc, icon, openSheet, confirmDialog, toast } from '../ui.js';
import { plugins } from '../plugins.js';
import { MAX_TABLE_ROWS, decodeText, parseTable, detectColumns, tableToItems, sourceName } from '../table-import.js';
import { findPlaylistIds, isPlaylistLine, fetchPlaylist, fetchVideos, videoToSong } from '../youtube.js';
import { state, rangeAuto, sleep } from './core.js';
import { runRangeBatch } from './plugin-host.js';
import { runArtJob } from './artwork.js';

// ---- テキストから追加 -------------------------------------------------

// iTunes で検索する。1 分あたりの回数の上限に達しているときは、空くまで待つ
async function searchWhenFree(term, alive) {
  for (let i = 0; i < 6; i++) {
    await waitForSlot();
    if (!alive()) return null;
    const res = await searchSongs(term, { limit: 25 });
    if (res) return res;
  }
  throw new Error('iTunes rate limited');
}

const TI_STATUS = {
  pending: { label: '待機中', cls: 'wait' },
  searching: { label: '調べています…', cls: 'wait' },
  check: { label: '要確認', cls: 'check' },
  none: { label: '見つかりません', cls: 'none' },
  error: { label: '調べられませんでした', cls: 'none' },
};
const TI_FILTERS = [['all', 'すべて'], ['check', '要確認'], ['none', '見つからない'], ['dup', '登録済み・重複']];
const TI_PER_MINUTE = 15;

// YouTube の公式 API のキー。追加機能（plugins.js）が別のキーを持っていれば、そちらを使う
const ytApiKey = () => plugins.find((p) => p.youtubeApiKey)?.youtubeApiKey ?? YOUTUBE_API_KEY;
const TI_FILE_ACCEPT = '.csv,.tsv,.txt,.zip,text/csv,text/tab-separated-values,text/plain,application/zip';
// Takeout の ZIP の中で読む CSV（再生リスト・ライブラリの曲）。コメントや登録チャンネルなどは読まない
const TAKEOUT_CSV = /(playlist|再生リスト|music|ミュージック|音楽|library|ライブラリ)/i;
const TAKEOUT_SKIP = /(comment|コメント|subscription|登録チャンネル|channel|チャンネル)/i;

// テキスト（メモ）・曲の一覧のファイル（CSV など）・YouTube の再生リストのリンクから、曲をまとめて追加する
export function openTextImport() {
  const aliases = aliasMap(state.profile.aliases);
  const knownArtists = new Map([...state.profile.artists, ...state.songs.map((s) => s.artist)].filter(Boolean).map((n) => [looseKey(n), n]));
  // gen：調べている処理の世代。中止・やり直し・閉じたときに増やし、古い処理の結果を捨てる
  const job = { gen: 0, running: false, rows: [], filter: 'all', source: '', qk: '', text: '', files: [], fileSeq: 0, pending: null };
  const sheet = openSheet(`<div class="timport">
      <div class="sheet-head"><h3>まとめて追加</h3><button type="button" class="icon-btn" data-act="close" aria-label="閉じる">${icon('close')}</button></div>
      <div class="sheet-body" data-role="body"></div>
      <div class="sheet-foot" data-role="foot"></div>
    </div>`, {
    label: 'まとめて追加',
    className: 'history-layer',
    onClose: () => { job.gen++; },
  });
  const body = $('[data-role="body"]', sheet.el);
  const foot = $('[data-role="foot"]', sheet.el);

  // 登録済み・重複の判定は、行が多くても速いように、描くたびに 1 回だけまとめて求める
  let dupCache = null;
  const busy = (r) => r.status === 'pending' || r.status === 'searching';
  const dupOf = (r) => {
    if (busy(r) || !r.title) return null;
    if (!dupCache) {
      dupCache = new Map();
      const registered = new Set(state.songs.map(dupKey));
      const seen = new Set();
      for (const o of job.rows) {
        if (busy(o) || !o.title) continue;
        const k = dupKey(o);
        if (registered.has(k)) dupCache.set(o.i, 'registered');
        else if (seen.has(k)) dupCache.set(o.i, 'repeat');
        else if (o.checked) seen.add(k);
      }
    }
    return dupCache.get(r.i) ?? null;
  };
  const canAdd = (r) => !busy(r) && r.checked && !!r.title && !dupOf(r);
  const kindOf = (r) => {
    if (busy(r)) return 'wait';
    if (dupOf(r)) return 'dup';
    if (r.status === 'check') return 'check';
    if (r.status === 'none' || r.status === 'error') return 'none';
    return 'ok';
  };

  // ---- 入力 ----

  const filesHTML = () => job.files.map((f) => {
    const note = f.kind === 'cols'
      ? `<button type="button" class="link-btn" data-cols="${f.id}">列を選ぶ</button>`
      : f.kind === 'error'
        ? `<span class="ti-fnote err">${esc(f.error)}</span>`
        : `<span class="ti-fnote">${f.kind === 'lines' ? `${f.lines.length}行` : `${f.items.length}曲`}</span>`;
    return `<li class="ti-file">${icon('list')}<span class="ti-fname">${esc(f.name)}</span>${note}<button type="button" class="icon-btn sm" data-unfile="${f.id}" aria-label="${esc(f.name)}を外す">${icon('close')}</button></li>`;
  }).join('');
  const paintFiles = () => {
    const el = $('[data-role="files"]', body);
    if (el) el.innerHTML = filesHTML();
  };

  const showInput = () => {
    job.gen++;
    job.running = false;
    job.rows = [];
    job.pending = null;
    sheet.dismissible = true;
    body.innerHTML = `<p class="hint ti-lead">メモ・音楽サービスから書き出した曲の一覧（CSV など）・YouTube の再生リストのリンクから、曲をまとめて追加します。追加する前に確認・修正できます。</p>
      <textarea class="input ti-text" data-role="text" rows="8" placeholder="アーティスト名 - 曲名&#10;曲名 / アーティスト名&#10;https://music.youtube.com/playlist?list=…" aria-label="追加する曲の一覧" autocomplete="off" autocapitalize="off" spellcheck="false">${esc(job.text)}</textarea>
      <div class="ti-tools">
        <button type="button" class="pill" data-act="pick-files">${icon('upload')}ファイルを選ぶ</button>
        <button type="button" class="link-btn" data-act="guide">書き出し方のガイド</button>
      </div>
      <ul class="ti-files" data-role="files"></ul>
      <p class="hint">テキストは、1行を1曲として iTunes で調べます。アーティスト名と曲名の順番や区切り（- や / など）は、ばらばらでも構いません（${MAX_LINES}行まで）。ファイルは、CSV・タブ区切りのテキストと、YouTube Music の Takeout の ZIP を読めます（${MAX_TABLE_ROWS}曲まで）。YouTube の再生リストのリンク（公開・限定公開）を貼ると、その中の曲を読み込みます。</p>`;
    paintFiles();
    foot.className = 'sheet-foot';
    foot.innerHTML = `<button type="button" class="btn primary" data-act="run">${icon('search')}読み込む</button>`;
  };

  // 読み込んだファイルを、表（曲名・アーティストの列が分かるもの）・列を選ぶ表・1行1曲のテキストのどれかにする
  const addEntry = (name, text) => {
    const id = ++job.fileSeq;
    const table = parseTable(text);
    if (table && table.length >= 2 && table[0].length >= 2) {
      const cols = detectColumns(table[0]);
      if (!cols) {
        job.files.push({ id, name, kind: 'cols', table });
        return;
      }
      const items = tableToItems(table.slice(1), cols, sourceName(name));
      job.files.push(items.length ? { id, name, kind: 'table', items } : { id, name, kind: 'error', error: '曲が見つかりませんでした' });
      return;
    }
    const lines = parseLines(text);
    job.files.push(lines.length ? { id, name, kind: 'lines', lines } : { id, name, kind: 'error', error: '曲が見つかりませんでした' });
  };
  const readZip = async (file) => {
    const { unzipSync } = await import('../vendor/fflate.js');
    const files = unzipSync(new Uint8Array(await file.arrayBuffer()), {
      filter: (f) => /\.csv$/i.test(f.name) && TAKEOUT_CSV.test(f.name) && !TAKEOUT_SKIP.test(f.name),
    });
    let n = 0;
    for (const [path, data] of Object.entries(files)) {
      const table = parseTable(decodeText(data));
      const cols = table && table.length >= 2 ? detectColumns(table[0]) : null;
      if (!cols) continue;
      const items = tableToItems(table.slice(1), cols, sourceName(path));
      if (!items.length) continue;
      job.files.push({ id: ++job.fileSeq, name: sourceName(path), kind: 'table', items });
      n++;
    }
    if (!n) job.files.push({ id: ++job.fileSeq, name: file.name, kind: 'error', error: '曲の一覧（CSV）が見つかりませんでした' });
  };
  const pickFiles = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = TI_FILE_ACCEPT;
    input.multiple = true;
    input.hidden = true;
    document.body.append(input);
    const done = () => input.remove();
    input.addEventListener('cancel', done, { once: true });
    input.addEventListener('change', async () => {
      const files = [...(input.files ?? [])];
      done();
      for (const f of files) {
        try {
          if (/\.zip$/i.test(f.name)) await readZip(f);
          else addEntry(f.name, decodeText(new Uint8Array(await f.arrayBuffer())));
        } catch (err) {
          console.warn(err);
          job.files.push({ id: ++job.fileSeq, name: f.name, kind: 'error', error: '読み込めませんでした' });
        }
      }
      paintFiles();
      const need = job.files.find((f) => f.kind === 'cols');
      if (need) pickColumns(need);
    }, { once: true });
    input.click();
  };

  // 見出しで曲名・アーティストの列が分からない表は、最初の数行を見せて列を選んでもらう
  const pickColumns = (f) => {
    const rows = f.table;
    const width = Math.max(...rows.slice(0, 20).map((r) => r.length));
    const label = (i) => `${i + 1}列目${rows[0][i] ? `（${rows[0][i].slice(0, 20)}）` : ''}`;
    const opts = (sel) => Array.from({ length: width }, (_, i) => `<option value="${i}"${i === sel ? ' selected' : ''}>${esc(label(i))}</option>`).join('');
    const sub = openSheet(`<div class="ti-pick">
        <div class="sheet-head"><h3>列を選ぶ</h3><button type="button" class="icon-btn" data-act="close" aria-label="閉じる">${icon('close')}</button></div>
        <div class="sheet-body">
          <p class="hint">「${esc(f.name)}」の、曲名とアーティストの列を選んでください。</p>
          <div class="ti-colprev"><table>${rows.slice(0, 5).map((r) => `<tr>${Array.from({ length: width }, (_, i) => `<td>${esc(r[i] ?? '')}</td>`).join('')}</tr>`).join('')}</table></div>
          <label class="label" for="ti-col-title">曲名の列</label>
          <select class="input" id="ti-col-title" data-role="title">${opts(0)}</select>
          <label class="label" for="ti-col-artist">アーティストの列</label>
          <select class="input" id="ti-col-artist" data-role="artist"><option value="-1">なし</option>${opts(width > 1 ? 1 : -1)}</select>
          <label class="switch-row ti-colhead"><span>1行目は見出し（曲ではない）</span><input type="checkbox" class="switch" data-role="header" checked></label>
        </div>
        <div class="sheet-foot"><button type="button" class="btn primary" data-act="ok">この列で読む</button></div>
      </div>`, { label: '列を選ぶ', className: 'history-layer' });
    sub.el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.act === 'close') sub.close();
      else if (b.dataset.act === 'ok') {
        const cols = { title: +$('[data-role="title"]', sub.el).value, artist: +$('[data-role="artist"]', sub.el).value, videoId: -1, playlist: -1 };
        const items = tableToItems($('[data-role="header"]', sub.el).checked ? rows.slice(1) : rows, cols, sourceName(f.name));
        Object.assign(f, items.length ? { kind: 'table', items } : { kind: 'error', error: '曲が見つかりませんでした' });
        delete f.table;
        sub.close();
        paintFiles();
      }
    });
  };

  // ---- 読み込む ----

  const start = async () => {
    const ta = $('[data-role="text"]', body);
    job.text = ta.value;
    const need = job.files.find((f) => f.kind === 'cols');
    if (need) {
      toast(`「${need.name}」の曲名・アーティストの列を選んでください`);
      pickColumns(need);
      return;
    }
    const ytIds = findPlaylistIds(job.text);
    const rest = job.text.split(/\r?\n/).filter((l) => !isPlaylistLine(l)).join('\n');
    let structured = [];
    let lines = [];
    // 貼り付けた表（見出しから列が分かるもの）は、ファイルと同じように読む
    const pasted = parseTable(rest);
    const pastedCols = pasted && pasted.length >= 2 ? detectColumns(pasted[0]) : null;
    if (pastedCols) structured.push(...tableToItems(pasted.slice(1), pastedCols, '貼り付けた表'));
    else lines.push(...parseLines(rest).map((line) => ({ line, source: '' })));
    for (const f of job.files) {
      if (f.kind === 'table') structured.push(...f.items.map((it) => ({ ...it })));
      else if (f.kind === 'lines') lines.push(...f.lines.map((line) => ({ line, source: f.name })));
    }
    if (!structured.length && !lines.length && !ytIds.length) {
      toast('曲が書かれた行がありません');
      ta.focus();
      return;
    }
    const gen = ++job.gen;
    const alive = () => gen === job.gen;
    sheet.dismissible = false;
    foot.innerHTML = '';
    body.innerHTML = '<div class="ti-status" data-role="status"></div>';
    const say = (msg) => {
      const el = $('[data-role="status"]', body);
      if (el) el.innerHTML = `<span>${esc(msg)}</span>`;
    };
    say('読み込んでいます…');
    const errors = [];
    const key = ytApiKey();
    const idOnly = () => structured.filter((it) => it.videoId && !it.title);
    if ((ytIds.length || idOnly().length) && !key) errors.push('YouTube の読み込みは、このページでは使えません');
    else {
      for (const [k, id] of ytIds.entries()) {
        say(`YouTube の再生リストを読んでいます（${k + 1} / ${ytIds.length}）…`);
        try {
          const p = await fetchPlaylist(id, key, { max: MAX_TABLE_ROWS });
          if (!alive()) return;
          for (const v of p.items) {
            const s = videoToSong(v);
            structured.push({ title: trimReading(s.title), artist: s.artist, sure: s.sure, source: p.title || 'YouTube の再生リスト' });
          }
        } catch (err) {
          if (!alive()) return;
          console.warn(err);
          errors.push(`YouTube の再生リスト：${err.userMessage ?? '読み込めませんでした'}`);
        }
      }
      const ids = idOnly();
      if (ids.length) {
        say(`YouTube の動画の曲名を読んでいます（${ids.length}本）…`);
        try {
          const map = await fetchVideos(ids.slice(0, MAX_TABLE_ROWS).map((it) => it.videoId), key);
          if (!alive()) return;
          for (const it of ids) {
            const v = map.get(it.videoId);
            if (!v) continue;
            const s = videoToSong(v);
            Object.assign(it, { title: trimReading(s.title), artist: s.artist, sure: s.sure });
          }
        } catch (err) {
          if (!alive()) return;
          console.warn(err);
          errors.push(`YouTube の動画：${err.userMessage ?? '読み込めませんでした'}`);
        }
      }
    }
    if (!alive()) return;
    structured = structured.filter((it) => it.title);
    if (errors.length) toast(errors.join('\n'), { duration: 8000 });
    if (structured.length > MAX_TABLE_ROWS) {
      toast(`一度に読めるのは${MAX_TABLE_ROWS}曲までです。最初の${MAX_TABLE_ROWS}曲を読みます`, { duration: 6000 });
      structured = structured.slice(0, MAX_TABLE_ROWS);
    }
    if (lines.length > MAX_LINES) {
      toast(`テキストは一度に${MAX_LINES}行までです。最初の${MAX_LINES}行を調べます`, { duration: 6000 });
      lines = lines.slice(0, MAX_LINES);
    }
    if (!structured.length && !lines.length) {
      showInput();
      return;
    }
    if (structured.length) chooseMode(structured, lines);
    else buildRows([], lines, 'itunes');
  };

  // 表や再生リストから読んだ曲の、登録の仕方を選ぶ
  const chooseMode = (structured, lines) => {
    job.pending = { structured, lines };
    sheet.dismissible = true;
    const min = Math.ceil((structured.length + lines.length) / TI_PER_MINUTE);
    body.innerHTML = `<p class="ti-mode-lead">${structured.length}曲を読み込みました。${lines.length ? `テキストの${lines.length}行は、どちらを選んでも iTunes で調べます。` : ''}登録の仕方を選んでください。</p>
      <button type="button" class="ti-mode" data-mode="as-is"><b>${icon('check')}そのまま登録する（おすすめ）</b><span>書いてある曲名・アーティストのまま、すぐ確認画面に進みます。ジャケット画像は、追加したあとに裏で探します。</span></button>
      <button type="button" class="ti-mode" data-mode="itunes"><b>${icon('search')}iTunes で確かめる</b><span>1曲ずつ iTunes で調べて、正しい表記とジャケット画像を入れます。${min >= 2 ? `約${min}分かかります。` : ''}</span></button>`;
    foot.className = 'sheet-foot';
    foot.innerHTML = '<button type="button" class="btn" data-act="back-input">戻る</button>';
  };

  const buildRows = (structured, lines, mode) => {
    job.pending = null;
    const rows = [];
    for (const it of structured) {
      const info = analyzeLine(it.artist ? `${it.artist}\t${it.title}` : it.title, { aliases, knownArtists });
      if (it.artist) info.titleSide = 1;
      const r = {
        i: rows.length, line: `${it.artist ? `${it.artist} - ` : ''}${it.title}`, source: it.source || '', info, structured: true,
        cands: [], pick: null, artist: it.artist, title: it.title, artwork: null,
      };
      if (mode === 'as-is') {
        r.status = it.sure === false || !it.artist ? 'check' : 'sure';
        r.checked = true;
      } else {
        r.status = 'pending';
        r.checked = false;
      }
      rows.push(r);
    }
    for (const { line, source } of lines) {
      rows.push({ i: rows.length, line, source, info: analyzeLine(line, { aliases, knownArtists }), status: 'pending', cands: [], pick: null, artist: '', title: '', artwork: null, checked: false });
    }
    job.rows = rows;
    job.filter = 'all';
    job.source = '';
    job.qk = '';
    // 登録済みの曲と、同じ曲の 2 つ目以降は、チェックを外しておく
    dupCache = null;
    const marks = rows.map((r) => dupOf(r));
    rows.forEach((r, k) => { if (marks[k]) r.checked = false; });
    dupCache = null;
    sheet.dismissible = false;
    const sources = [...new Set(rows.map((r) => r.source).filter(Boolean))];
    body.innerHTML = `<div class="ti-status" data-role="status"></div>
      <div class="ti-tools2">
        <label class="search sm">${icon('search')}<input type="search" data-role="q" placeholder="曲名・アーティストで絞り込み" autocomplete="off" aria-label="曲名・アーティストで絞り込み"></label>
        ${sources.length > 1 ? `<select class="input ti-source" data-role="source" aria-label="ファイル・再生リストで絞り込み"><option value="">すべてのファイル・再生リスト</option>${sources.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('')}</select>` : ''}
      </div>
      <div class="ti-filter" data-role="filter"></div>
      <div class="ti-bulk"><button type="button" class="link-btn" data-act="check-shown">表示中をすべてチェック</button><button type="button" class="link-btn" data-act="uncheck-shown">表示中のチェックを外す</button></div>
      <ul class="hist-list ti-list" data-role="list"></ul>`;
    foot.className = 'sheet-foot ti-foot';
    body.scrollTop = 0;
    if (rows.some(busy)) run();
    else paintAll();
  };

  const setPick = (r, s) => {
    r.pick = s;
    r.artist = s.artist;
    r.title = trimReading(s.title);
    r.artwork = s.artwork ?? null;
  };

  const resolveRow = async (r, alive) => {
    const info = r.info;
    try {
      let cands = mergeCandidates(scoreSongs(await searchWhenFree(info.term, alive), info));
      if (!alive()) return;
      let j = judge(cands, info);
      if (j.status === 'none') {
        for (const t of fallbackTerms(info)) {
          const more = await searchWhenFree(t, alive);
          if (!alive()) return;
          cands = mergeCandidates(cands, scoreSongs(more, info));
          j = judge(cands, info);
          if (j.status !== 'none') break;
        }
      }
      r.status = j.status;
      r.cands = j.candidates.map((c) => c.song);
      if (j.pick) setPick(r, j.pick.song);
      else if (r.structured) Object.assign(r, { pick: null, artwork: null });
      else Object.assign(r, guessSong(info), { pick: null, artwork: null });
    } catch (e) {
      if (!alive()) return;
      console.warn(e);
      r.status = 'error';
      if (!r.structured) Object.assign(r, guessSong(info), { pick: null, artwork: null });
    }
    // 要確認の行もチェックを付けておく。見つからない行・登録済みの曲は外しておく。
    // 表から読んだ曲は、iTunes で見つからなくても、書いてあるとおりに入れられるようチェックを付けておく
    r.checked = r.status === 'sure' || r.status === 'check' || (r.structured && !!r.title);
    dupCache = null;
    if (dupOf(r)) r.checked = false;
  };

  const run = async () => {
    const gen = ++job.gen;
    const alive = () => gen === job.gen;
    job.running = true;
    paintAll();
    for (const r of job.rows) {
      if (!alive()) return;
      if (r.status !== 'pending') continue;
      r.status = 'searching';
      paintRow(r);
      await resolveRow(r, alive);
      if (!alive()) return;
      paintRow(r);
      paintStatus();
      paintFilter();
      paintFoot();
    }
    job.running = false;
    paintAll();
  };

  const stop = () => {
    job.gen++;
    job.running = false;
    for (const r of job.rows) if (r.status === 'searching') r.status = 'pending';
    paintAll();
  };

  // ---- 確認画面 ----

  const rowHTML = (r) => {
    const dup = dupOf(r);
    const st = dup ? { label: dup === 'registered' ? '登録済み' : '重複', cls: 'dup' } : TI_STATUS[r.status];
    const wait = busy(r);
    const can = !wait && !dup && !!r.title;
    const art = r.artwork ? `<img src="${esc(r.artwork)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : icon('music');
    const src = r.structured ? r.source : r.source ? `${r.source}・${r.line}` : r.line;
    return `<li class="ti-row${st ? ` is-${st.cls}` : ''}" data-i="${r.i}">
        <input type="checkbox" data-check="${r.i}"${r.checked && can ? ' checked' : ''}${can ? '' : ' disabled'} aria-label="追加する">
        <span class="hist-art">${art}</span>
        <button type="button" class="ti-main" data-edit="${r.i}"${wait ? ' disabled' : ''}>
          ${wait && !r.structured
            ? `<span class="hist-t">${esc(r.line)}</span>`
            : `<span class="hist-t">${esc(r.title || '（曲名なし）')}</span><span class="hist-a">${esc(r.artist || '（アーティスト名なし）')}</span>`}
          <span class="ti-src">${st ? `<span class="ti-badge">${st.label}</span>` : ''}${src && !(wait && !r.structured) ? `<span class="ti-line">${esc(src)}</span>` : ''}</span>
        </button>
        ${wait ? '' : `<button type="button" class="icon-btn ti-edit" data-edit="${r.i}" aria-label="選び直す・直す">${icon('pen')}</button>`}
      </li>`;
  };
  const shown = (r) => (job.filter === 'all' || kindOf(r) === job.filter)
    && (!job.source || r.source === job.source)
    && (!job.qk || looseKey(`${r.title} ${r.artist} ${r.line}`).includes(job.qk));
  const paintRow = (r) => {
    dupCache = null;
    const el = $(`.ti-row[data-i="${r.i}"]`, body);
    if (!shown(r)) {
      el?.remove();
      return;
    }
    if (el) el.outerHTML = rowHTML(r);
    else paintList();
  };
  const paintList = () => {
    const list = $('[data-role="list"]', body);
    if (!list) return;
    dupCache = null;
    const rows = job.rows.filter(shown);
    list.innerHTML = rows.length ? rows.map(rowHTML).join('') : '<li class="hist-more">該当する曲はありません</li>';
  };
  const paintFilter = () => {
    const el = $('[data-role="filter"]', body);
    if (!el) return;
    dupCache = null;
    const counts = {};
    for (const r of job.rows) counts[kindOf(r)] = (counts[kindOf(r)] ?? 0) + 1;
    if (job.filter !== 'all' && !counts[job.filter]) {
      job.filter = 'all';
      paintList();
    }
    const items = TI_FILTERS.filter(([id]) => id === 'all' || counts[id]);
    el.innerHTML = items.length > 1
      ? items.map(([id, label]) => `<button type="button" class="pill" data-filter="${id}" aria-pressed="${job.filter === id}">${label}${id === 'all' ? '' : ` ${counts[id]}`}</button>`).join('')
      : '';
  };
  const paintStatus = () => {
    const el = $('[data-role="status"]', body);
    if (!el) return;
    const total = job.rows.length;
    const left = job.rows.filter(busy).length;
    const min = Math.ceil(left / TI_PER_MINUTE);
    if (job.running) {
      const pct = total ? Math.round(((total - left) / total) * 100) : 0;
      el.innerHTML = `<span>調べています（${total - left} / ${total}）${min >= 2 ? `・残り約${min}分` : ''}</span><button type="button" class="link-btn" data-act="stop">中止</button>
        <div class="job-bar" role="progressbar" aria-label="調べた曲" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${total - left}"><span style="width:${pct}%"></span></div>`;
    } else if (left) {
      el.innerHTML = `<span>${left}曲はまだ調べていません</span><button type="button" class="link-btn" data-act="resume">続きを調べる</button>`;
    } else {
      el.innerHTML = `<span>${total}曲を読み込みました。違う曲は、行をタップして選び直せます。</span>`;
    }
  };
  const paintFoot = () => {
    if (!job.rows.length) return;
    dupCache = null;
    const n = job.rows.filter(canAdd).length;
    foot.innerHTML = `<button type="button" class="btn" data-act="back">最初に戻る</button>
      <button type="button" class="btn primary" data-act="add"${n ? '' : ' disabled'}>${n ? `${n}曲を追加` : '追加する曲がありません'}</button>`;
  };
  const paintAll = () => {
    paintStatus();
    paintFilter();
    paintList();
    paintFoot();
  };

  const editRow = (r) => {
    if (!r || busy(r)) return;
    const sub = openSheet(`<div class="ti-pick">
        <div class="sheet-head"><h3>曲を選ぶ・直す</h3><button type="button" class="icon-btn" data-act="close" aria-label="閉じる">${icon('close')}</button></div>
        <div class="sheet-body">
          <p class="ti-orig">${r.structured ? '読み込んだ内容' : '元のテキスト'}：<span>${esc(r.source ? `${r.source}・${r.line}` : r.line)}</span></p>
          <form class="ti-search" data-role="search"><input class="input" type="search" name="q" value="${esc(r.info.term)}" aria-label="検索する言葉" enterkeyhint="search" autocomplete="off"><button type="submit" class="btn sm">${icon('search')}検索</button></form>
          <ul class="hist-list" data-role="cands"></ul>
          <h4 class="ti-h">自分で入力する</h4>
          <form class="ti-manual" data-role="manual" novalidate>
            <label class="label" for="ti-artist">アーティスト</label>
            <input id="ti-artist" class="input" name="artist" value="${esc(r.artist)}" autocomplete="off">
            <label class="label" for="ti-title">曲名</label>
            <input id="ti-title" class="input" name="title" value="${esc(r.title)}" autocomplete="off">
            <button type="submit" class="btn wide">この内容にする</button>
          </form>
        </div>
      </div>`, { label: '曲を選ぶ・直す', className: 'history-layer' });
    let cands = r.cands;
    const list = $('[data-role="cands"]', sub.el);
    const same = (a, b) => !!a && !!b && a.artist === b.artist && a.title === b.title && a.album === b.album;
    const paintCands = (msg) => {
      if (msg) {
        list.innerHTML = `<li class="hist-more">${esc(msg)}</li>`;
        return;
      }
      list.innerHTML = cands.length
        ? cands.map((s, k) => {
          const on = same(s, r.pick);
          return `<li><button type="button" class="hist-row ti-cand${on ? ' on' : ''}" data-k="${k}"${on ? ' aria-current="true"' : ''}>
              <span class="hist-art">${s.artwork ? `<img src="${esc(s.artwork)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : icon('music')}</span>
              <span class="hist-text"><span class="hist-t">${esc(trimReading(s.title))}</span><span class="hist-a">${esc(s.artist)}${s.album ? ` · ${esc(s.album)}` : ''}</span></span>
              ${on ? icon('check') : ''}
            </button></li>`;
        }).join('')
        : '<li class="hist-more">候補がありません。検索する言葉を変えるか、下で入力してください。</li>';
    };
    const done = () => {
      r.status = 'ok';
      r.checked = true;
      sub.close();
      paintRow(r);
      paintList();
      paintFilter();
      paintFoot();
    };
    paintCands();
    sub.el.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const fd = new FormData(f);
      if (f.dataset.role === 'search') {
        const q = String(fd.get('q') ?? '').trim();
        if (!q) return;
        paintCands('探しています…');
        try {
          const res = await searchWhenFree(q, () => list.isConnected);
          if (!list.isConnected) return;
          cands = mergeCandidates(scoreSongs(res, r.info)).map((c) => c.song);
        } catch (err) {
          console.warn(err);
          paintCands('探せませんでした。通信を確認してください');
          return;
        }
        paintCands();
        return;
      }
      const artist = String(fd.get('artist') ?? '').trim();
      const title = String(fd.get('title') ?? '').trim();
      if (!title) {
        $('#ti-title', sub.el).focus();
        return;
      }
      const keep = r.pick && looseKey(r.pick.artist) === looseKey(artist) && looseKey(trimReading(r.pick.title)) === looseKey(title);
      if (!keep) {
        r.pick = null;
        r.artwork = null;
      }
      r.artist = artist;
      r.title = title;
      done();
    });
    sub.el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.act === 'close') sub.close();
      else if (b.dataset.k != null) {
        const s = cands[+b.dataset.k];
        if (!s) return;
        setPick(r, s);
        done();
      }
    });
  };


  const addPicked = async () => {
    const picks = job.rows.filter(canAdd);
    if (!picks.length) return;
    const left = job.rows.filter(busy).length;
    if (left && !(await confirmDialog({ title: `${picks.length}曲を追加しますか？`, message: `まだ調べていない${left}曲は追加しません。`, ok: '追加する' }))) return;
    job.gen++;
    const now = Date.now();
    const entries = picks.map((r, i) => ({
      id: newSongId(),
      data: toPayload(normalizeSong({ ...emptySong(), artist: r.artist, title: r.title, artwork: r.artwork, createdAt: now - i, updatedAt: now })),
    }));
    state.store.putSongs(entries);
    if (rangeAuto()) runRangeBatch(entries.map((e) => ({ id: e.id, artist: e.data.artist, title: e.data.title })));
    const artists = [...new Set(picks.map((r) => r.artist).filter(Boolean))].filter((n) => !state.profile.artists.includes(n));
    if (artists.length) state.store.addArtists(artists);
    // 行に書いた略称と、選んだアーティスト名を覚えて、次から使う
    const learned = {};
    for (const r of picks) {
      const a = aliasToLearn(r.info, r.artist, r.title);
      if (a && aliases.get(a[0]) !== a[1]) learned[a[0]] = a[1];
    }
    if (Object.keys(learned).length) state.store.updateProfile({ aliases: sanitizeAliases({ ...state.profile.aliases, ...learned }) });
    sheet.close();
    // ジャケット画像がない曲は、追加されたのを待ってから、裏でまとめて探す
    const noArt = entries.filter((e) => !e.data.artwork).map((e) => e.id);
    if (!noArt.length) {
      toast(`${picks.length}曲を追加しました`);
      return;
    }
    toast(`${picks.length}曲を追加しました。ジャケット画像は裏で探します（進み具合は設定に出ます）`, { duration: 6000 });
    for (let t = 0; t < 50 && !noArt.every((id) => state.byId.has(id)); t++) await sleep(100);
    runArtJob({ quiet: true });
  };

  sheet.el.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.edit != null) {
      editRow(job.rows[+b.dataset.edit]);
      return;
    }
    if (b.dataset.filter) {
      job.filter = b.dataset.filter;
      paintFilter();
      paintList();
      return;
    }
    if (b.dataset.unfile) {
      job.files = job.files.filter((f) => f.id !== +b.dataset.unfile);
      paintFiles();
      return;
    }
    if (b.dataset.cols) {
      const f = job.files.find((x) => x.id === +b.dataset.cols);
      if (f) pickColumns(f);
      return;
    }
    if (b.dataset.mode && job.pending) {
      buildRows(job.pending.structured, job.pending.lines, b.dataset.mode);
      return;
    }
    switch (b.dataset.act) {
      case 'close':
        if (job.rows.length && !(await confirmDialog({ title: '閉じますか？', message: '読み込んだ結果は消えます（まだ追加していません）。', ok: '閉じる' }))) return;
        sheet.close();
        break;
      case 'run': start(); break;
      case 'pick-files': job.text = $('[data-role="text"]', body)?.value ?? job.text; pickFiles(); break;
      case 'guide': openImportGuide(); break;
      case 'back-input': showInput(); break;
      case 'stop': stop(); break;
      case 'resume': run(); break;
      case 'check-shown':
      case 'uncheck-shown':
        for (const r of job.rows) if (shown(r) && !busy(r) && r.title) r.checked = b.dataset.act === 'check-shown';
        paintList();
        paintFilter();
        paintFoot();
        break;
      case 'back':
        if (await confirmDialog({ title: '最初に戻りますか？', message: '読み込んだ結果は消えます。テキストと選んだファイルはそのまま残ります。', ok: '戻る' })) showInput();
        break;
      case 'add': addPicked(); break;
      default:
    }
  });
  let qTimer = 0;
  sheet.el.addEventListener('input', (e) => {
    if (e.target.dataset.role !== 'q') return;
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      job.qk = looseKey(e.target.value);
      paintList();
    }, 150);
  });
  sheet.el.addEventListener('change', (e) => {
    if (e.target.dataset.role === 'source') {
      job.source = e.target.value;
      paintList();
      return;
    }
    const i = e.target.dataset.check;
    if (i == null) return;
    job.rows[+i].checked = e.target.checked;
    paintList();
    paintFilter();
    paintFoot();
  });
  showInput();
  // マウスで操作する端末（PC など）だけ、すぐ書けるようにテキスト欄に移る。スマホでは、キーボードで
  // 下の「ファイルを選ぶ」などが隠れないよう、テキスト欄を押すまでキーボードを出さない
  if (matchMedia('(pointer: fine)').matches) setTimeout(() => $('[data-role="text"]', body)?.focus({ preventScroll: true }), 80);
}

// 音楽サービスから曲の一覧を書き出す方法
function openImportGuide() {
  const ext = (href, label) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${esc(label)}${icon('external')}</a>`;
  const sheet = openSheet(`<div class="ti-guide">
      <div class="sheet-head"><h3>書き出し方のガイド</h3><button type="button" class="icon-btn" data-act="close" aria-label="閉じる">${icon('close')}</button></div>
      <div class="sheet-body">
        <p class="hint">音楽サービスの再生リストを、曲の一覧のファイル（CSV など）にしてから、「ファイルを選ぶ」で読み込みます。外部のサイトの画面や文言は、変わることがあります。</p>
        <details open><summary>Spotify</summary>
          <ol>
            <li>${ext('https://exportify.app/', 'Exportify')}を開き、「開始する」から Spotify でログインする</li>
            <li>書き出したい再生リストの「Export」を押す（全部なら「Export All」）。「Liked Songs」はお気に入りの曲</li>
            <li>保存された CSV（全部のときは ZIP の中の CSV）を、このアプリの「ファイルを選ぶ」で選ぶ</li>
          </ol>
        </details>
        <details><summary>Apple Music</summary>
          <p class="hint">やり方は2通りあります。スマホの Apple Music アプリからは書き出せないため、PC があれば方法1、スマホだけのときは方法2を使います。</p>
          <h5 class="gd-way">方法1：PC の「ミュージック」「iTunes」で書き出す</h5>
          <ol>
            <li>PC の「ミュージック」（Mac）か「iTunes」（Windows）で、書き出したい再生リストを選ぶ</li>
            <li>メニューの「ファイル」→「ライブラリ」→「プレイリストを書き出す」を選び、形式を「テキストファイル」にして保存する</li>
            <li>保存したファイルを、このアプリの「ファイルを選ぶ」で選ぶ（いくつかまとめて選べます）</li>
          </ol>
          <h5 class="gd-way">方法2：TuneMyMusic で書き出す（スマホだけでもできる）</h5>
          <ol>
            <li>${ext('https://www.tunemymusic.com/', 'TuneMyMusic')}を開き、移行元に「Apple Music」を選んでログインする</li>
            <li>書き出したい再生リストを選び、移行先に「ファイルにエクスポート」を選んで、CSV で保存する</li>
            <li>保存した CSV を、このアプリの「ファイルを選ぶ」で選ぶ</li>
          </ol>
          <p class="hint">無料では 500 曲まで（TuneMyMusic の説明による）。</p>
        </details>
        <details><summary>YouTube Music</summary>
          <p class="hint">やり方は2通りあります。公開・限定公開の再生リストなら、リンクを貼るだけの方法1が簡単です。</p>
          <h5 class="gd-way">方法1：再生リストのリンクを貼る</h5>
          <ol>
            <li>YouTube Music で再生リストを開き、「共有」→「リンクをコピー」を押す</li>
            <li>このアプリのテキスト欄に、コピーしたリンクを貼る（いくつ貼っても大丈夫です）</li>
          </ol>
          <p class="hint">読めるのは「公開」か「限定公開」の再生リストです。「非公開」のときは、再生リストの公開範囲を一時的に「限定公開」にしてください。「高く評価した曲」は読めません。</p>
          <h5 class="gd-way">方法2：Google Takeout で書き出す</h5>
          <ol>
            <li>${ext('https://takeout.google.com/', 'Google Takeout')}を開き、「選択をすべて解除」を押してから「YouTube と YouTube Music」にだけチェックを付ける</li>
            <li>「YouTube のすべてのデータが含まれます」を押し、「ミュージック ライブラリの曲」と「再生リスト」だけを選ぶ</li>
            <li>「次のステップ」→「エクスポートを作成」を押し、届いたメールのリンクから ZIP をダウンロードする（準備に数分〜数時間かかります）</li>
            <li>ZIP のまま、このアプリの「ファイルを選ぶ」で選ぶ</li>
          </ol>
          <p class="hint">方法1より手間はかかりますが、非公開の再生リストやライブラリの曲もまとめて読めます。</p>
        </details>
        <details><summary>Amazon Music・KKBOX など</summary>
          <ol>
            <li>${ext('https://www.tunemymusic.com/', 'TuneMyMusic')}を開き、移行元に使っているサービスを選んでログインする</li>
            <li>書き出したい再生リストを選び、移行先に「ファイルにエクスポート」を選んで、CSV で保存する</li>
            <li>保存した CSV を、このアプリの「ファイルを選ぶ」で選ぶ</li>
          </ol>
          <p class="hint">無料では 500 曲まで（TuneMyMusic の説明による）。LINE MUSIC・AWA には対応していません。</p>
        </details>
        <details><summary>表計算ソフト・メモ</summary>
          <p class="hint">曲名とアーティストの列をコピーして、テキスト欄に貼れます。1行目に「曲名」「アーティスト」の見出しを入れると、列を確実に見分けます。メモは、1行に1曲ずつ書いて貼ります。</p>
        </details>
      </div>
    </div>`, { label: '書き出し方のガイド', className: 'history-layer' });
  sheet.el.addEventListener('click', (e) => {
    if (e.target.closest('[data-act="close"]')) sheet.close();
  });
}
