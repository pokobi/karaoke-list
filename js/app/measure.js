// マイクで自分の音域を測る画面

import { isNote } from '../notes.js';
import { fmtNoteHTML } from '../display.js';
import { $, $$, esc, icon, openSheet, toast } from '../ui.js';
import { detectPitch, hzToNoteValue, inNoteRange, createRangeTracker } from '../pitch-detect.js';
import { haptic, state, voice } from './core.js';

// ---- マイクで自分の音域を測る ----------------------------------------------
// 最低音 → 地声最高音 → 裏声最高音 の順に、同じ高さで少し伸ばした音のうち、いちばん低い・高い音を記録する。
// 音はこの端末の中で高さを調べるだけで、録音も送信もしない

const MEASURE_STEPS = [
  { id: 'low', mode: 'low', title: '最低音', hint: '地声で、出せるいちばん低い声を「あー」と伸ばしてください。少しずつ下げていくと測りやすいです。' },
  { id: 'chestHigh', mode: 'high', title: '地声最高音', hint: '地声のまま、出せるいちばん高い声を伸ばしてください。少しずつ上げていきましょう。無理はしないでください。' },
  { id: 'falsettoHigh', mode: 'high', title: '裏声最高音', hint: '裏声で、出せるいちばん高い声を伸ばしてください。裏声を使わないときは、測らずに次へ進めます。' },
];
const MEASURE_HOLD_MS = 400; // 同じ高さでこれだけ伸ばした音だけを記録する
const MEASURE_CLARITY = 0.85; // これよりはっきりしない音（息・雑音）は使わない

// マイクの音を受け取る関数。古いブラウザの書き方（navigator.webkitGetUserMedia など）にも対応する。使えなければ null
function micGetter() {
  if (navigator.mediaDevices?.getUserMedia) return (c) => navigator.mediaDevices.getUserMedia(c);
  const legacy = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia;
  return legacy ? (c) => new Promise((resolve, reject) => legacy.call(navigator, c, resolve, reject)) : null;
}

// マイクで測れないときの理由と、確認用の詳しい情報。測れるときは null
function measureUnsupported() {
  const detail = `接続：${location.protocol.replace(':', '')}・安全な接続：${window.isSecureContext ? 'はい' : 'いいえ'}・マイクの機能：${navigator.mediaDevices ? 'あり' : 'なし'}・音の処理：${window.AudioContext || window.webkitAudioContext ? 'あり' : 'なし'}`;
  if (!(window.AudioContext || window.webkitAudioContext)) return { reason: 'このブラウザは、音の処理に対応していません。Chrome や Safari の新しい版で開いてください。', detail };
  if (micGetter()) return null;
  if (window.isSecureContext === false) return { reason: '安全な接続（https）で開いていないため、マイクを使えません。https:// で始まるアドレスで開き直してください。', detail };
  return { reason: 'このブラウザでは、マイクを使えません。ほかのアプリの中で開いている場合は、Chrome や Safari で開き直してください。', detail };
}

// マイクの許可の状態（'granted' / 'denied' / 'prompt'）。分からなければ null
async function micPermission() {
  try {
    return (await navigator.permissions?.query({ name: 'microphone' }))?.state ?? null;
  } catch {
    return null;
  }
}

// マイクを許可する手順（端末ごと）
function micAllowSteps() {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return 'Chrome のアドレスバーの左のアイコン →「権限」→「マイク」を許可してください。ホーム画面のアプリのときは、Chrome の「︙」→「設定」→「サイトの設定」→「マイク」から許可できます。それでも使えないときは、Android の「設定」→「アプリ」→「Chrome」→「権限」→「マイク」を許可してください。';
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) return 'iPhone の「設定」→「アプリ」→「Safari」→「マイク」を「確認」か「許可」にしてから、このページを開き直してください。';
  return 'アドレスバーの左のアイコンから、このサイトのマイクを許可してください。';
}

