// 入力欄の下に出す候補（アーティスト名・曲名）

import { normalize } from '../text.js';
import { dupKey, artistCounts, suggestArtists } from '../model.js';
import { suggestArtistsOnline, suggestSongsOnline, suggestSongsByTitle, trimReading } from '../itunes.js';
import { esc, icon } from '../ui.js';
import { state } from './core.js';

// 入力欄の下に候補を出す共通部品（キーボードの上下・Enter・Esc に対応）
function combobox(input, list, { idPrefix, onPick }) {
  let items = [];
  let active = -1;
  let renderFn = null;
  // pinned：入力欄にフォーカスがなくても（キーボードを閉じたまま）候補を出している状態。
  // このときは、候補と入力欄以外の場所をタップしたら閉じる
  let pinned = false;
  const onOutside = (e) => {
    if (!list.contains(e.target) && e.target !== input) hide();
  };
  const pin = () => {
    if (pinned) return;
    pinned = true;
    document.addEventListener('pointerdown', onOutside, true);
  };
  const unpin = () => {
    if (!pinned) return;
    pinned = false;
    document.removeEventListener('pointerdown', onOutside, true);
  };
  const canShow = () => pinned || document.activeElement === input;
  function hide() {
    list.hidden = true;
    active = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    unpin();
  }
  const show = (next, render, { pin: keep = false } = {}) => {
    items = next;
    renderFn = render;
    if (keep) pin();
    if (!canShow() || !items.length) return hide();
    if (active >= items.length) active = -1;
    list.innerHTML = render(items, active, idPrefix);
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (active >= 0) input.setAttribute('aria-activedescendant', `${idPrefix}-${active}`);
    else input.removeAttribute('aria-activedescendant');
  };
  const choose = (it) => {
    hide();
    onPick(it);
  };
  // 閉じるのは、少し待ってもフォーカスが戻っていないときだけ（すぐ別の操作で開き直すことがあるため）
  input.addEventListener('blur', () => setTimeout(() => {
    if (document.activeElement !== input && !pinned) hide();
  }, 120));
  input.addEventListener('keydown', (e) => {
    if (list.hidden || e.isComposing || !items.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      active = e.key === 'ArrowDown' ? (active + 1) % items.length : (active - 1 + items.length) % items.length;
      show(items, renderFn);
      e.preventDefault();
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      choose(items[active]);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      hide();
    }
  });
  list.addEventListener('pointerdown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => {
    const li = e.target.closest('[data-i]');
    if (li) choose(items[+li.dataset.i]);
  });
  // 選べない一行メッセージ（読み込み中など）を出す
  const message = (text, { pin: keep = false } = {}) => {
    if (keep) pin();
    if (!canShow()) return hide();
    items = [];
    list.innerHTML = `<li class="ac-head" role="presentation">${esc(text)}</li>`;
    list.hidden = false;
  };
  return { show, hide, message, reset: () => { active = -1; } };
}

const highlight = (name, query) => {
  const q = query.trim().toLowerCase();
  const at = q ? name.toLowerCase().indexOf(q) : -1;
  return at >= 0 ? `${esc(name.slice(0, at))}<mark>${esc(name.slice(at, at + q.length))}</mark>${esc(name.slice(at + q.length))}` : esc(name);
};

