// 一覧のスワイプと長押し

import { $, toast, closePopover } from '../ui.js';
import { devicePrefs, haptic, state } from './core.js';
import { markSung, removeSong } from './detail.js';

// ---- 一覧のスワイプ操作 -----------------------------------------------
// 右へスワイプ：「歌った！」を記録／左へスワイプ：お気に入りの切り替え。
// 指で触ったときだけ動かす（マウスでは動かさない）。縦のスクロールはブラウザに任せる。

const SWIPE_THRESHOLD = 72;

function toggleFavorite(id) {
  const s = state.byId.get(id);
  if (!s) return;
  const prev = s.favorite;
  haptic('fav');
  state.store.updateSong(id, { favorite: !prev });
  toast(prev ? `「${s.title}」をお気に入りから外しました` : `「${s.title}」をお気に入りにしました`, {
    action: '元に戻す',
    onAction: () => state.store.updateSong(id, { favorite: prev }),
  });
}

export function setupSwipe(ul) {
  let st = null;
  let suppressClick = false;
  ul.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || state.select.on || !devicePrefs.swipe) return;
    const li = e.target.closest('.song');
    if (!li || li.classList.contains('skeleton')) return;
    st = { li, inner: $('.song-inner', li), id: li.dataset.id, x0: e.clientX, y0: e.clientY, dx: 0, active: false, armed: false, pid: e.pointerId };
  });
  ul.addEventListener('pointermove', (e) => {
    if (!st || e.pointerId !== st.pid) return;
    const dx = e.clientX - st.x0;
    const dy = e.clientY - st.y0;
    if (!st.active) {
      // 縦の動きが先に大きくなったら、スクロールとみなして何もしない
      if (Math.abs(dy) > 8 && Math.abs(dy) >= Math.abs(dx)) {
        st = null;
        return;
      }
      if (Math.abs(dx) < 12) return;
      st.active = true;
      closePopover();
      st.li.classList.remove('settling');
      st.li.classList.add('swiping');
      try {
        st.li.setPointerCapture(e.pointerId);
      } catch { /* 取れなくても動く */ }
    }
    const mag = Math.abs(dx);
    // しきい値を超えたら、指の動きより少し重く動かす
    const eased = mag <= SWIPE_THRESHOLD ? mag : SWIPE_THRESHOLD + (mag - SWIPE_THRESHOLD) * 0.35;
    const x = Math.sign(dx) * Math.min(eased, st.li.clientWidth * 0.45);
    st.dx = dx;
    st.inner.style.transform = `translateX(${x}px)`;
    st.li.dataset.swipe = dx > 0 ? 'right' : 'left';
    const armed = mag >= SWIPE_THRESHOLD;
    if (armed !== st.armed) {
      st.armed = armed;
      st.li.classList.toggle('armed', armed);
      if (armed) haptic('swipe');
    }
  });
  const end = (e) => {
    if (!st || (e && e.pointerId !== st.pid)) return;
    const { li, inner, active, armed, dx, id } = st;
    st = null;
    if (!active) return;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 350);
    li.classList.remove('swiping');
    li.classList.add('settling');
    inner.style.transform = '';
    setTimeout(() => {
      li.classList.remove('settling', 'armed');
      delete li.dataset.swipe;
    }, 240);
    if (!armed) return;
    if (dx > 0) markSung(id);
    else toggleFavorite(id);
  };
  ul.addEventListener('pointerup', end);
  ul.addEventListener('pointercancel', end);
  // スワイプした直後の「クリック」で詳細画面やキーの操作が動かないようにする
  ul.addEventListener('click', (e) => {
    if (!suppressClick) return;
    suppressClick = false;
    e.stopPropagation();
    e.preventDefault();
  }, true);
}

// 一覧の曲を長押し（PC は右クリック）すると、削除するか確かめる。
// 指が動いたら（スクロール・スワイプ）やめる。選択中・キーのボタンの上では使わない
const LONG_PRESS_MS = 550;
export function setupLongPress(ul) {
  let lp = null;
  let firedAt = 0;
  const targetRow = (e) => {
    if (state.select.on || e.target.closest('.keyctl')) return null;
    const li = e.target.closest('.song');
    return li && !li.classList.contains('skeleton') ? li : null;
  };
  const cancel = () => {
    if (!lp) return;
    clearTimeout(lp.timer);
    lp.li.classList.remove('pressing');
    lp = null;
  };
  const fire = () => {
    const { id } = lp;
    cancel();
    firedAt = Date.now();
    haptic('swipe');
    removeSong(id);
  };
  ul.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    const li = targetRow(e);
    if (!li) return;
    cancel();
    lp = { li, id: li.dataset.id, x0: e.clientX, y0: e.clientY, pid: e.pointerId, timer: setTimeout(fire, LONG_PRESS_MS) };
    li.classList.add('pressing');
  });
  ul.addEventListener('pointermove', (e) => {
    if (lp && e.pointerId === lp.pid && Math.hypot(e.clientX - lp.x0, e.clientY - lp.y0) > 10) cancel();
  });
  ul.addEventListener('pointerup', cancel);
  ul.addEventListener('pointercancel', cancel);
  // スマホのブラウザが長押しで出すメニューは出さない。PC の右クリックは、ここで削除を確かめる
  ul.addEventListener('contextmenu', (e) => {
    const li = targetRow(e);
    if (!li) return;
    e.preventDefault();
    if (lp) fire();
    else if (Date.now() - firedAt > 800) removeSong(li.dataset.id);
  });
  // 長押しのあとに続く「クリック」で、詳細画面が開かないようにする
  ul.addEventListener('click', (e) => {
    if (Date.now() - firedAt > 800) return;
    e.stopPropagation();
    e.preventDefault();
  }, true);
}
