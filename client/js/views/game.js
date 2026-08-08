import { api, esc, fmtDate, fmtDateTime, humanSize, pfpUrl } from '../api.js';
import { hashFile } from '../sha256.js';
import { uploadChunks } from '../chunker.js';
import { createReqFields } from '../reqfields.js';
import { confirmDialog, h, toast } from '../ui.js';
import { state, currentRenderSeq } from '../app.js';

let syncSession = null;
let syncBarHost = null;

function endSync() {
  syncSession = null;
  if (syncBarHost) renderSyncBar(syncBarHost);
}

function updateSyncBar() {
  if (!syncBarHost || !syncSession) return;
  const sub = syncBarHost.querySelector('.ub-sync');
  const bar = sub?.querySelector('.uploadbar');
  if (!sub || !bar) return;
  const s = syncSession;
  const pct =
    s.phase === 'hashing'
      ? Math.round((s.done / Math.max(1, s.files)) * 100)
      : s.total > 0
        ? Math.round((s.uploaded / s.total) * 100)
        : 100;
  bar.querySelector('.progress-bar').style.width = `${pct}%`;
  bar.querySelector('.uploadbar-stats').textContent =
    s.phase === 'hashing'
      ? `hashing ${s.done}/${s.files} files · ${pct}%`
      : `${s.doneCount}/${s.files} files · ${pct}% · ${humanSize(s.uploaded)} / ${humanSize(s.total)}`;
}

function cancelSync() {
  if (!syncSession) return;
  syncSession.cancelled = true;
  syncSession.controller.abort();
  toast('sync cancelled');
  endSync();
}

export function syncProgress() {
  return syncSession ? { active: true, gameId: syncSession.gameId, name: syncSession.name } : null;
}

export function renderSyncBar(host) {
  syncBarHost = host;
  let sub = host.querySelector(':scope > .ub-sync');
  if (!sub) {
    sub = h('div', { class: 'ub-sync' });
    host.appendChild(sub);
  }
  if (!syncSession) {
    sub.hidden = true;
    return;
  }
  sub.hidden = false;
  sub.replaceChildren(
    h('div', { class: 'uploadbar' }, [
      h('div', { class: 'flex uploadbar-head' }, [
        h('span', { class: 'uploadbar-name', text: `syncing "${syncSession.name}"` }),
        h('div', { class: 'uploadbar-right' }, [
          h('span', { class: 'uploadbar-stats' }),
          h('button', { class: 'btn btn-sm btn-ghost', text: 'cancel', onclick: cancelSync }),
        ]),
      ]),
      h('div', { class: 'progress' }, [h('div', { class: 'progress-bar' })]),
    ]),
  );
  updateSyncBar();
}

