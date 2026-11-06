// 保存先の切り替え。ログインは任意で、ログインしていないときはこの端末のブラウザだけに保存する（store-local.js）。
// Google でログインすると Firebase（store-firebase.js）に保存し、ほかの端末と同期する。ログアウトすると、この端末のリストに戻る。
// 前にログインしていた端末で Firebase を読み込めない（オフラインなど）ときは、端末のリストを出さずにエラーにする
// （ログインしているつもりで、端末のリストに登録してしまわないように）。

const SESSION_KEY = 'karaoke-list:session:v1'; // 前回の状態。'account'（ログイン中）か 'guest'（ログインなし）

const GUEST = Object.freeze({ uid: 'local', name: null, email: null, local: true });

function defaultStorage() {
  return {
    get(k) {
      try { return localStorage.getItem(k); } catch { return null; }
    },
    set(k, v) {
      try { localStorage.setItem(k, v); } catch { /* 保存できなくても動く */ }
    },
  };
}

// local：createLocalStore() の戻り値。loadRemote：Firebase のストアを作る関数（なければログインできない）
export function createStore({ local, loadRemote = null, storage = defaultStorage() }) {
  let remote = null;
  let loading = null;
  let active = local;
  let current = null; // 今の利用者（'guest' か uid）
  let authCb = null;

  function switchTo(next, user) {
    active = next;
    if (loadRemote) storage.set(SESSION_KEY, user.local ? 'guest' : 'account');
    const key = user.local ? 'guest' : user.uid;
    if (key === current) return;
    current = key;
    authCb?.(user);
  }

  function load() {
    if (remote) return Promise.resolve(remote);
    loading ??= loadRemote().then((r) => {
      remote = r;
      r.onWriteError = (e) => store.onWriteError?.(e);
      r.onAuth((u) => (u ? switchTo(r, { ...u, local: false }) : switchTo(local, GUEST)));
      return r;
    }).catch((e) => {
      loading = null;
      throw e;
    });
    return loading;
  }

  local.onWriteError = (e) => store.onWriteError?.(e);

  const store = {
    onWriteError: null,
    get mode() {
      return active === local ? 'local' : 'firebase';
    },
    // ログインできる設定か（Firebase の設定がなければ、この端末だけで使う）
    canSignIn: !!loadRemote,
    // cb(user)：利用者が決まったとき・変わったとき。user.local が true ならログインなし
    // onError(e)：前にログインしていた端末で、Firebase を読み込めなかったとき
    onAuth(cb, onError) {
      authCb = cb;
      if (!loadRemote) {
        queueMicrotask(() => switchTo(local, GUEST));
        return;
      }
      load().catch((e) => {
        if (storage.get(SESSION_KEY) === 'guest') {
          console.warn('ログインの仕組みを読み込めませんでした', e);
          switchTo(local, GUEST);
        } else {
          onError?.(e);
        }
      });
    },
    async signIn() {
      const r = await load();
      await r.signIn();
    },
    async signOut() {
      await remote?.signOut();
    },
    subscribe: (cb, onError) => active.subscribe(cb, onError),
    addSong: (payload) => active.addSong(payload),
    updateSong: (id, patch) => active.updateSong(id, patch),
    deleteSong: (id) => active.deleteSong(id),
    putSongs: (entries, deleteIds) => active.putSongs(entries, deleteIds),
    updateProfile: (patch) => active.updateProfile(patch),
    addArtists: (names) => active.addArtists(names),
    removeArtist: (name) => active.removeArtist(name),
    // ログインしていないときに、この端末に保存したデータ（ログイン中でも読める）
    localData: () => local.peek(),
    clearLocal: () => local.clear(),
    // ログイン中のアカウントのデータを、サーバーから読む（端末内のキャッシュは使わない）
    fetchAccount() {
      if (active !== remote) return Promise.reject(new Error('not signed in'));
      return remote.fetchFromServer();
    },
  };
  return store;
}
