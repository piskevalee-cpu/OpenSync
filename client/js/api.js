async function request(method, url, { json, body, headers = {}, onProgress } = {}) {
  const opts = { method, headers: { ...headers } };
  if (json !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(json);
  } else if (body !== undefined) {
    opts.body = body;
  }
  let res;
  if (onProgress && body && typeof body.pipe === 'function') {
    throw new Error('use XHR for stream progress');
  } else {
    res = await fetch(url, opts);
  }
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error(data?.error || data || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, json) => request('POST', url, { json }),
  patch: (url, json) => request('PATCH', url, { json }),
  del: (url) => request('DELETE', url),
  raw: (url, { body, headers }) => request('POST', url, { body, headers }),

  info: () => api.get('/api/info'),
  users: () => api.get('/api/users'),

  auth: {
    register: (username, password, pfp) => api.post('/api/auth/register', { username, password, pfp }),
    login: (username, password) => api.post('/api/auth/login', { username, password }),
    logout: () => api.post('/api/auth/logout', {}),
    me: () => api.get('/api/auth/me'),
    uploadPfp: (body) => request('PUT', '/api/auth/me/pfp', { body, headers: { 'content-type': body.type } }),
    removePfp: () => request('DELETE', '/api/auth/me/pfp'),
    deleteAccount: () => api.del('/api/auth/me'),
  },
  games: {
    list: () => api.get('/api/games'),
    get: (id) => api.get(`/api/games/${id}`),
    create: (data) => api.post('/api/games', data),
    patch: (id, data) => api.patch(`/api/games/${id}`, data),
    remove: (id) => api.del(`/api/games/${id}`),
    status: (id) => api.get(`/api/games/${id}/status`),
    manifest: (id) => api.get(`/api/games/${id}/manifest`),
    uploadInit: (id) => api.post(`/api/games/${id}/upload/init`, {}),
    uploadComplete: (id) => api.post(`/api/games/${id}/upload/complete`, {}),
    overlayInit: (id) => api.get(`/api/games/${id}/overlay/init`),
    overlay: (id) => api.get(`/api/games/${id}/overlay`),
    syncComplete: (id, deletions, force = false) => api.post(`/api/games/${id}/sync/complete`, { deletions, force }),
    clearOverlay: (id) => api.del(`/api/games/${id}/overlay`),
    cover: (id, body) => api.raw(`/api/games/${id}/cover`, { body, headers: { 'content-type': body.type } }),
  },
  comments: {
    create: (gameId, text, parentId) => api.post(`/api/games/${gameId}/comments`, parentId == null ? { text } : { text, parent_id: parentId }),
    remove: (id) => api.del(`/api/comments/${id}`),
  },
  notifications: {
    list: () => api.get('/api/notifications'),
    markRead: (id) => api.post('/api/notifications/read', { id }),
    markAllRead: () => api.post('/api/notifications/read', { all: true }),
    clearAll: () => api.del('/api/notifications'),
  },
  admin: {
    stats: () => api.get('/api/admin/stats'),
    users: () => api.get('/api/admin/users'),
    createUser: (data) => api.post('/api/admin/users', data),
    setRole: (id, role) => api.patch(`/api/admin/users/${id}/role`, { role }),
    removeUser: (id) => api.del(`/api/admin/users/${id}`),
    bench: () => api.get('/api/admin/bench'),
  },
};

export function humanSize(bytes) {
  if (!Number.isFinite(bytes)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function pfpUrl(pfp) {
  if (!pfp) return '';
  // backend returns /api/auth/users/{id}/pfp or an absolute asset path
  // like /img/blankpfp.jpg (the default avatar) — pass those through
  if (pfp.startsWith('/')) return pfp;
  return `/api/auth/users/${pfp}/pfp`;
}
