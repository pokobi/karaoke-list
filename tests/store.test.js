import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../js/store.js';
import { planLocalMove, PRESET_TAGS } from '../js/model.js';
import { parseNote as n } from '../js/notes.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

function memoryStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v), map: m };
}

function fakeBackend(name) {
  const calls = [];
  const b = { name, calls, onWriteError: null };
  for (const k of ['subscribe', 'addSong', 'updateSong', 'deleteSong', 'putSongs', 'updateProfile', 'addArtists', 'removeArtist']) {
    b[k] = (...a) => { calls.push([k, ...a]); return k === 'addSong' ? `${name}-id` : undefined; };
  }
  return b;
}

function fakeLocal() {
  const b = fakeBackend('local');
  b.data = { songs: [{ id: 'g1', title: 'A' }], profile: {} };
  b.peek = () => structuredClone(b.data);
  b.clear = () => { b.data = { songs: [], profile: {} }; };
  return b;
}

function fakeRemote() {
  const b = fakeBackend('remote');
  b.signIn = async () => b.emit({ uid: 'u1', name: 'N', email: 'e@example.com', local: false });
  b.signOut = async () => b.emit(null);
  b.onAuth = (cb) => { b.emit = cb; };
  b.fetchFromServer = async () => ({ songs: [], profile: {} });
  return b;
}

test('Firebase の設定がなければ、ログインなしの端末のリストで始まる', async () => {
  const local = fakeLocal();
  const store = createStore({ local, loadRemote: null, storage: memoryStorage() });
  const users = [];
  store.onAuth((u) => users.push(u));
  await tick();
  assert.equal(store.canSignIn, false);
  assert.equal(users.length, 1);
  assert.equal(users[0].local, true);
  assert.equal(store.mode, 'local');
  store.addSong({ title: 'x' });
  assert.equal(local.calls[0][0], 'addSong');
});

test('ログインしていなければ端末のリスト、ログインするとアカウント、ログアウトで端末のリストに戻る', async () => {
  const local = fakeLocal();
  const remote = fakeRemote();
  const storage = memoryStorage();
  const store = createStore({ local, loadRemote: async () => remote, storage });
  const users = [];
  store.onAuth((u) => users.push(u));
  await tick();
  remote.emit(null);
  assert.equal(users.at(-1).local, true);
  assert.equal(store.mode, 'local');
  assert.equal(storage.get('karaoke-list:session:v1'), 'guest');
  store.updateSong('g1', { favorite: true });
  assert.deepEqual(local.calls.at(-1), ['updateSong', 'g1', { favorite: true }]);

  await store.signIn();
  assert.equal(users.at(-1).uid, 'u1');
  assert.equal(store.mode, 'firebase');
  assert.equal(storage.get('karaoke-list:session:v1'), 'account');
  store.updateSong('s1', { key: 2 });
  assert.deepEqual(remote.calls.at(-1), ['updateSong', 's1', { key: 2 }]);
  assert.equal(local.calls.length, 1);
  // ログイン中でも、この端末のデータを読める
  assert.equal(store.localData().songs.length, 1);

  await store.signOut();
  assert.equal(users.at(-1).local, true);
  assert.equal(store.mode, 'local');
  assert.equal(users.length, 3);
});

test('前にログインしていた端末（以前の版から使っている端末を含む）でログインの仕組みを読み込めなければエラー、ログインなしだった端末なら端末のリスト', async () => {
  const fail = async () => { throw new Error('offline'); };
  for (const [prev, expectGuest] of [['account', false], [null, false], ['guest', true]]) {
    const store = createStore({ local: fakeLocal(), loadRemote: fail, storage: memoryStorage(prev ? { 'karaoke-list:session:v1': prev } : {}) });
    const users = [];
    const errors = [];
    store.onAuth((u) => users.push(u), (e) => errors.push(e));
    await tick();
    assert.equal(users.length, expectGuest ? 1 : 0, String(prev));
    assert.equal(errors.length, expectGuest ? 0 : 1, String(prev));
  }
});

test('読み込みに失敗しても、ログインの操作でもう一度読み込む', async () => {
  const remote = fakeRemote();
  let n = 0;
  const store = createStore({
    local: fakeLocal(),
    loadRemote: async () => { n += 1; if (n === 1) throw new Error('offline'); return remote; },
    storage: memoryStorage({ 'karaoke-list:session:v1': 'guest' }),
  });
  const users = [];
  store.onAuth((u) => users.push(u));
  await tick();
  assert.equal(users.at(-1).local, true);
  await store.signIn();
  assert.equal(n, 2);
  assert.equal(users.at(-1).uid, 'u1');
});

test('書き込みのエラーは、どちらの保存先からも通知される', async () => {
  const local = fakeLocal();
  const remote = fakeRemote();
  const store = createStore({ local, loadRemote: async () => remote, storage: memoryStorage() });
  const errs = [];
  store.onWriteError = (e) => errs.push(e);
  store.onAuth(() => {});
  await tick();
  local.onWriteError('a');
  remote.onWriteError('b');
  assert.deepEqual(errs, ['a', 'b']);
});

test('この端末の曲をアカウントへ移す：同じ曲は追加せず、ID はそのまま使う', () => {
  const local = {
    songs: [
      { id: 'g1', artist: 'YOASOBI', title: '夜に駆ける', key: -2, singCount: 3 },
      { id: 'g2', artist: 'スピッツ', title: 'チェリー' },
      { id: 's9', artist: 'Aimer', title: '残響散歌' },
    ],
    profile: {},
  };
  const account = {
    songs: [
      { id: 's1', artist: 'ＹＯＡＳＯＢＩ', title: '夜に駆ける' },
      { id: 's9', artist: 'back number', title: '水平線' },
    ],
    profile: {},
  };
  const plan = planLocalMove(local, account, () => 'new-id');
  assert.deepEqual(plan.skipped, [{ from: 'g1', to: 's1' }]);
  assert.deepEqual(plan.add.map((e) => [e.from, e.id]), [['g2', 'g2'], ['s9', 'new-id']]);
  assert.equal(plan.add[0].data.title, 'チェリー');
  assert.equal('id' in plan.add[0].data, false);
});

test('この端末の音域・タグ・候補・表示の設定は、アカウントにないものだけを足す', () => {
  const local = {
    songs: [],
    profile: {
      range: { low: n('mid1C'), chestHigh: n('hiA') },
      tags: ['練習中', 'バラード'],
      artists: ['YOASOBI', 'Aimer'],
      prefs: { accent: 'pink' },
    },
  };
  const plan = planLocalMove(local, { songs: [], profile: { range: { chestHigh: n('mid2G') }, artists: ['Aimer'], prefs: { accent: 'teal' } } });
  assert.deepEqual(plan.profile.range, { low: n('mid1C'), chestHigh: n('mid2G') });
  assert.deepEqual(plan.profile.tags, [...PRESET_TAGS, 'バラード']);
  assert.equal('prefs' in plan.profile, false);
  assert.deepEqual(plan.artists, ['YOASOBI']);

  const fresh = planLocalMove(local, { songs: [], profile: {} });
  assert.equal(fresh.profile.prefs.accent, 'pink');
  // アカウントのタグの並びは変えない
  const kept = planLocalMove({ songs: [], profile: { tags: ['練習中'] } }, { songs: [], profile: { tags: ['得意'] } });
  assert.deepEqual(kept.profile.tags, ['得意', '練習中']);
  assert.deepEqual(planLocalMove({ songs: [], profile: {} }, { songs: [], profile: {} }), { add: [], skipped: [], profile: {}, artists: [] });
});
