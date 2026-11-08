// 再生履歴のファイルから曲を追加する画面

import { normalize } from '../text.js';
import { emptySong, normalizeSong, toPayload, dupKey } from '../model.js';
import { readHistoryFile, aggregate, thumbnailUrl } from '../history.js';
import { $, esc, icon, openSheet, choiceDialog, toast } from '../ui.js';
import { state } from './core.js';

// ---- 再生履歴から追加 -------------------------------------------------

export async function importHistory(file) {
  toast('再生履歴を読み込んでいます…');
  let entries;
  try {
    entries = await readHistoryFile(await file.arrayBuffer());
  } catch (e) {
    console.error(e);
    await choiceDialog({ title: '読み込めませんでした', message: e.message, choices: [{ value: true, label: '閉じる', kind: 'primary' }] });
    return;
  }
  const all = aggregate(entries);
  if (!all.length) {
    toast('YouTube Music の再生記録が見つかりませんでした');
    return;
  }
  openHistory(all, entries.length);
}

function openHistory(all, plays) {
  const registered = new Set(state.songs.map(dupKey));
  const candidates = all.filter((c) => !registered.has(c.key));
  const selected = new Set();
  const LIMIT = 200;
  const sheet = openSheet(`<div class="history">
      <div class="sheet-head"><h3>再生履歴から追加</h3><button type="button" class="icon-btn" data-act="close" aria-label="閉じる">${icon('close')}</button></div>
      <div class="sheet-body">
        <p class="hint hist-sum">${plays.toLocaleString()}回分の再生から、まだ登録していない${candidates.length.toLocaleString()}曲を、よく聴いた順に並べています。</p>
        <label class="search sm">${icon('search')}<input type="search" data-role="q" placeholder="曲名・アーティストで絞り込み" autocomplete="off" aria-label="絞り込み"></label>
        <div class="hist-tools">
          <button type="button" class="pill" data-act="top">上位20曲を選ぶ</button>
          <button type="button" class="pill" data-act="none">選択を解除</button>
        </div>
        <ul class="hist-list" data-role="list"></ul>
      </div>
      <div class="sheet-foot">
        <button type="button" class="btn primary" data-act="add" disabled>選んだ曲を登録</button>
      </div>
    </div>`, {
    label: '再生履歴から追加',
    className: 'history-layer',
    onClose: () => { state.historySheet = null; },
  });
  state.historySheet = sheet;
  const q = $('[data-role="q"]', sheet.el);
  const listEl = $('[data-role="list"]', sheet.el);
  const addBtn = $('[data-act="add"]', sheet.el);
  let shown = [];
  const paint = () => {
    const words = normalize(q.value).split(' ').filter(Boolean);
    const filtered = words.length
      ? candidates.filter((c) => { const k = normalize(`${c.title} ${c.artist}`); return words.every((w) => k.includes(w)); })
      : candidates;
    shown = filtered.slice(0, LIMIT);
    listEl.innerHTML = shown.length
      ? shown.map((c, i) => `<li><label class="hist-row">
          <input type="checkbox" data-i="${i}"${selected.has(c.key) ? ' checked' : ''}>
          <span class="hist-art">${c.video ? `<img src="${thumbnailUrl(c.video)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : icon('music')}</span>
          <span class="hist-text"><span class="hist-t">${esc(c.title)}</span><span class="hist-a">${esc(c.artist)}</span></span>
          <span class="hist-n">${c.count}回</span>
        </label></li>`).join('') + (filtered.length > LIMIT ? `<li class="hist-more">ほか${filtered.length - LIMIT}曲（絞り込むと表示されます）</li>` : '')
      : '<li class="hist-more">該当する曲がありません</li>';
    addBtn.disabled = !selected.size;
    addBtn.textContent = selected.size ? `選んだ${selected.size}曲を登録` : '選んだ曲を登録';
  };
  q.addEventListener('input', paint);
  listEl.addEventListener('change', (e) => {
    const c = shown[+e.target.dataset.i];
    if (!c) return;
    if (e.target.checked) selected.add(c.key);
    else selected.delete(c.key);
    addBtn.disabled = !selected.size;
    addBtn.textContent = selected.size ? `選んだ${selected.size}曲を登録` : '選んだ曲を登録';
  });
  sheet.el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.act === 'close') sheet.close();
    else if (b.dataset.act === 'top') {
      candidates.slice(0, 20).forEach((c) => selected.add(c.key));
      paint();
    } else if (b.dataset.act === 'none') {
      selected.clear();
      paint();
    } else if (b.dataset.act === 'add') {
      const picks = candidates.filter((c) => selected.has(c.key));
      const now = Date.now();
      const entriesToAdd = picks.map((c, i) => ({
        id: null,
        // 公式音源のサムネイルはジャケット画像なのでそのまま使う。MV などは後で iTunes から探す
        data: toPayload(normalizeSong({ ...emptySong(), artist: c.artist, title: c.title, artwork: c.topic ? thumbnailUrl(c.video) : null, createdAt: now - i, updatedAt: now })),
      }));
      state.store.putSongs(entriesToAdd);
      const artists = [...new Set(picks.map((c) => c.artist))].filter((n) => !state.profile.artists.includes(n));
      if (artists.length) state.store.addArtists(artists);
      sheet.close();
      const noArt = entriesToAdd.filter((x) => !x.data.artwork).length;
      toast(`${picks.length}曲を登録しました${noArt ? `（画像なし${noArt}曲は、設定からまとめて探せます）` : ''}`, { duration: 6000 });
    }
  });
  paint();
}