// マイクを使い始められなかったときの説明
async function micErrorText(err) {
  const name = err?.name ?? '';
  if (['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(name)) {
    const st = await micPermission();
    return `${st === 'denied' ? 'このサイトのマイクの使用がブロックされているため、許可の確認が出ませんでした。' : 'マイクの使用が許可されませんでした。'}${micAllowSteps()}`;
  }
  if (['NotFoundError', 'DevicesNotFoundError', 'OverconstrainedError'].includes(name)) return 'マイクが見つかりませんでした。マイクがつながっているか確認してください。';
  if (['NotReadableError', 'TrackStartError', 'AbortError'].includes(name)) return 'マイクを使い始められませんでした。通話中のアプリなど、ほかにマイクを使っているアプリを閉じてから、もう一度試してください。';
  return 'マイクを使い始められませんでした。ページを開き直してから、もう一度試してください。';
}

export function openVoiceMeasure() {
  const m = { step: -1, results: {}, mic: null, tracker: null, timer: 0, recent: [], closed: false };
  const sheet = openSheet(`<div class="vm">
      <div class="sheet-head"><h3>マイクで音域を測る</h3><button type="button" class="icon-btn" data-act="close" aria-label="閉じる">${icon('close')}</button></div>
      <div class="sheet-body" data-role="stage"></div>
      <div class="sheet-foot vm-foot" data-role="foot"></div>
    </div>`, { label: 'マイクで音域を測る', className: 'vm-layer', onClose: () => {
    m.closed = true;
    stopMic();
  } });
  const stage = $('[data-role="stage"]', sheet.el);
  const foot = $('[data-role="foot"]', sheet.el);

  function stopMic() {
    clearInterval(m.timer);
    m.timer = 0;
    m.mic?.stream.getTracks().forEach((t) => t.stop());
    m.mic?.ctx.close().catch(() => {});
    m.mic = null;
  }

  async function startMic() {
    // iPhone などでは、ボタンを押した直後（待つ前）に作らないと音の処理が始まらないため、先に作る
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    let stream;
    try {
      stream = await micGetter()({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch (err) {
      ctx.close().catch(() => {});
      throw err;
    }
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    // スピーカーにはつながない（自分の声が聞こえたり、ハウリングしたりしないように）
    ctx.createMediaStreamSource(stream).connect(analyser);
    m.mic = { stream, ctx, analyser, buf: new Float32Array(analyser.fftSize) };
  }

  const stepsHTML = () => `<ol class="vm-steps">${MEASURE_STEPS.map((s, i) => `<li class="${i === m.step ? 'on' : i < m.step || m.step === MEASURE_STEPS.length ? 'done' : ''}">${s.title}</li>`).join('')}<li class="${m.step === MEASURE_STEPS.length ? 'on' : ''}">確認</li></ol>`;

  // error：{ text, detail? }
  function paintIntro(error = null) {
    m.step = -1;
    const no = measureUnsupported();
    stage.innerHTML = `${stepsHTML()}
      <p class="vm-lead">最低音・地声の最高音・裏声の最高音の順に、声を出して測ります。</p>
      <ul class="vm-notes">
        <li>同じ高さで少し（${MEASURE_HOLD_MS / 1000}秒ほど）伸ばした音だけを記録します。一瞬出ただけの音は記録しません。</li>
        <li>静かな場所で、スマホのマイクに向かって「あー」と声を出してください。</li>
        <li>音はこの端末の中で高さを調べるだけで、録音や送信はしません。</li>
      </ul>
      ${error ? `<p class="vm-error">${esc(error.text)}${error.detail ? `<span class="vm-error-d">${esc(error.detail)}</span>` : ''}</p>` : ''}
      ${no ? `<p class="vm-error">${esc(no.reason)}<span class="vm-error-d">${esc(no.detail)}</span></p>` : ''}`;
    foot.innerHTML = no
      ? '<button type="button" class="btn wide" data-act="close">閉じる</button>'
      : `<button type="button" class="btn primary wide" data-act="start">${icon('mic')}マイクを使って始める</button>`;
    // 前にブロックした場合は、押す前に知らせる（このときは許可の確認が出ない）
    if (!no && !error) {
      micPermission().then((st) => {
        if (st !== 'denied' || m.step !== -1 || $('.vm-error', stage)) return;
        stage.insertAdjacentHTML('beforeend', `<p class="vm-error">このサイトのマイクの使用がブロックされています。${esc(micAllowSteps())}</p>`);
      });
    }
  }

  function paintStep() {
    const s = MEASURE_STEPS[m.step];
    stage.innerHTML = `${stepsHTML()}
      <h4 class="vm-title">${s.title}を測る</h4>
      <p class="vm-lead">${s.hint}</p>
      <div class="vm-live">
        <span class="vm-live-l">いまの音</span>
        <span class="vm-now" data-role="now">—</span>
        <span class="vm-hold" aria-hidden="true"><span data-role="hold"></span></span>
        <span class="vm-level" aria-hidden="true"><span data-role="level"></span></span>
      </div>
      <div class="vm-best"><span class="vm-best-l">記録した${s.title}</span><span class="vm-best-v" data-role="best">まだありません</span></div>`;
    paintStepFoot();
  }

  function paintStepFoot() {
    const best = m.tracker?.best;
    foot.innerHTML = `<button type="button" class="btn" data-act="back">${m.step ? '戻る' : 'やめる'}</button>`
      + `<button type="button" class="btn" data-act="redo"${best == null ? ' disabled' : ''}>やり直す</button>`
      + `<button type="button" class="btn primary" data-act="next">${best == null ? '測らずに次へ' : '次へ'}</button>`;
  }

  function goStep(i) {
    m.step = i;
    m.recent = [];
    if (i >= MEASURE_STEPS.length) {
      paintResult();
      return;
    }
    const s = MEASURE_STEPS[i];
    m.tracker = createRangeTracker({ mode: s.mode, holdMs: MEASURE_HOLD_MS });
    paintStep();
  }

  // 声の高さを調べて、画面に出す（1 秒に 25 回ほど）
  function tick() {
    if (!m.mic || m.step < 0 || m.step >= MEASURE_STEPS.length) return;
    const { analyser, buf, ctx } = m.mic;
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    const p = detectPitch(buf, ctx.sampleRate);
    let v = p && p.clarity >= MEASURE_CLARITY ? hzToNoteValue(p.hz) : null;
    if (!inNoteRange(v)) v = null;
    // 直近 3 回の中央値にして、一瞬の取り違え（1 オクターブずれなど）をならす
    m.recent.push(v);
    if (m.recent.length > 3) m.recent.shift();
    const vals = m.recent.filter((x) => x != null).sort((a, b) => a - b);
    const smooth = vals.length >= 2 ? vals[Math.floor(vals.length / 2)] : null;
    const before = m.tracker.best;
    const r = m.tracker.feed(smooth, performance.now());
    const now = $('[data-role="now"]', stage);
    if (!now) return;
    now.innerHTML = r.note != null ? fmtNoteHTML(r.note) : '—';
    $('[data-role="hold"]', stage).style.width = `${Math.round(r.held * 100)}%`;
    $('[data-role="level"]', stage).style.width = `${Math.min(100, Math.round(rms * 400))}%`;
    if (r.best !== before) {
      $('[data-role="best"]', stage).innerHTML = fmtNoteHTML(r.best);
      haptic('key');
      paintStepFoot();
    }
  }

  function paintResult() {
    const vo = voice();
    const rows = MEASURE_STEPS.map((s) => {
      const v = m.results[s.id];
      return `<label class="vm-res${isNote(v) ? '' : ' none'}">
          <input type="checkbox" data-field="${s.id}"${isNote(v) ? ' checked' : ' disabled'}>
          <span class="vm-res-l">${s.title}</span>
          <span class="vm-res-old">${isNote(vo[s.id]) ? fmtNoteHTML(vo[s.id]) : '未選択'}</span>
          ${icon('chevron-right')}
          <span class="vm-res-new">${isNote(v) ? fmtNoteHTML(v) : '測っていません'}</span>
        </label>`;
    }).join('');
    stage.innerHTML = `${stepsHTML()}
      <h4 class="vm-title">測った結果</h4>
      <p class="vm-lead">保存する項目にチェックを付けてください。今の値（左）を、測った値（右）に置き換えます。</p>
      <div class="vm-results">${rows}</div>`;
    const paint = () => {
      const n = $$('input[data-field]:checked', stage).length;
      foot.innerHTML = `<button type="button" class="btn" data-act="restart">測り直す</button>`
        + `<button type="button" class="btn primary" data-act="save"${n ? '' : ' disabled'}>保存する</button>`;
    };
    stage.onchange = paint;
    paint();
  }

  sheet.el.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    switch (b.dataset.act) {
      case 'close': sheet.close(); break;
      case 'start': {
        b.disabled = true;
        // 許可の確認が出ないまま待ち続けることがあるので、少し待っても進まなければ案内を出す
        const slow = setTimeout(() => {
          if (m.closed || m.step !== -1) return;
          stage.querySelectorAll('.vm-error, .vm-wait').forEach((e) => e.remove());
          stage.insertAdjacentHTML('beforeend', `<p class="vm-wait">マイクの許可を待っています。許可の確認が出ていないときは、${esc(micAllowSteps())}</p>`);
        }, 3000);
        try {
          await startMic();
        } catch (err) {
          console.warn('mic', err);
          if (!m.closed) paintIntro({ text: await micErrorText(err), detail: `エラー：${err?.name || String(err)}` });
          return;
        } finally {
          clearTimeout(slow);
        }
        // 許可を待っている間に閉じたときは、すぐにマイクを止める
        if (m.closed) {
          stopMic();
          return;
        }
        m.timer = setInterval(tick, 40);
        goStep(0);
        break;
      }
      case 'redo':
        m.tracker?.reset();
        paintStep();
        break;
      case 'back':
        if (m.step <= 0) sheet.close();
        else goStep(m.step - 1);
        break;
      case 'next': {
        const s = MEASURE_STEPS[m.step];
        if (m.tracker?.best != null) m.results[s.id] = m.tracker.best;
        else delete m.results[s.id];
        goStep(m.step + 1);
        break;
      }
      case 'restart':
        m.results = {};
        goStep(0);
        break;
      case 'save': {
        const picked = {};
        for (const c of $$('input[data-field]:checked', stage)) picked[c.dataset.field] = m.results[c.dataset.field];
        if (!Object.keys(picked).length) return;
        state.store.updateProfile({ range: { ...voice(), ...picked } });
        sheet.close();
        toast('自分の音域を保存しました');
        break;
      }
      default:
    }
  });
  paintIntro();
}
