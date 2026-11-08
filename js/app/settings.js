// 設定の画面と、アーティストの一覧。表示の設定（端末ごと・アカウントごと）の反映もここで行う

import { RANGE_FIELDS, isNote } from '../notes.js';
import { collator } from '../text.js';
import { dupKey, artistCounts, ACCENTS, NOTE_STYLES, REC_OFFSETS, isRangeMissing } from '../model.js';
import { setNoteStyle, getNoteStyle, fmtNoteHTML } from '../display.js';
import { trimReading } from '../itunes.js';
import { $, $$, esc, icon, openSheet, confirmDialog, toast, pickNote } from '../ui.js';
import { sanitizeHaptics, hapticMode } from '../haptics.js';
import { RANDOM_FX } from '../random-fx.js';
import { previewSupported, audioFiles, formatBytes } from '../preview.js';
import { signIn, offerLocalMove } from '../app.js';
import { DEFAULT_OCTAVE, devicePrefs, saveDevicePrefs, state, voice, rangeAuto, tagList, sleep } from './core.js';
import { render, invalidateList, updateView } from './list.js';
import { paintKeyMenu, paintDetail } from './detail.js';
import { paintRandom } from './random-sheet.js';
import { rangeBatches, runRangeBatch } from './plugin-host.js';
import { artJob, runArtJob } from './artwork.js';
import { pickAudioFiles } from './audio-files.js';
import { openTextImport } from './add-text.js';
import { openVoiceMeasure } from './measure.js';
import { openTagManager } from './tags.js';
import { exportCSV } from './csv-file.js';

// ---- 設定 -------------------------------------------------------------

export function openSettings() {
  if (state.settings) return;
  const sheet = openSheet('<div class="settings"></div>', {
    label: '設定',
    onClose: () => { state.settings = null; },
  });
  state.settings = sheet;
  paintSettings();
  sheet.el.addEventListener('click', onSettingsClick);
  sheet.el.addEventListener('change', (e) => {
    if (e.target.dataset.role === 'show-art') {
      updateView({ showArt: e.target.checked });
      paintSettings();
    }
    if (e.target.dataset.role === 'swipe') setDevicePref({ swipe: e.target.checked });
    if (e.target.dataset.role === 'rec-up') updateAccountPrefs({ recUp: e.target.checked });
    if (e.target.dataset.role === 'range-auto') updateAccountPrefs({ rangeAuto: e.target.checked });
    if (e.target.dataset.role === 'hap-on') setHaptics({ on: e.target.checked });
  });
}

// 触覚フィードバックの設定（この端末）。指で操作する端末で、振動できるときだけ出す
function hapticsSettingsHTML() {
  const mode = hapticMode();
  if (!mode) return '';
  const hp = devicePrefs.haptics;
  return `<section class="set-sec">
        <h4>触覚フィードバック（この端末）</h4>
        <label class="switch-row"><span>操作したときに振動する</span><input type="checkbox" class="switch" data-role="hap-on"${hp.on ? ' checked' : ''}></label>
        ${mode === 'ios' ? '<p class="hint">iPhone では iOS 18 以降で、本体の「設定」→「サウンドと触覚」→「システムの触覚」がオンのときに振動します。</p>' : ''}
      </section>`;
}

function setHaptics(patch) {
  setDevicePref({ haptics: sanitizeHaptics({ ...devicePrefs.haptics, ...patch }) });
}

