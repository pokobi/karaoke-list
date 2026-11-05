// Firebase を設定していないときに使う、この端末のブラウザだけに保存するストア。
// Firebase 版（store-firebase.js）と同じ形の API を持つ。

const KEY = 'karaoke-list:local:v1';

function uid() {
  return crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '').slice(0, 20) : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function createLocalStore() {
  const listeners = new Set();
  let data = load();

  function load() {
    try {
      const v = JSON.parse(localStorage.getItem(KEY));
      if (v && Array.isArray(v.songs)) return { songs: v.songs, profile: v.profile ?? {} };
    } catch { /* 読めなければ空から始める */ }
    return { songs: [], profile: {} };
  }

  function snapshot() {
    return { songs: data.songs.map((s) => ({ ...s })), profile: structuredClone(data.profile) };
  }

  function emit() {
    const snap = snapshot();
    listeners.forEach((l) => l.cb(snap));
  }

  function commit() {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch (e) {
      store.onWriteError?.(e);
    }
    queueMicrotask(emit);
  }

  window.addEventListener('storage', (e) => {
    if (e.key === KEY) { data = load(); emit(); }
  });

  const store = {
    mode: 'local',
    onWriteError: null,
    onAuth(cb) {
      queueMicrotask(() => cb({ uid: 'local', name: null, email: null, local: true }));
      return () => {};
    },
    async signIn() {},
    async signOut() {},
    subscribe(cb) {
      const l = { cb };
      listeners.add(l);
      queueMicrotask(() => cb(snapshot()));
      return () => listeners.delete(l);
    },
    addSong(payload) {
      const id = uid();
      data.songs.push({ ...payload, id });
      commit();
      return id;
    },
    updateSong(id, patch) {
      const s = data.songs.find((x) => x.id === id);
      if (s) Object.assign(s, patch);
      commit();
    },
    deleteSong(id) {
      data.songs = data.songs.filter((x) => x.id !== id);
      commit();
    },
    putSongs(entries, deleteIds = []) {
      const del = new Set(deleteIds);
      data.songs = data.songs.filter((x) => !del.has(x.id));
      for (const { id, data: payload } of entries) {
        const i = id ? data.songs.findIndex((x) => x.id === id) : -1;
        if (i >= 0) data.songs[i] = { ...payload, id };
        else data.songs.push({ ...payload, id: id ?? uid() });
      }
      commit();
    },
    updateProfile(patch) {
      data.profile = { ...data.profile, ...patch };
      commit();
    },
    addArtists(names) {
      const cur = new Set(data.profile.artists ?? []);
      let changed = false;
      for (const n of names) if (n && !cur.has(n)) { cur.add(n); changed = true; }
      if (!changed) return;
      data.profile = { ...data.profile, artists: [...cur] };
      commit();
    },
    removeArtist(name) {
      data.profile = { ...data.profile, artists: (data.profile.artists ?? []).filter((n) => n !== name) };
      commit();
    },
  };
  return store;
}
