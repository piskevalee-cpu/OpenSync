import { api, humanSize } from '../api.js';
import { uploadChunks } from '../chunker.js';
import { createReqFields } from '../reqfields.js';
import { h, toast } from '../ui.js';

let session = null;
let viewRoot = null;
let barHost = null;
let pickerEl = null;

export function renderUploadBar(host) {
  barHost = host;
  let sub = host.querySelector(':scope > .ub-upload');
  if (!sub) {
    sub = h('div', { class: 'ub-upload' });
    host.appendChild(sub);
  }
  if (!session) {
    sub.hidden = true;
    return;
  }
  sub.hidden = false;
  sub.replaceChildren(
    h('div', { class: 'uploadbar' }, [
      h('div', { class: 'flex uploadbar-head' }, [
        h('a', { class: 'uploadbar-name', href: '#/upload' }),
        h('div', { class: 'uploadbar-right' }, [
          h('span', { class: 'uploadbar-stats' }),
          h('button', { class: 'btn btn-sm btn-ghost', text: 'cancel', onclick: cancelUpload }),
        ]),
      ]),
      h('div', { class: 'progress' }, [h('div', { class: 'progress-bar' })]),
    ]),
  );
  updateBar();
}

export function uploadProgress() {
  return session
    ? { active: true, gameId: session.gameId, name: session.name, total: session.total, uploaded: session.uploaded, doneCount: session.doneCount, files: session.files.length }
    : null;
}

function fmtEta(sec) {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  return `${m}m ${sec % 60}s`;
}

function updateBar() {
  if (!barHost || !session) return;
  const bar = barHost.querySelector('.ub-upload .uploadbar');
  if (!bar) return;
  const pct = session.total > 0 ? Math.round((session.uploaded / session.total) * 100) : 100;
  bar.querySelector('.uploadbar-name').textContent = `uploading "${session.name}"`;
  bar.querySelector('.progress-bar').style.width = `${pct}%`;
  const parts = [`${session.doneCount}/${session.files.length} files`, `${pct}%`, `${humanSize(session.rate)}/s`];
  if (session.eta != null) parts.push(`ETA ${fmtEta(session.eta)}`);
  bar.querySelector('.uploadbar-stats').textContent = parts.join(' · ');
}

async function cancelUpload() {
  if (!session) return;
  session.cancelled = true;
  session.controller.abort();
  try {
    await api.games.remove(session.gameId);
  } catch {}
  toast('upload cancelled');
  resetView();
}

function resetView() {
  viewRoot = null;
  session = null;
  if (pickerEl) {
    pickerEl.remove();
    pickerEl = null;
  }
  if (barHost) renderUploadBar(barHost);
}

export async function renderUpload(el) {
  if (viewRoot) {
    el.replaceChildren(viewRoot);
    return;
  }
  viewRoot = buildUploadView();
  el.replaceChildren(viewRoot);
}

