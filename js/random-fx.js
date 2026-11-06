// ランダム選曲の演出。結果を描いたあと、その上に「選んでいる途中」の表示を重ねて動かし、
// 1 曲ずつ結果を見せる。演出の種類は設定（この端末）で選ぶ。

export const RANDOM_FX = [
  { id: 'slot', label: 'スロット' },
  { id: 'reel', label: 'リール' },
  { id: 'cards', label: 'カード' },
  { id: 'none', label: 'なし' },
];

export const sanitizeRandomFx = (v) => (RANDOM_FX.some((f) => f.id === v) ? v : 'slot');

export const FX_DURATION = 1500;

// i 番目（0 から）の曲が止まるまでの時間。1 曲ならちょうど duration、複数なら途中から順に止める
export function stopTimes(n, duration = FX_DURATION) {
  if (n <= 1) return [duration];
  return Array.from({ length: n }, (_, i) => Math.round(duration * 0.6 + duration * 0.4 * (i / (n - 1))));
}

// スロットの入れ替えの間隔（ミリ秒）。始めは速く、止まる直前はゆっくり
export function slotInterval(progress) {
  const p = Math.min(1, Math.max(0, progress));
  return Math.round(45 + 240 * p * p);
}

// 演出で流す曲を 1 つ選ぶ。直前と同じ曲はなるべく避ける
export function pickDecoy(pool, prev, rng = Math.random) {
  if (!pool.length) return null;
  let s = pool[Math.floor(rng() * pool.length)];
  for (let i = 0; i < 4 && s === prev && pool.length > 1; i++) s = pool[Math.floor(rng() * pool.length)];
  return s;
}

/**
 * 演出を始める。
 * targets：[{ item：結果の 1 枠, face：曲名などを出している部分, song：選ばれた曲 }]
 * render(song, index)：face の中身の HTML（結果と同じ形で、別の曲を描く）
 * 戻り値の finish() はすぐ結果を見せる、cancel() は画面に触らずに止める（描き直す前に使う）
 */
