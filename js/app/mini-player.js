// 画面の下のバー：詳細画面を閉じても続けている試聴の曲名・ジャケット画像と、5 秒戻る・再生・一時停止・5 秒進む・停止のボタン
import { $, esc, icon } from '../ui.js';
import { onNowPlaying, controlNowPlaying } from '../preview.js';
import { openDetail } from './detail.js';

let sig = '';

export function initMiniPlayer() {
  const el = $('#mini');
  if (!el) return;
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mini]');
    if (!b) return;
    if (b.dataset.mini === 'open') {
      if (el.dataset.id) openDetail(el.dataset.id);
    } else controlNowPlaying(b.dataset.mini);
  });
  onNowPlaying((np) => paint(el, np));
}

function paint(el, np) {
  const s = np?.detached ? np.song : null;
  el.hidden = !s;
  document.body.classList.toggle('has-mini', !!s);
  if (!s) {
    sig = '';
    delete el.dataset.id;
    return;
  }
  el.dataset.id = np.id;
  const next = JSON.stringify([np.id, s.title, s.artist, s.artwork, np.playing, np.message]);
  if (next !== sig) {
    sig = next;
    el.innerHTML = `<div class="mini-progress" aria-hidden="true"></div>
      <div class="mini-inner">
        <button type="button" class="mini-main" data-mini="open" aria-label="${esc(s.title)} の詳細を開く">
          <span class="art mini-art" aria-hidden="true">${icon('music')}${s.artwork ? `<img src="${esc(s.artwork)}" alt="" referrerpolicy="no-referrer" onload="this.classList.add('ok')" onerror="this.remove()">` : ''}</span>
          <span class="mini-text">
            <span class="mini-title">${esc(s.title)}</span>
            <span class="mini-sub${np.message ? ' err' : ''}">${esc(np.message || s.artist || '')}</span>
          </span>
        </button>
        <div class="mini-ctl">
          <button type="button" class="mini-btn" data-mini="back" aria-label="5秒戻る" title="5秒戻る">${icon('back5')}</button>
          <button type="button" class="mini-btn mini-play" data-mini="toggle" aria-label="${np.playing ? '一時停止' : '再生'}" title="${np.playing ? '一時停止' : '再生'}">${icon(np.playing ? 'pause' : 'play')}</button>
          <button type="button" class="mini-btn" data-mini="fwd" aria-label="5秒進む" title="5秒進む">${icon('fwd5')}</button>
          <button type="button" class="mini-btn" data-mini="stop" aria-label="停止" title="停止">${icon('close')}</button>
        </div>
      </div>`;
  }
  el.style.setProperty('--mini-p', np.dur ? `${Math.min(100, (np.cur / np.dur) * 100).toFixed(2)}%` : '0%');
  for (const b of el.querySelectorAll('[data-mini="back"], [data-mini="fwd"]')) b.disabled = !np.dur;
}