export function paintSettings() {
  const sheet = state.settings;
  if (!sheet) return;
  const vo = voice();
  const scrollTop = $('.settings .sheet-body', sheet.el)?.scrollTop ?? 0;
  const p = state.profile.prefs;
  const seg = (attr, options, current) => `<div class="seg full" role="group">${options.map(([v, l]) => `<button type="button" data-${attr}="${v}" aria-pressed="${String(v) === String(current)}">${l}</button>`).join('')}</div>`;
  $('.settings', sheet.el).innerHTML = `
    <div class="sheet-head"><h3>設定</h3><button type="button" class="icon-btn" data-act="close" aria-label="閉じる">${icon('close')}</button></div>
    <div class="sheet-body">
      ${accountSettingsHTML()}
      <section class="set-sec">
        <h4>表示（この端末）</h4>
        <span class="set-label">テーマ</span>
        ${seg('theme-set', [['system', '端末に合わせる'], ['light', 'ライト'], ['dark', 'ダーク']], devicePrefs.theme)}
        <span class="set-label">一覧の文字の大きさ</span>
        ${seg('density', [['compact', 'コンパクト'], ['normal', '標準'], ['large', '大きめ']], devicePrefs.density)}
        <label class="switch-row"><span>一覧にジャケット画像を表示</span><input type="checkbox" class="switch" data-role="show-art"${state.view.showArt ? ' checked' : ''}></label>
        <label class="switch-row"><span>一覧のスワイプ操作</span><input type="checkbox" class="switch" data-role="swipe"${devicePrefs.swipe ? ' checked' : ''}></label>
        <p class="hint">曲の行を右へスワイプすると「歌った！」を記録し、左へスワイプするとお気に入りを切り替えます（スマホなど指で操作するときだけ）。</p>
        <span class="set-label">ランダム選曲の演出</span>
        ${seg('random-fx', RANDOM_FX.map((f) => [f.id, f.label]), devicePrefs.randomFx)}
        <p class="hint">曲を選ぶときの演出です。演出の途中で画面をタップすると、すぐに結果を表示します。</p>
      </section>
      ${hapticsSettingsHTML()}
      <section class="set-sec">
        <h4>表示（すべての端末で共通）</h4>
        <span class="set-label">アクセントカラー</span>
        <div class="accent-set">${ACCENTS.map((a) => `<button type="button" class="swatch" style="background:${a.color}" data-accent-set="${a.id}" aria-pressed="${p.accent === a.id}" aria-label="${a.label}" title="${a.label}">${icon('check')}</button>`).join('')}</div>
        <span class="set-label">音域の表記</span>
        ${seg('note-style', NOTE_STYLES.map((s) => [s.id, s.label]), p.noteStyle)}
        <p class="hint">G4 形式は音楽で一般的な表記で、mid2G は G4、hiA は A4 です。「両方」では、詳細画面や入力欄に並べて表示します。</p>
      </section>
      <section class="set-sec">
        <h4>自分の音域</h4>
        <div class="note-fields">
          ${RANGE_FIELDS.map((f) => `<button type="button" class="note-field${isNote(vo[f.id]) ? ' set' : ''}" data-voice="${f.id}"><span class="nf-l">${f.label}</span><span class="nf-v">${isNote(vo[f.id]) ? fmtNoteHTML(vo[f.id]) : '未選択'}</span></button>`).join('')}
        </div>
        <button type="button" class="btn wide vm-open" data-act="voice-measure">${icon('mic')}マイクで測る</button>
        <p class="hint">登録すると、曲ごとに「おすすめキー」を表示します。マイクで声を出して測ることもできます。</p>
        <span class="set-label">おすすめキーの余裕</span>
        ${seg('offset', REC_OFFSETS.map((m) => [m, m ? `−${m}半音` : 'ちょうど']), p.recOffset)}
        <p class="hint">おすすめキーは、曲の地声最高音が、自分の地声最高音よりこの分だけ低くなるキーです。そのキーでも最低音や裏声最高音が自分の音域を超えるときは、注意を表示します。</p>
        <label class="switch-row"><span>キーを上げるおすすめも出す</span><input type="checkbox" class="switch" data-role="rec-up"${p.recUp !== false ? ' checked' : ''}></label>
        <p class="hint">オフにすると、原曲より高く歌うおすすめキーは出さず、代わりに原キーをすすめます。オク下で歌うおすすめ（オク下 +5 など）は、オフでも出します。</p>
      </section>
      <section class="set-sec">
        <h4>タグと入力補助</h4>
        <button type="button" class="row-btn" data-act="tags">
          <span class="row-l">${icon('tag')}タグの管理</span>
          <span class="row-r">${tagList().length}件${icon('chevron-right')}</span>
        </button>
        <button type="button" class="row-btn" data-act="artists" style="margin-top:8px">
          <span class="row-l">${icon('list')}アーティスト名の候補</span>
          <span class="row-r">${state.profile.artists.length}件${icon('chevron-right')}</span>
        </button>
      </section>
      ${readingSettingsHTML()}
      ${rangeBatchSettingsHTML()}
      <section class="set-sec">
        <h4>ジャケット画像</h4>
        <div data-role="art-job">${artJobHTML()}</div>
        <p class="hint">画像が未設定の曲を iTunes で探して入れます。1曲に数秒かかるので、曲数が多いときは時間がかかります。</p>
      </section>
      <section class="set-sec">
        <h4>まとめて追加</h4>
        <button type="button" class="btn wide" data-act="text-import">${icon('list')}テキスト・ファイルから追加</button>
        <p class="hint">メモに書いた曲の一覧、音楽サービスから書き出した曲の一覧（CSV など）、YouTube の再生リストのリンクから、確認してからまとめて追加できます。</p>
        <button type="button" class="btn wide" data-act="history">${icon('history')}YouTube Music の再生履歴を読み込む</button>
        <p class="hint">Google Takeout で書き出した watch-history.json（ZIP のままでも可）から、よく聴いている曲を候補に出します。履歴はこの端末の中だけで読み込み、どこにも保存しません。</p>
      </section>
      <section class="set-sec">
        <h4>バックアップ</h4>
        <div class="btn-row">
          <button type="button" class="btn" data-act="export">${icon('download')}CSVに書き出す</button>
          <button type="button" class="btn" data-act="import">${icon('upload')}CSVを読み込む</button>
        </div>
        <p class="hint">CSV は表計算ソフトで編集できます。読み込むと、まとめて登録・復元できます。</p>
      </section>
      ${previewSupported() ? `<section class="set-sec" data-role="pv-files">
        <h4>試聴の音楽ファイル（この端末）</h4>
        <div class="pv-files" data-role="pv-sum-row" hidden><span data-role="pv-sum"></span><button type="button" class="btn sm danger-ghost" data-act="pv-clear">${icon('trash')}すべて削除</button></div>
        <button type="button" class="btn wide" data-act="audio-import">${icon('music')}音楽ファイルをまとめて割り当てる</button>
        <p class="hint">端末にある曲のファイルを複数選ぶと、ファイルの中の曲名・アーティスト名（なければファイル名）から登録済みの曲を探して、試聴に使えるようにします。割り当てる前に確認・修正できます。ファイルはこの端末にだけ保存し、元のファイルと同じだけ容量を使います。</p>
      </section>` : ''}
    </div>`;
  const body = $('.settings .sheet-body', sheet.el);
  if (body) body.scrollTop = scrollTop;
  paintAudioFiles();
}

