// 曲の登録・編集フォーム

import { RANGE_FIELDS, KEY_MIN, KEY_MAX, isNote, clampKey, toggleOctave } from '../notes.js';
import { emptySong, toPayload, dupKey, isRangeMissing } from '../model.js';
import { fmtNoteHTML } from '../display.js';
import { songsOfArtist } from '../itunes.js';
import { $, esc, icon, openSheet, confirmDialog, toast, pickNote } from '../ui.js';
import { DEFAULT_OCTAVE, state, rangeAuto, tagList, pad2, paintKv } from './core.js';
import { setupArtistSuggest, setupTitleSuggest } from './suggest.js';
import { rangeActionsHTML, openRangeSearch, runRangeBatch, runRangeAction } from './plugin-host.js';
import { openArtPicker, autoArtwork } from './artwork.js';
import { ensureTags, tagC } from './tags.js';

// ---- 登録・編集フォーム -----------------------------------------------

function formHTML(isNew, openMore) {
  return `<form class="form" novalidate autocomplete="off">
    <div class="sheet-head">
      <h3>${isNew ? '曲を登録' : '曲を編集'}</h3>
      <button type="button" class="icon-btn" data-act="cancel" aria-label="閉じる">${icon('close')}</button>
    </div>
    <div class="sheet-body">
      <div class="field ac">
        <label class="label" for="fm-artist">アーティスト</label>
        <input class="input" id="fm-artist" name="artist" maxlength="100" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="next"
          role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="fm-artist-list">
        <ul class="ac-list" id="fm-artist-list" role="listbox" hidden></ul>
      </div>
      <div class="field ac">
        <label class="label" for="fm-title">曲名</label>
        <input class="input" id="fm-title" name="title" maxlength="150" autocomplete="off" enterkeyhint="done"
          role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="fm-title-list">
        <ul class="ac-list song-ac" id="fm-title-list" role="listbox" hidden></ul>
      </div>
      <div class="field">
        <span class="label">ジャケット画像</span>
        <div class="art-edit">
          <span class="art-prev" data-role="art-prev">${icon('music')}<img alt="" referrerpolicy="no-referrer" hidden></span>
          <button type="button" class="pill" data-act="art-find">${icon('search')}画像を探す</button>
          <button type="button" class="pill" data-act="art-clear" hidden>${icon('close')}外す</button>
        </div>
        <p class="hint">曲名を候補から選ぶと自動で入ります。未設定のまま登録すると、あとから自動で探します。</p>
      </div>
      <div class="field">
        <span class="label">音域</span>
        <div class="note-fields">
          ${RANGE_FIELDS.map((f) => `<button type="button" class="note-field" data-field="${f.id}"><span class="nf-l">${f.label}</span><span class="nf-v"></span></button>`).join('')}
        </div>
        <p class="field-warn" data-role="range-warn" hidden></p>
        ${rangeActionsHTML()}
      </div>
      <div class="field">
        <span class="label">キー</span>
        <div class="key-edit">
          <div class="stepper">
            <button type="button" class="kb" data-act="k-down" aria-label="キーを1下げる">${icon('minus')}</button>
            <output class="kv" data-role="kv"></output>
            <button type="button" class="kb" data-act="k-up" aria-label="キーを1上げる">${icon('plus')}</button>
          </div>
          <button type="button" class="pill" data-act="k-reset">${icon('reset')}原キー</button>
          <button type="button" class="pill" data-act="k-oct-down">${icon('octave')}オク下</button>
          <button type="button" class="pill" data-act="k-oct-up">${icon('octave', 'flip')}オク上</button>
          <span class="key-actual" data-role="key-actual"></span>
        </div>
      </div>
      <details class="more"${openMore ? ' open' : ''}>
        <summary><span>お気に入り・タグ・記録・メモ</span>${icon('chevron-down')}</summary>
        <div class="more-body">
          <label class="switch-row"><span>お気に入り</span><input type="checkbox" class="switch" name="favorite"></label>
          <div class="field">
            <span class="label">タグ</span>
            <div class="chip-set" data-role="tags"></div>
            <div class="tag-add">
              <input class="input" data-role="tag-input" placeholder="新しいタグ" maxlength="20" enterkeyhint="done" aria-label="新しいタグ">
              <button type="button" class="btn" data-act="tag-add">追加</button>
            </div>
          </div>
          <div class="field-grid">
            <div class="field"><label class="label" for="fm-score">採点</label><input class="input" id="fm-score" name="score" type="number" inputmode="decimal" min="0" max="100" step="0.001" placeholder="例 92.345"></div>
            <div class="field"><label class="label" for="fm-count">歌った回数</label><input class="input" id="fm-count" name="singCount" type="number" inputmode="numeric" min="0" step="1"></div>
            <div class="field span2"><label class="label" for="fm-last">最終歌唱日</label><input class="input" id="fm-last" name="lastSungAt" type="date"></div>
          </div>
          <div class="field"><label class="label" for="fm-memo">メモ</label><textarea class="input" id="fm-memo" name="memo" rows="3" maxlength="1000"></textarea></div>
        </div>
      </details>
      <p class="form-error" data-role="error" role="alert" hidden></p>
    </div>
    <div class="sheet-foot">
      ${isNew ? '<button type="button" class="btn" data-act="save-next">続けて登録</button>' : ''}
      <button type="submit" class="btn primary">${isNew ? '登録' : '保存'}</button>
    </div>
  </form>`;
}

