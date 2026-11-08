// 試聴用の音楽ファイルをまとめて割り当てる画面

import { collator } from '../text.js';
import { looseKey } from '../text-import.js';
import { $, esc, icon, openSheet, toast } from '../ui.js';
import { audioFiles, formatBytes, FILE_ACCEPT, MAX_FILE_BYTES } from '../preview.js';
import { readTags, matchFile } from '../audio-match.js';
import { state } from './core.js';
import { paintAudioFiles } from './settings.js';

// ---- 音楽ファイルをまとめて割り当てる -------------------------------------
// 端末の音楽ファイルを複数選ぶと、ファイルの中の曲名・アーティスト名（なければファイル名）から登録済みの曲を探し、
// 確認・修正してから、試聴用にこの端末へ保存する（テキストから追加と同じ流れ）。

const AM_STATUS = {
  reading: { label: '読んでいます…', cls: 'wait' },
  sure: null,
  check: { label: '要確認', cls: 'check' },
  none: { label: '合う曲が見つかりません', cls: 'none' },
  has: { label: 'ファイルあり', cls: 'dup' },
  replace: { label: '今のファイルと置き換え', cls: 'check' },
  dup: { label: 'ほかのファイルと同じ曲', cls: 'dup' },
  big: { label: `大きすぎます（${formatBytes(MAX_FILE_BYTES)} まで）`, cls: 'none' },
};
const AM_FILTERS = [['all', 'すべて'], ['check', '要確認'], ['none', '見つからない'], ['has', 'ファイルあり・重複']];

export function pickAudioFiles() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = FILE_ACCEPT;
  input.multiple = true;
  input.hidden = true;
  document.body.append(input);
  const done = () => input.remove();
  input.addEventListener('cancel', done, { once: true });
  input.addEventListener('change', () => {
    const files = [...(input.files ?? [])];
    done();
    if (files.length) openAudioImport(files);
  }, { once: true });
  input.click();
}