function accountSettingsHTML() {
  const user = state.user;
  if (!state.store.canSignIn) {
    return `<section class="set-sec">
        <h4>アカウント</h4>
        <p class="hint">ローカルモード：データはこのブラウザだけに保存されています。</p>
      </section>`;
  }
  if (user?.local) {
    return `<section class="set-sec">
        <h4>アカウント</h4>
        <p class="hint">ログインしていません。データはこの端末のブラウザだけに保存しています。</p>
        <button type="button" class="btn primary wide" data-act="login"${state.signingIn ? ' disabled' : ''}>${icon('login')}Google でログイン</button>
        <p class="hint">ログインすると、スマホと PC など複数の端末で同じリストを使えます。この端末の曲は、ログインしたあとにアカウントへ移せます。</p>
      </section>`;
  }
  const n = state.store.localData().songs.length;
  return `<section class="set-sec">
      <h4>アカウント</h4>
      <div class="account"><span class="acc-name">${esc(user?.email ?? user?.name ?? '')}</span><button type="button" class="btn sm" data-act="logout">${icon('logout')}ログアウト</button></div>
      <p class="hint">ログインしている端末どうしで、同じリストを使えます。</p>
      ${n ? `<div class="acc-local">
        <span>ログインする前にこの端末に保存した曲が${n}曲あります。</span>
        <button type="button" class="btn sm" data-act="move-local"${state.moving ? ' disabled' : ''}>${icon('upload')}アカウントに移す</button>
      </div>` : ''}
    </section>`;
}

export async function paintAudioFiles() {
  const sec = state.settings && $('[data-role="pv-files"]', state.settings.el);
  if (!sec) return;
  let sum = null;
  try {
    sum = await audioFiles.summary();
  } catch {
    return;
  }
  if (!sec.isConnected) return;
  $('[data-role="pv-sum-row"]', sec).hidden = !sum.count;
  $('[data-role="pv-sum"]', sec).textContent = `${sum.count}曲（${formatBytes(sum.bytes)}）`;
}