function buildUploadView() {
  const name = h('div', { class: 'field' }, [
    h('label', { text: 'name *' }),
    h('input', { type: 'text', name: 'name', placeholder: 'e.g. Cyber Runner 2077' }),
  ]);
  const desc = h('div', { class: 'field' }, [
    h('label', { text: 'description (optional)' }),
    h('textarea', { placeholder: 'short bio of the game…' }),
  ]);
  const reqs = createReqFields();
  const cover = h('div', { class: 'field' }, [
    h('label', { text: 'cover image (optional, jpg/png)' }),
    h('input', { type: 'file', accept: 'image/jpeg,image/png' }),
  ]);
  const folderBtn = h('button', { class: 'btn', text: 'select folder…' });
  const folderState = h('span', { class: 'muted small' });
  const picker = h('input', { type: 'file', style: 'display:none' });
  picker.webkitdirectory = true;
  picker.directory = true;
  pickerEl = picker;
  document.body.appendChild(picker);

  let files = [];

  const startBtn = h('button', { class: 'btn btn-primary', text: 'start upload', disabled: true });
  const err = h('div', { class: 'form-error' });

  const progressPanel = h('div', { class: 'panel', hidden: true }, [
    h('h3', { text: 'uploading' }),
    h('div', { class: 'flex', style: 'justify-content:space-between;align-items:center;margin-bottom:8px;' }, [
      h('span', { class: 'small faint' }),
      h('button', { class: 'btn btn-sm btn-ghost', text: 'cancel upload', onclick: cancelUpload }),
    ]),
    h('div', { class: 'progress', style: 'margin-bottom:8px;' }),
    h('div', { class: 'stats-line', text: '0 / 0 files' }),
    h('div', { class: 'upload-list' }),
  ]);
  const headerName = progressPanel.querySelector('.small.faint');
  const overallWrap = progressPanel.querySelector('.progress');
  const stats = progressPanel.querySelector('.stats-line');
  const rowsWrap = progressPanel.querySelector('.upload-list');
  const preview = h('div', { class: 'upload-list' });

  const root = h('div', {}, [
    h('h1', { class: 'page-title' }, 'upload a game'),
    h('div', { class: 'panel drop-target' }, [
      h('div', { class: 'form-grid' }, [name, desc, reqs.wrap, cover]),
      h('div', { class: 'drop-hint', hidden: true }, 'drop your game folder here'),
      h('div', { class: 'flex' }, [
        folderBtn,
        folderState,
        startBtn,
        h('button', { class: 'btn btn-ghost', text: 'cancel', onclick: () => (location.hash = '#/') }),
      ]),
      err,
    ]),
    progressPanel,
    preview,
  ]);

  const dropTarget = root.querySelector('.drop-target');
  const dropHint = root.querySelector('.drop-hint');
  let dragDepth = 0;
  dropTarget.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth += 1;
    dropTarget.classList.add('drag-over');
    dropHint.hidden = dragDepth <= 0;
  });
  dropTarget.addEventListener('dragover', (e) => e.preventDefault());
  dropTarget.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth <= 0) {
      dropTarget.classList.remove('drag-over');
      dropHint.hidden = true;
    }
  });
  dropTarget.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    dropTarget.classList.remove('drag-over');
    dropHint.hidden = true;
    const files = await droppedFiles(e.dataTransfer);
    if (files.length) setFiles(files);
  });

  function setFiles(list) {
    files = list.filter((f) => f.webkitRelativePath);
    files.sort((a, b) => a.webkitRelativePath.localeCompare(b.webkitRelativePath));
    folderState.textContent = files.length
      ? `${files.length} files · ${humanSize(files.reduce((s, f) => s + f.size, 0))}`
      : '';
    startBtn.disabled = !files.length;
    preview.replaceChildren(...files.slice(0, 20).map((f) => h('div', { class: 'upload-row-name small faint', text: f.webkitRelativePath })));
  }

  folderBtn.onclick = () => picker.click();

  picker.onchange = () => setFiles([...picker.files]);

  startBtn.onclick = async () => {
    err.textContent = '';
    if (!files.length) {
      err.textContent = 'select a folder first';
      return;
    }
    const nameVal = name.querySelector('input').value.trim();
    const descVal = desc.querySelector('textarea').value;
    if (!nameVal) {
      err.textContent = 'name is required';
      return;
    }
    startBtn.disabled = true;
    try {
      const { game } = await api.games.create({
        name: nameVal,
        description: descVal,
        system_requirements: reqs.read(),
      });
      const coverInput = cover.querySelector('input');
      if (coverInput.files[0]) await api.games.cover(game.id, coverInput.files[0]);
      await runUpload(game, files, nameVal);
      toast('upload complete — generating manifest');
      resetView();
      location.hash = `#/game/${game.id}`;
    } catch (e) {
      if (e?.name === 'AbortError' || session?.cancelled) return;
      err.textContent = e.message;
      startBtn.disabled = false;
      resetView();
    }
  };

  async function runUpload(game, fileList, nameVal) {
    const state = await api.games.uploadInit(game.id);
    const resume = new Map(state.files.map((f) => [f.path, f.received]));
    const chunkSize = state.chunkSize;

    const controller = new AbortController();
    const total = fileList.reduce((s, f) => s + f.size, 0);
    session = { gameId: game.id, name: nameVal, files: fileList, total, uploaded: 0, doneCount: 0, rate: 0, eta: null, controller, cancelled: false };

    progressPanel.hidden = false;
    headerName.textContent = `"${nameVal}"`;
    const overallBar = h('div', { class: 'progress-bar', style: 'width:0%;' });
    overallWrap.replaceChildren(overallBar);
    stats.textContent = '0 / 0 files';
    const rows = new Map();
    rowsWrap.replaceChildren(...fileList.map((f) => rowEl(f)));

    let uploaded = 0;
    let prevUploaded = 0;
    let prevTime = performance.now();
    const samples = [];
    let doneCount = 0;

    function rowEl(f) {
      const nameEl = h('div', { class: 'upload-row-name', text: f.webkitRelativePath });
      const pct = h('span', { class: 'faint', text: '0%' });
      const bar = h('div', { class: 'progress-bar', style: 'width:0%;' });
      const wrap = h('div', { class: 'progress' });
      wrap.appendChild(bar);
      const row = h('div', { class: 'upload-row' }, [h('div', { class: 'upload-row-head' }, [nameEl, pct]), wrap]);
      rows.set(f.webkitRelativePath, { bar, pct, file: f, prev: 0 });
      return row;
    }

    function updateOverall() {
      const pct = total > 0 ? Math.round((uploaded / total) * 100) : 100;
      overallBar.style.width = `${pct}%`;

      const now = performance.now();
      const dt = now - prevTime;
      prevTime = now;
      if (dt > 0) {
        samples.push({ bytes: uploaded - prevUploaded, dt });
        prevUploaded = uploaded;
        if (samples.length > 120) samples.shift();
      }
      const window = samples.reduce((a, s) => ({ bytes: a.bytes + s.bytes, dt: a.dt + s.dt }), { bytes: 0, dt: 0 });
      const rate = window.dt > 0 ? (window.bytes / window.dt) * 1000 : 0;
      const remain = Math.max(0, total - uploaded);
      const eta = rate > 0 ? Math.round(remain / rate) : null;

      stats.textContent =
        `${doneCount} / ${fileList.length} files · ${humanSize(uploaded)} / ${humanSize(total)}` +
        ` · ${humanSize(rate)}/s${eta != null ? ` · ETA ${fmtEta(eta)}` : ''}`;

      if (session) {
        session.uploaded = uploaded;
        session.doneCount = doneCount;
        session.rate = rate;
        session.eta = eta;
        updateBar();
      }
    }

    const CONCURRENCY = 3;
    let idx = 0;
    async function worker() {
      while (idx < fileList.length) {
        if (session?.cancelled) return;
        const f = fileList[idx++];
        const r = rows.get(f.webkitRelativePath);
        const totalChunks = Math.max(1, Math.ceil(f.size / chunkSize));
        const resumeFrom = Math.min(resume.get(f.webkitRelativePath) || 0, totalChunks);

        if (resumeFrom >= totalChunks) {
          r.bar.style.width = '100%';
          r.pct.textContent = '100%';
          uploaded += f.size;
          doneCount += 1;
          updateOverall();
          continue;
        }

        r.bar.style.width = '4%';
        try {
          await uploadChunks({
            url: `/api/games/${game.id}/files`,
            path: f.webkitRelativePath,
            file: f,
            chunkSize,
            resumeFrom,
            signal: controller.signal,
            onProgress: (bytes, done) => {
              const pct = f.size > 0 ? Math.round((bytes / f.size) * 100) : 100;
              r.bar.style.width = `${pct}%`;
              r.pct.textContent = `${pct}%`;
              uploaded += bytes - r.prev;
              r.prev = bytes;
              if (done === totalChunks) doneCount += 1;
              updateOverall();
            },
          });
          r.bar.style.width = '100%';
          r.pct.textContent = '100%';
        } catch (e) {
          r.pct.textContent = '✕';
          throw e;
        }
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    if (session?.cancelled) throw new DOMException('aborted', 'AbortError');
    overallBar.style.width = '100%';
    doneCount = fileList.length;
    updateOverall();
    await api.games.uploadComplete(game.id);
  }

  return root;
}

/** Walk a DataTransfer (dropped folders/files) into Files with webkitRelativePath set. */
async function droppedFiles(dataTransfer) {
  const files = [];
  if (!dataTransfer) return files;
  const entries = [...dataTransfer.items]
    .map((item) => item.webkitGetAsEntry?.() || null)
    .filter(Boolean);
  if (entries.length) {
    async function walkEntry(entry, prefix) {
      if (entry.isFile) {
        const file = await new Promise((resolve) => entry.file(resolve, () => resolve(null)));
        if (!file) return;
        const rel = prefix ? `${prefix}/${file.name}` : file.name;
        try {
          Object.defineProperty(file, 'webkitRelativePath', { value: rel, configurable: true });
        } catch { /* keep the native value */ }
        files.push(file);
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        let batch;
        do {
          batch = await new Promise((resolve) => reader.readEntries(resolve, () => resolve([])));
          const sub = prefix ? `${prefix}/${entry.name}` : entry.name;
          for (const child of batch) await walkEntry(child, sub);
        } while (batch.length > 0);
      }
    }
    for (const entry of entries) await walkEntry(entry, '');
  } else {
    for (const f of dataTransfer.files || []) {
      try {
        Object.defineProperty(f, 'webkitRelativePath', { value: f.name, configurable: true });
      } catch { /* keep the native value */ }
      files.push(f);
    }
  }
  return files;
}