async function openAudioImport(files) {
  const job = { gen: 1, rows: [], filter: 'all', reading: true, saving: false, has: new Set() };
  const sheet = openSheet(`<div class="timport">
      <div class="sheet-head"><h3>音楽ファイルを割り当てる</h3><button type="button" class="icon-btn" data-act="close" aria-label="閉じる">${icon('close')}</button></div>
      <div class="sheet-body" data-role="body">
        <div class="ti-status" data-role="status"></div><div class="ti-filter" data-role="filter"></div><ul class="hist-list ti-list" data-role="list"></ul>
      </div>
      <div class="sheet-foot" data-role="foot"></div>
    </div>`, {
    label: '音楽ファイルを割り当てる',
    className: 'history-layer',
    onClose: () => { job.gen++; },
  });
  const body = $('[data-role="body"]', sheet.el);
  const foot = $('[data-role="foot"]', sheet.el);
  const songOf = (r) => (r.songId ? state.byId.get(r.songId) ?? null : null);
  const kindOf = (r) => {
    if (r.status === 'reading') return 'wait';
    if (r.status === 'big' || r.status === 'none') return 'none';
    if (r.status === 'has' || r.status === 'dup') return 'has';
    if (r.status === 'check' || r.status === 'replace') return 'check';
    return 'ok';
  };
  const canSave = (r) => !!songOf(r) && r.status !== 'big' && r.status !== 'reading';

  // 同じ曲に合ったファイルが複数あるときは、いちばん確かなもの（自分で選んだもの → 確実 → 要確認 の順、同じなら先のもの）
  // 以外を「ほかのファイルと同じ曲」にして、チェックを外す
  const rank = (r) => (r.manual ? 3 : r.base === 'sure' ? 2 : r.base === 'check' ? 1 : 0);
  const ownStatus = (r) => (r.manual ? (job.has.has(r.songId) ? 'replace' : 'sure') : r.base);
  const markDuplicates = () => {
    const best = new Map();
    for (const r of job.rows) {
      if (!r.songId || !rank(r)) continue;
      const cur = best.get(r.songId);
      if (!cur || rank(r) > rank(cur)) best.set(r.songId, r);
    }
    for (const r of job.rows) {
      if (!r.songId || !rank(r)) continue;
      const isBest = best.get(r.songId) === r;
      if (!isBest && r.status !== 'dup') {
        r.status = 'dup';
        r.checked = false;
      } else if (isBest && r.status === 'dup') {
        r.status = ownStatus(r);
        r.checked = true;
      }
    }
  };

  const rowHTML = (r) => {
    const s = songOf(r);
    const st = AM_STATUS[r.status];
    const can = canSave(r);
    return `<li class="ti-row${st ? ` is-${st.cls}` : ''}" data-i="${r.i}">
        <input type="checkbox" data-check="${r.i}"${r.checked && can ? ' checked' : ''}${can ? '' : ' disabled'} aria-label="割り当てる">
        <span class="hist-art">${s?.artwork ? `<img src="${esc(s.artwork)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : icon('music')}</span>
        <button type="button" class="ti-main" data-edit="${r.i}"${r.status === 'reading' ? ' disabled' : ''}>
          <span class="hist-t">${esc(s ? s.title : r.status === 'reading' ? r.file.name : '（曲を選んでください）')}</span>
          ${s ? `<span class="hist-a">${esc(s.artist)}</span>` : ''}
          <span class="ti-src">${st ? `<span class="ti-badge">${esc(st.label)}</span>` : ''}<span class="ti-line">${esc(r.file.name)}</span></span>
        </button>
        ${r.status === 'reading' ? '' : `<button type="button" class="icon-btn ti-edit" data-edit="${r.i}" aria-label="曲を選び直す">${icon('pen')}</button>`}
      </li>`;
  };
  const shown = (r) => job.filter === 'all' || kindOf(r) === job.filter;
  const paintList = () => {
    const rows = job.rows.filter(shown);
    $('[data-role="list"]', body).innerHTML = rows.length ? rows.map(rowHTML).join('') : '<li class="hist-more">該当するファイルはありません</li>';
  };
  const paintFilter = () => {
    const counts = { check: 0, none: 0, has: 0 };
    for (const r of job.rows) {
      const k = kindOf(r);
      if (k in counts) counts[k]++;
    }
    const items = AM_FILTERS.filter(([id]) => id === 'all' || counts[id]);
    if (!items.some(([id]) => id === job.filter)) job.filter = 'all';
    $('[data-role="filter"]', body).innerHTML = items.length > 1
      ? items.map(([id, label]) => `<button type="button" class="pill" data-filter="${id}" aria-pressed="${job.filter === id}">${label}${id === 'all' ? '' : ` ${counts[id]}`}</button>`).join('')
      : '';
  };
  const paintStatus = () => {
    const el = $('[data-role="status"]', body);
    const total = job.rows.length;
    const read = job.rows.filter((r) => r.status !== 'reading').length;
    if (job.reading || job.saving) {
      const n = job.saving ? job.savedCount : read;
      const all = job.saving ? job.saveTotal : total;
      const pct = all ? Math.round((n / all) * 100) : 0;
      el.innerHTML = `<span>${job.saving ? `保存しています（${n} / ${all}）` : `ファイルを読んでいます（${n} / ${all}）`}</span>
        <div class="job-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${all}" aria-valuenow="${n}"><span style="width:${pct}%"></span></div>`;
    } else {
      el.innerHTML = `<span>${total}個のファイルを調べました。違う曲は、行をタップして選び直せます。</span>`;
    }
  };
  const paintFoot = () => {
    const n = job.rows.filter((r) => r.checked && canSave(r)).length;
    foot.innerHTML = `<button type="button" class="btn primary" data-act="save"${n && !job.reading && !job.saving ? '' : ' disabled'}>${icon('music')}${n ? `${n}曲に割り当てる` : '割り当てる'}</button>`;
  };
  const paintAll = () => {
    paintStatus();
    paintFilter();
    paintList();
    paintFoot();
  };

  // 曲を選び直す
  const editRow = (r) => {
    if (!r || r.status === 'reading') return;
    const sub = openSheet(`<div class="ti-pick">
        <div class="sheet-head"><h3>曲を選ぶ</h3><button type="button" class="icon-btn" data-act="close" aria-label="閉じる">${icon('close')}</button></div>
        <div class="sheet-body">
          <p class="ti-orig">ファイル：<span>${esc(r.file.name)}</span>${r.tags.title ? `<br>ファイルの中の曲名：<span>${esc(r.tags.title)}${r.tags.artist ? ` / ${esc(r.tags.artist)}` : ''}</span>` : ''}</p>
          <label class="search sm">${icon('search')}<input type="search" data-role="q" placeholder="曲名・アーティストで絞り込み" autocomplete="off" aria-label="絞り込み"></label>
          <ul class="hist-list" data-role="cands"></ul>
          <button type="button" class="btn wide" data-act="unset" style="margin-top:12px">この曲には割り当てない</button>
        </div>
      </div>`, { label: '曲を選ぶ', className: 'history-layer' });
    const list = $('[data-role="cands"]', sub.el);
    const q = $('[data-role="q"]', sub.el);
    const all = [...state.songs].sort((a, b) => collator.compare(a.title, b.title));
    const paintCands = () => {
      const key = looseKey(q.value);
      const base = key ? all.filter((s) => looseKey(`${s.title}${s.artist}`).includes(key)) : [...r.cands.map((id) => state.byId.get(id)).filter(Boolean), ...all.filter((s) => !r.cands.includes(s.id))];
      const items = base.slice(0, 60);
      list.innerHTML = items.length
        ? items.map((s) => `<li><button type="button" class="hist-row ti-cand${s.id === r.songId ? ' on' : ''}" data-song="${esc(s.id)}">
            <span class="hist-art">${s.artwork ? `<img src="${esc(s.artwork)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : icon('music')}</span>
            <span class="hist-text"><span class="hist-t">${esc(s.title)}</span><span class="hist-a">${esc(s.artist)}${job.has.has(s.id) ? ' · ファイルあり' : ''}</span></span>
            ${s.id === r.songId ? icon('check') : ''}
          </button></li>`).join('') + (base.length > items.length ? `<li class="hist-more">ほか${base.length - items.length}曲（絞り込むと表示されます）</li>` : '')
        : '<li class="hist-more">該当する曲がありません</li>';
    };
    q.addEventListener('input', paintCands);
    sub.el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.act === 'close') sub.close();
      else if (b.dataset.act === 'unset') {
        r.songId = null;
        r.status = 'none';
        r.manual = true;
        r.checked = false;
        sub.close();
        markDuplicates();
        paintAll();
      } else if (b.dataset.song) {
        r.songId = b.dataset.song;
        r.manual = true;
        r.status = r.big ? 'big' : ownStatus(r);
        r.checked = !r.big;
        sub.close();
        markDuplicates();
        paintAll();
      }
    });
    paintCands();
  };

  const save = async () => {
    const targets = job.rows.filter((r) => r.checked && canSave(r));
    if (!targets.length) return;
    job.saving = true;
    job.saveTotal = targets.length;
    job.savedCount = 0;
    paintAll();
    let ok = 0;
    let failed = 0;
    for (const r of targets) {
      try {
        await audioFiles.put(r.songId, { blob: r.file, name: r.file.name, type: r.file.type, size: r.file.size, addedAt: Date.now() });
        ok++;
      } catch (err) {
        console.error(err);
        failed++;
      }
      job.savedCount++;
      paintStatus();
    }
    navigator.storage?.persist?.().catch(() => {});
    job.saving = false;
    sheet.close();
    paintAudioFiles();
    toast(failed
      ? `${ok}曲に保存し、${failed}曲は保存できませんでした（端末の空き容量が足りない可能性があります）`
      : `${ok}曲に音楽ファイルを保存しました（この端末だけ）`, { duration: 5000 });
  };

  sheet.el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.act === 'close') sheet.close();
    else if (b.dataset.act === 'save') save();
    else if (b.dataset.filter) {
      job.filter = b.dataset.filter;
      paintFilter();
      paintList();
    } else if (b.dataset.edit != null) editRow(job.rows[+b.dataset.edit]);
  });
  sheet.el.addEventListener('change', (e) => {
    const c = e.target.closest('[data-check]');
    if (!c) return;
    const r = job.rows[+c.dataset.check];
    if (r) r.checked = c.checked;
    paintFoot();
  });

  // ファイルを順に読み、曲と照らし合わせる
  job.rows = files.map((file, i) => ({ i, file, tags: {}, status: 'reading', songId: null, cands: [], checked: false, manual: false, big: file.size > MAX_FILE_BYTES }));
  paintAll();
  try {
    job.has = new Set(await audioFiles.keys());
  } catch {
    job.has = new Set();
  }
  const songs = state.songs.map((s) => ({ id: s.id, title: s.title, artist: s.artist }));
  const gen = job.gen;
  for (const r of job.rows) {
    r.tags = await readTags(r.file);
    if (gen !== job.gen) return;
    const m = matchFile({ ...r.tags, name: r.file.name }, songs);
    r.songId = m.pick?.id ?? null;
    r.cands = m.candidates.map((s) => s.id);
    if (r.big) r.status = 'big';
    else if (!r.songId) r.status = 'none';
    else if (job.has.has(r.songId)) r.status = 'has';
    else r.status = m.status;
    r.base = r.status;
    // 確実・要確認はチェックを付けておく。見つからない・ファイルあり・大きすぎるものは外しておく
    r.checked = r.status === 'sure' || r.status === 'check';
    paintStatus();
    const el = $(`.ti-row[data-i="${r.i}"]`, body);
    if (el && shown(r)) el.outerHTML = rowHTML(r);
  }
  job.reading = false;
  markDuplicates();
  paintAll();
}