// アーティスト名：登録済みの名前を先に、その下に iTunes の候補を出す
export function setupArtistSuggest(input, list, onPick) {
  let online = { q: '', names: [] };
  let timer = 0;
  let ctrl = null;
  const cb = combobox(input, list, {
    idPrefix: 'ac-artist',
    onPick: (it) => {
      input.value = it.name;
      onPick?.(it.name);
    },
  });
  const render = (items, active, pre) => {
    const counts = artistCounts(state.songs);
    let head = false;
    return items.map((it, i) => {
      const sep = it.online && !head ? ((head = true), '<li class="ac-head" role="presentation">iTunes の候補</li>') : '';
      const c = counts.get(it.name);
      return `${sep}<li role="option" id="${pre}-${i}" data-i="${i}" class="${i === active ? 'active' : ''}" aria-selected="${i === active}">
        <span class="ac-name">${highlight(it.name, input.value)}</span>${c ? `<span class="ac-count">${c}曲</span>` : ''}</li>`;
    }).join('');
  };
  const paint = () => {
    const value = input.value.trim();
    const local = suggestArtists(state.profile.artists, state.songs, input.value);
    const known = new Set([...local, ...state.profile.artists].map((n) => normalize(n)));
    const extra = online.q === value
      ? online.names.filter((n) => !known.has(normalize(n)) && n !== value).slice(0, 6)
      : [];
    cb.show([...local.map((name) => ({ name })), ...extra.map((name) => ({ name, online: true }))], render);
  };
  const fetchOnline = () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2 || !navigator.onLine || online.q === q) return;
    timer = setTimeout(async () => {
      ctrl?.abort();
      ctrl = new AbortController();
      try {
        const names = await suggestArtistsOnline(q, { signal: ctrl.signal });
        online = { q, names };
        if (input.value.trim() === q) paint();
      } catch (e) {
        if (e.name !== 'AbortError') console.warn('artist suggest', e);
      }
    }, 350);
  };
  input.addEventListener('focus', () => {
    paint();
    fetchOnline();
  });
  input.addEventListener('input', () => {
    cb.reset();
    paint();
    fetchOnline();
  });
}

// 曲名：入力済みのアーティストの曲を iTunes から出す（選ぶとジャケット画像も入る）
export function setupTitleSuggest(input, list, getArtist, onPick) {
  let timer = 0;
  let ctrl = null;
  let loadedKey = '';
  let songs = [];
  const cb = combobox(input, list, {
    idPrefix: 'ac-title',
    onPick: (s) => {
      input.value = trimReading(s.title);
      input.blur();
      onPick?.(s);
    },
  });
  const render = (items, active, pre) => {
    const artist = getArtist().trim();
    const registered = new Set(state.songs.map(dupKey));
    // アーティストが未入力のときは曲名だけで探すので、候補にアーティスト名も出す
    const sub = (s) => [artist ? '' : s.artist, s.album].filter(Boolean).map(esc).join(' · ');
    return `<li class="ac-head" role="presentation">${artist ? 'iTunes の候補' : 'iTunes の候補（曲名で検索）'}</li>` + items.map((s, i) => {
      const title = trimReading(s.title);
      const done = registered.has(dupKey({ artist: artist || s.artist, title }));
      return `<li role="option" id="${pre}-${i}" data-i="${i}" class="song-opt${i === active ? ' active' : ''}" aria-selected="${i === active}">
        <span class="ac-art">${s.artwork ? `<img src="${esc(s.artwork)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : icon('music')}</span>
        <span class="ac-text"><span class="ac-name">${highlight(title, input.value)}</span>${sub(s) ? `<span class="ac-sub">${sub(s)}</span>` : ''}</span>
        ${done ? '<span class="ac-count">登録済み</span>' : ''}</li>`;
    }).join('');
  };
  const load = ({ pin = false } = {}) => {
    clearTimeout(timer);
    const artist = getArtist().trim();
    const q = input.value.trim();
    // アーティストが決まっていればその曲から、未入力なら曲名だけで探す
    if (!navigator.onLine || (!artist && !q)) return cb.hide();
    const key = `${artist}\u0001${q}`;
    if (key === loadedKey) return cb.show(songs, render, { pin });
    if (!songs.length || pin) cb.message('iTunes で曲を探しています…', { pin });
    timer = setTimeout(async () => {
      ctrl?.abort();
      ctrl = new AbortController();
      try {
        const found = artist
          ? await suggestSongsOnline(artist, q, { signal: ctrl.signal })
          : await suggestSongsByTitle(q, { signal: ctrl.signal });
        if (`${getArtist().trim()}\u0001${input.value.trim()}` !== key) return;
        if (found.length) loadedKey = key;
        songs = found.slice(0, 8);
        cb.reset();
        cb.show(songs, render, { pin });
      } catch (e) {
        if (e.name !== 'AbortError') console.warn('title suggest', e);
      }
    }, q ? 300 : 30);
  };
  input.addEventListener('focus', () => load());
  input.addEventListener('input', () => {
    cb.reset();
    load();
  });
  // キーボードを閉じたまま、そのアーティストの曲名の候補を出す
  return { open: () => load({ pin: true }) };
}