export function playRandomFx(style, targets, { pool = [], render, backHTML = '', duration = FX_DURATION, onLand, onDone } = {}) {
  const timers = new Set();
  const anims = new Set();
  const landed = targets.map(() => false);
  const times = stopTimes(targets.length, duration);
  const decoys = pool.length ? pool : targets.map((t) => t.song);
  let active = true;

  const later = (fn, ms) => {
    const id = setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
  };
  const track = (a) => {
    anims.add(a);
    a.addEventListener('finish', () => anims.delete(a));
    return a;
  };
  const stopAll = () => {
    timers.forEach(clearTimeout);
    timers.clear();
    anims.forEach((a) => a.cancel());
    anims.clear();
  };

  // すべて止まったとき。最後の動き（めくる・ふくらむ）は最後まで見せるので、動きは止めない
  function end() {
    if (!active) return;
    active = false;
    timers.forEach(clearTimeout);
    timers.clear();
    anims.clear();
    onDone?.();
  }

  function land(i, { quiet = false, pop = true } = {}) {
    if (landed[i]) return;
    landed[i] = true;
    const t = targets[i];
    t.overlay?.remove();
    t.overlay = null;
    t.face.classList.remove('fx-host');
    t.item.classList.remove('fx-pending');
    t.item.classList.add(pop ? 'fx-landed' : 'fx-shown');
    if (!quiet) onLand?.(i);
    if (landed.every(Boolean)) end();
  }

  function overlay(t) {
    const ov = document.createElement('div');
    ov.className = 'fx-overlay';
    ov.setAttribute('aria-hidden', 'true');
    t.face.append(ov);
    t.overlay = ov;
    return ov;
  }

  // スロット：枠の中で曲が次々に入れ替わり、だんだん遅くなって止まる
  function startSlot(t, i) {
    const inner = document.createElement('div');
    inner.className = `${t.faceClass} fx-in`;
    overlay(t).append(inner);
    const start = performance.now();
    let prev = null;
    const step = () => {
      const elapsed = performance.now() - start;
      if (elapsed >= times[i]) {
        land(i);
        return;
      }
      prev = pickDecoy(decoys, prev);
      inner.innerHTML = render(prev, i);
      track(inner.animate([{ transform: 'translateY(-45%)', opacity: 0.35 }, { transform: 'none', opacity: 1 }], { duration: 70, easing: 'ease-out' }));
      later(step, Math.min(slotInterval(elapsed / times[i]), times[i] - elapsed));
    };
    step();
  }

  // リール：曲名が縦に流れ、減速して選ばれた曲で止まる
  function startReel(t, i) {
    const h = t.face.offsetHeight;
    const count = Math.round(10 + 12 * (times[i] / duration));
    const cells = [];
    let prev = null;
    for (let k = 0; k < count - 1; k++) {
      prev = pickDecoy(decoys, prev);
      cells.push(render(prev, i));
    }
    cells.push(render(t.song, i));
    const strip = document.createElement('div');
    strip.className = 'fx-strip';
    strip.innerHTML = cells.map((c) => `<div class="${t.faceClass} fx-cell" style="height:${h}px">${c}</div>`).join('');
    overlay(t).append(strip);
    track(strip.animate(
      [{ transform: 'translateY(0)' }, { transform: `translateY(${-(count - 1) * h}px)` }],
      { duration: times[i], easing: 'cubic-bezier(.12,.72,.22,1)', fill: 'forwards' },
    ));
    // 止めるのは時間で決める（画面が裏に回って動きが止まっていても、結果は出す）
    later(() => land(i), times[i]);
  }

  // カード：裏向きのカードが少し混ざってから、1 枚ずつめくれる
  function startCards(t, i) {
    const back = document.createElement('div');
    back.className = 'fx-back';
    back.setAttribute('aria-hidden', 'true');
    back.innerHTML = backHTML;
    t.item.append(back);
    t.overlay = back;
    const shuffle = Math.round(duration * 0.45);
    const dir = i % 2 ? -1 : 1;
    track(t.item.animate([
      { transform: 'none' },
      { transform: `translateX(${dir * 14}px) rotate(${dir * 2}deg)` },
      { transform: `translateX(${-dir * 10}px) rotate(${-dir * 1.5}deg)` },
      { transform: `translateX(${dir * 5}px)` },
      { transform: 'none' },
    ], { duration: shuffle, delay: Math.min(i * 25, 150), easing: 'ease-in-out' }));
    const flipAt = Math.max(shuffle + 40, times[i] - 300);
    later(() => {
      // 半分めくる（真横を向く）
      const out = track(t.item.animate(
        [{ transform: 'perspective(900px) rotateY(0deg)' }, { transform: 'perspective(900px) rotateY(90deg)' }],
        { duration: 130, easing: 'ease-in', fill: 'forwards' },
      ));
      // 真横を向いたところで表に替えて、残りをめくる
      later(() => {
        out.cancel();
        track(t.item.animate(
          [{ transform: 'perspective(900px) rotateY(-90deg)' }, { transform: 'perspective(900px) rotateY(0deg)' }],
          { duration: 170, easing: 'ease-out' },
        ));
        land(i, { pop: false });
      }, 130);
    }, flipAt);
  }

  targets.forEach((t, i) => {
    t.faceClass = t.face.className;
    t.item.classList.remove('fx-landed', 'fx-shown');
    t.item.classList.add('fx-pending');
    t.face.classList.add('fx-host');
  });
  targets.forEach((t, i) => {
    if (style === 'reel') startReel(t, i);
    else if (style === 'cards') startCards(t, i);
    else startSlot(t, i);
  });
  if (!targets.length) end();

  return {
    get active() { return active; },
    // すぐ結果を見せる（まだ止まっていない曲をまとめて止める。振動は 1 回だけ）
    finish() {
      if (!active) return;
      stopAll();
      let first = true;
      targets.forEach((t, i) => {
        if (landed[i]) return;
        land(i, { quiet: !first });
        first = false;
      });
    },
    // 画面に触らずに止める（このあと結果を描き直すとき）
    cancel() {
      if (!active) return;
      active = false;
      stopAll();
    },
  };
}
