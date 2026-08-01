import { h } from './ui.js';

const REQ_FIELDS = [
  ['OS', 'e.g. Windows 10 64-bit'],
  ['CPU', 'e.g. Intel i5-8400'],
  ['RAM', 'e.g. 8 GB'],
  ['GPU', 'e.g. GTX 1060 6GB'],
  ['Storage', 'e.g. 20 GB free'],
];

/**
 * Fixed optional system-requirements template: labeled inputs (OS/CPU/RAM/GPU/
 * Storage) plus a free-text notes box. Stored/parsed as "Label: value" lines so
 * the value round-trips losslessly through the plain-text DB field.
 */
export function createReqFields(text = '') {
  const inputs = {};
  const grid = h('div', { class: 'req-grid' }, REQ_FIELDS.map(([label, placeholder]) => {
    const input = h('input', { type: 'text', placeholder });
    inputs[label.toLowerCase()] = input;
    return h('div', { class: 'field' }, [h('label', { class: 'req-label', text: label }), input]);
  }));
  const notes = h('textarea', { placeholder: 'notes (anything else)…', style: 'margin-top:8px;' });
  const wrap = h('div', { class: 'field' }, [h('label', { text: 'system requirements (optional)' }), grid, notes]);

  function fill(t) {
    const rest = [];
    for (const line of String(t || '').split('\n')) {
      const m = line.match(/^(OS|CPU|RAM|GPU|Storage):\s?(.*)$/i);
      const key = m ? m[1].toLowerCase() : null;
      if (key && inputs[key]) inputs[key].value = m[2];
      else if (line.trim()) rest.push(line);
    }
    notes.value = rest.join('\n');
  }

  function read() {
    const lines = [];
    for (const [label] of REQ_FIELDS) {
      const v = inputs[label.toLowerCase()].value.trim();
      if (v) lines.push(`${label}: ${v}`);
    }
    const n = notes.value.trim();
    if (n) lines.push(n);
    return lines.join('\n');
  }

  fill(text);
  return { wrap, read, fill };
}