export async function renderGame(el) {
  const id = location.hash.split('/')[2];
  const seq = currentRenderSeq();
  const box = h('div', { class: 'muted small flex', style: 'gap:8px;padding:24px 0;' }, [h('span', { class: 'spinner' }), h('span', { text: 'loading…' })]);
  el.replaceChildren(box);

  const { game, comments, overlay } = await api.games.get(id);
  if (currentRenderSeq() !== seq) return;
  const canManage = state.user.role === 'admin' || game.uploaded_by === state.user.id;

  if (game.status === 'processing') {
    renderProcessing(el, game);
    return;
  }

  el.replaceChildren(
    h('a', { class: 'btn btn-sm btn-ghost', href: '#/', text: '← library' }),
    h('div', { class: 'game-header', style: 'margin-top:18px;' }, [
      game.cover
        ? h('div', { class: 'game-cover-lg' }, [h('img', { src: game.cover, alt: game.name })])
        : h('div', { class: 'game-cover-lg' }, [h('span', { text: '▢' })]),
      h('div', { style: 'flex:1;' }, [
        h('div', { class: 'flex-between' }, [
          h('h1', { text: game.name }),
          h('div', { class: 'flex', style: 'gap:8px;' }, [
            h('span', { class: `badge badge-${game.status}`, text: game.status }),
            overlay.has_overlay ? h('span', { class: 'badge badge-synced', text: 'synced' }) : null,
          ]),
        ]),
        h('dl', { class: 'stat-row' }, [
          h('dt', { text: 'size' }), h('dd', { text: humanSize(game.total_size) }),
          h('dt', { text: 'uploaded by' }), h('dd', { class: 'dd-uploader' }, [
            game.uploader_pfp ? h('img', { class: 'uploader-pfp', src: pfpUrl(game.uploader_pfp), alt: '' }) : null,
            h('span', { text: `@${game.uploader_name || 'system'}` })
          ]),
          h('dt', { text: 'added' }), h('dd', { text: fmtDate(game.created_at) }),
          h('dt', { text: 'downloads' }), h('dd', { text: String(game.download_count) }),
          h('dt', { text: 'slug' }), h('dd', {}, [h('span', { class: 'pill', text: game.slug })]),
        ]),
        h('div', { class: 'game-actions' }, [
          h('a', {
            class: 'btn btn-primary',
            href: `/api/games/${game.id}/download`,
            download: `${game.name}.zip`,
            text: '⤓ download',
            onclick: (e) => {
              if (overlay.has_overlay) {
                e.preventDefault();
                showDownloadDialog(game);
              }
            },
          }),
          h('button', { class: 'btn', text: overlay.has_overlay ? '⇄ re-sync my save' : '⇄ sync my save', onclick: () => startSync(el, game, overlay) }),
          overlay.has_overlay
            ? h('button', { class: 'btn btn-danger', text: 'reset my save', onclick: () => resetOverlay(game) })
            : null,
          canManage ? h('button', { class: 'btn', text: 'edit', onclick: () => renderEdit(el, game) }) : null,
          canManage ? h('button', { class: 'btn btn-danger', text: 'delete', onclick: () => deleteGame(game) }) : null,
        ]),
      ]),
    ]),
  );

  if (game.description) {
    el.append(h('div', { class: 'panel' }, [
      h('h3', { text: 'description' }),
      h('p', { class: 'muted small', style: 'white-space:pre-wrap;' }, [esc(game.description)]),
    ]));
  }
  if (game.system_requirements) {
    el.append(h('div', { class: 'panel' }, [
      h('h3', { text: 'system requirements' }),
      h('pre', { class: 'codebox small', text: game.system_requirements }),
    ]));
  }

  renderOverlayStatus(el, overlay);
  renderComments(el, game, comments);
}

