import { api } from '../api.js';
import { h } from '../ui.js';
import { state } from '../app.js';

let infoPromise = null;
function getInfo() {
  if (!infoPromise) {
    infoPromise = api.info().catch(() => ({ has_admin: true }));
  }
  return infoPromise;
}

export async function renderAuth(el) {
  const form = h('div', { class: 'auth-wrap panel' }, [
    h('img', { class: 'auth-logo', src: '/img/opensync.png', alt: 'OpenSync' }),
    h('p', { class: 'muted small' }, 'self-hosted game library & save sync · LAN'),
    h('div', { class: 'auth-tabs' }, [
      h('button', { class: 'active', text: 'login', onclick: (e) => switchTab(e.target, 'login') }),
      h('button', { text: 'register', onclick: (e) => switchTab(e.target, 'register') }),
    ]),
    h('div', { id: 'auth-body' }),
    h('div', { id: 'auth-error', class: 'form-error' }),
  ]);
  el.replaceChildren(form);

  let mode = 'login';

  function switchTab(btn, next) {
    mode = next;
    form.querySelectorAll('.auth-tabs button').forEach((b) => b.classList.toggle('active', b === btn));
    renderBody();
  }

  async function renderBody() {
    const body = form.querySelector('#auth-body');
    const err = form.querySelector('#auth-error');
    err.textContent = '';
    const prevH = body.offsetHeight;
    const username = h('div', { class: 'field' }, [
      h('label', { text: 'username' }),
      h('input', { type: 'text', name: 'username', autocomplete: 'username' }),
    ]);
    const password = h('div', { class: 'field' }, [
      h('label', { text: 'password' }),
      h('input', { type: 'password', name: 'password', autocomplete: mode === 'login' ? 'current-password' : 'new-password' }),
    ]);
    const pfp = h('div', { class: 'field' }, [
      h('label', { text: 'profile picture (optional, jpg/png)' }),
      h('div', { class: 'pfp-picker' }, [
        h('img', { class: 'pfp-lg pfp-preview', src: '/img/blankpfp.jpg', alt: '' }),
        h('p', { class: 'muted small', text: 'drag & drop an image here' }),
      ]),
    ]);
    let pfpFile = null;
    const pfpPicker = pfp.querySelector('.pfp-picker');
    const pfpImg = pfp.querySelector('img');
    function setPfpFile(file) {
      pfpFile = file || null;
      if (file) {
        const url = URL.createObjectURL(file);
        pfpImg.src = url;
        pfpImg.onload = () => URL.revokeObjectURL(url);
      } else {
        pfpImg.src = '/img/blankpfp.jpg';
      }
    }
    pfpPicker.addEventListener('dragover', (e) => {
      e.preventDefault();
      pfpPicker.classList.add('drag-over');
    });
    pfpPicker.addEventListener('dragleave', () => pfpPicker.classList.remove('drag-over'));
    pfpPicker.addEventListener('drop', (e) => {
      e.preventDefault();
      pfpPicker.classList.remove('drag-over');
      const file = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith('image/'));
      if (file) setPfpFile(file);
    });
    const submit = h('button', { class: 'btn btn-primary', text: mode === 'login' ? 'enter' : 'create account' });
    const hints = [];
    if (mode === 'register' && !(await getInfo()).has_admin) {
      hints.push(h('p', { class: 'faint small' }, 'first account on the server becomes the admin.'));
    }
    if (mode === 'login') {
      hints.push(h('p', { class: 'faint small' }, 'no account yet? switch to register.'));
    }
    body.replaceChildren(username, password, ...(mode === 'register' ? [pfp] : []), submit, ...hints);
    const targetH = body.scrollHeight;
    if (prevH > 0 && targetH !== prevH) {
      body.style.height = `${prevH}px`;
      void body.offsetHeight;
      body.style.height = `${targetH}px`;
      body.addEventListener('transitionend', () => { body.style.height = ''; }, { once: true });
    }
    if (mode === 'login') password.querySelector('input').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit.click(); });

    submit.onclick = async () => {
      err.textContent = '';
      submit.disabled = true;
      submit.textContent = '…';
      try {
        const u = username.querySelector('input').value;
        const p = password.querySelector('input').value;
        let pfpDataUrl = null;
        if (mode === 'register') {
          const file = pfpFile;
          if (file) {
            if (!/^image\/(jpeg|png)$/.test(file.type)) throw new Error('profile picture must be jpeg or png');
            if (file.size > 8 * 1024 * 1024) throw new Error('profile picture too large (max 8 MB)');
            pfpDataUrl = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = () => reject(new Error('could not read profile picture'));
              reader.readAsDataURL(file);
            });
          }
        }
        const { user } = mode === 'login'
          ? await api.auth.login(u, p)
          : await api.auth.register(u, p, pfpDataUrl);
        state.user = user;
        location.hash = '#/';
      } catch (e) {
        err.textContent = e.message;
        submit.disabled = false;
        submit.textContent = mode === 'login' ? 'enter' : 'create account';
      }
    };
  }

  renderBody();
}
