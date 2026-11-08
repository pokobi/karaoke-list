// アプリの入口：起動、ログインとデータの読み込み、この端末のデータのアカウントへの移動。
// 画面ごとの処理は js/app/ に分けてある（一覧は list.js、曲の詳細は detail.js など）。

import { FIREBASE_CONFIG } from './config.js';
import { normalizeSong, sanitizePrefs, planLocalMove, tagColorMap } from './model.js';
import { installExternalLinks } from './external.js';
import { sanitizeAliases } from './text-import.js';
import { $, esc, choiceDialog, toast } from './ui.js';
import { createLocalStore } from './store-local.js';
import { createStore } from './store.js';
import { previewSupported, audioFiles } from './preview.js';
import { MOVE_AFTER_LOGIN_KEY, state, sessionFlag } from './app/core.js';
import { render, bindStatic } from './app/list.js';
import { paintKeyMenu, paintDetail } from './app/detail.js';
import { paintRandom } from './app/random-sheet.js';
import { paintSettings, paintArtists, applyDevicePrefs, applyAccountPrefs } from './app/settings.js';
import { paintTagManager } from './app/tags.js';
import { paintSelbar } from './app/select.js';

// ---- 起動 -------------------------------------------------------------

installExternalLinks();
boot();

async function boot() {
  applyDevicePrefs();
  registerServiceWorker();
  bindStatic();
  // ログインは任意。ログインしていなければ、この端末のブラウザだけに保存する
  const forceLocal = ['localhost', '127.0.0.1'].includes(location.hostname) && new URLSearchParams(location.search).has('local');
  state.store = createStore({
    local: createLocalStore(),
    loadRemote: FIREBASE_CONFIG && !forceLocal
      ? async () => (await import('./store-firebase.js')).createFirebaseStore(FIREBASE_CONFIG)
      : null,
  });
  state.store.onWriteError = (e) => {
    console.error(e);
    const code = errorCode(e);
    toast(code === 'permission-denied'
      ? '保存できませんでした（権限エラー：permission-denied）'
      : `保存に失敗しました（${code}）`, { duration: 7000 });
  };
  state.store.onAuth(startSession, (e) => {
    console.error(e);
    showFatal('データベースに接続できませんでした。通信状況を確認して、ページを再読み込みしてください。');
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('service worker', e));
  });
}

function showFatal(msg) {
  $('#boot').hidden = true;
  $('#app').hidden = true;
  const el = $('#fatal');
  el.innerHTML = `<p>${esc(msg)}</p><button type="button" class="btn primary" onclick="location.reload()">再読み込み</button>`;
  el.hidden = false;
}

