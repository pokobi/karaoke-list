// 画面部品：シート（下から出るパネル）、確認ダイアログ、トースト、音階ピッカー、ポップオーバー。
import { NOTE_NAMES, OCTAVES, noteName, scientificName, isNote } from './notes.js';
import { getNoteStyle } from './display.js';

// ピッカーの小さい表記（設定の「音域の表記」に合わせる）
function pickerLabel(v) {
  const style = getNoteStyle();
  if (style === 'scientific') return scientificName(v);
  if (style === 'both') return `${noteName(v)}・${scientificName(v)}`;
  return noteName(v);
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export const icon = (name, cls = '') => `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

// iOS でキーボードが出たときも、シートが見えている範囲に収まるようにする
if (window.visualViewport) {
  const vv = window.visualViewport;
  const sync = () => {
    document.documentElement.style.setProperty('--vvh', `${vv.height}px`);
    document.documentElement.style.setProperty('--vvt', `${vv.offsetTop}px`);
  };
  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', sync);
  sync();
}

// ---- シート -----------------------------------------------------------
// 開くたびに履歴を1つ積み、スマホの「戻る」で一番上のシートを閉じられるようにする。

const stack = [];
let ignorePops = 0;

window.addEventListener('popstate', () => {
  if (ignorePops > 0) { ignorePops--; return; }
  closePopover();
  const top = stack[stack.length - 1];
  if (top) top.close({ fromHistory: true });
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (closePopover()) return;
  const top = stack[stack.length - 1];
  if (top?.dismissible) top.close();
});

export function topSheet() {
  return stack[stack.length - 1] ?? null;
}

export function openSheet(content, { label = '', variant = 'sheet', dismissible = true, className = '', onClose, onRemoved } = {}) {
  closePopover();
  const layer = h(`<div class="layer layer-${variant} ${className}">
    <div class="backdrop"></div>
    <section class="${variant}" role="dialog" aria-modal="true" aria-label="${esc(label)}" tabindex="-1"></section>
  </div>`);
  const panel = layer.querySelector('section');
  if (typeof content === 'string') panel.innerHTML = content;
  else panel.append(content);
  document.body.append(layer);
  document.documentElement.classList.add('has-layer');
  const prevFocus = document.activeElement;
  void layer.offsetHeight;
  layer.classList.add('open');
  setTimeout(() => {
    if (!panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
  }, 30);

  let closed = false;
  const api = {
    el: panel,
    layer,
    dismissible,
    close({ fromHistory = false } = {}) {
      if (closed) return;
      closed = true;
      const i = stack.indexOf(api);
      if (i >= 0) stack.splice(i, 1);
      if (!fromHistory) { ignorePops++; history.back(); }
      layer.classList.remove('open');
      layer.classList.add('closing');
      let removed = false;
      const remove = () => {
        if (removed) return;
        removed = true;
        onRemoved?.();
        layer.remove();
        if (!stack.length) document.documentElement.classList.remove('has-layer');
      };
      panel.addEventListener('transitionend', remove, { once: true });
      setTimeout(remove, 320);
      onClose?.();
      if (prevFocus?.isConnected && !stack.length) prevFocus.focus?.({ preventScroll: true });
    },
  };
  layer.querySelector('.backdrop').addEventListener('click', () => {
    if (api.dismissible) api.close();
  });
  stack.push(api);
  history.pushState({ layer: stack.length }, '');
  return api;
}

// ---- ダイアログ -------------------------------------------------------

export function choiceDialog({ title, message = '', choices }) {
  return new Promise((resolve) => {
    let result = null;
    const body = `<div class="dlg">
      <h3 class="dlg-title">${esc(title)}</h3>
      ${message ? `<p class="dlg-msg">${esc(message).replace(/\n/g, '<br>')}</p>` : ''}
      <div class="dlg-actions ${choices.length > 2 ? 'stack' : ''}">
        ${choices.map((c, i) => `<button type="button" class="btn ${c.kind ?? ''}" data-i="${i}">${esc(c.label)}</button>`).join('')}
      </div>
    </div>`;
    const s = openSheet(body, { variant: 'dialog', label: title, onClose: () => resolve(result) });
    s.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-i]');
      if (!b) return;
      result = choices[+b.dataset.i].value ?? null;
      s.close();
    });
    setTimeout(() => s.el.querySelector('.btn.primary, .btn.danger')?.focus({ preventScroll: true }), 40);
  });
}

// 1 行の文字を入力してもらう。戻り値：入力した文字（前後の空白を除く）、キャンセルなら null
export function promptDialog({ title, message = '', value = '', placeholder = '', ok = 'OK', maxLength = 30 }) {
  return new Promise((resolve) => {
    let result = null;
    const s = openSheet(`<form class="dlg" novalidate>
        <h3 class="dlg-title">${esc(title)}</h3>
        ${message ? `<p class="dlg-msg">${esc(message)}</p>` : ''}
        <input class="input" data-role="value" maxlength="${maxLength}" placeholder="${esc(placeholder)}" value="${esc(value)}" enterkeyhint="done" autocomplete="off" aria-label="${esc(title)}">
        <div class="dlg-actions">
          <button type="button" class="btn" data-act="cancel">キャンセル</button>
          <button type="submit" class="btn primary">${esc(ok)}</button>
        </div>
      </form>`, { variant: 'dialog', label: title, onClose: () => resolve(result) });
    const form = $('form', s.el);
    const input = $('[data-role="value"]', s.el);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (!v) {
        input.focus();
        return;
      }
      result = v;
      s.close();
    });
    $('[data-act="cancel"]', s.el).addEventListener('click', () => s.close());
    setTimeout(() => {
      input.focus();
      input.select();
    }, 60);
  });
}

export async function confirmDialog({ title, message = '', ok = 'OK', cancel = 'キャンセル', danger = false }) {
  const v = await choiceDialog({
    title,
    message,
    choices: [
      { value: false, label: cancel },
      { value: true, label: ok, kind: danger ? 'danger' : 'primary' },
    ],
  });
  return v === true;
}

// ---- トースト ---------------------------------------------------------

let toastTimer = 0;
export function toast(message, { action, onAction, duration = 3000 } = {}) {
  let el = $('#toast');
  if (!el) {
    el = h('<div id="toast" class="toast" role="status" aria-live="polite"><span class="toast-msg"></span><button type="button" class="toast-act"></button></div>');
    document.body.append(el);
  }
  const msg = $('.toast-msg', el);
  const btn = $('.toast-act', el);
  msg.textContent = message;
  btn.hidden = !action;
  btn.textContent = action ?? '';
  btn.onclick = () => {
    hide();
    onAction?.();
  };
  el.classList.add('show');
  clearTimeout(toastTimer);
  function hide() {
    el.classList.remove('show');
  }
  toastTimer = setTimeout(hide, action ? Math.max(duration, 5000) : duration);
}

// ---- ポップオーバー ---------------------------------------------------

let popover = null;

export function closePopover() {
  if (!popover) return false;
  const p = popover;
  popover = null;
  p.el.remove();
  document.removeEventListener('pointerdown', p.onDown, true);
  window.removeEventListener('scroll', p.onScroll, true);
  window.removeEventListener('resize', p.onScroll);
  p.onClose?.();
  return true;
}

export function openPopover(anchor, content, { className = '', onClose } = {}) {
  closePopover();
  const el = h(`<div class="popover ${className}" role="dialog"></div>`);
  if (typeof content === 'string') el.innerHTML = content;
  else el.append(content);
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const ht = el.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  let left = Math.min(Math.max(8, r.right - w), vw - w - 8);
  let top = r.bottom + 6;
  if (top + ht > vh - 8) top = Math.max(8, r.top - ht - 6);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.style.transformOrigin = `${Math.round(r.left + r.width / 2 - left)}px ${top > r.top ? 0 : ht}px`;
  void el.offsetHeight;
  el.classList.add('open');
  const onDown = (e) => {
    if (!el.contains(e.target) && !anchor.contains(e.target)) closePopover();
  };
  const onScroll = (e) => {
    if (e && el.contains(e.target)) return;
    closePopover();
  };
  document.addEventListener('pointerdown', onDown, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onScroll);
  popover = { el, anchor, onDown, onScroll, onClose };
  return { el, close: closePopover };
}

export function popoverAnchor() {
  return popover?.anchor ?? null;
}

// ---- 音階ピッカー -----------------------------------------------------
// オクターブ（low〜hihi）を選んでから音名をタップする。
// 戻り値：選んだ音（整数）、「指定なし」なら null、キャンセルなら undefined。

export function pickNote({ title, value = null, octave = 1, clearLabel = 'なし', allowClear = true }) {
  return new Promise((resolve) => {
    let result;
    let oct = isNote(value) ? Math.min(OCTAVES.length - 1, Math.max(0, Math.floor(value / 12))) : octave;
    const body = `<div class="picker">
      <div class="sheet-head">
        <h3>${esc(title)}</h3>
        <button type="button" class="icon-btn" data-act="cancel" aria-label="閉じる">${icon('close')}</button>
      </div>
      <div class="sheet-body">
        <div class="seg oct-seg" role="group" aria-label="オクターブ">
          ${OCTAVES.map((o, i) => `<button type="button" data-oct="${i}">${o}</button>`).join('')}
        </div>
        <div class="note-grid">
          ${NOTE_NAMES.map((n, i) => `<button type="button" class="${n.includes('#') ? 'sharp' : ''}" data-n="${i}"><span class="nn">${n}</span><span class="nf"></span></button>`).join('')}
        </div>
        ${allowClear ? `<button type="button" class="btn ghost wide" data-act="clear">${esc(clearLabel)}</button>` : ''}
      </div>
    </div>`;
    const s = openSheet(body, { label: title, className: 'picker-layer', onClose: () => resolve(result) });
    const paint = () => {
      $$('[data-oct]', s.el).forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.oct === oct)));
      $$('[data-n]', s.el).forEach((b) => {
        const v = oct * 12 + +b.dataset.n;
        $('.nf', b).textContent = pickerLabel(v);
        b.classList.toggle('sel', v === value);
        b.setAttribute('aria-label', pickerLabel(v));
      });
    };
    paint();
    s.el.addEventListener('click', (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.dataset.oct != null) { oct = +t.dataset.oct; paint(); return; }
      if (t.dataset.n != null) { result = oct * 12 + +t.dataset.n; s.close(); return; }
      if (t.dataset.act === 'clear') { result = null; s.close(); return; }
      if (t.dataset.act === 'cancel') s.close();
    });
  });
}