function showDownloadDialog(game) {
  const overlay = h('div', {
    class: 'modal-overlay',
    style: 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:900;',
  });
  const btn = (label, href) =>
    h('a', {
      class: 'btn btn-primary',
      href,
      download: `${game.name}.zip`,
      text: label,
      style: 'display:flex;justify-content:center;margin:6px 0;',
      onclick: () => overlay.remove(),
    });
  const box = h('div', { class: 'panel pop-dialog', style: 'max-width:420px;width:90%;background:var(--panel-2);' }, [
    h('h3', { text: `download ${game.name}` }),
    h('p', { class: 'muted small', text: 'choose what to download:' }),
    btn('fresh install', `/api/games/${game.id}/download?fresh=1`),
    btn('synced game', `/api/games/${game.id}/download`),
    h('div', { class: 'flex', style: 'justify-content:flex-end;margin-top:10px;' }, [
      h('button', { class: 'btn btn-ghost', text: 'cancel', onclick: () => overlay.remove() }),
    ]),
  ]);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

function renderProcessing(el, game) {
  const title = h('div', { class: 'flex', style: 'justify-content:center;gap:10px;margin-bottom:10px;' }, [
    h('span', { class: 'spinner', style: 'width:18px;height:18px;' }),
    h('h2', { style: 'margin:0;', text: 'processing manifest…' }),
  ]);
  const sub = h('p', { class: 'muted small', text: `hashing every file for ${game.name}` });
  const progLabel = h('p', { class: 'muted small', style: 'margin-bottom:8px;' });
  const barWrap = h('div', { class: 'progress', style: 'max-width:420px;margin:0 auto 16px;' });
  const bar = h('div', { class: 'progress-bar', style: 'width:0%;' });
  barWrap.appendChild(bar);
  const link = h('a', { class: 'btn btn-ghost', href: '#/', text: 'back to library' });

  el.replaceChildren(
    h('div', { class: 'panel', style: 'text-align:center;padding:40px;' }, [title, sub, progLabel, barWrap, link]),
  );

  const poll = async () => {
    if (!location.hash.startsWith(`#/game/${game.id}`)) {
      clearInterval(timer);
      return;
    }
    try {
      const st = await api.games.status(game.id);
      if (st.status === 'ready') {
        clearInterval(timer);
        renderGame(el);
        return;
      }
      const p = st.progress;
      if (p && Number.isInteger(p.total) && p.total > 0) {
        const pct = Math.min(100, Math.round((p.done / p.total) * 100));
        bar.style.width = `${pct}%`;
        progLabel.textContent = `hashing file ${Math.min(p.done + 1, p.total)} of ${p.total}`;
      } else {
        bar.style.width = '6%';
        progLabel.textContent = 'walking files…';
      }
    } catch {
      /* transient */
    }
  };
  const timer = setInterval(poll, 1000);
  poll();
}

function renderOverlayStatus(el, overlay) {
  const sec = h('div', { class: 'section-title' }, ['my save sync']);
  const panel = h('div', { class: 'panel' });
  el.append(sec, panel);
  if (!overlay.has_overlay) {
    panel.append(h('p', { class: 'muted small' }, 'no save overlay stored on this server for you yet.'));
    return;
  }
  panel.append(
    h('dl', { class: 'stat-row' }, [
      h('dt', { text: 'overlay files' }), h('dd', { text: String(overlay.files) }),
      h('dt', { text: 'deleted paths' }), h('dd', { text: String(overlay.deletions) }),
      h('dt', { text: 'overlay size' }), h('dd', { text: humanSize(overlay.size) }),
      h('dt', { text: 'last sync' }), h('dd', { text: fmtDateTime(overlay.updated_at) }),
    ]),
  );
}

let cachedUsers = null;
async function getUsers() {
  if (!cachedUsers) cachedUsers = await api.users().then((r) => r.users);
  return cachedUsers;
}

function attachMentionPicker(input) {
  let drop = null;
  let list = [];
  let selected = 0;
  let tok = null;

  function hide() {
    drop?.remove();
    drop = null;
    list = [];
    tok = null;
  }

  function currentToken() {
    const v = input.value;
    const caret = input.selectionStart ?? v.length;
    const before = v.slice(0, caret);
    const lastAt = before.lastIndexOf('@');
    if (lastAt === -1) return null;
    const tail = before.slice(lastAt);
    if (/\s/.test(tail.slice(1))) return null;
    return { start: lastAt, end: caret, token: tail.slice(1) };
  }

  function pick(user) {
    const t = tok;
    hide();
    if (!t) return;
    input.value = input.value.slice(0, t.start) + `@${user.username} ` + input.value.slice(t.end);
    const caret = t.start + user.username.length + 2;
    input.focus();
    input.setSelectionRange(caret, caret);
  }

  async function update() {
    const t = currentToken();
    if (!t) { hide(); return; }
    tok = t;
    if (!list.length) list = await getUsers().catch(() => []);
    const q = t.token.toLowerCase();
    const matches = q
      ? list.filter((u) => u.username.toLowerCase().startsWith(q) || u.username.toLowerCase().includes(q))
      : list;
    const shown = matches.slice(0, 8);
    if (!shown.length) { hide(); return; }
    if (!drop) {
      drop = h('div', { class: 'mention-drop panel' });
      document.body.append(drop);
    }
    const rect = input.getBoundingClientRect();
    drop.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - 280))}px`;
    drop.style.top = `${rect.bottom + 4}px`;
    selected = Math.min(selected, shown.length - 1);
    drop.replaceChildren(...shown.map((u, i) => h('button', {
      class: `mention-item ${i === selected ? 'mention-sel' : ''}`,
      onpointerdown: (e) => { e.preventDefault(); pick(u); },
      onclick: () => pick(u),
    }, [
      u.pfp ? h('img', { class: 'mention-pfp', src: pfpUrl(u.pfp), alt: '' }) : h('span', { class: 'mention-pfp mention-pfp-empty' }),
      h('span', { text: `@${u.username}` }),
    ])));
  }

  input.addEventListener('input', update);
  input.addEventListener('keydown', (e) => {
    if (!drop) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); selected = Math.min(selected + 1, list.length - 1); update(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); selected = Math.max(selected - 1, 0); update(); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); const btn = drop.querySelector('.mention-sel'); if (btn) btn.click(); }
    else if (e.key === 'Escape') { e.preventDefault(); hide(); }
  });
  document.addEventListener('click', (e) => {
    if (drop && !drop.contains(e.target)) hide();
  });
  input.addEventListener('blur', () => setTimeout(() => { if (drop && !document.activeElement?.closest('.mention-drop')) hide(); }, 120));
}

function renderComments(el, game, comments) {
  const sec = h('div', { class: 'section-title' }, ['comments']);
  el.append(sec);

  const input = h('textarea', { rows: 1, placeholder: 'write a comment…' });
  const submit = h('button', { class: 'btn btn-primary btn-sm', text: 'post', disabled: true });
  const hint = h('span', { class: 'composer-hint', text: 'enter to post · @ to mention' });
  const composerBody = h('div', { class: 'composer-body' }, [
    h('div', { class: 'composer-input-wrap' }, [input]),
    h('div', { class: 'composer-footer' }, [hint, submit]),
  ]);
  const avatar = state.user.pfp
    ? h('img', { class: 'composer-avatar', src: state.user.pfp, alt: '' })
    : h('span', { class: 'composer-avatar composer-avatar-empty' });
  el.append(h('div', { class: 'panel' }, [h('div', { class: 'composer' }, [avatar, composerBody])]));

  const grow = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
    submit.disabled = !input.value.trim();
  };
  input.addEventListener('input', grow);

  const list = h('div', { class: 'panel', style: 'padding-top:4px;' });
  el.append(list);

  let data = comments;

  async function reload() {
    try {
      const fresh = await api.games.get(game.id);
      data = fresh.comments;
      refresh();
    } catch {
      /* keep current list */
    }
  }

  const children = new Map();

  function renderThread(c, depth) {
    const replies = (children.get(c.id) || []).sort((a, b) => a.created_at.localeCompare(b.created_at));
    return h('div', { class: 'comment-thread' }, [
      commentEl(c),
      replies.length
        ? h('div', {
            class: 'comment-replies',
            style: depth >= 6 ? 'margin-left:8px;padding-left:8px;border-left:none;' : '',
          }, replies.map((r) => renderThread(r, depth + 1)))
        : null,
    ]);
  }

  function refresh() {
    const top = data.filter((c) => c.parent_id == null);
    if (!top.length) {
      list.replaceChildren(h('p', { class: 'faint small', text: 'no comments yet.' }));
      return;
    }
    const byId = new Map(data.map((c) => [c.id, c]));
    children.clear();
    for (const c of data) {
      if (c.parent_id == null) continue;
      if (!byId.has(c.parent_id)) continue;
      if (!children.has(c.parent_id)) children.set(c.parent_id, []);
      children.get(c.parent_id).push(c);
    }
    list.replaceChildren(...top.map((c) => renderThread(c, 0)));
  }

  function replyBox(parentId) {
    const rinput = h('input', { type: 'text', placeholder: 'reply…' });
    const rsubmit = h('button', { class: 'btn btn-primary btn-sm', text: 'post' });
    const rbox = h('div', { class: 'reply-form' }, [h('div', { class: 'reply-input-wrap' }, [rinput]), rsubmit]);
    attachMentionPicker(rinput);
    rsubmit.onclick = async () => {
      if (!rinput.value.trim()) return;
      try {
        await api.comments.create(game.id, rinput.value, parentId);
        toast('reply posted');
        rbox.remove();
        reload();
      } catch (e) {
        toast(e.message, 'error');
      }
    };
    rinput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') rsubmit.click();
    });
    rinput.focus();
    return rbox;
  }

  function commentEl(c) {
    const canDelete = state.user.role === 'admin' || c.user_id === state.user.id;
    const pfp = c.author_pfp ? h('img', { class: 'comment-pfp', src: pfpUrl(c.author_pfp), alt: '' }) : h('span', { class: 'comment-pfp comment-pfp-empty' });
    const body = h('div', { style: 'flex:1;' }, [
      h('div', { class: 'flex', style: 'gap:8px;' }, [
        h('span', { class: 'comment-author', text: `@${c.author}` }),
        h('span', { class: 'comment-meta', text: fmtDateTime(c.created_at) }),
      ]),
      h('div', { class: 'comment-text small', text: c.text }),
      h('div', { class: 'flex', style: 'gap:8px;margin-top:4px;' }, [
        h('button', {
          class: 'btn btn-sm btn-ghost reply-btn',
          text: '↩ reply',
          onclick: () => {
            const existing = body.querySelector('.reply-form');
            if (existing) { existing.remove(); return; }
            body.append(replyBox(c.id));
          },
        }),
      ]),
    ]);
    return h('div', { class: 'comment' }, [
      pfp,
      body,
      canDelete
        ? h('button', { class: 'btn btn-sm btn-ghost btn-danger', text: '✕', onclick: async () => {
            await api.comments.remove(c.id);
            toast('comment deleted');
            reload();
          } })
        : null,
    ]);
  }

  attachMentionPicker(input);
  submit.onclick = async () => {
    if (!input.value.trim()) return;
    try {
      const { comment } = await api.comments.create(game.id, input.value);
      data.push(comment);
      input.value = '';
      input.style.height = '';
      submit.disabled = true;
      refresh();
      reload();
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit.click();
    }
  });

  refresh();
}

function renderEdit(el, game) {
  const name = h('div', { class: 'field' }, [h('label', { text: 'name' }), h('input', { type: 'text', value: game.name })]);
  const desc = h('div', { class: 'field' }, [h('label', { text: 'description (optional)' }), h('textarea', {}, game.description || '')]);
  const reqs = createReqFields(game.system_requirements || '');
  const cover = h('div', { class: 'field' }, [
    h('label', { text: 'cover image (optional, jpg/png)' }),
    h('div', { class: 'cover-picker' }, [
      h('img', { class: 'cover-preview', alt: '', hidden: true }),
      h('input', { type: 'file', accept: 'image/jpeg,image/png', style: 'display:none' }),
      h('button', { class: 'btn btn-ghost btn-sm', text: 'choose image' }),
      h('span', { class: 'muted small', text: 'or drop the artwork here' }),
    ]),
  ]);
  const coverInput = cover.querySelector('input');
  const coverImg = cover.querySelector('img');
  const coverPicker = cover.querySelector('.cover-picker');
  coverPicker.querySelector('button').addEventListener('click', () => coverInput.click());
  coverInput.addEventListener('change', () => {
    const f = coverInput.files[0];
    if (f) {
      const url = URL.createObjectURL(f);
      coverImg.onload = () => URL.revokeObjectURL(url);
      coverImg.src = url;
      coverImg.hidden = false;
    }
  });
  coverPicker.addEventListener('dragover', (e) => {
    e.preventDefault();
    coverPicker.classList.add('drag-over');
  });
  coverPicker.addEventListener('dragleave', () => coverPicker.classList.remove('drag-over'));
  coverPicker.addEventListener('drop', (e) => {
    e.preventDefault();
    coverPicker.classList.remove('drag-over');
    const f = [...(e.dataTransfer?.files || [])].find((f) => /^image\/(jpeg|png)$/.test(f.type));
    if (f) {
      const dt = new DataTransfer();
      dt.items.add(f);
      coverInput.files = dt.files;
      coverInput.dispatchEvent(new Event('change'));
    }
  });
  const save = h('button', { class: 'btn btn-primary', text: 'save' });
  const err = h('div', { class: 'form-error' });
  const panel = h('div', { class: 'panel' }, [
    h('h3', { text: 'edit game' }),
    name, desc, reqs.wrap, cover,
    h('div', { class: 'flex' }, [save, h('button', { class: 'btn btn-ghost', text: 'cancel', onclick: () => renderGame(el) })]),
    err,
  ]);

  const anchor = el.querySelector('.game-header');
  anchor.after(panel);

  save.onclick = async () => {
    try {
      await api.games.patch(game.id, { name: name.querySelector('input').value, description: desc.querySelector('textarea').value, system_requirements: reqs.read() });
      const coverInput = cover.querySelector('input');
      if (coverInput.files[0]) {
        await api.games.cover(game.id, coverInput.files[0]);
      }
      toast('saved');
      renderGame(el);
    } catch (e) {
      err.textContent = e.message;
    }
  };
}

async function deleteGame(game) {
  const ok = await confirmDialog('delete game', `This permanently deletes "${game.name}" and all its files from disk.`, { danger: true });
  if (!ok) return;
  await api.games.remove(game.id);
  toast('game deleted');
  location.hash = '#/';
}

async function resetOverlay(game) {
  const ok = await confirmDialog('reset save', 'Remove your save overlay for this game? Your local files are untouched.', { danger: true });
  if (!ok) return;
  await api.games.clearOverlay(game.id);
  toast('save overlay reset');
  renderGame(document.getElementById('view'));
}

// ---------- sync ----------

async function startSync(el, game, overlay) {
  if (syncSession) {
    toast('a sync is already running', 'warn');
    return;
  }
  const picker = h('input', { type: 'file', style: 'display:none' });
  picker.webkitdirectory = true;
  picker.directory = true;
  document.body.appendChild(picker);
  picker.onchange = () => {
    const files = [...picker.files];
    picker.remove();
    runSync(el, game, files).catch((e) => {
      endSync();
      toast(e.message || 'sync failed', 'error');
    });
  };
  picker.click();
}

async function runSync(el, game, files) {
  const statusEl = h('div', { class: 'panel' });
  const p1 = h('p', { class: 'muted small', text: 'hashing local files…' });
  const p2 = h('p', { class: 'muted small' });
  const barWrap = h('div', { class: 'progress', style: 'margin:10px 0;' });
  const bar = h('div', { class: 'progress-bar', style: 'width:0%;' });
  barWrap.appendChild(bar);
  const cancelBtn = h('button', { class: 'btn btn-sm btn-ghost', text: 'cancel', onclick: cancelSync });
  statusEl.append(
    h('div', { class: 'flex', style: 'justify-content:space-between;align-items:center;' }, [p1, cancelBtn]),
    p2,
    barWrap,
  );
  el.querySelector('.game-header').after(statusEl);

  const controller = new AbortController();
  syncSession = {
    gameId: game.id,
    name: game.name,
    controller,
    cancelled: false,
    phase: 'hashing',
    done: 0,
    files: files.length,
    uploaded: 0,
    total: 0,
    doneCount: 0,
  };
  if (syncBarHost) renderSyncBar(syncBarHost);

  const local = new Map(files.map((f) => [f.webkitRelativePath, f]));
  const manifest = await api.games.manifest(game.id);

  let hashed = 0;
  for (const [path, file] of local) {
    p2.textContent = `hashing ${path} …`;
    const hash = await hashFile(file);
    local.set(path, { file, hash });
    hashed += 1;
    const pct = Math.round((hashed / Math.max(1, local.size)) * 100);
    bar.style.width = `${pct}%`;
    if (syncSession) {
      syncSession.done = hashed;
      updateSyncBar();
    }
  }
  p1.textContent = 'hashing done — computing diff';

  const clean = new Map(manifest.files.map((f) => [f.path, f]));
  const uploads = [];
  const deletions = [];

  for (const [path, entry] of local) {
    const cleanFile = clean.get(path);
    if (!cleanFile) {
      uploads.push({ path, file: entry.file, hash: entry.hash, kind: 'new' });
    } else if (cleanFile.hash !== entry.hash) {
      uploads.push({ path, file: entry.file, hash: entry.hash, kind: 'changed' });
    }
  }
  for (const [path, cleanFile] of clean) {
    if (!local.has(path)) deletions.push(path);
  }

  if (deletions.length > 0) {
    const pct = Math.round((deletions.length / Math.max(1, clean.size)) * 100);
    const ok = await confirmDialog(
      'many files missing',
      `${deletions.length} files (${pct}% of the game) are missing from the folder you selected and will be removed from your download. If you only picked your save folder, cancel and select the full game folder.`,
      { danger: true },
    );
    if (!ok) {
      p1.textContent = 'sync cancelled';
      endSync();
      return;
    }
  }

  if (!uploads.length && !deletions.length) {
    p1.textContent = 'everything already in sync — nothing to do';
    bar.style.width = '100%';
    endSync();
    return;
  }

  p1.textContent = `uploading ${uploads.length} file(s), removing ${deletions.length} path(s)`;
  const initState = await api.games.overlayInit(game.id);
  const resume = new Map(initState.files.map((f) => [f.path, f.received]));
  const chunkSize = initState.chunkSize;

  let uploadedBytes = 0;
  const totalBytes = uploads.reduce((s, u) => s + u.file.size, 0);
  let doneCount = 0;
  if (syncSession) {
    syncSession.phase = 'uploading';
    syncSession.files = uploads.length;
    syncSession.total = totalBytes;
    syncSession.doneCount = doneCount;
    updateSyncBar();
  }

  for (const u of uploads) {
    if (syncSession?.cancelled) return;
    p2.textContent = `${u.kind === 'new' ? '+' : '~'} ${u.path}`;
    const totalChunks = Math.max(1, Math.ceil(u.file.size / chunkSize));
    try {
      await uploadChunks({
        url: `/api/games/${game.id}/overlay/files`,
        path: u.path,
        file: u.file,
        chunkSize,
        resumeFrom: resume.get(u.path) || 0,
        extraHeaders: { 'x-hash': u.hash },
        signal: controller.signal,
        onProgress: (bytes, done) => {
          uploadedBytes += bytes - (u._prevBytes || 0);
          u._prevBytes = bytes;
          bar.style.width = `${Math.round((uploadedBytes / Math.max(1, totalBytes)) * 100)}%`;
          if (done === totalChunks) doneCount += 1;
          if (syncSession) {
            syncSession.uploaded = uploadedBytes;
            syncSession.doneCount = doneCount;
            updateSyncBar();
          }
        },
      });
    } catch (e) {
      if (e.name === 'AbortError' || syncSession?.cancelled) {
        p1.textContent = 'sync cancelled';
        endSync();
        return;
      }
      endSync();
      if (e.code === 'RESUME_REQUIRED') {
        toast('upload state changed mid-sync; retry', 'warn');
        return;
      }
      throw e;
    }
  }

  p1.textContent = 'finalizing sync…';
  bar.style.width = '100%';
  try {
    await api.games.syncComplete(game.id, deletions, true);
  } finally {
    endSync();
  }
  p2.textContent = '';
  p1.textContent = '';
  statusEl.append(h('div', { class: 'stats-line' }, [
    h('span', { text: `✓ synced ${uploads.length} files (${humanSize(totalBytes)}), ${deletions.length} deletions` }),
    h('a', { class: 'btn btn-sm', href: `#/game/${game.id}`, text: 'reload' }),
  ]));
  toast('save synced');
}