async function onSettingsClick(e) {
  const b = e.target.closest('button');
  if (!b || !state.settings) return;
  if (b.dataset.voice) {
    const id = b.dataset.voice;
    const f = RANGE_FIELDS.find((x) => x.id === id);
    const v = await pickNote({ title: `自分の${f.label}`, value: voice()[id] ?? null, octave: DEFAULT_OCTAVE[id], clearLabel: '未選択に戻す' });
    if (v === undefined) return;
    state.store.updateProfile({ range: { ...voice(), [id]: v } });
    return;
  }
  if (b.dataset.themeSet) return setDevicePref({ theme: b.dataset.themeSet });
  if (b.dataset.density) return setDevicePref({ density: b.dataset.density });
  if (b.dataset.randomFx) return setDevicePref({ randomFx: b.dataset.randomFx });
  if (b.dataset.accentSet) return updateAccountPrefs({ accent: b.dataset.accentSet });
  if (b.dataset.noteStyle) return updateAccountPrefs({ noteStyle: b.dataset.noteStyle });
  if (b.dataset.offset != null) return updateAccountPrefs({ recOffset: +b.dataset.offset });
  switch (b.dataset.act) {
    case 'close': state.settings.close(); break;
    case 'artists': openArtists(); break;
    case 'tags': openTagManager(); break;
    case 'voice-measure': openVoiceMeasure(); break;
    case 'export': exportCSV(); break;
    case 'import': $('#csv-file').click(); break;
    case 'art-run': runArtJob(); break;
    case 'range-batch': {
      const targets = state.songs.filter(isRangeMissing);
      if (!targets.length) break;
      const ok = await confirmDialog({
        title: `${targets.length}曲の音域を取り込みますか？`,
        message: '1曲ずつ順に調べるので、曲数が多いと時間がかかります。調べている間も、ほかの操作はできます。',
        ok: '取り込む',
      });
      if (ok) runRangeBatch(targets.map((s) => ({ id: s.id, artist: s.artist, title: s.title })));
      break;
    }
    case 'reading': openReadingCleanup(); break;
    case 'art-cancel': artJob.cancel = true; break;
    case 'history': $('#history-file').click(); break;
    case 'text-import': openTextImport(); break;
    case 'audio-import': pickAudioFiles(); break;
    case 'pv-clear':
      if (await confirmDialog({ title: '試聴の音楽ファイルをすべて削除しますか？', message: 'この端末に保存したファイルを削除します。元のファイルは消えません。', ok: '削除する', danger: true })) {
        state.detail?.preview?.stop();
        await audioFiles.clear().catch(() => {});
        paintAudioFiles();
        toast('削除しました');
      }
      break;
    case 'login': signIn(); break;
    case 'move-local': offerLocalMove(); break;
    case 'logout':
      if (await confirmDialog({
        title: 'ログアウトしますか？',
        message: 'アカウントの曲は消えず、もう一度ログインすると表示されます。この端末では、ログインしていないときのリストに切り替わります。',
        ok: 'ログアウト',
      })) {
        state.settings?.close();
        state.store.signOut();
      }
      break;
    default:
  }
}

function openArtists() {
  const sheet = openSheet(`<div class="artists">
      <div class="sheet-head"><h3>アーティスト名の候補</h3><button type="button" class="icon-btn" data-act="close" aria-label="閉じる">${icon('close')}</button></div>
      <div class="sheet-body">
        <p class="hint">曲の登録時に候補として表示される名前です。候補から外しても、登録済みの曲は消えません。</p>
        <label class="search sm">${icon('search')}<input type="search" data-role="q" placeholder="絞り込み" autocomplete="off" aria-label="アーティスト名を絞り込む"></label>
        <ul class="artist-list" data-role="list"></ul>
      </div>
    </div>`, {
    label: 'アーティスト名の候補',
    onClose: () => { state.artistsSheet = null; },
  });
  state.artistsSheet = sheet;
  $('[data-role="q"]', sheet.el).addEventListener('input', paintArtists);
  sheet.el.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.act === 'close') sheet.close();
    if (b.dataset.remove != null) {
      const name = b.dataset.remove;
      const ok = await confirmDialog({
        title: '候補から外しますか？',
        message: `「${name}」を入力候補から外します。登録済みの曲は削除されません。`,
        ok: '候補から外す',
        danger: true,
      });
      if (ok) state.store.removeArtist(name);
    }
  });
  paintArtists();
}