const dateInputValue = (ms) => {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

export function openForm(song = null) {
  const isNew = !song;
  let draft = isNew ? emptySong() : { ...song, tags: [...song.tags] };
  const hasMore = !isNew && (song.favorite || song.tags.length || song.score != null || song.singCount || song.lastSungAt || song.memo);
  const sheet = openSheet(formHTML(isNew, hasMore), {
    label: isNew ? '曲を登録' : '曲を編集',
    dismissible: false,
    className: 'form-layer',
  });
  const form = $('form', sheet.el);
  const el = (sel) => $(sel, form);
  const extraTags = new Set();

  const fill = () => {
    form.artist.value = draft.artist;
    form.title.value = draft.title;
    form.favorite.checked = draft.favorite;
    form.score.value = draft.score ?? '';
    form.singCount.value = draft.singCount || '';
    form.lastSungAt.value = dateInputValue(draft.lastSungAt);
    form.memo.value = draft.memo;
    paintRange();
    paintKey();
    paintTags();
    paintArt();
  };

  // 追加機能に渡す、フォームを操作するための窓口
  const pluginCtx = {
    get artist() { return form.artist.value.trim(); },
    get title() { return form.title.value.trim(); },
    searchWeb: () => openRangeSearch(form.artist.value, form.title.value),
    current: () => ({ low: draft.low, chestHigh: draft.chestHigh, falsettoHigh: draft.falsettoHigh }),
    applyRange: (range, extPatch) => {
      for (const f of RANGE_FIELDS) if (range[f.id] !== undefined) draft[f.id] = range[f.id];
      if (extPatch) draft.ext = { ...(draft.ext ?? {}), ...extPatch };
      paintRange();
    },
  };

  const paintArt = () => {
    const img = $('img', el('[data-role="art-prev"]'));
    if (draft.artwork) {
      img.src = draft.artwork;
      img.hidden = false;
    } else {
      img.hidden = true;
      img.removeAttribute('src');
    }
    el('[data-act="art-clear"]').hidden = !draft.artwork;
  };

  const paintRange = () => {
    for (const f of RANGE_FIELDS) {
      const b = el(`[data-field="${f.id}"]`);
      const v = draft[f.id];
      $('.nf-v', b).innerHTML = isNote(v) ? fmtNoteHTML(v) : f.id === 'falsettoHigh' ? 'なし' : '未選択';
      b.classList.toggle('set', isNote(v));
    }
    const warns = [];
    if (isNote(draft.low) && isNote(draft.chestHigh) && draft.low > draft.chestHigh) warns.push('最低音が地声最高音より高くなっています');
    if (isNote(draft.low) && isNote(draft.falsettoHigh) && draft.low > draft.falsettoHigh) warns.push('最低音が裏声最高音より高くなっています');
    const w = el('[data-role="range-warn"]');
    w.hidden = !warns.length;
    w.textContent = warns.join('。');
    // 最低音か地声最高音が未入力なら、「音域を調べる」に色を付ける
    const missing = !isNote(draft.low) || !isNote(draft.chestHigh);
    for (const b of form.querySelectorAll('.pill-lookup')) b.classList.toggle('urgent', missing);
  };

  const paintKey = () => {
    const kd = paintKv(el('[data-role="kv"]'), draft.key, draft.octave);
    el('[data-role="key-actual"]').textContent = kd.oct ? `実際 ${kd.actual}` : '';
    el('[data-act="k-down"]').disabled = draft.key <= KEY_MIN;
    el('[data-act="k-up"]').disabled = draft.key >= KEY_MAX;
    el('[data-act="k-reset"]').setAttribute('aria-pressed', String(draft.key === 0 && !draft.octave));
    el('[data-act="k-oct-down"]').setAttribute('aria-pressed', String(draft.octave === -1));
    el('[data-act="k-oct-up"]').setAttribute('aria-pressed', String(draft.octave === 1));
  };

  const paintTags = () => {
    const tags = [...new Set([...tagList(), ...extraTags, ...draft.tags])];
    el('[data-role="tags"]').innerHTML = tags.map((t) => {
      const on = draft.tags.includes(t);
      return `<button type="button" class="chip${on ? ' on' : ''}"${tagC(t)} data-tag="${esc(t)}" aria-pressed="${on}">${esc(t)}</button>`;
    }).join('');
  };

  const addTag = () => {
    const input = el('[data-role="tag-input"]');
    const t = input.value.trim();
    if (!t) return;
    if (!draft.tags.includes(t)) draft.tags.push(t);
    extraTags.add(t);
    input.value = '';
    paintTags();
  };

  const showError = (msg, focusEl) => {
    const e = el('[data-role="error"]');
    e.textContent = msg;
    e.hidden = !msg;
    if (msg) {
      focusEl?.focus();
      e.scrollIntoView({ block: 'nearest' });
    }
  };

  // アーティストが決まったら、その曲一覧を先に読み込んでおき、曲名の候補をすぐ出せるようにする
  const prefetchSongs = () => {
    const a = form.artist.value.trim();
    if (a && navigator.onLine) songsOfArtist(a).catch(() => {});
  };
  form.artist.addEventListener('change', prefetchSongs);
  const titleSuggest = setupTitleSuggest(form.title, el('#fm-title-list'), () => form.artist.value, (s) => {
    // 曲名だけで探して選んだときは、アーティスト名も入れる
    if (!form.artist.value.trim() && s.artist) {
      form.artist.value = s.artist;
      prefetchSongs();
    }
    if (s.artwork) {
      draft.artwork = s.artwork;
      paintArt();
    }
  });
  // アーティストが決まったら、キーボードを閉じて、そのアーティストの曲名の候補を出す
  const afterArtist = () => {
    prefetchSongs();
    form.artist.blur();
    if (form.artist.value.trim()) titleSuggest.open();
  };
  setupArtistSuggest(form.artist, el('#fm-artist-list'), afterArtist);

  form.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.tagName === 'TEXTAREA' || e.isComposing) return;
    if (e.target.matches('[data-role="tag-input"]')) {
      e.preventDefault();
      addTag();
    } else if (e.target === form.artist) {
      if (!e.defaultPrevented) {
        e.preventDefault();
        afterArtist();
      }
    } else if (e.target.matches('input')) {
      e.preventDefault();
      e.target.blur();
    }
  });

  form.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.tag != null) {
      const t = b.dataset.tag;
      draft.tags = draft.tags.includes(t) ? draft.tags.filter((x) => x !== t) : [...draft.tags, t];
      paintTags();
      return;
    }
    if (b.dataset.plugin != null) {
      await runRangeAction(+b.dataset.plugin, pluginCtx);
      return;
    }
    if (b.dataset.act === 'range-web') {
      openRangeSearch(form.artist.value, form.title.value);
      return;
    }
    if (b.dataset.field) {
      const f = RANGE_FIELDS.find((x) => x.id === b.dataset.field);
      const guess = isNote(draft.chestHigh) ? Math.floor(draft.chestHigh / 12) : DEFAULT_OCTAVE[f.id];
      const v = await pickNote({
        title: f.label,
        value: draft[f.id],
        octave: f.id === 'chestHigh' ? DEFAULT_OCTAVE.chestHigh : f.id === 'falsettoHigh' ? Math.max(guess, DEFAULT_OCTAVE.chestHigh) : DEFAULT_OCTAVE.low,
        clearLabel: f.id === 'falsettoHigh' ? '裏声なし' : '未選択に戻す',
      });
      if (v === undefined) return;
      draft[f.id] = v;
      paintRange();
      return;
    }
    switch (b.dataset.act) {
      case 'cancel': sheet.close(); break;
      case 'k-down': draft.key = clampKey(draft.key - 1); paintKey(); break;
      case 'k-up': draft.key = clampKey(draft.key + 1); paintKey(); break;
      case 'k-reset': draft.key = 0; draft.octave = 0; paintKey(); break;
      case 'k-oct-down': Object.assign(draft, toggleOctave(draft.key, draft.octave, -1)); paintKey(); break;
      case 'k-oct-up': Object.assign(draft, toggleOctave(draft.key, draft.octave, 1)); paintKey(); break;
      case 'tag-add': addTag(); break;
      case 'art-find': {
        const url = await openArtPicker(form.artist.value, form.title.value);
        if (url !== undefined) {
          draft.artwork = url;
          paintArt();
        }
        break;
      }
      case 'art-clear': draft.artwork = null; paintArt(); break;
      case 'save-next': save(true); break;
      default:
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    save(false);
  });

  async function save(next) {
    const artist = form.artist.value.trim();
    const title = form.title.value.trim();
    if (!artist) return showError('アーティストを入力してください', form.artist);
    if (!title) return showError('曲名を入力してください', form.title);
    let score = null;
    if (form.score.value.trim() !== '') {
      score = Number(form.score.value);
      if (!Number.isFinite(score) || score < 0 || score > 100) {
        el('.more').open = true;
        return showError('採点は 0〜100 の数字で入力してください', form.score);
      }
      score = Math.round(score * 1000) / 1000;
    }
    let singCount = 0;
    if (form.singCount.value.trim() !== '') {
      singCount = Number(form.singCount.value);
      if (!Number.isInteger(singCount) || singCount < 0) {
        el('.more').open = true;
        return showError('歌った回数は 0 以上の整数で入力してください', form.singCount);
      }
    }
    let lastSungAt = null;
    const dv = form.lastSungAt.value;
    // 歌った回数が 0 なら、最終歌唱日も消す
    if (dv && singCount > 0) {
      if (dv === dateInputValue(draft.lastSungAt)) lastSungAt = draft.lastSungAt;
      else {
        const [y, m, d] = dv.split('-').map(Number);
        lastSungAt = new Date(y, m - 1, d, 12, 0).getTime();
      }
    }
    showError('');
    const now = Date.now();
    const data = {
      ...draft,
      artist,
      title,
      favorite: form.favorite.checked,
      memo: form.memo.value.trim(),
      score,
      singCount,
      lastSungAt,
      updatedAt: now,
    };
    const dup = state.songs.find((x) => x.id !== song?.id && dupKey(x) === dupKey(data));
    if (dup) {
      const ok = await confirmDialog({
        title: '同じ曲が登録されています',
        message: `${dup.title} / ${dup.artist}\nこのまま${isNew ? '登録' : '保存'}しますか？`,
        ok: isNew ? '登録する' : '保存する',
      });
      if (!ok) return;
    }
    let id = song?.id;
    if (isNew) {
      data.createdAt = now;
      id = state.store.addSong(toPayload(data));
    } else {
      state.store.updateSong(song.id, toPayload(data));
    }
    if (!data.artwork) autoArtwork(id, artist, title);
    // 音域を入れずに登録した曲は、追加機能で音域を補う
    if (isNew && isRangeMissing(data) && rangeAuto()) runRangeBatch([{ id, artist, title }], { quiet: true });
    if (!state.profile.artists.includes(artist)) state.store.addArtists([artist]);
    if (data.tags.length) ensureTags(data.tags);
    toast(isNew ? `登録しました：${title}` : '保存しました');
    if (next) {
      draft = { ...emptySong(), artist, tags: [] };
      fill();
      el('.sheet-body').scrollTop = 0;
      // キーボードは閉じたまま、同じアーティストの曲名の候補を出す
      document.activeElement?.blur?.();
      // 登録した曲がデータに反映されてから出す（候補に「登録済み」と付けるため）
      setTimeout(() => titleSuggest.open(), 80);
    } else {
      sheet.close();
    }
  }

  fill();
  if (isNew) setTimeout(() => form.artist.focus({ preventScroll: true }), 60);
}
