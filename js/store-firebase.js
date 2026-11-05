// Firebase（Google ログイン + Firestore）のストア。
// データは users/{uid}（プロフィール）と users/{uid}/songs/{songId} に保存する。
// 書き込みは端末内のキャッシュに即座に反映され、通信できるようになるとサーバーへ送られる。

const SDK = 'https://www.gstatic.com/firebasejs/12.19.0';
const BATCH_LIMIT = 450;

export async function createFirebaseStore(config) {
  const [{ initializeApp }, A, F] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`),
  ]);

  const app = initializeApp(config);
  const auth = A.getAuth(app);
  let db;
  try {
    db = F.initializeFirestore(app, {
      ignoreUndefinedProperties: true,
      localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }),
    });
  } catch {
    db = F.getFirestore(app);
  }

  let uid = null;
  const songsCol = () => F.collection(db, 'users', uid, 'songs');
  const songDoc = (id) => F.doc(db, 'users', uid, 'songs', id);
  const profileDoc = () => F.doc(db, 'users', uid);

  // 書き込みの完了（サーバー反映）は待たない。失敗だけ通知する。
  const fire = (p) => {
    p.catch((e) => store.onWriteError?.(e));
  };

  A.getRedirectResult(auth).catch((e) => console.warn('redirect sign-in failed', e));

  const store = {
    mode: 'firebase',
    onWriteError: null,
    onAuth(cb) {
      return A.onAuthStateChanged(auth, (u) => {
        uid = u?.uid ?? null;
        cb(u ? { uid: u.uid, name: u.displayName, email: u.email, local: false } : null);
      });
    },
    async signIn() {
      const provider = new A.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      try {
        await A.signInWithPopup(auth, provider);
      } catch (e) {
        if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment', 'auth/web-storage-unsupported'].includes(e?.code)) {
          await A.signInWithRedirect(auth, provider);
          return;
        }
        throw e;
      }
    },
    signOut: () => A.signOut(auth),
    subscribe(cb, onError) {
      let songs = null;
      let profile = null;
      const emit = () => {
        if (songs && profile) cb({ songs, profile });
      };
      const u1 = F.onSnapshot(songsCol(), (snap) => {
        songs = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
        emit();
      }, onError);
      const u2 = F.onSnapshot(profileDoc(), (snap) => {
        profile = snap.exists() ? snap.data() : {};
        emit();
      }, onError);
      return () => { u1(); u2(); };
    },
    addSong(payload) {
      const ref = F.doc(songsCol());
      fire(F.setDoc(ref, payload));
      return ref.id;
    },
    updateSong(id, patch) {
      fire(F.updateDoc(songDoc(id), patch));
    },
    deleteSong(id) {
      fire(F.deleteDoc(songDoc(id)));
    },
    putSongs(entries, deleteIds = []) {
      const ops = [
        ...deleteIds.map((id) => (b) => b.delete(songDoc(id))),
        ...entries.map(({ id, data }) => (b) => b.set(id ? songDoc(id) : F.doc(songsCol()), data)),
      ];
      for (let i = 0; i < ops.length; i += BATCH_LIMIT) {
        const batch = F.writeBatch(db);
        ops.slice(i, i + BATCH_LIMIT).forEach((op) => op(batch));
        fire(batch.commit());
      }
    },
    updateProfile(patch) {
      fire(F.setDoc(profileDoc(), patch, { merge: true }));
    },
    addArtists(names) {
      const list = names.filter(Boolean);
      if (list.length) fire(F.setDoc(profileDoc(), { artists: F.arrayUnion(...list) }, { merge: true }));
    },
    removeArtist(name) {
      fire(F.setDoc(profileDoc(), { artists: F.arrayRemove(name) }, { merge: true }));
    },
  };
  return store;
}
