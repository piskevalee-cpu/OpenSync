import { esc } from './api.js';

/** Tiny hyperscript helper: h('div', {class:'x', onclick: fn}, [children]). */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && k !== 'value' && typeof v !== 'function') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function toast(message, type = 'info') {
  const container = document.getElementById('toasts');
  const t = h('div', { class: `toast ${type}`, html: esc(message) });
  container.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

export async function confirmDialog(title, message, { danger = false } = {}) {
  return new Promise((resolve) => {
    const overlay = h('div', {
      class: 'modal-overlay',
      style: 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:900;',
    });
    const box = h('div', { class: 'panel', style: 'max-width:420px;width:90%;background:var(--panel-2);' }, [
      h('h3', { text: title }),
      h('p', { class: 'muted small', text: message }),
      h('div', { class: 'flex', style: 'justify-content:flex-end;margin-top:16px;' }, [
        h('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: () => { overlay.remove(); resolve(false); } }),
        h('button', {
          class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`,
          text: 'Confirm',
          onclick: () => { overlay.remove(); resolve(true); },
        }),
      ]),
    ]);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  });
}

export function spinner(label) {
  return h('div', { class: 'flex muted small' }, [h('span', { class: 'spinner' }), h('span', { text: label || 'working' })]);
}

export function disable(btn, disabled) {
  btn.disabled = disabled;
}

export function setBusy(btn, busy, busyText = 'working…', idleText) {
  if (busy) {
    if (idleText == null) idleText = btn.dataset.text || btn.textContent;
    btn.dataset.text = idleText;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> ${esc(busyText)}`;
  } else {
    btn.disabled = false;
    if (btn.dataset.text) btn.textContent = btn.dataset.text;
  }
}
