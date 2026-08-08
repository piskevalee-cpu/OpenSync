import { api, fmtDateTime, humanSize, pfpUrl } from '../api.js';
import { currentRenderSeq } from '../app.js';
import { confirmDialog, h, toast } from '../ui.js';

let adminTimer = null;
let lastSig = null;
let benchResult = null;

function benchTable() {
  const rows = benchResult.results.map((r) =>
    h('tr', {}, [
      h('td', { class: 'muted small', text: r.method }),
      h('td', { text: `${r.mbps} MB/s` }),
      h('td', { class: 'muted small', text: `${r.out_mb} MB` }),
    ]));
  return h('table', { class: 'tbl' }, [
    h('thead', {}, [h('tr', {}, [h('th', { text: 'zip method' }), h('th', { text: 'throughput' }), h('th', { text: 'output (64 MB input)' })])]),
    h('tbody', {}, rows),
  ]);
}

export async function renderAdmin(el) {
  const seq = currentRenderSeq();
  const [statsRes, usersRes] = await Promise.all([api.admin.stats(), api.admin.users()]);
  if (currentRenderSeq() !== seq) return;
  const { stats } = statsRes;
  const { users } = usersRes;

  const kpis = h('div', { class: 'kpis' }, [
    kpi(stats.users, 'users'),
    kpi(stats.games, 'games'),
    kpi(stats.downloads, 'downloads'),
    kpi(stats.comments, 'comments'),
    kpi(humanSize(stats.storage_bytes), 'storage used'),
  ]);

  const usersTable = h('table', { class: 'tbl' });
  usersTable.append(
    h('thead', {}, [
      h('tr', {}, ['id', 'username', 'role', 'games', 'downloads', 'created', 'actions'].map((c) => h('th', { text: c }))),
    ]),
    h('tbody', {}, users.map((u) => userRow(u))),
  );

  const createForm = h('div', { class: 'flex' }, [
    h('input', { type: 'text', id: 'nu-user', placeholder: 'username', style: 'flex:1;background:var(--bg-soft);border:1px solid var(--border);color:var(--fg);font-family:var(--mono);padding:8px;border-radius:var(--radius);' }),
    h('input', { type: 'password', id: 'nu-pass', placeholder: 'password', style: 'flex:1;background:var(--bg-soft);border:1px solid var(--border);color:var(--fg);font-family:var(--mono);padding:8px;border-radius:var(--radius);' }),
    h('button', { class: 'btn btn-sm', text: 'create user', onclick: async () => {
      const u = document.getElementById('nu-user').value;
      const p = document.getElementById('nu-pass').value;
      try {
        await api.admin.createUser({ username: u, password: p });
        toast('user created');
        renderAdmin(document.getElementById('view'));
      } catch (e) {
        toast(e.message, 'error');
      }
    } }),
  ]);

  el.replaceChildren(
    h('h1', { class: 'page-title' }, 'admin panel'),
    kpis,
    h('div', { class: 'section-title' }, ['zip benchmark']),
    h('div', { class: 'panel' }, [
      (() => {
        const btn = h('button', { class: 'btn btn-sm', text: 'run benchmark' });
        btn.onclick = async () => {
          btn.disabled = true;
          btn.textContent = 'benchmarking…';
          try {
            benchResult = await api.admin.bench();
          } catch (e) {
            toast(e.message, 'error');
          }
          renderAdmin(document.getElementById('view'));
        };
        return h('div', { class: 'flex' }, [btn]);
      })(),
      benchResult ? benchTable() : h('p', { class: 'faint small', style: 'padding-top:8px;', text: 'measures archiver zip throughput on this server (CPU, in-memory).' }),
    ]),
    h('div', { class: 'section-title' }, ['users']),
    h('div', { class: 'panel' }, [createForm, usersTable]),
  );

  const recentSec = h('div', { class: 'section-title' }, ['recent downloads']);
  el.append(recentSec);
  const recentPanel = h('div', { class: 'panel' });
  el.append(recentPanel);
  if (!stats.recent_downloads.length) {
    recentPanel.append(h('p', { class: 'faint small', text: 'no downloads yet.' }));
  } else {
    const table = h('table', { class: 'tbl' });
    table.append(
      h('thead', {}, [h('tr', {}, [h('th', { text: 'when' }), h('th', { text: 'user' }), h('th', { text: 'game' })])]),
      h('tbody', {}, stats.recent_downloads.map((r) =>
        h('tr', {}, [
          h('td', { class: 'muted small', text: fmtDateTime(r.created_at) }),
          h('td', {}, [
            h('div', { class: 'cell-user' }, [
              r.user_pfp ? h('img', { class: 'admin-pfp', src: pfpUrl(r.user_pfp), alt: '' }) : null,
              h('span', { text: `@${r.user}` }),
            ]),
          ]),
          h('td', { text: r.game }),
        ]))),
    );
    recentPanel.append(table);
  }

  function kpi(num, label) {
    return h('div', { class: 'kpi' }, [h('div', { class: 'num', text: String(num) }), h('div', { class: 'label', text: label })]);
  }

  function userRow(u) {
    return h('tr', {}, [
      h('td', { class: 'muted small', text: String(u.id) }),
      h('td', {}, [
        h('div', { class: 'cell-user' }, [
          u.pfp ? h('img', { class: 'admin-pfp', src: pfpUrl(u.pfp), alt: '' }) : null,
          h('span', { text: `@${u.username}` }),
          u.role === 'admin' ? h('span', { class: 'badge badge-admin', text: 'admin' }) : null,
        ]),
      ]),
      h('td', { class: 'muted small', text: u.role }),
      h('td', { class: 'muted small', text: String(u.games_count) }),
      h('td', { class: 'muted small', text: String(u.downloads_count) }),
      h('td', { class: 'muted small', text: fmtDateTime(u.created_at) }),
      h('td', {}, [
        h('button', {
          class: 'btn btn-sm btn-ghost',
          text: u.role === 'admin' ? 'demote' : 'promote',
          onclick: async () => {
            try {
              await api.admin.setRole(u.id, u.role === 'admin' ? 'user' : 'admin');
              toast('role updated');
              renderAdmin(document.getElementById('view'));
            } catch (e) {
              toast(e.message, 'error');
            }
          },
        }),
        h('button', {
          class: 'btn btn-sm btn-ghost btn-danger',
          text: 'delete',
          onclick: async () => {
            const ok = await confirmDialog('delete user', `Delete @${u.username}? Their overlays are removed from disk.`, { danger: true });
            if (!ok) return;
            try {
              await api.admin.removeUser(u.id);
              toast('user deleted');
              renderAdmin(document.getElementById('view'));
            } catch (e) {
              toast(e.message, 'error');
            }
          },
        }),
      ]),
    ]);
  }

  clearInterval(adminTimer);
  lastSig = JSON.stringify([stats, users]);
  adminTimer = setInterval(async () => {
    if (!location.hash.startsWith('#/admin') || !el.isConnected) {
      clearInterval(adminTimer);
      adminTimer = null;
      lastSig = null;
      return;
    }
    try {
      const [sRes, uRes] = await Promise.all([api.admin.stats(), api.admin.users()]);
      const sig = JSON.stringify([sRes.stats, uRes.users]);
      if (sig === lastSig) return;
      lastSig = sig;
      const nu = document.getElementById('nu-user');
      const saved = nu ? { u: nu.value, p: document.getElementById('nu-pass')?.value ?? '' } : null;
      await renderAdmin(el);
      if (saved) {
        const u = document.getElementById('nu-user');
        if (u) u.value = saved.u;
        const p = document.getElementById('nu-pass');
        if (p) p.value = saved.p;
      }
    } catch {
      /* keep current view */
    }
  }, 8000);
}