export function paintArtists() {
  const sheet = state.artistsSheet;
  if (!sheet) return;
  const q = $('[data-role="q"]', sheet.el).value.trim().toLowerCase();
  const counts = artistCounts(state.songs);
  const names = [...state.profile.artists].sort(collator.compare).filter((n) => !q || n.toLowerCase().includes(q));
  $('[data-role="list"]', sheet.el).innerHTML = names.length
    ? names.map((n) => `<li><span class="al-name">${esc(n)}</span><span class="al-count">${counts.get(n) ?? 0}曲</span>
        <button type="button" class="icon-btn sm" data-remove="${esc(n)}" aria-label="${esc(n)}を候補から外す">${icon('trash')}</button></li>`).join('')
    : `<li class="al-empty">${q ? '一致する名前がありません' : 'まだ候補がありません'}</li>`;
}

// ---- 表示の設定 -------------------------------------------------------
// テーマと一覧の文字の大きさは端末ごと（この端末に記憶）。
// アクセントカラー・音域の表記・おすすめキーの余裕はアカウントに保存し、全端末で共通にする。

export function applyDevicePrefs() {
  const root = document.documentElement;
  if (devicePrefs.theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = devicePrefs.theme;
  if (devicePrefs.density === 'normal') delete root.dataset.density;
  else root.dataset.density = devicePrefs.density;
  // スマホのステータスバーの色もテーマに合わせる
  $$('meta[name="theme-color"]').forEach((m) => {
    const dark = devicePrefs.theme === 'system' ? m.media.includes('dark') : devicePrefs.theme === 'dark';
    m.content = dark ? '#0d0e11' : '#f4f5f7';
  });
}

function setDevicePref(patch) {
  Object.assign(devicePrefs, patch);
  saveDevicePrefs();
  applyDevicePrefs();
  paintSettings();
}

export function applyAccountPrefs() {
  const p = state.profile.prefs;
  if (getNoteStyle() !== p.noteStyle) {
    setNoteStyle(p.noteStyle);
    // 表記が変わったら、一覧などを描き直す
    invalidateList();
    if (state.detail) state.detail.sig = '';
  }
  const root = document.documentElement;
  if (p.accent === 'indigo') delete root.dataset.accent;
  else root.dataset.accent = p.accent;
  if (devicePrefs.accent !== p.accent) {
    devicePrefs.accent = p.accent;
    saveDevicePrefs();
  }
}

function updateAccountPrefs(patch) {
  const next = { ...state.profile.prefs, ...patch };
  state.profile.prefs = next;
  applyAccountPrefs();
  render();
  paintDetail();
  paintKeyMenu();
  paintSettings();
  paintRandom();
  state.store.updateProfile({ prefs: next });
}


// ---- 曲名の英語表記 -----------------------------------------------------
// 曲名の後ろに付いた英語表記（「さくら - Sakura」など）を外せる曲
const readingTargets = () => state.songs.flatMap((s) => {
  const to = trimReading(s.title);
  return to !== s.title ? [{ id: s.id, artist: s.artist, from: s.title, to }] : [];
});

function readingSettingsHTML() {
  const n = readingTargets().length;
  if (!n) return '';
  return `<section class="set-sec">
        <h4>曲名の英語表記</h4>
        <button type="button" class="btn wide" data-act="reading">${icon('pen')}曲名の英語表記を外す（${n}曲）</button>
        <p class="hint">「さくら - Sakura」のように曲名の後ろに付いた英語表記を、一覧で確認してから外します。</p>
      </section>`;
}

function openReadingCleanup() {
  const targets = readingTargets();
  if (!targets.length) return;
  const registered = new Set(state.songs.map(dupKey));
  // 外すと、登録済みのほかの曲と同じ曲名になるものは、最初はチェックを外しておく
  const items = targets.map((x) => ({ ...x, dup: registered.has(dupKey({ artist: x.artist, title: x.to })) }));
  const sheet = openSheet(`<div class="rdg">
      <div class="sheet-head"><h3>曲名の英語表記を外す</h3><button type="button" class="icon-btn" data-act="close" aria-label="閉じる">${icon('close')}</button></div>
      <div class="sheet-body">
        <p class="hint">英語表記を外す曲にチェックを付けてください。英語表記も曲名の一部の場合は、チェックを外してください。</p>
        <ul class="rdg-list">${items.map((x, i) => `<li><label class="rdg-row">
            <input type="checkbox" data-i="${i}"${x.dup ? '' : ' checked'}>
            <span class="rdg-text"><span class="rdg-to">${esc(x.to)}</span><span class="rdg-from">${esc(x.from)}${x.artist ? ` · ${esc(x.artist)}` : ''}</span>${x.dup ? '<span class="rdg-dup">外すと、登録済みの曲と同じ曲名になります</span>' : ''}</span>
          </label></li>`).join('')}</ul>
      </div>
      <div class="sheet-foot"><button type="button" class="btn primary" data-act="apply"></button></div>
    </div>`, { label: '曲名の英語表記を外す', className: 'history-layer' });
  const btn = $('[data-act="apply"]', sheet.el);
  const checked = () => $$('input[data-i]', sheet.el).filter((c) => c.checked).map((c) => items[+c.dataset.i]);
  const paint = () => {
    const n = checked().length;
    btn.textContent = `外す（${n}曲）`;
    btn.disabled = !n;
  };
  sheet.el.addEventListener('change', paint);
  sheet.el.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.act === 'close') {
      sheet.close();
      return;
    }
    if (b.dataset.act !== 'apply') return;
    // 一覧を開いたあとに曲名を変えた曲は変えない
    const list = checked().filter((x) => state.byId.get(x.id)?.title === x.from);
    for (const x of list) state.store.updateSong(x.id, { title: x.to });
    sheet.close();
    toast(`${list.length}曲の曲名から英語表記を外しました`);
    // 音域が未入力の曲は、曲名が変わったのを待ってから、追加機能で音域を補う
    const missing = list.filter((x) => isRangeMissing(state.byId.get(x.id) ?? {}));
    if (!missing.length || !rangeBatches().length || !rangeAuto()) return;
    for (let t = 0; t < 30 && !missing.every((x) => state.byId.get(x.id)?.title === x.to); t++) await sleep(100);
    runRangeBatch(missing.map((x) => ({ id: x.id, artist: x.artist, title: x.to })));
  });
  paint();
}

