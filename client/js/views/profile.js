import { api, esc, fmtDate } from '../api.js';
import { confirmDialog, h, toast } from '../ui.js';
import { navigate } from '../app.js';

export async function renderProfile(el, state) {
  const refresh = async () => {
    const { user } = await api.auth.me();
    Object.assign(state.user, user);
  };

  const header = h('div', { class: 'hero' }, [
    h('h1', { class: 'page-title' }, 'profile'),
    h('p', { class: 'sub small' }, `signed in as @${state.user.username}`),
  ]);

  const pfp = state.user.pfp
    ? h('img', { class: 'pfp-lg', src: state.user.pfp, alt: '' })
    : h('span', { text: '▢' });
  const userCard = h('div', { class: 'panel flex', style: 'gap:20px;align-items:center;' }, [
    h('div', { class: 'flex', style: 'align-items:center;gap:16px;flex:1;' }, [
      pfp,
      h('div', { style: 'flex:1;' }, [
        h('h2', { style: 'margin-bottom:6px;', text: state.user.username }),
        h('div', { class: 'flex', style: 'gap:10px;' }, [
          state.user.role === 'admin' ? h('span', { class: 'badge badge-admin', text: 'admin' }) : null,
          h('span', { class: 'faint small', text: `member since ${fmtDate(state.user.created_at)}` }),
        ]),
      ]),
    ]),
  ]);

  const stats = state.user.stats || {};
  const statGrid = h('div', { class: 'profile-stats' }, [
    statItem(stats.uploaded, 'games uploaded'),
    statItem(stats.downloaded, 'games downloaded'),
    statItem(stats.synced, 'games synced'),
  ]);

  const statsPanel = h('div', { class: 'panel' }, [
    h('h3', { text: 'activity' }),
    statGrid,
  ]);

  const pfpInput = h('input', { type: 'file', accept: 'image/jpeg,image/png' });
  const saveBtn = h('button', { class: 'btn btn-primary', text: 'save pfp' });
  const pfpErr = h('div', { class: 'form-error' });
  const pfpPanel = h('div', { class: 'panel' }, [
    h('h3', { text: 'change profile picture' }),
    h('div', { class: 'flex' }, [pfpInput, saveBtn]),
    pfpErr,
  ]);

  saveBtn.onclick = async () => {
    const file = pfpInput.files[0];
    if (!file) return;
    pfpErr.textContent = '';
    saveBtn.disabled = true;
    saveBtn.textContent = '…';
    try {
      await api.auth.uploadPfp(file);
      toast('profile picture saved');
      await refresh();
      navigate('#/profile');
    } catch (e) {
      pfpErr.textContent = e.message;
      saveBtn.disabled = false;
      saveBtn.textContent = 'save pfp';
    }
  };

  const dangerErr = h('div', { class: 'form-error' });
  const dangerBtn = h('button', { class: 'btn btn-danger', text: 'delete account' });
  const dangerZone = h('div', { class: 'danger-zone' }, [
    h('h3', { text: 'danger zone' }),
    h('p', { class: 'muted small' }, 'permanently removes your account and save syncs. your comments stay on the server as "deleted". games you uploaded stay on the server.'),
    h('div', { class: 'flex' }, [dangerBtn]),
    dangerErr,
  ]);

  dangerBtn.onclick = async () => {
    const ok = await confirmDialog('delete account', 'This permanently deletes your account and your save syncs. Your comments stay on the server as "deleted". Games you uploaded stay on the server. Continue?', { danger: true });
    if (!ok) return;
    try {
      await api.auth.deleteAccount();
      toast('account deleted');
      state.user = null;
      location.hash = '#/login';
    } catch (e) {
      dangerErr.textContent = e.message;
    }
  };

  el.replaceChildren(header, userCard, statsPanel, pfpPanel, dangerZone);
}

function statItem(num, label) {
  return h('div', { class: 'profile-stat' }, [
    h('div', { class: 'num', text: String(num ?? 0) }),
    h('div', { class: 'label', text: label }),
  ]);
}