function errorCode(e) {
  return String(e?.code ?? e?.name ?? 'unknown').replace(/^firestore\//, '');
}

function startSession(user) {
  state.unsub?.();
  state.user = user;
  state.loaded = false;
  state.loadError = null;
  $('#boot').hidden = true;
  $('#app').hidden = false;
  render();
  state.unsub = state.store.subscribe(onData, (e) => {
    console.error(e);
    if (state.loaded) {
      toast(`データを読み込めませんでした（${errorCode(e)}）`, { duration: 7000 });
      return;
    }
    state.loadError = errorCode(e);
    render();
  });
}

function onData({ songs, profile }) {
  state.songs = songs.map(normalizeSong);
  state.byId = new Map(state.songs.map((s) => [s.id, s]));
  state.profile = {
    range: profile?.range && typeof profile.range === 'object' ? profile.range : {},
    artists: Array.isArray(profile?.artists) ? profile.artists.filter((n) => typeof n === 'string') : [],
    tags: Array.isArray(profile?.tags) ? profile.tags.filter((n) => typeof n === 'string' && n.trim()) : null,
    prefs: sanitizePrefs(profile?.prefs),
    aliases: sanitizeAliases(profile?.aliases),
    tagColors: tagColorMap(profile?.tagColors),
  };
  applyAccountPrefs();
  const first = !state.loaded;
  state.loaded = true;
  render();
  paintDetail();
  paintKeyMenu();
  paintSettings();
  paintArtists();
  paintRandom();
  paintTagManager();
  paintSelbar();
  if (first && !state.user?.local && state.moveAfterLogin) {
    state.moveAfterLogin = sessionFlag(MOVE_AFTER_LOGIN_KEY, false);
    offerLocalMove({ afterLogin: true });
  }
}

// ---- ログインと、この端末のデータの移動 ---------------------------------

export async function signIn() {
  if (state.signingIn) return;
  state.signingIn = true;
  paintSettings();
  state.moveAfterLogin = sessionFlag(MOVE_AFTER_LOGIN_KEY, true);
  try {
    await state.store.signIn();
  } catch (e) {
    state.moveAfterLogin = sessionFlag(MOVE_AFTER_LOGIN_KEY, false);
    if (['auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/user-cancelled'].includes(e?.code)) return;
    console.error(e);
    toast(e?.code === 'auth/unauthorized-domain'
      ? 'このURLからのログインが許可されていません。Firebase の承認済みドメインを確認してください。'
      : e?.code
        ? `ログインできませんでした（${e.code}）`
        : 'ログインできませんでした。通信状況を確認してください。', { duration: 7000 });
  } finally {
    state.signingIn = false;
    paintSettings();
  }
}

// ログインする前にこの端末に保存した曲を、アカウントへ移す（聞いてから）
export async function offerLocalMove({ afterLogin = false } = {}) {
  if (state.user?.local || state.moving) return;
  const local = state.store.localData();
  const n = local.songs.length;
  if (!n) return;
  state.moving = true;
  paintSettings();
  try {
    let account;
    try {
      account = await state.store.fetchAccount();
    } catch (e) {
      console.error(e);
      toast('アカウントの曲を確かめられなかったため、この端末の曲はまだ移していません。設定の「アカウント」から移せます。', { duration: 7000 });
      return;
    }
    if (state.user?.local) return;
    const plan = planLocalMove(local, account);
    const message = [
      'ログインする前に、この端末に保存した曲です。アカウントにある曲は変わりません。',
      plan.skipped.length ? `うち${plan.skipped.length}曲は、アカウントにある曲と同じアーティスト・曲名のため追加しません。` : '',
      afterLogin ? '移さない場合はこの端末に残り、あとから設定の「アカウント」で移せます。' : '',
    ].filter(Boolean).join('\n');
    const ok = await choiceDialog({
      title: `この端末の${n}曲をアカウントに移しますか？`,
      message,
      choices: [{ value: false, label: afterLogin ? 'あとで' : 'キャンセル' }, { value: true, label: '移す', kind: 'primary' }],
    });
    // 聞いている間にログアウトしたら、何もしない（端末のリストに書いてしまわないように）
    if (!ok || state.user?.local) return;
    const saved = state.store.putSongs(plan.add.map(({ id, data }) => ({ id, data })));
    if (Object.keys(plan.profile).length) state.store.updateProfile(plan.profile);
    if (plan.artists.length) state.store.addArtists(plan.artists);
    toast(plan.add.length ? `${plan.add.length}曲をアカウントに移しました` : '移す曲はありませんでした（すべてアカウントにある曲でした）');
    relinkAudioFiles(plan);
    // サーバーに届いてから、この端末のリストを空にする（届く前に閉じても、次に移すときは同じ曲として扱う）
    if (await saved) state.store.clearLocal();
  } finally {
    state.moving = false;
    paintSettings();
  }
}

// 試聴の音楽ファイルは曲の ID で結び付いているので、ID が変わる曲・追加しない曲のファイルを付け替える
async function relinkAudioFiles(plan) {
  if (!previewSupported()) return;
  const moves = [
    ...plan.add.filter((e) => e.id !== e.from).map((e) => ({ from: e.from, to: e.id })),
    ...plan.skipped,
  ];
  for (const { from, to } of moves) {
    try {
      const rec = await audioFiles.get(from);
      if (!rec) continue;
      if (!(await audioFiles.get(to))) await audioFiles.put(to, rec);
      await audioFiles.remove(from);
    } catch (e) {
      console.warn(e);
    }
  }
}