function rangeBatchSettingsHTML() {
  const b = rangeBatches()[0];
  if (!b) return '';
  const n = state.songs.filter(isRangeMissing).length;
  return `<section class="set-sec">
        <h4>音域の取り込み</h4>
        <label class="switch-row"><span>追加した曲の音域を自動で取り込む</span><input type="checkbox" class="switch" data-role="range-auto"${rangeAuto() ? ' checked' : ''}></label>
        <p class="hint">＋から登録した曲や、テキストからまとめて追加した曲の音域を、追加した直後に取り込みます。曲名から英語表記を外した曲も、音域が未入力なら取り込みます。音域を入力して登録した曲はそのままです。</p>
        <button type="button" class="btn wide" data-act="range-batch"${n ? '' : ' disabled'}>${icon('search')}${esc(b.label)}（${n}曲）</button>
        ${b.hint ? `<p class="hint">${esc(b.hint)}</p>` : ''}
      </section>`;
}

function artJobHTML() {
  if (artJob.running) {
    const pct = artJob.total ? Math.round((artJob.done / artJob.total) * 100) : 0;
    return `<div class="job">
      <div class="job-bar"><span style="width:${pct}%"></span></div>
      <div class="job-row"><span class="job-text">${artJob.done} / ${artJob.total} 曲を確認（${artJob.found}曲に設定）</span>
      <button type="button" class="btn sm" data-act="art-cancel">中止</button></div>
    </div>`;
  }
  const n = state.songs.filter((s) => !s.artwork).length;
  return `<button type="button" class="btn wide" data-act="art-run"${n ? '' : ' disabled'}>${icon('image')}未設定の曲の画像をまとめて探す（${n}曲）</button>`;
}

export function paintArtJob() {
  const box = state.settings && $('[data-role="art-job"]', state.settings.el);
  if (box) box.innerHTML = artJobHTML();
}
