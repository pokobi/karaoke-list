// iTunes の試聴（曲の一部・約 30 秒）を、曲の詳細画面の「試聴」で今のキーに合わせて再生する音源。
// 初めて再生するときに曲を探して、見つかった曲を song.ext.previewTrack に覚える（ほかの端末とも共有される）。
// Apple の決まりに合わせて、試聴はストアの曲の紹介として扱い、Apple Music のバッジとその曲へのリンクを添える。
import { $, esc, icon, openSheet } from './ui.js';
import { searchSongs, artworkUrl, rankPreviews, releaseYear } from './itunes.js';

const EXT_KEY = 'previewTrack';

const saved = (song) => {
  const t = song?.ext?.[EXT_KEY];
  return t && typeof t.url === 'string' && t.url ? t : null;
};

const toSaved = (s) => ({
  id: s.trackId,
  url: s.previewUrl,
  title: s.title,
  artist: s.artist,
  album: s.album,
  year: releaseYear(s),
  link: s.trackUrl,
});

function failure(message) {
  const err = new Error(message);
  err.userMessage = message;
  return err;
}

async function candidates(song, term) {
  const q = (term ?? `${song.artist} ${song.title}`).trim();
  let res;
  try {
    res = await searchSongs(q, { limit: 25 });
  } catch (err) {
    console.error(err);
    throw failure('iTunes で探せませんでした（通信を確認してください）');
  }
  if (res === null) throw failure('iTunes への問い合わせが続いたため、少し待ってからもう一度お試しください');
  return rankPreviews(res, song.artist, song.title);
}

// 試聴に使う曲を、検索結果から選び直す。選んだら true
function pickTrack(song, ctx) {
  const cur = saved(song);
  const term = `${song.artist} ${song.title}`.trim();
  return new Promise((resolve) => {
    let changed = false;
    let items = [];
    const sheet = openSheet(`<div class="itp">
        <div class="sheet-head"><h3>試聴する音源を選ぶ</h3><button type="button" class="icon-btn" data-act="close" aria-label="閉じる">${icon('close')}</button></div>
        <div class="sheet-body">
          <form class="itp-search"><input class="input" type="search" name="q" value="${esc(term)}" aria-label="検索する言葉" enterkeyhint="search"><button type="submit" class="btn sm">${icon('search')}検索</button></form>
          <div data-role="list"></div>
          <p class="hint">iTunes の試聴（曲の一部）を再生します。ライブ版などが選ばれているときは、ここで選び直してください。</p>
        </div>
      </div>`, { label: '試聴する音源を選ぶ', onClose: () => resolve(changed) });
    const list = $('[data-role="list"]', sheet.el);

    const load = async (q) => {
      list.innerHTML = '<p class="hint">探しています…</p>';
      try {
        items = (await candidates(song, q)).slice(0, 15);
      } catch (err) {
        list.innerHTML = `<p class="hint">${esc(err.userMessage ?? '探せませんでした')}</p>`;
        return;
      }
      if (!list.isConnected) return;
      if (!items.length) {
        list.innerHTML = '<p class="hint">試聴できる曲が見つかりませんでした。検索する言葉を変えてみてください。</p>';
        return;
      }
      list.innerHTML = `<div class="itp-list">${items.map((s, i) => {
        const on = cur && cur.id === s.trackId;
        const year = releaseYear(s);
        return `<button type="button" class="itp-item${on ? ' on' : ''}" data-i="${i}"${on ? ' aria-current="true"' : ''}>
            ${s.artwork ? `<img src="${esc(artworkUrl(s.artwork, 100))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="itp-noart">${icon('music')}</span>`}
            <span class="itp-text"><span class="itp-title">${esc(s.title)}</span><span class="itp-sub">${esc(s.artist)}${s.album ? ` · ${esc(s.album)}` : ''}${year ? ` · ${year}` : ''}</span></span>
            ${on ? icon('check') : ''}
          </button>`;
      }).join('')}</div>`;
    };

    sheet.el.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = String(new FormData(e.target).get('q') ?? '').trim();
      if (q) load(q);
    });
    sheet.el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.act === 'close') {
        sheet.close();
        return;
      }
      if (b.dataset.i != null) {
        const s = items[+b.dataset.i];
        if (!s) return;
        if (!cur || cur.id !== s.trackId || cur.url !== s.previewUrl) {
          ctx.saveExt({ [EXT_KEY]: toSaved(s) });
          changed = true;
        }
        sheet.close();
      }
    });
    load(term);
  });
}

// 試聴欄の音源（preview.js の createPreview に渡す形。js/plugins.js の previewSource と同じ）
export const itunesPreviewSource = {
  id: 'itunes',
  label: 'iTunes の試聴',
  hint: '曲の一部（約30秒）を再生します',
  info(song) {
    const t = saved(song);
    if (!t) return null;
    return {
      text: `${t.title} / ${t.artist}${t.album ? `（${t.album}${t.year ? `・${t.year}` : ''}）` : ''}`,
      link: t.link ? { href: t.link, label: 'Apple Music で聴く', badge: 'apple-music' } : null,
    };
  },
  async resolve(song, ctx, { refresh = false } = {}) {
    const t = saved(song);
    if (t && !refresh) return t.url;
    const list = await candidates(song);
    // 選んである曲は、同じ曲の新しい URL を使う
    const hit = (t && list.find((s) => s.trackId === t.id)) || list[0];
    if (!hit) return null;
    ctx.saveExt({ [EXT_KEY]: toSaved(hit) });
    return hit.previewUrl;
  },
  pick: { label: 'ほかの音源を選ぶ', run: pickTrack },
};
