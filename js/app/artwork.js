// ジャケット画像を選ぶ・まとめて探す

import { searchTracks, findTrack, waitForSlot } from '../itunes.js';
import { $, esc, icon, openSheet, toast } from '../ui.js';
import { state, sleep } from './core.js';
import { paintArtJob } from './settings.js';

// ---- ジャケット画像 ---------------------------------------------------

// iTunes で画像を探して選ぶ。戻り値：選んだ画像の URL、キャンセルなら undefined
export function openArtPicker(artist, title) {
  return new Promise((resolve) => {
    let result;
    const sheet = openSheet(`<div class="artpick">
        <div class="sheet-head"><h3>ジャケット画像を選ぶ</h3><button type="button" class="icon-btn" data-act="close" aria-label="閉じる">${icon('close')}</button></div>
        <div class="sheet-body">
          <form class="search sm" data-role="form">${icon('search')}<input type="search" data-role="q" enterkeyhint="search" aria-label="検索する言葉" placeholder="アーティスト名と曲名"></form>
          <div class="art-grid" data-role="grid"></div>
        </div>
      </div>`, { label: 'ジャケット画像を選ぶ', className: 'artpick-layer', onClose: () => resolve(result) });
    const input = $('[data-role="q"]', sheet.el);
    const grid = $('[data-role="grid"]', sheet.el);
    let found = [];
    input.value = `${artist} ${title}`.trim();
    const run = async () => {
      const q = input.value.trim();
      if (!q) {
        grid.innerHTML = '<p class="hint">アーティスト名と曲名を入れて検索してください。</p>';
        return;
      }
      grid.innerHTML = '<p class="hint">検索しています…</p>';
      try {
        const songs = await searchTracks(q);
        if (songs === null) {
          grid.innerHTML = '<p class="hint">検索の回数が上限に近いため、1分ほど待ってからもう一度お試しください。</p>';
          return;
        }
        found = songs;
        grid.innerHTML = songs.length
          ? songs.map((s, i) => `<button type="button" class="art-cand" data-i="${i}">
              <img src="${esc(s.artwork)}" alt="" loading="lazy" referrerpolicy="no-referrer">
              <span class="art-cand-t">${esc(s.title)}</span><span class="art-cand-a">${esc(s.artist)}</span></button>`).join('')
          : '<p class="hint">見つかりませんでした。検索する言葉を変えてみてください。</p>';
      } catch (e) {
        console.warn(e);
        grid.innerHTML = '<p class="hint">検索できませんでした。通信状況を確認してください。</p>';
      }
    };
    $('[data-role="form"]', sheet.el).addEventListener('submit', (e) => {
      e.preventDefault();
      input.blur();
      run();
    });
    sheet.el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.act === 'close') sheet.close();
      if (b.dataset.i != null) {
        result = found[+b.dataset.i]?.artwork ?? undefined;
        sheet.close();
      }
    });
    run();
  });
}

// 画像が未設定の曲を登録したとき、裏で iTunes から探して入れる
export async function autoArtwork(id, artist, title) {
  if (!id || !navigator.onLine) return;
  try {
    const r = await findTrack(artist, title);
    const s = state.byId.get(id);
    if (r?.match?.artwork && (!s || !s.artwork)) state.store.updateSong(id, { artwork: r.match.artwork });
  } catch (e) {
    console.warn('artwork', e);
  }
}

// 画像が未設定の曲をまとめて探す（1分あたりの問い合わせ回数を守るため、1曲ずつ間をあける）
export const artJob = { running: false, cancel: false, done: 0, total: 0, found: 0 };

export async function runArtJob({ quiet = false } = {}) {
  if (artJob.running) return;
  const targets = state.songs.filter((s) => !s.artwork && s.title);
  if (!targets.length) {
    if (!quiet) toast('ジャケット画像が未設定の曲はありません');
    return;
  }
  Object.assign(artJob, { running: true, cancel: false, done: 0, total: targets.length, found: 0 });
  paintArtJob();
  for (const t of targets) {
    if (artJob.cancel) break;
    await waitForSlot();
    try {
      const r = await findTrack(t.artist, t.title);
      const cur = state.byId.get(t.id);
      if (r?.match?.artwork && cur && !cur.artwork) {
        state.store.updateSong(t.id, { artwork: r.match.artwork });
        artJob.found++;
      }
    } catch (e) {
      console.warn('artwork', e);
    }
    artJob.done++;
    paintArtJob();
    if (artJob.done < artJob.total && !artJob.cancel) await sleep(3300);
  }
  artJob.running = false;
  paintArtJob();
  toast(`${artJob.done}曲を調べて、${artJob.found}曲に画像を設定しました`, { duration: 5000 });
}
