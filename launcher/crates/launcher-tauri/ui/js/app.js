import { bridge, listenDragDrop, listenEvents } from './bridge.js';
import { createGamepadController } from './gamepad.js';
import { icon } from './icons.js';
import { WaveformCanvas } from './waveform.js';

// ---------- Formatting & URL Helpers ----------

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeServerUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) {
    s = `http://${s}`;
  }
  try {
    const u = new URL(s);
    if (u.hostname === '0.0.0.0' || u.hostname === '[::]' || u.hostname === '::') {
      u.hostname = '127.0.0.1';
    }
    u.hash = '';
    u.search = '';
    let p = u.pathname.replace(/\/+$/, '');
    if (p === '/api') p = '';
    else if (p.includes('/api/')) p = p.slice(0, p.indexOf('/api/'));
    u.pathname = p || '/';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return s.split('#')[0].split('?')[0].replace(/\/+$/, '');
  }
}

function humanBytes(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let val = n / 1024;
  let u = 0;
  while (val >= 1024 && u < units.length - 1) {
    val /= 1024;
    u++;
  }
  return `${val >= 100 ? val.toFixed(0) : val >= 10 ? val.toFixed(1) : val.toFixed(2)} ${units[u]}`;
}

function humanSpeed(bps) {
  const n = Number(bps || 0);
  if (n <= 0) return '0 MB/s';
  const mb = n / (1024 * 1024);
  if (mb >= 100) return `${mb.toFixed(0)} MB/s`;
  if (mb >= 1) return `${mb.toFixed(1)} MB/s`;
  return `${Math.max(1, Math.round(n / 1024))} KB/s`;
}

function humanEta(secs) {
  if (secs == null || !Number.isFinite(secs) || secs < 0) return 'Estimating…';
  if (secs < 1) return 'Finishing…';
  const s = Math.round(secs);
  if (s < 60) return `${s}s left`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) return remS ? `${m}m ${remS}s left` : `${m}m left`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM ? `${h}h ${remM}m left` : `${h}h left`;
}

function humanPlaytime(totalSecs) {
  const s = Math.max(0, Math.floor(Number(totalSecs || 0)));
  if (s === 0) return 'Not played yet';
  if (s < 60) return `${s}s played`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m played`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM ? `${h}h ${remM}m played` : `${h}h played`;
}

function humanRelativeDate(iso) {
  if (!iso) return 'Never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Never';
  const diffSec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (diffSec < 60) return 'Just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function monogram(name) {
  const words = String(name || 'OS').trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return String(name || 'OS').trim().slice(0, 2).toUpperCase();
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function isDefaultPfp(path) {
  return !path || path === '/img/blankpfp.jpg';
}

function pfpCacheKey(profileId, userId) {
  return `${profileId || 'none'}_${userId}`;
}

/// Renders an avatar slot: cached image when available, otherwise a clean monogram that is
/// upgraded in place once `ensureUserPfp` resolves.
function pfpSlotHtml(profileId, userId, pfpPath, className, label) {
  const safeClass = esc(className);
  const monogramHtml = esc(monogram(label));
  if (profileId == null || userId == null) {
    return `<span class="${safeClass}" aria-hidden="true">${monogramHtml}</span>`;
  }
  const key = pfpCacheKey(profileId, userId);
  if (!state.pfpCache.has(key)) {
    ensureUserPfp(profileId, userId, pfpPath);
  }
  const cached = state.pfpCache.get(key);
  if (cached) {
    return `<img class="${safeClass}" src="${esc(cached)}" alt="" decoding="async" />`;
  }
  return `<span class="${safeClass} pfp-pending" data-pfp-key="${esc(key)}" data-pfp-class="${safeClass}" aria-hidden="true">${monogramHtml}</span>`;
}

async function ensureUserPfp(profileId, userId, pfpPath) {
  const key = pfpCacheKey(profileId, userId);
  if (state.pfpCache.has(key) || state.pfpPending.has(key)) return;
  state.pfpPending.add(key);
  try {
    const dataUrl = await bridge.getUserPfpDataUrl(pfpPath || null, userId);
    state.pfpCache.set(key, dataUrl || null);
    const slots = [...document.querySelectorAll('[data-pfp-key]')].filter(
      (el) => el.dataset.pfpKey === key,
    );
    if (dataUrl) {
      for (const slot of slots) {
        const img = document.createElement('img');
        img.className = slot.dataset.pfpClass || '';
        img.src = dataUrl;
        img.alt = '';
        img.decoding = 'async';
        img.dataset.pfpLoaded = String(userId);
        slot.replaceWith(img);
      }
    } else {
      for (const slot of slots) {
        slot.removeAttribute('data-pfp-key');
        slot.classList.remove('pfp-pending');
      }
    }
  } catch {
    state.pfpCache.set(key, null);
  } finally {
    state.pfpPending.delete(key);
  }
}

function invalidateUserPfp(profileId, userId) {
  state.pfpCache.delete(pfpCacheKey(profileId, userId));
}

function protonSourceLabel(source) {
  switch (source) {
    case 'OpenSyncManaged': return 'OpenSync';
    case 'SteamCompatTools': return 'Steam Compat';
    case 'SteamCommon': return 'Steam';
    case 'FlatpakSteam': return 'Flatpak';
    default: return 'Custom';
  }
}

function parseSystemRequirements(raw) {
  const lines = String(raw || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const pairs = [];
  const notes = [];
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx > 0 && idx < 24) {
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim();
      if (k && v) {
        pairs.push([k, v]);
        continue;
      }
    }
    notes.push(line);
  }
  return { pairs, notes };
}

function normalizeConnectionState(raw) {
  if (!raw) return { status: 'disconnected' };
  if (typeof raw === 'string') return { status: raw.toLowerCase() };
  if (raw.status) return { status: String(raw.status).toLowerCase(), attempt: raw.attempt };
  if (raw.Reconnecting) return { status: 'reconnecting', attempt: raw.Reconnecting.attempt || 1 };
  const key = Object.keys(raw)[0];
  if (key) return { status: key.toLowerCase(), attempt: raw[key]?.attempt };
  return { status: 'disconnected' };
}

function normalizeDownloadJob(raw) {
  if (!raw) return null;
  const kindType = raw.kind?.type === 'proton' || raw.kind === 'ge_proton' ? 'ge_proton' : 'game';
  const gameId = kindType === 'game' ? (raw.kind?.game_id ?? raw.game_id ?? null) : null;
  const fresh = Boolean(raw.kind?.fresh);
  const stage = String(raw.status?.state ?? raw.stage ?? 'queued').toLowerCase();
  const error = raw.status?.error ?? raw.error ?? null;
  const bytesDownloaded = Number(raw.bytes_downloaded || 0);
  const totalBytes = Number(raw.total_bytes || 0);
  const bps = Number(raw.bytes_per_sec || 0);
  const remaining = Math.max(0, totalBytes - bytesDownloaded);
  const etaSecs = stage === 'downloading' && bps > 0
    ? Math.ceil(remaining / bps)
    : stage === 'verifying' || stage === 'completed'
      ? 0
      : null;

  return {
    job_id: raw.id || raw.job_id,
    kind: kindType,
    game_id: gameId,
    title: raw.name || raw.title || 'Download',
    subtitle: kindType === 'ge_proton'
      ? 'GE-Proton compatibility runtime (SHA-512 verified)'
      : fresh
        ? 'Clean install (pristine archive, no saves)'
        : 'With saves (includes cloud save overlay)',
    stage,
    paused: stage === 'paused',
    bytes_downloaded: bytesDownloaded,
    total_bytes: totalBytes,
    files_extracted: Number(raw.files_extracted || 0),
    total_files: Number(raw.total_files || 0),
    current_file: raw.current_file || null,
    bytes_per_sec: bps,
    eta_secs: etaSecs,
    error,
    speed_samples: Array.isArray(raw.speed_samples) ? raw.speed_samples : [],
  };
}

// ---------- App State ----------

const TAB_ORDER = ['library', 'downloads', 'settings'];

const state = {
  view: 'library', // 'library' | 'game-detail' | 'downloads' | 'settings' | 'profile'
  gamesDir: '',
  selectedGameId: null,
  activeProfile: null,
  profiles: [],
  currentUser: null,
  pfpCache: new Map(), // `${profileId}_${userId}` -> dataUrl | null
  pfpPending: new Set(),
  profileDangerError: null,
  connectionState: { status: 'disconnected' },
  protonInstallations: [],
  pendingSyncs: [],
  downloads: [],
  bandwidthLimitBps: 0,
  library: [],
  coverCache: new Map(), // game_id -> dataUrl | null
  coverPending: new Set(),
  heroColorCache: new Map(), // `${profileId}_${gameId}` -> CSS gradient string | null
  playingGameIds: new Set(),
  syncingGameIds: new Set(),
  uninstallingGameIds: new Set(),
  searchQuery: '',
  filterMode: 'all', // 'all' | 'installed'
  sortBy: 'recent', // 'recent' | 'newest' | 'name' | 'size'
  profileMenuOpen: false,
  latestGeProton: null,
  checkingGeProton: false,
  geProtonError: null,
  reconnecting: false,
  uploads: [], // normalized live upload jobs
  uploadForm: null, // form state survives navigation (like the web UI's session)
  cssSelectOpen: null, // currently open custom dropdown
  activityLogs: [],
  activityMenuOpen: false,
  interruptedSessions: [],
  promptedInterruptedGameIds: new Set(),
};

const activeWaveforms = new Map(); // job_id -> WaveformCanvas
const activeUploadWaveforms = new Map(); // job_id -> WaveformCanvas
let activeUploadViewApi = null; // live handlers bound by renderUploadView()

// Teardown handle for the first-run auth particle field. It is only alive while
// the auth screen is mounted and is always disposed when leaving it.
let stopAuthParticleField = null;

// ---------- Scroll performance ----------
// Mark the body while the user is actively scrolling so paused cards skip the
// expensive 3D-tilt/backdrop repaints. No layout reads in the hot path.
let scrollIdleTimer = null;
let wasScrolled = false;
function initScrollPerf() {
  window.addEventListener(
    'scroll',
    () => {
      document.body.classList.add('is-scrolling');
      const isScrolled = window.scrollY > 4;
      if (isScrolled !== wasScrolled) {
        wasScrolled = isScrolled;
        document.body.classList.toggle('is-scrolled', isScrolled);
      }
      if (scrollIdleTimer !== null) clearTimeout(scrollIdleTimer);
      scrollIdleTimer = window.setTimeout(() => {
        document.body.classList.remove('is-scrolling');
        scrollIdleTimer = null;
      }, 90);
    },
    { passive: true },
  );
}

// ---------- Reusable CSS select (replaces every native <select>) ----------

function closeCssSelect() {
  const inst = state.cssSelectOpen;
  if (!inst) return;
  state.cssSelectOpen = null;
  inst.close();
}

/**
 * Creates an accessible, gamepad-friendly dropdown. The menu is appended to
 * #app-shell with fixed positioning so it is never clipped by panels/cards.
 */
function createCssSelect({ options, value = '', onChange, disabled = false, ariaLabel = 'Select', placeholder = 'Select…' }) {
  const root = document.createElement('div');
  root.className = 'css-select';
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'css-select-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-label', ariaLabel);
  trigger.disabled = Boolean(disabled);
  trigger.innerHTML = `<span class="css-select-value"></span><span class="css-select-chevron">${icon('chevron-down', 15)}</span>`;

  const valueEl = trigger.querySelector('.css-select-value');
  let selected = options.some((o) => o.value === value) ? value : (options[0]?.value ?? '');
  let activeIndex = Math.max(0, options.findIndex((o) => o.value === selected));
  let menu = null;
  let open = false;

  function labelFor(v) {
    return options.find((o) => o.value === v)?.label ?? placeholder;
  }

  function syncTrigger() {
    valueEl.textContent = labelFor(selected);
    trigger.setAttribute('aria-label', `${ariaLabel}: ${labelFor(selected)}`);
  }

  function positionMenu() {
    if (!menu || !trigger.isConnected) return;
    const r = trigger.getBoundingClientRect();
    menu.style.setProperty('--css-select-width', `${Math.round(r.width)}px`);
    const menuRect = menu.getBoundingClientRect();
    const menuW = Math.max(r.width, menuRect.width);
    const fitsLeft = r.left + menuW <= window.innerWidth - 8;
    const left = fitsLeft
      ? Math.max(8, Math.round(r.left))
      : Math.max(8, Math.round(r.right - menuW));
    const below = window.innerHeight - r.bottom - 8;
    const above = r.top - 8;
    const top = below >= Math.min(menuRect.height, 220) || below >= above
      ? Math.round(r.bottom + 6)
      : Math.max(8, Math.round(r.top - menuRect.height - 6));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  function onWindowLayout() {
    if (open) positionMenu();
  }

  function onDocPointer(e) {
    if (!root.contains(e.target) && !menu?.contains(e.target)) closeCssSelect();
  }
  function onDocKey(e) {
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeCssSelect();
      trigger.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      activeIndex = (activeIndex + dir + options.length) % options.length;
      paintActive();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      pick(activeIndex);
    }
  }

  function paintActive() {
    if (!menu) return;
    [...menu.querySelectorAll('.css-select-option')].forEach((el, i) => {
      el.classList.toggle('is-active', i === activeIndex);
    });
    const active = menu.querySelector('.css-select-option.is-active');
    active?.scrollIntoView({ block: 'nearest' });
  }

  function pick(index) {
    const opt = options[index];
    if (!opt) return;
    selected = opt.value;
    activeIndex = index;
    syncTrigger();
    closeCssSelect();
    trigger.focus();
    if (typeof onChange === 'function') onChange(selected);
  }

  function openMenu() {
    if (disabled || open) return;
    closeCssSelect();
    open = true;
    activeIndex = Math.max(0, options.findIndex((o) => o.value === selected));
    menu = document.createElement('div');
    menu.className = 'css-select-menu';
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', ariaLabel);
    for (const [i, opt] of options.entries()) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `css-select-option${opt.value === selected ? ' selected' : ''}${i === activeIndex ? ' is-active' : ''}`;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(opt.value === selected));
      item.innerHTML = `<span>${esc(opt.label)}</span>${opt.value === selected ? `<span class="css-select-check">${icon('check', 15)}</span>` : ''}`;
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        pick(i);
      });
      item.addEventListener('pointerenter', () => {
        activeIndex = i;
        paintActive();
      });
      menu.appendChild(item);
    }
    document.body.appendChild(menu);
    state.cssSelectOpen = { close: destroyMenu };
    root.classList.add('is-open');
    trigger.setAttribute('aria-expanded', 'true');
    positionMenu();
    document.addEventListener('pointerdown', onDocPointer);
    document.addEventListener('keydown', onDocKey, true);
    window.addEventListener('resize', onWindowLayout);
    window.addEventListener('scroll', onWindowLayout, true);
    // Only move controller focus ring into the menu when controller/keyboard nav is active.
    if (document.body.classList.contains('gp-mode')) {
      gamepadCtrl?.focusElement?.(menu.querySelector('.css-select-option.is-active'));
    }
  }

  function destroyMenu() {
    if (!open) return;
    open = false;
    root.classList.remove('is-open');
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onDocPointer);
    document.removeEventListener('keydown', onDocKey, true);
    window.removeEventListener('resize', onWindowLayout);
    window.removeEventListener('scroll', onWindowLayout, true);
    menu?.remove();
    menu = null;
  }

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (open) closeCssSelect();
    else openMenu();
  });
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) openMenu();
    }
  });
  root.addEventListener('css-select-destroy', destroyMenu);

  syncTrigger();
  root.appendChild(trigger);
  return {
    element: root,
    get value() { return selected; },
    set(value) {
      selected = options.some((o) => o.value === value) ? value : (options[0]?.value ?? '');
      syncTrigger();
    },
    setDisabled(v) { trigger.disabled = Boolean(v); },
    destroy() {
      destroyMenu();
      root.remove();
    },
  };
}

// ---------- DOM References ----------

const viewEl = document.getElementById('view');
const topbarEl = document.getElementById('topbar');
const detailHeroBg = document.getElementById('detail-hero-bg');
const detailHeroLayers = detailHeroBg ? [...detailHeroBg.querySelectorAll('.detail-hero-layer')] : [];
const profileSwitcherEl = document.getElementById('profile-switcher');
const statusRightEl = document.getElementById('status-right');
const modalRoot = document.getElementById('modal-root');
const lightboxRoot = document.getElementById('lightbox-root');
const syncBannerRoot = document.getElementById('sync-banner-root');
const toastRoot = document.getElementById('toast-root');
const navDlPill = document.getElementById('nav-dl-pill');
const fabUploadEl = document.getElementById('fab-upload');

let gamepadCtrl = null;
let libViewShell = null;
let libSortControl = null;
const cardDomCache = new Map(); // game_id -> { sig, card }
const liveSyncBanners = new Map(); // game_id -> { el, timer }

// ---------- Live Post-Close Auto-Sync Banner ----------

function showLiveSyncBanner(gameId, gameName, trigger = 'post_exit') {
  if (!syncBannerRoot) return;
  const existing = liveSyncBanners.get(gameId);
  if (existing) {
    if (existing.timer) clearTimeout(existing.timer);
    existing.el.remove();
    liveSyncBanners.delete(gameId);
  }

  const titleText = trigger === 'post_exit'
    ? `Game closed · Auto-syncing ${gameName}…`
    : trigger === 'recovery'
      ? `Recovering saves · ${gameName}…`
      : `Syncing saves · ${gameName}…`;
  const subText = trigger === 'post_exit'
    ? 'Scanning game folder & uploading differential save overlay…'
    : 'Diffing save files against clean server manifest…';

  const el = document.createElement('div');
  el.className = 'sync-banner';
  el.dataset.gameId = String(gameId);
  el.innerHTML = `
    <div class="sync-banner-main">
      <div class="sync-banner-icon"><span class="spin-icon">${icon('refresh-cw', 17)}</span></div>
      <div class="sync-banner-text">
        <div class="sync-banner-title">${esc(titleText)}</div>
        <div class="sync-banner-sub">${esc(subText)}</div>
      </div>
    </div>
    <div class="sync-banner-track"><div class="sync-banner-fill"></div></div>
  `;
  syncBannerRoot.appendChild(el);
  liveSyncBanners.set(gameId, { el, timer: null });
}

function completeLiveSyncBanner(gameId, gameName, { uploadedFiles = 0, uploadedBytes = 0, deletedPaths = 0, error = null } = {}) {
  if (!syncBannerRoot) return;
  let record = liveSyncBanners.get(gameId);
  if (!record) {
    showLiveSyncBanner(gameId, gameName, 'post_exit');
    record = liveSyncBanners.get(gameId);
  }
  if (!record) return;
  if (record.timer) clearTimeout(record.timer);

  const { el } = record;
  el.classList.add('is-complete');
  if (error) {
    el.classList.add('is-warn');
    el.innerHTML = `
      <div class="sync-banner-main">
        <div class="sync-banner-icon">${icon('wifi-off', 17)}</div>
        <div class="sync-banner-text">
          <div class="sync-banner-title">Save sync queued · ${esc(gameName)}</div>
          <div class="sync-banner-sub">${esc(error)}</div>
        </div>
      </div>
      <div class="sync-banner-track"><div class="sync-banner-fill"></div></div>
    `;
  } else {
    const detail = uploadedFiles > 0 || deletedPaths > 0
      ? `${uploadedFiles} file${uploadedFiles === 1 ? '' : 's'} uploaded (${humanBytes(uploadedBytes)})${deletedPaths > 0 ? ` · ${deletedPaths} deleted` : ''}`
      : 'All save files verified up to date';
    el.innerHTML = `
      <div class="sync-banner-main">
        <div class="sync-banner-icon">${icon('check', 17)}</div>
        <div class="sync-banner-text">
          <div class="sync-banner-title">Auto-sync complete · ${esc(gameName)}</div>
          <div class="sync-banner-sub">${esc(detail)}</div>
        </div>
      </div>
      <div class="sync-banner-track"><div class="sync-banner-fill"></div></div>
    `;
  }

  record.timer = window.setTimeout(() => {
    el.style.transition = 'opacity 0.24s ease, transform 0.24s ease';
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    window.setTimeout(() => {
      el.remove();
      liveSyncBanners.delete(gameId);
    }, 250);
  }, 4400);
}

// ---------- Toast System ----------

function showToast(message, tone = 'accent', iconName = 'check') {
  const el = document.createElement('div');
  el.className = `toast ${tone}`;
  el.innerHTML = `<span class="toast-icon">${icon(iconName, 16)}</span><span>${esc(message)}</span>`;
  toastRoot.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity 0.22s ease, transform 0.22s ease';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 240);
  }, 3400);
}

// ---------- Cover Lazy Loader ----------

let heroSeq = 0;
let heroActiveLayer = 0;
let heroHoverGameId = null;
let heroFadeOutTimer = null;

function heroCacheKey(profileId, gameId) {
  return `${profileId || 'none'}_${gameId}`;
}

function cancelHeroFadeTimer() {
  if (heroFadeOutTimer !== null) {
    window.clearTimeout(heroFadeOutTimer);
    heroFadeOutTimer = null;
  }
}

function prepareHeroBg() {
  if (!detailHeroBg) return;
  detailHeroBg.hidden = false;
}

function fadeOutHero() {
  cancelHeroFadeTimer();
  heroHoverGameId = null;
  heroSeq += 1;
  if (!detailHeroBg) return;
  detailHeroBg.classList.remove('is-active');
  for (const layer of detailHeroLayers) {
    layer.classList.remove('is-visible');
  }
}

function scheduleClearHero(gameId, delayMs = 95) {
  cancelHeroFadeTimer();
  if (state.view !== 'library') return;
  if (delayMs <= 0) {
    if (gameId == null || heroHoverGameId === gameId) fadeOutHero();
    return;
  }
  heroFadeOutTimer = window.setTimeout(() => {
    heroFadeOutTimer = null;
    if (state.view === 'library' && (gameId == null || heroHoverGameId === gameId)) {
      fadeOutHero();
    }
  }, delayMs);
}

function clearDetailHero() {
  cancelHeroFadeTimer();
  heroHoverGameId = null;
  heroSeq += 1;
  if (!detailHeroBg) return;
  detailHeroBg.hidden = true;
  detailHeroBg.classList.remove('is-active');
  for (const layer of detailHeroLayers) {
    layer.classList.remove('is-visible');
    layer.style.backgroundImage = '';
    delete layer.dataset.grad;
  }
}

function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h, s, l) {
  if (s <= 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const hue2rgb = (p, q, t) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ];
}

function tuneHeroColor([r, g, b]) {
  const [h, s, l] = rgbToHsl(r, g, b);
  if (s < 0.08) {
    const clampedL = Math.max(0.28, Math.min(0.40, l));
    return hslToRgb(0.60, 0.10, clampedL);
  }
  const tunedS = Math.max(0.30, Math.min(0.78, s * 1.25));
  const tunedL = Math.max(0.30, Math.min(0.52, l));
  return hslToRgb(h, tunedS, tunedL);
}

function colorDistSq(a, b) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

function extractHeroColorGradient(srcUrl) {
  return new Promise((resolve) => {
    if (!srcUrl || typeof document === 'undefined') {
      resolve(null);
      return;
    }
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      try {
        const w = img.naturalWidth || 0;
        const h = img.naturalHeight || 0;
        if (!w || !h) {
          resolve(null);
          return;
        }
        const cw = 24;
        const ch = 36;
        const canvas = document.createElement('canvas');
        canvas.width = cw;
        canvas.height = ch;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) {
          resolve(null);
          return;
        }
        ctx.drawImage(img, 0, 0, cw, ch);
        const { data } = ctx.getImageData(0, 0, cw, ch);

        const buckets = new Map();
        const rightHalfSum = [0, 0, 0, 0];
        const allSum = [0, 0, 0, 0];

        for (let y = 0; y < ch; y += 1) {
          for (let x = 0; x < cw; x += 1) {
            const idx = (y * cw + x) * 4;
            const a = data[idx + 3];
            if (a < 32) continue;
            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];

            allSum[0] += r;
            allSum[1] += g;
            allSum[2] += b;
            allSum[3] += 1;
            if (x >= cw / 2) {
              rightHalfSum[0] += r;
              rightHalfSum[1] += g;
              rightHalfSum[2] += b;
              rightHalfSum[3] += 1;
            }

            const luma = 0.299 * r + 0.587 * g + 0.114 * b;
            if (luma < 14 || luma > 242) continue;

            const [, sat] = rgbToHsl(r, g, b);
            const weight = 0.25 + sat * 1.9;
            const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
            let bucket = buckets.get(key);
            if (!bucket) {
              bucket = { rSum: 0, gSum: 0, bSum: 0, count: 0, score: 0, satSum: 0 };
              buckets.set(key, bucket);
            }
            bucket.rSum += r;
            bucket.gSum += g;
            bucket.bSum += b;
            bucket.count += 1;
            bucket.score += weight;
            bucket.satSum += sat;
          }
        }

        if (allSum[3] === 0) {
          resolve(null);
          return;
        }

        const avgAll = [
          allSum[0] / allSum[3],
          allSum[1] / allSum[3],
          allSum[2] / allSum[3],
        ];
        const avgRight = rightHalfSum[3] > 0
          ? [
              rightHalfSum[0] / rightHalfSum[3],
              rightHalfSum[1] / rightHalfSum[3],
              rightHalfSum[2] / rightHalfSum[3],
            ]
          : avgAll;

        const candidates = [...buckets.values()]
          .map((bkt) => ({
            rgb: [bkt.rSum / bkt.count, bkt.gSum / bkt.count, bkt.bSum / bkt.count],
            score: bkt.score,
            avgSat: bkt.satSum / bkt.count,
          }))
          .sort((a, b) => b.score - a.score);

        const primaryRaw = candidates[0]?.rgb || avgAll;

        let secondaryRaw = avgRight;
        let bestSecondaryScore = -1;
        for (const c of candidates.slice(0, 12)) {
          const dist = colorDistSq(c.rgb, primaryRaw);
          if (dist < 900) continue;
          const combined = Math.sqrt(dist) * (0.4 + c.score);
          if (combined > bestSecondaryScore) {
            bestSecondaryScore = combined;
            secondaryRaw = c.rgb;
          }
        }

        let accentRaw = primaryRaw;
        let bestAccentScore = -1;
        for (const c of candidates.slice(0, 16)) {
          const accentScore = c.avgSat * Math.log1p(c.score) * (colorDistSq(c.rgb, secondaryRaw) > 500 ? 1.15 : 1);
          if (accentScore > bestAccentScore) {
            bestAccentScore = accentScore;
            accentRaw = c.rgb;
          }
        }

        const [r1, g1, b1] = tuneHeroColor(primaryRaw);
        const [r2, g2, b2] = tuneHeroColor(secondaryRaw);
        const [r3, g3, b3] = tuneHeroColor(accentRaw);

        resolve([
          `radial-gradient(ellipse 68% 92% at 18% 8%, rgba(${r1}, ${g1}, ${b1}, 0.44) 0%, rgba(${r1}, ${g1}, ${b1}, 0.14) 46%, transparent 78%)`,
          `radial-gradient(ellipse 62% 88% at 78% 14%, rgba(${r2}, ${g2}, ${b2}, 0.34) 0%, rgba(${r2}, ${g2}, ${b2}, 0.10) 48%, transparent 80%)`,
          `radial-gradient(ellipse 50% 75% at 48% 26%, rgba(${r3}, ${g3}, ${b3}, 0.24) 0%, transparent 74%)`,
        ].join(', '));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = srcUrl;
  });
}

function isHeroStillValid(gameId, mode) {
  if (mode === 'detail') {
    return state.view === 'game-detail' && state.selectedGameId === gameId;
  }
  return state.view === 'library' && Boolean(state.activeProfile) && heroHoverGameId === gameId;
}

async function applyHeroForGame(game, mode) {
  if (!detailHeroBg || !game || !isHeroStillValid(game.game_id, mode)) {
    return;
  }
  cancelHeroFadeTimer();
  const seq = ++heroSeq;
  detailHeroBg.hidden = false;
  if (!detailHeroBg.classList.contains('is-active')) {
    void detailHeroBg.offsetWidth;
    detailHeroBg.classList.add('is-active');
  }

  const coverUrl = state.coverCache.get(game.game_id);
  if (!coverUrl) {
    for (const layer of detailHeroLayers) layer.classList.remove('is-visible');
    if (game.has_cover) ensureCover(game);
    return;
  }

  const key = heroCacheKey(state.activeProfile?.id, game.game_id);
  let gradient = state.heroColorCache.get(key);
  if (gradient === undefined) {
    gradient = await extractHeroColorGradient(coverUrl);
    state.heroColorCache.set(key, gradient);
  }
  if (seq !== heroSeq || !isHeroStillValid(game.game_id, mode)) {
    return;
  }
  if (!gradient || detailHeroLayers.length === 0) {
    for (const layer of detailHeroLayers) layer.classList.remove('is-visible');
    return;
  }

  const currentLayer = detailHeroLayers[heroActiveLayer];
  if (currentLayer && currentLayer.dataset.grad === gradient && currentLayer.classList.contains('is-visible')) {
    return;
  }

  const nextLayerIdx = detailHeroLayers.length > 1 ? (heroActiveLayer + 1) % detailHeroLayers.length : 0;
  const nextLayer = detailHeroLayers[nextLayerIdx];
  heroActiveLayer = nextLayerIdx;

  if (nextLayer.dataset.grad !== gradient) {
    nextLayer.classList.remove('is-visible');
    nextLayer.dataset.grad = gradient;
    nextLayer.style.backgroundImage = gradient;
  }
  void nextLayer.offsetWidth;
  nextLayer.classList.add('is-visible');
  for (let i = 0; i < detailHeroLayers.length; i += 1) {
    if (i !== heroActiveLayer) {
      detailHeroLayers[i].classList.remove('is-visible');
    }
  }
}

function syncDetailHero(game) {
  heroHoverGameId = null;
  return applyHeroForGame(game, 'detail');
}

function showLibraryHoverHero(game) {
  if (!game || state.view !== 'library') return;
  heroHoverGameId = game.game_id;
  return applyHeroForGame(game, 'hover');
}

const MAX_CONCURRENT_COVERS = 6;
const inFlightCovers = new Set();
const coverQueue = [];
let activeCoverCount = 0;

function drainCoverQueue() {
  while (activeCoverCount < MAX_CONCURRENT_COVERS && coverQueue.length > 0) {
    const next = coverQueue.shift();
    if (next) next();
  }
}

async function ensureCover(game) {
  if (!game || !game.has_cover) return;
  if (state.coverCache.has(game.game_id) || state.coverPending.has(game.game_id) || inFlightCovers.has(game.game_id)) return;
  state.coverPending.add(game.game_id);
  inFlightCovers.add(game.game_id);

  const run = async () => {
    activeCoverCount += 1;
    try {
      const dataUrl = await bridge.getGameCoverDataUrl(game.game_id);
      state.coverCache.set(game.game_id, dataUrl || null);
      if (dataUrl) {
        document.querySelectorAll(`[data-cover-game="${game.game_id}"]`).forEach((slot) => {
          const img = document.createElement('img');
          img.className = slot.dataset.coverClass || 'card-cover-img';
          img.src = dataUrl;
          img.alt = game.name;
          img.decoding = 'async';
          slot.replaceWith(img);
          img.dataset.coverLoaded = String(game.game_id);
        });
        const cached = cardDomCache.get(game.game_id);
        if (cached && cached.sig.endsWith('|0')) {
          cached.sig = `${cached.sig.slice(0, -2)}|1`;
        }
        if (state.view === 'game-detail' && state.selectedGameId === game.game_id) {
          syncDetailHero(game);
        } else if (state.view === 'library' && heroHoverGameId === game.game_id) {
          showLibraryHoverHero(game);
        }
      }
    } catch {
      state.coverCache.set(game.game_id, null);
    } finally {
      activeCoverCount -= 1;
      state.coverPending.delete(game.game_id);
      inFlightCovers.delete(game.game_id);
      drainCoverQueue();
    }
  };

  if (activeCoverCount < MAX_CONCURRENT_COVERS) {
    void run();
  } else {
    coverQueue.push(() => { void run(); });
  }
}

// ---------- Steam 3D Perspective Tilt ----------
// Same math/vars as the web UI (client/js/views/library.js). The only difference is
// rAF throttling + a cached rect: identical rendered result, fewer webview repaints.

function attachSteamTilt(card) {
  const MAX_TILT_X = 7;
  const MAX_TILT_Y = 8;
  let rect = null;
  let latest = null;
  let frame = 0;
  let lastVars = null;

  card.addEventListener('pointerenter', () => {
    rect = card.getBoundingClientRect();
    lastVars = null;
  });

  card.addEventListener('pointermove', (e) => {
    latest = e;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!latest || !rect || !rect.width || !rect.height) return;
      const px = ((latest.clientX - rect.left) / rect.width) * 2 - 1; // -1..1
      const py = ((latest.clientY - rect.top) / rect.height) * 2 - 1; // -1..1
      const rx = (-py * MAX_TILT_X).toFixed(2);
      const ry = (px * MAX_TILT_Y).toFixed(2);
      const gx = (((latest.clientX - rect.left) / rect.width) * 100).toFixed(1);
      const gy = (((latest.clientY - rect.top) / rect.height) * 100).toFixed(1);
      const nextVars = `${rx}|${ry}|${gx}|${gy}`;
      if (nextVars === lastVars) return;
      lastVars = nextVars;
      card.style.setProperty('--rx', `${rx}deg`);
      card.style.setProperty('--ry', `${ry}deg`);
      card.style.setProperty('--gx', `${gx}%`);
      card.style.setProperty('--gy', `${gy}%`);
    });
  });

  card.addEventListener('pointerleave', () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    latest = null;
    rect = null;
    lastVars = null;
    card.style.removeProperty('--rx');
    card.style.removeProperty('--ry');
    card.style.removeProperty('--gx');
    card.style.removeProperty('--gy');
  });
}

// ---------- Card Hover Stat Ticker (cycles every 2s while hovered or focused) ----------

function formatCardPlaytime(playtime) {
  const secs = Math.max(0, Math.floor(Number(playtime?.total_secs || 0)));
  if (secs === 0) return 'Never played before';

  let recent = false;
  if (playtime?.last_played_at) {
    const ts = new Date(playtime.last_played_at).getTime();
    if (!Number.isNaN(ts) && (Date.now() - ts) <= 14 * 86400 * 1000) {
      recent = true;
    }
  }

  if (secs < 60) {
    return recent ? 'Played recently' : '< 1 min played';
  }
  const mins = Math.floor(secs / 60);
  if (mins < 60) {
    return recent ? `${mins}m played recently` : `${mins}m played`;
  }
  const hours = secs / 3600;
  const hStr = hours >= 10
    ? String(Math.round(hours))
    : hours.toFixed(1).replace(/\.0$/, '');
  const unit = hStr === '1' ? 'hour' : 'hours';
  return recent ? `${hStr} ${unit} played recently` : `${hStr} ${unit} played`;
}

function buildCardStats(g, isPlaying) {
  const stats = [humanBytes(g.total_size)];
  if (isPlaying) {
    stats.push('Playing now');
  }

  const totalSecs = Math.max(0, Math.floor(Number(g.playtime?.total_secs || 0)));
  stats.push(formatCardPlaytime(g.playtime));

  if (totalSecs > 0) {
    if (g.playtime?.last_played_at) {
      stats.push(`Last played ${humanRelativeDate(g.playtime.last_played_at)}`);
    }
    const sessions = Number(g.playtime?.session_count || 0);
    if (sessions > 0) {
      stats.push(`${sessions} ${sessions === 1 ? 'session' : 'sessions'}`);
    }
  } else {
    if (g.download_count > 0) {
      stats.push(`${g.download_count} ${g.download_count === 1 ? 'download' : 'downloads'}`);
    }
    if (g.uploader_name) {
      stats.push(`Uploaded by @${g.uploader_name}`);
    }
  }

  return stats;
}

function attachStatTicker(card, stats, intervalMs = 1500, firstDelayMs = 450) {
  if (!Array.isArray(stats) || stats.length < 2) return;
  const ticker = card.querySelector('.card-stat-ticker');
  if (!ticker) return;

  let index = 0;
  let firstTimer = null;
  let timer = null;
  let hovered = false;
  let focused = false;

  const swapTo = (nextIndex, direction = 'up') => {
    if (nextIndex === index) return;
    index = nextIndex;
    card.classList.toggle('is-stat-cycling', index !== 0);

    const outClass = direction === 'down' ? 'is-leaving-down' : 'is-leaving';
    const inClass = direction === 'down' ? 'is-entering-down' : 'is-entering';

    for (const stale of ticker.querySelectorAll('.is-leaving, .is-leaving-down')) {
      stale.remove();
    }

    const current = ticker.querySelector('.card-stat-item');
    const next = document.createElement('span');
    next.className = `card-stat-item ${inClass}`;
    next.textContent = stats[index];
    ticker.appendChild(next);

    if (current) {
      current.classList.remove('is-entering', 'is-entering-down');
      current.classList.add(outClass);
      current.setAttribute('aria-hidden', 'true');
      let removed = false;
      const cleanup = () => {
        if (removed) return;
        removed = true;
        current.remove();
      };
      current.addEventListener('animationend', cleanup, { once: true });
      window.setTimeout(cleanup, 460);
    }

    next.addEventListener('animationend', () => {
      next.classList.remove('is-entering', 'is-entering-down');
    }, { once: true });
  };

  const stopTimers = () => {
    if (firstTimer !== null) {
      window.clearTimeout(firstTimer);
      firstTimer = null;
    }
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };

  const stepNext = () => {
    if (!card.isConnected) {
      stopTimers();
      return false;
    }
    swapTo((index + 1) % stats.length, 'up');
    return true;
  };

  const syncTimer = () => {
    if (hovered || focused) {
      if (firstTimer !== null || timer !== null) return;
      firstTimer = window.setTimeout(() => {
        firstTimer = null;
        if (!stepNext()) return;
        timer = window.setInterval(stepNext, intervalMs);
      }, firstDelayMs);
    } else {
      stopTimers();
      if (index !== 0) {
        swapTo(0, 'down');
      }
    }
  };

  card.addEventListener('pointerenter', () => {
    hovered = true;
    syncTimer();
  });
  card.addEventListener('pointerleave', () => {
    hovered = false;
    syncTimer();
  });
  card.addEventListener('focusin', () => {
    focused = true;
    syncTimer();
  });
  card.addEventListener('focusout', (e) => {
    if (!card.contains(e.relatedTarget)) {
      focused = false;
      syncTimer();
    }
  });
  card.addEventListener('card-reset', () => {
    hovered = false;
    focused = false;
    syncTimer();
  });
}

// ---------- Topbar Navigation & Status ----------

function syncFabVisibility() {
  const signedIn = Boolean(state.activeProfile);
  if (topbarEl) {
    topbarEl.style.display = signedIn ? '' : 'none';
  }
  document.documentElement.classList.toggle('is-auth-screen', !signedIn);
  document.body.classList.toggle('is-auth-screen', !signedIn);
  if (fabUploadEl) {
    fabUploadEl.hidden = !(state.view === 'library' && signedIn);
  }
}

function initTopbarNav() {
  if (fabUploadEl) {
    fabUploadEl.innerHTML = icon('plus', 26);
    fabUploadEl.addEventListener('click', () => navigate('upload'));
  }

  document.getElementById('brand-logo')?.addEventListener('click', (e) => {
    e.preventDefault();
    navigate('library');
  });

  document.querySelectorAll('.nav-link[data-view]').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      navigate(link.dataset.view);
    });
  });
}

function updateNavState() {
  const activeKey = state.view === 'game-detail' ? 'library' : state.view;
  document.querySelectorAll('.nav-link[data-view]').forEach((link) => {
    link.classList.toggle('active', link.dataset.view === activeKey);
  });

  const activeJobs = state.downloads.filter(
    (d) => d.stage === 'downloading' || d.stage === 'paused' || d.stage === 'verifying' || d.stage === 'queued',
  );
  const count = activeJobs.length;
  const allPaused = count > 0 && activeJobs.every((d) => d.stage === 'paused' || d.paused);

  if (!navDlPill) return;
  if (count === 0) {
    navDlPill.hidden = true;
    navDlPill.classList.remove('is-paused');
    return;
  }

  let totalBytes = 0;
  let doneBytes = 0;
  for (const j of activeJobs) {
    totalBytes += Math.max(1, Number(j.total_bytes || 0));
    doneBytes += Math.min(Number(j.total_bytes || 0), Number(j.bytes_downloaded || 0));
  }
  const pct = Math.min(100, Math.round((doneBytes / Math.max(1, totalBytes)) * 100));
  navDlPill.hidden = false;
  navDlPill.classList.toggle('is-paused', allPaused);
  navDlPill.textContent = allPaused ? `${count} paused` : `${pct}%`;
}

function activityIconName(kind) {
  switch (kind) {
    case 'game_start':
      return 'play';
    case 'game_close':
      return 'clock';
    case 'game_install':
      return 'hard-drive';
    case 'game_uninstall':
      return 'trash-2';
    case 'sync_complete':
      return 'check';
    case 'sync_offline':
      return 'wifi-off';
    case 'sync_error':
      return 'alert-triangle';
    case 'crash_detected':
    case 'crash_resolved':
      return 'alert-triangle';
    case 'safe_shutdown':
      return 'shield-check';
    default:
      return 'refresh-cw';
  }
}

function renderActivityItemHtml(entry) {
  const level = entry.level || 'info';
  const iconName = activityIconName(entry.kind);
  return `
    <div class="activity-item level-${esc(level)}" data-log-id="${esc(entry.id)}">
      <span class="activity-icon">${icon(iconName, 14)}</span>
      <div class="activity-body">
        <div class="activity-top-row">
          <span class="activity-title">${esc(entry.title || 'Event')}</span>
          <span class="activity-time">${esc(humanRelativeDate(entry.created_at))}</span>
        </div>
        ${entry.detail ? `<div class="activity-detail">${esc(entry.detail)}</div>` : ''}
      </div>
    </div>
  `;
}

function renderStatusStrip() {
  const active = state.activeProfile;
  // User first (with their avatar chip), instance label second.
  const chipInner = active
    ? pfpSlotHtml(active.id, active.user_id, state.currentUser?.pfp, 'profile-avatar-chip', active.username || active.label)
    : `<span class="profile-avatar-chip">${icon('server', 13)}</span>`;
  const labelText = active ? active.username : 'Connect instance';
  const subText = active ? active.label : 'Sign in';

  let menuHtml = '';
  if (state.profileMenuOpen) {
    const items = state.profiles.map((p) => {
      const isCurrent = active && p.id === active.id;
      return `
        <button type="button" class="profile-menu-item ${isCurrent ? 'active' : ''}" data-switch-profile="${esc(p.id)}">
          ${pfpSlotHtml(p.id, p.user_id, isCurrent ? state.currentUser?.pfp : null, 'profile-menu-avatar', p.username)}
          <div class="profile-menu-body">
            <div class="profile-menu-name">${esc(p.label)}</div>
            <div class="profile-menu-url">@${esc(p.username)} ${esc(p.server_url)}</div>
          </div>
          ${isCurrent ? icon('check', 15) : ''}
        </button>
      `;
    }).join('');

    menuHtml = `
      <div class="profile-menu" role="menu">
        ${items || '<div class="small muted" style="padding:8px 10px;">No saved instances yet.</div>'}
        <div class="profile-menu-sep"></div>
        <button type="button" class="profile-menu-item" id="btn-menu-profile">
          <span style="display:inline-flex;align-items:center;gap:8px;">${icon('user', 15)}<span>Profile &amp; avatar</span></span>
        </button>
        <button type="button" class="profile-menu-item" id="btn-menu-add-profile">
          <span style="display:inline-flex;align-items:center;gap:8px;">${icon('plus', 15)}<span>Add instance</span></span>
        </button>
        <button type="button" class="profile-menu-item" id="btn-menu-manage-profiles">
          <span style="display:inline-flex;align-items:center;gap:8px;">${icon('settings', 15)}<span>Manage instances</span></span>
        </button>
        <div class="profile-menu-sep"></div>
        <button type="button" class="profile-menu-item" id="btn-menu-safe-shutdown">
          <span style="display:inline-flex;align-items:center;gap:8px;">${icon('shield-check', 15)}<span>Safe quit launcher</span></span>
        </button>
      </div>
    `;
  }

  profileSwitcherEl.innerHTML = `
    <button type="button" class="profile-trigger" id="btn-profile-dropdown" aria-expanded="${state.profileMenuOpen}">
      ${chipInner}
      <span class="profile-trigger-meta">
        <span class="profile-trigger-label">${esc(labelText)}</span>
        <span class="profile-trigger-sub">${esc(subText)}</span>
      </span>
      ${icon('chevron-down', 15)}
    </button>
    ${menuHtml}
  `;

  document.getElementById('btn-profile-dropdown')?.addEventListener('click', (e) => {
    e.stopPropagation();
    state.activityMenuOpen = false;
    state.profileMenuOpen = !state.profileMenuOpen;
    renderStatusStrip();
  });

  profileSwitcherEl.querySelectorAll('[data-switch-profile]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const pid = btn.dataset.switchProfile;
      state.profileMenuOpen = false;
      renderStatusStrip();
      if (active && active.id === pid) return;
      try {
        await bridge.switchProfile(pid);
        await refreshAll();
        showToast('Switched OpenSync instance', 'accent', 'check');
      } catch (err) {
        showToast(String(err?.message || err), 'danger', 'alert-triangle');
      }
    });
  });

  document.getElementById('btn-menu-profile')?.addEventListener('click', async () => {
    state.profileMenuOpen = false;
    renderStatusStrip();
    await refreshCurrentUser();
    navigate('profile');
  });

  document.getElementById('btn-menu-add-profile')?.addEventListener('click', () => {
    state.profileMenuOpen = false;
    renderStatusStrip();
    openConnectModal();
  });

  document.getElementById('btn-menu-manage-profiles')?.addEventListener('click', () => {
    state.profileMenuOpen = false;
    renderStatusStrip();
    navigate('settings');
  });

  document.getElementById('btn-menu-safe-shutdown')?.addEventListener('click', async () => {
    state.profileMenuOpen = false;
    renderStatusStrip();
    await triggerSafeShutdownRequest();
  });

  // Connection & pending sync indicators
  const pendingCount = state.pendingSyncs.length;
  const pendingHtml = pendingCount > 0
    ? `
      <button type="button" class="status-pill status-pill-warn" id="btn-flush-pending" title="Upload pending offline saves">
        ${icon('refresh-cw', 13)}
        <span class="num">${pendingCount} pending ${pendingCount === 1 ? 'sync' : 'syncs'}</span>
      </button>
    `
    : '';

  const conn = state.connectionState?.status || 'disconnected';
  const connLabel = conn === 'connected'
    ? 'Connected'
    : conn === 'reconnecting'
      ? `Reconnecting${state.connectionState?.attempt ? ` (${state.connectionState.attempt})` : '…'}`
      : conn === 'connecting'
        ? 'Connecting…'
        : 'Offline';
  const connDotClass = conn === 'connected'
    ? 'connected'
    : conn === 'reconnecting' || conn === 'connecting'
      ? 'reconnecting'
      : 'disconnected';

  const reconnectBtn = conn !== 'connected' && state.activeProfile
    ? `<button type="button" class="btn btn-sm" id="btn-reconnect-now" ${state.reconnecting ? 'disabled' : ''}>${icon('refresh-cw', 13, state.reconnecting ? 'spin' : '')}<span>Reconnect</span></button>`
    : '';

  const runningUploads = activeUploads();
  const uploadPillHtml = runningUploads.length
    ? (() => {
        const job = runningUploads[0];
        const pct = job.total_bytes > 0 ? Math.min(100, Math.round((job.bytes_uploaded / job.total_bytes) * 100)) : 0;
        const paused = job.stage === 'paused';
        return `<button type="button" class="topbar-upload-pill${paused ? ' is-paused' : ''}" id="btn-upload-pill" title="View upload progress">
          ${icon('arrow-down', 13)}
          <span>${runningUploads.length > 1 ? `${runningUploads.length} uploads` : `Uploading ${pct}%`}</span>
        </button>`;
      })()
    : '';

  const isSyncing = state.syncingGameIds.size > 0;
  const logCount = state.activityLogs.length;
  const activityDrawerHtml = state.activityMenuOpen
    ? `
      <div class="activity-drawer" role="dialog" aria-label="Sync and launch activity log">
        <div class="activity-drawer-header">
          <span class="activity-drawer-title">
            ${isSyncing ? `<span class="spin-icon">${icon('refresh-cw', 14)}</span>` : icon('clock', 14)}
            <span>Sync and launch log</span>
          </span>
          <div class="activity-drawer-actions">
            ${logCount > 0 ? `<button type="button" class="btn btn-ghost btn-sm" id="btn-clear-activity-log" style="padding:3px 8px;font-size:11.5px;">Clear</button>` : ''}
          </div>
        </div>
        <div class="activity-list">
          ${logCount > 0
            ? state.activityLogs.slice(0, 35).map(renderActivityItemHtml).join('')
            : '<div class="activity-empty">No game launches or save syncs recorded in this session yet.</div>'}
        </div>
        <div class="activity-drawer-footer">
          <span class="small faint">${state.playingGameIds.size > 0 ? `${state.playingGameIds.size} game running · auto-sync on exit` : 'Auto-syncs saves on game close'}</span>
          <button type="button" class="btn btn-sm" id="btn-drawer-safe-shutdown" style="padding:4px 10px;font-size:11.5px;">
            ${icon('shield-check', 13)}<span>Safe quit</span>
          </button>
        </div>
      </div>
    `
    : '';

  const activityWrapHtml = state.activeProfile
    ? `
      <div class="activity-log-wrap" id="activity-log-wrap">
        <button type="button" class="activity-trigger${state.activityMenuOpen ? ' is-open' : ''}${isSyncing ? ' is-syncing' : ''}" id="btn-activity-log" aria-expanded="${state.activityMenuOpen}" title="View save sync & game launch log">
          ${isSyncing ? `<span class="spin-icon">${icon('refresh-cw', 13)}</span>` : icon('clock', 13)}
          <span>${isSyncing ? 'Syncing saves…' : 'Activity'}</span>
          ${logCount > 0 ? `<span class="activity-count-pill">${logCount}</span>` : ''}
        </button>
        ${activityDrawerHtml}
      </div>
    `
    : '';

  statusRightEl.innerHTML = `
    ${uploadPillHtml}
    ${pendingHtml}
    ${activityWrapHtml}
    <div class="status-pill ${conn === 'connected' ? 'is-online' : ''}" title="${state.activeProfile ? esc(state.activeProfile.server_url) : 'Not connected'}">
      <span class="status-dot ${connDotClass}"></span>
      <span>${esc(connLabel)}</span>
    </div>
    ${reconnectBtn}
  `;

  document.getElementById('btn-upload-pill')?.addEventListener('click', () => navigate('upload'));

  document.getElementById('btn-activity-log')?.addEventListener('click', (e) => {
    e.stopPropagation();
    state.profileMenuOpen = false;
    state.activityMenuOpen = !state.activityMenuOpen;
    renderStatusStrip();
  });

  document.getElementById('activity-log-wrap')?.querySelector('.activity-drawer')?.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  document.getElementById('btn-clear-activity-log')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await bridge.clearActivityLogs?.();
      state.activityLogs = [];
      renderStatusStrip();
      if (state.view === 'game-detail') renderGameDetailView();
    } catch (err) {
      showToast(String(err?.message || err), 'danger', 'alert-triangle');
    }
  });

  document.getElementById('btn-drawer-safe-shutdown')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    state.activityMenuOpen = false;
    renderStatusStrip();
    await triggerSafeShutdownRequest();
  });

  document.getElementById('btn-reconnect-now')?.addEventListener('click', async () => {
    state.reconnecting = true;
    renderStatusStrip();
    try {
      await bridge.reconnectNow();
      await refreshAll();
      showToast('Reconnected to OpenSync server', 'accent', 'wifi');
    } catch (err) {
      showToast(`Reconnect failed: ${err?.message || err}`, 'danger', 'wifi-off');
    } finally {
      state.reconnecting = false;
      renderStatusStrip();
    }
  });

  document.getElementById('btn-flush-pending')?.addEventListener('click', async () => {
    const items = [...state.pendingSyncs];
    if (!items.length) return;
    showToast(`Syncing ${items.length} pending ${items.length === 1 ? 'game' : 'games'}…`, 'accent', 'refresh-cw');
    for (const item of items) {
      try {
        await bridge.syncGameNow(item.game_id, false);
      } catch (err) {
        showToast(`Sync failed: ${err?.message || err}`, 'warn', 'alert-triangle');
      }
    }
    await refreshAll();
  });
}

document.addEventListener('click', () => {
  if (state.profileMenuOpen || state.activityMenuOpen) {
    state.profileMenuOpen = false;
    state.activityMenuOpen = false;
    renderStatusStrip();
  }
});

// ---------- Navigation & View Lifecycle ----------

function destroyWaveforms() {
  for (const wf of activeWaveforms.values()) {
    wf.destroy();
  }
  activeWaveforms.clear();
}

function destroyUploadWaveforms() {
  for (const wf of activeUploadWaveforms.values()) {
    wf.destroy();
  }
  activeUploadWaveforms.clear();
}

function updateUploadStatusPill() {
  const runningUploads = activeUploads();
  const pill = document.getElementById('btn-upload-pill');
  if (!runningUploads.length) {
    if (pill) renderStatusStrip();
    return;
  }
  if (!pill) {
    renderStatusStrip();
    return;
  }
  const job = runningUploads[0];
  const pct = job.total_bytes > 0 ? Math.min(100, Math.round((job.bytes_uploaded / job.total_bytes) * 100)) : 0;
  pill.classList.toggle('is-paused', job.stage === 'paused');
  const span = pill.querySelector('span');
  if (span) {
    span.textContent = runningUploads.length > 1 ? `${runningUploads.length} uploads` : `Uploading ${pct}%`;
  }
}

let viewSwitchTimer = null;
let viewSwitchEndHandler = null;
let viewRenderSeq = 0;

function clearPendingViewSwitch() {
  if (viewSwitchTimer !== null) {
    clearTimeout(viewSwitchTimer);
    viewSwitchTimer = null;
  }
  if (viewEl && viewSwitchEndHandler) {
    viewEl.removeEventListener('animationend', viewSwitchEndHandler);
    viewSwitchEndHandler = null;
  }
  if (viewEl) {
    viewEl.classList.remove('view-switch');
    viewEl.style.removeProperty('opacity');
  }
}

function navigate(nextView, opts = {}) {
  clearPendingViewSwitch();
  closeCssSelect();
  teardownAuthParticles();
  destroyWaveforms();
  if (nextView !== 'upload') destroyUploadWaveforms();
  if (nextView !== 'game-detail' && nextView !== 'library') {
    clearDetailHero();
  } else if (nextView === 'library') {
    fadeOutHero();
  }
  state.view = nextView;
  if (opts.gameId != null) {
    state.selectedGameId = opts.gameId;
  }
  if (window.scrollY > 0) {
    window.scrollTo(0, 0);
  }
  wasScrolled = false;
  document.body.classList.remove('is-scrolled');
  updateNavState();
  renderCurrentView(true);
}

function renderCurrentView(animate = false) {
  const seq = ++viewRenderSeq;
  clearPendingViewSwitch();
  syncFabVisibility();
  // Before signing in, only the sign-in menu may appear.
  if (!state.activeProfile) {
    clearDetailHero();
    renderLibraryView();
    gamepadCtrl?.onViewRendered();
    return;
  }
  // The orbital field belongs to the auth screen only; drop it the moment any
  // other view (including the connected library) is rendered.
  if (state.view !== 'library' || state.activeProfile) {
    teardownAuthParticles();
  }
  if (state.view !== 'downloads') {
    destroyWaveforms();
  }
  if (state.view !== 'upload') {
    activeUploadViewApi = null;
  }
  if (state.view !== 'game-detail' && state.view !== 'library') {
    clearDetailHero();
  }

  const reducedMotion = Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
  const canAnimate = Boolean(animate && !reducedMotion && viewEl);

  switch (state.view) {
    case 'library':
      renderLibraryView();
      break;
    case 'game-detail':
      renderGameDetailView();
      break;
    case 'downloads':
      renderDownloadsView();
      break;
    case 'settings':
      renderSettingsView();
      break;
    case 'profile':
      renderProfileView();
      break;
    case 'upload':
      renderUploadView();
      break;
    default:
      renderLibraryView();
  }

  syncFabVisibility();
  if (canAnimate) {
    void viewEl.offsetWidth;
    viewEl.classList.add('view-switch');
    const finish = () => {
      if (seq !== viewRenderSeq) return;
      clearPendingViewSwitch();
    };
    viewSwitchEndHandler = (e) => {
      if (e.target === viewEl && e.animationName === 'view-switch-in') {
        finish();
      }
    };
    viewEl.addEventListener('animationend', viewSwitchEndHandler);
    viewSwitchTimer = window.setTimeout(finish, 220);
  }

  gamepadCtrl?.onViewRendered();
}

// ---------- First-Run Auth: green orbital particle field ----------
// Adapted from the web UI's AG-DESIGN auth canvas, constrained to a single
// green hue. Short, round-capped dashes drift on a trig phase and point away
// from the viewport centre (or the live pointer). The animation pauses while
// the page is hidden, is skipped entirely under prefers-reduced-motion, and
// tears down its observers, listeners, rAF loop and canvas when the auth
// screen is replaced by any other view.

const AUTH_CANVAS_STYLE = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:0;display:block;';
const AUTH_SCREEN_STYLE = 'position:relative;z-index:1;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 0;';

function teardownAuthParticles() {
  if (!stopAuthParticleField) return;
  const stop = stopAuthParticleField;
  stopAuthParticleField = null;
  stop();
}

function attachAuthParticleField(canvas, host) {
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const ctx = canvas.getContext?.('2d');
  if (!ctx) return () => canvas.remove();

  // Matches the landing page hero orbital particle field.
  const PALETTE = [
    'rgba(125, 250, 155, 0.85)',
    'rgba(125, 250, 155, 0.56)',
    'rgba(74, 222, 128, 0.45)',
    'rgba(187, 247, 208, 0.34)',
  ];
  const pointer = { x: -9999, y: -9999, active: false };
  let width = 0;
  let height = 0;
  let particles = [];
  let rafId = 0;
  let tickPhase = 0;
  let running = false;
  let cleaned = false;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = Math.max(320, window.innerWidth);
    height = Math.max(240, window.innerHeight);
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = Math.min(115, Math.round((width * height) / 11000));
    particles = Array.from({ length: count }, (_, idx) => {
      const angle = (idx / count) * Math.PI * 2 + (idx % 7) * 0.2;
      const radiusFactor = 0.18 + ((idx * 37) % 100) / 120;
      return {
        x: (width * 0.5) + Math.cos(angle) * width * 0.44 * radiusFactor,
        y: (height * 0.48) + Math.sin(angle) * height * 0.46 * radiusFactor,
        vx: (Math.random() - 0.5) * 0.16,
        vy: (Math.random() - 0.5) * 0.16,
        len: 3 + (idx % 5) * 1.4,
        color: PALETTE[idx % PALETTE.length],
        phase: idx * 0.41,
      };
    });
    if (!running) draw();
  }

  function draw() {
    tickPhase += 0.015;
    ctx.clearRect(0, 0, width, height);
    const cx = width * 0.5;
    const cy = height * 0.44;
    ctx.lineWidth = 1.6;
    ctx.lineCap = 'round';
    for (const p of particles) {
      p.x += p.vx + Math.cos(tickPhase + p.phase) * 0.12;
      p.y += p.vy + Math.sin(tickPhase + p.phase) * 0.12;

      if (p.x < -20) p.x = width + 20;
      if (p.x > width + 20) p.x = -20;
      if (p.y < -20) p.y = height + 20;
      if (p.y > height + 20) p.y = -20;

      let dx = p.x - cx;
      let dy = p.y - cy;
      if (pointer.active) {
        dx = p.x - pointer.x;
        dy = p.y - pointer.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 140 && dist > 1) {
          const push = (140 - dist) * 0.014;
          p.x += (dx / dist) * push;
          p.y += (dy / dist) * push;
        }
      }

      const angle = Math.atan2(dy, dx);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(angle);
      ctx.strokeStyle = p.color;
      ctx.beginPath();
      ctx.moveTo(-p.len * 0.5, 0);
      ctx.lineTo(p.len * 0.5, 0);
      ctx.stroke();
      ctx.restore();
    }
  }

  function tick() {
    draw();
    rafId = requestAnimationFrame(tick);
  }

  function start() {
    if (running || cleaned) return;
    running = true;
    rafId = requestAnimationFrame(tick);
  }

  function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function onVisibility() {
    if (document.hidden) stop();
    else if (!reduce?.matches) start();
  }

  function onMotionChange() {
    if (reduce?.matches) {
      stop();
      draw();
    } else if (!document.hidden) {
      start();
    }
  }

  function onPointerMove(e) {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.active = true;
  }

  function onPointerLeave() {
    pointer.active = false;
  }

  // Safety net: if the host is ever detached without an explicit teardown,
  // clean everything up on the next DOM mutation.
  const observer = typeof MutationObserver !== 'undefined'
    ? new MutationObserver(() => {
        if (!host.isConnected) cleanup();
      })
    : null;
  observer?.observe(document.body, { childList: true, subtree: true });

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    stop();
    observer?.disconnect();
    document.removeEventListener('visibilitychange', onVisibility);
    document.removeEventListener('pointerleave', onPointerLeave);
    window.removeEventListener('resize', resize);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('blur', onPointerLeave);
    if (reduce?.removeEventListener) reduce.removeEventListener('change', onMotionChange);
    canvas.remove();
  }

  window.addEventListener('resize', resize);
  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('blur', onPointerLeave);
  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener('pointerleave', onPointerLeave);
  if (reduce?.addEventListener) reduce.addEventListener('change', onMotionChange);

  resize();
  if (reduce?.matches) draw(0);
  else start();

  return cleanup;
}

function mountAuthParticleField(screen) {
  if (!screen) return () => {};
  const canvas = document.createElement('canvas');
  canvas.className = 'auth-particles';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = AUTH_CANVAS_STYLE;
  screen.insertBefore(canvas, screen.firstChild);
  const card = screen.querySelector('.auth-wrap');
  if (card) {
    card.style.position = 'relative';
    card.style.zIndex = '1';
  }
  const cleanup = attachAuthParticleField(canvas, screen);
  return () => {
    cleanup();
    if (card) {
      card.style.removeProperty('position');
      card.style.removeProperty('z-index');
    }
  };
}

// ---------- View 1: Game Library ----------

function findActiveDownloadForGame(gameId) {
  return state.downloads.find(
    (d) => d.kind === 'game' && d.game_id === gameId
      && (d.stage === 'downloading' || d.stage === 'paused' || d.stage === 'verifying' || d.stage === 'queued'),
  ) || null;
}

function ensureLibraryShell() {
  const profileId = state.activeProfile?.id || '';
  if (libViewShell && libViewShell.dataset.profileId === profileId) {
    return libViewShell;
  }
  cardDomCache.clear();
  const root = document.createElement('div');
  root.className = 'lib-view-root';
  root.dataset.profileId = profileId;
  root.innerHTML = `
    <div class="lib-header">
      <h1 class="page-title">Game library</h1>
      <div class="lib-header-controls">
        <div class="search-wrap">
          <span class="search-icon">${icon('search', 15)}</span>
          <input type="text" class="input search-input" id="lib-search" placeholder="Filter by name or uploader…" value="${esc(state.searchQuery)}" aria-label="Filter games" />
          <button type="button" class="search-clear" id="lib-search-clear" aria-label="Clear filter" ${state.searchQuery ? '' : 'hidden'}>${icon('x', 14)}</button>
        </div>

        <div class="lib-right-controls">
          <span class="lib-count faint small num" id="lib-count"></span>
          <div class="segmented" role="tablist" aria-label="Filter by install status">
            <button type="button" role="tab" class="${state.filterMode === 'all' ? 'active' : ''}" data-filter="all">All</button>
            <button type="button" role="tab" class="${state.filterMode === 'installed' ? 'active' : ''}" data-filter="installed">Installed</button>
          </div>

          <div id="lib-sort-host"></div>
        </div>
      </div>
    </div>
    <div id="lib-grid-host"></div>
  `;

  const searchInput = root.querySelector('#lib-search');
  const clearBtn = root.querySelector('#lib-search-clear');

  libSortControl = createCssSelect({
    ariaLabel: 'Sort games',
    value: state.sortBy,
    options: [
      { value: 'recent', label: 'Recently played' },
      { value: 'newest', label: 'Newest first' },
      { value: 'name', label: 'Name A–Z' },
      { value: 'size', label: 'Largest first' },
    ],
    onChange: (v) => {
      state.sortBy = v;
      renderLibraryGrid();
    },
  });
  root.querySelector('#lib-sort-host').appendChild(libSortControl.element);

  searchInput.addEventListener('input', () => {
    state.searchQuery = searchInput.value;
    clearBtn.hidden = !state.searchQuery.trim();
    renderLibraryGrid();
  });

  clearBtn.addEventListener('click', () => {
    state.searchQuery = '';
    searchInput.value = '';
    clearBtn.hidden = true;
    renderLibraryGrid();
    searchInput.focus();
  });

  root.querySelectorAll('[data-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.filterMode = btn.dataset.filter;
      root.querySelectorAll('[data-filter]').forEach((b) =>
        b.classList.toggle('active', b.dataset.filter === state.filterMode),
      );
      renderLibraryGrid();
    });
  });

  libViewShell = root;
  return root;
}

function renderLibraryView() {
  syncFabVisibility();
  // First-run experience mirrors OpenSync Web's clean #/login card directly
  if (!state.activeProfile) {
    libViewShell = null;
    cardDomCache.clear();
    teardownAuthParticles();
    viewEl.innerHTML = `
      <div class="auth-screen" id="view-auth" style="${AUTH_SCREEN_STYLE}">
        <div class="auth-wrap panel">
          <img class="auth-logo" src="img/opensync-auth-2x.png" srcset="img/opensync-auth-1x.png 1x, img/opensync-auth-2x.png 2x, img/opensync-auth-3x.png 3x" width="146" alt="OpenSync" />
          <p class="auth-tagline">LAN game archive and save sync</p>
          <div id="first-run-connect-host"></div>
        </div>
      </div>
    `;
    stopAuthParticleField = mountAuthParticleField(document.getElementById('view-auth'));
    mountConnectForm(document.getElementById('first-run-connect-host'), {
      fullWidthSubmit: true,
      onSuccess: async () => {
        await refreshAll();
        navigate('library');
      },
    });
    return;
  }

  prepareHeroBg();
  const shell = ensureLibraryShell();
  if (viewEl.firstElementChild !== shell) {
    viewEl.replaceChildren(shell);
  }

  const searchInput = shell.querySelector('#lib-search');
  const clearBtn = shell.querySelector('#lib-search-clear');
  if (searchInput && searchInput.value !== state.searchQuery) {
    searchInput.value = state.searchQuery;
  }
  if (clearBtn) {
    clearBtn.hidden = !state.searchQuery.trim();
  }
  shell.querySelectorAll('[data-filter]').forEach((b) =>
    b.classList.toggle('active', b.dataset.filter === state.filterMode),
  );
  libSortControl?.set(state.sortBy);

  renderLibraryGrid();
}

function renderLibraryGrid() {
  const host = document.getElementById('lib-grid-host');
  const countEl = document.getElementById('lib-count');
  if (!host) return;

  let items = [...state.library];
  if (state.filterMode === 'installed') {
    items = items.filter((g) => g.installed);
  }
  const q = state.searchQuery.trim().toLowerCase();
  if (q) {
    items = items.filter((g) => {
      const hay = `${g.name} ${g.uploader_name || ''} ${g.description || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }

  items.sort((a, b) => {
    if (state.sortBy === 'name') return a.name.localeCompare(b.name);
    if (state.sortBy === 'size') return (b.total_size || 0) - (a.total_size || 0);
    if (state.sortBy === 'newest') return String(b.created_at || '').localeCompare(String(a.created_at || ''));
    const aPlay = a.playtime?.last_played_at || '';
    const bPlay = b.playtime?.last_played_at || '';
    if (aPlay !== bPlay) return bPlay.localeCompare(aPlay);
    if (a.installed !== b.installed) return a.installed ? -1 : 1;
    return String(b.created_at || '').localeCompare(String(a.created_at || ''));
  });

  if (countEl) {
    if (q || state.filterMode === 'installed') {
      countEl.textContent = `${items.length} of ${state.library.length} games`;
    } else {
      countEl.textContent = `${state.library.length} ${state.library.length === 1 ? 'game' : 'games'}`;
    }
  }

  if (!items.length) {
    fadeOutHero();
    host.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">${icon('search', 20)}</div>
        <h3>${state.library.length ? 'No matching games' : 'No games on this server yet'}</h3>
        <p>${q ? `Nothing matched "${esc(state.searchQuery.trim())}".` : state.filterMode === 'installed' ? 'No installed games yet. Switch to All to download games from your server.' : 'Upload games in OpenSync Web to see them ready to install here.'}</p>
        ${q || state.filterMode === 'installed' ? '<button type="button" class="btn btn-sm" id="btn-reset-lib-filter">Show all games</button>' : ''}
      </div>
    `;
    document.getElementById('btn-reset-lib-filter')?.addEventListener('click', () => {
      state.searchQuery = '';
      state.filterMode = 'all';
      renderLibraryView();
    });
    return;
  }

  let grid = host.firstElementChild?.classList?.contains('game-grid')
    ? host.firstElementChild
    : null;
  if (!grid) {
    grid = document.createElement('div');
    grid.className = 'game-grid';
  }

  const nextCards = [];
  const sigParts = [];

  for (const g of items) {
    const isPlaying = state.playingGameIds.has(g.game_id);
    const isSyncing = state.syncingGameIds.has(g.game_id);
    const dl = findActiveDownloadForGame(g.game_id);
    const dlPct = dl && dl.total_bytes > 0
      ? Math.min(100, Math.round((dl.bytes_downloaded / dl.total_bytes) * 100))
      : 0;
    const coverUrl = state.coverCache.get(g.game_id);
    const sig = [
      g.game_id,
      g.name,
      g.total_size,
      g.download_count,
      g.uploader_name || '',
      g.installed ? 1 : 0,
      g.has_overlay ? 1 : 0,
      g.pending_sync ? 1 : 0,
      g.last_synced_at || '',
      g.playtime?.total_secs || 0,
      g.playtime?.session_count || 0,
      g.playtime?.last_played_at || '',
      isPlaying ? 1 : 0,
      isSyncing ? 1 : 0,
      dl ? `${dl.stage}:${dlPct}:${dl.paused ? 1 : 0}` : '',
      coverUrl ? 1 : 0,
    ].join('|');
    sigParts.push(sig);

    const cached = cardDomCache.get(g.game_id);
    if (cached && cached.sig === sig) {
      cached.card.classList.remove('gp-focused');
      cached.card.style.removeProperty('--rx');
      cached.card.style.removeProperty('--ry');
      cached.card.style.removeProperty('--gx');
      cached.card.style.removeProperty('--gy');
      cached.card.dispatchEvent(new Event('card-reset'));
      nextCards.push(cached.card);
      continue;
    }

    let coverHtml;
    if (coverUrl) {
      coverHtml = `<img class="card-cover-img" src="${esc(coverUrl)}" alt="${esc(g.name)}" loading="lazy" decoding="async" />`;
    } else {
      coverHtml = `
        <div class="card-cover-placeholder" data-cover-game="${g.game_id}" data-cover-class="card-cover-img" aria-hidden="true">
          <span class="card-cover-monogram">${esc(monogram(g.name))}</span>
        </div>
      `;
      if (g.has_cover) ensureCover(g);
    }

    let topPillHtml = '';
    if (isPlaying) {
      topPillHtml = `<span class="card-top-pill playing"><span class="status-dot connected"></span>Playing</span>`;
    } else if (isSyncing) {
      topPillHtml = `<span class="card-top-pill syncing">${icon('refresh-cw', 12, 'spin')}Syncing saves</span>`;
    }

    let primaryAction = 'download';
    let centerBtnHtml = '';
    if (isPlaying) {
      primaryAction = 'playing';
      centerBtnHtml = `
        <button type="button" class="card-center-btn is-playing" data-card-action="playing" aria-label="Playing ${esc(g.name)}" title="Playing ${esc(g.name)}" tabindex="-1">
          ${icon('play', 22)}
        </button>
      `;
    } else if (dl) {
      primaryAction = 'downloads';
      centerBtnHtml = `
        <button type="button" class="card-center-btn" data-card-action="downloads" aria-label="View download for ${esc(g.name)}" title="Open Download Manager" tabindex="-1">
          <span class="card-dl-pct">${dl.paused ? 'Paused' : `${dlPct}%`}</span>
        </button>
      `;
    } else if (g.installed) {
      primaryAction = 'play';
      centerBtnHtml = `
        <button type="button" class="card-center-btn play-btn" data-card-action="play" aria-label="Play ${esc(g.name)}" title="Play ${esc(g.name)}" tabindex="-1">
          ${icon('play', 23)}
        </button>
      `;
    } else {
      primaryAction = 'download';
      centerBtnHtml = `
        <button type="button" class="card-center-btn" data-card-action="download" aria-label="Download ${esc(g.name)}" title="Install ${esc(g.name)}" tabindex="-1">
          ${icon('arrow-down', 24)}
        </button>
      `;
    }

    const cardStats = buildCardStats(g, isPlaying);

    let syncDotHtml = '';
    if (g.installed) {
      if (g.pending_sync) {
        syncDotHtml = `<span class="card-sync-indicator" title="Saves waiting to sync"><span class="sync-dot pending"></span><span class="card-sync-label">Pending sync</span></span>`;
      } else if (g.last_synced_at || g.has_overlay) {
        syncDotHtml = `<span class="card-sync-indicator" title="Saves synced"><span class="sync-dot synced"></span><span class="card-sync-label">Synced</span></span>`;
      } else {
        syncDotHtml = `<span class="card-sync-indicator" title="Installed"><span class="sync-dot synced"></span><span class="card-sync-label">Installed</span></span>`;
      }
    } else if (g.has_overlay) {
      syncDotHtml = `<span class="card-sync-indicator" title="Cloud saves available"><span class="sync-dot synced"></span><span class="card-sync-label">Cloud save</span></span>`;
    }

    const card = document.createElement('article');
    card.className = `card steam-card${isPlaying ? ' is-playing' : ''}${dl ? ' is-downloading' : ''}`;
    card.tabIndex = 0;
    card.dataset.gameId = String(g.game_id);
    card.dataset.primaryAction = primaryAction;
    card.setAttribute('aria-label', `${g.name}, ${primaryAction === 'play' ? 'installed' : 'available to install'}`);
    card.innerHTML = `
      ${coverHtml}
      <div class="card-glass-sheen" aria-hidden="true"></div>
      ${topPillHtml}
      ${centerBtnHtml}
      <div class="card-glass-footer">
        <div class="card-glass-info">
          <span class="card-glass-title">${esc(g.name)}</span>
          <div class="card-glass-meta">
            <span class="card-stat-ticker"><span class="card-stat-item">${esc(cardStats[0])}</span></span>
            ${syncDotHtml}
          </div>
        </div>
      </div>
    `;

    card.addEventListener('click', () => {
      navigate('game-detail', { gameId: g.game_id });
    });

    const actionBtn = card.querySelector('[data-card-action]');
    actionBtn?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const latestGame = state.library.find((x) => x.game_id === g.game_id) || g;
      await runCardPrimaryAction(latestGame);
    });

    const activateHero = () => {
      const latestGame = state.library.find((x) => x.game_id === g.game_id) || g;
      showLibraryHoverHero(latestGame);
    };
    const deactivateHero = () => scheduleClearHero(g.game_id, 95);
    card.addEventListener('pointerenter', activateHero);
    card.addEventListener('pointerleave', deactivateHero);
    card.addEventListener('focusin', activateHero);
    card.addEventListener('focusout', (e) => {
      if (!card.contains(e.relatedTarget)) deactivateHero();
    });

    attachSteamTilt(card);
    attachStatTicker(card, cardStats, 1500, 450);
    cardDomCache.set(g.game_id, { sig, card });
    nextCards.push(card);
  }

  if (heroHoverGameId != null && !items.some((g) => g.game_id === heroHoverGameId)) {
    fadeOutHero();
  }
  const gridSig = sigParts.join('||');
  if (grid.parentElement === host && grid.dataset.gridSig === gridSig) {
    return;
  }
  grid.dataset.gridSig = gridSig;
  grid.replaceChildren(...nextCards);
  if (grid.parentElement !== host) {
    host.replaceChildren(grid);
  }
}

async function runCardPrimaryAction(g) {
  if (!g) return;
  const isPlaying = state.playingGameIds.has(g.game_id);
  const dl = findActiveDownloadForGame(g.game_id);
  if (isPlaying) {
    navigate('game-detail', { gameId: g.game_id });
  } else if (dl) {
    navigate('downloads');
  } else if (g.installed) {
    await handleLaunchGame(g);
  } else if (g.has_overlay) {
    openDownloadChoiceModal(g);
  } else {
    await handleStartDownload(g, false);
  }
}

// ---------- View 2: Game Detail ----------

function renderGameDetailView() {
  const active = state.activeProfile;
  const g = state.library.find((x) => x.game_id === state.selectedGameId);
  if (!g) {
    navigate('library');
    return;
  }

  const isPlaying = state.playingGameIds.has(g.game_id);
  const isSyncing = state.syncingGameIds.has(g.game_id);
  const isUninstalling = state.uninstallingGameIds.has(g.game_id);
  const dl = findActiveDownloadForGame(g.game_id);
  const dlPct = dl && dl.total_bytes > 0
    ? Math.min(100, Math.round((dl.bytes_downloaded / dl.total_bytes) * 100))
    : 0;

  const coverUrl = state.coverCache.get(g.game_id);
  if (!coverUrl && g.has_cover) ensureCover(g);
  syncDetailHero(g);

  const coverInner = coverUrl
    ? `<img src="${esc(coverUrl)}" alt="${esc(g.name)}" decoding="async" /><span class="cover-zoom-hint">Expand</span>`
    : `<div class="card-cover-placeholder" data-cover-game="${g.game_id}" data-cover-class=""><span class="card-cover-monogram">${esc(monogram(g.name))}</span></div>`;

  const isWindows = g.binary_kind === 'WindowsPe';
  const isWindowsHost = /Win/i.test(navigator.platform || navigator.userAgent || '');
  const needsProton = isWindows && !isWindowsHost && state.protonInstallations.length === 0;

  let primaryBtnHtml;
  if (isPlaying) {
    primaryBtnHtml = `<button type="button" class="btn btn-playing" disabled>${icon('play', 16)}<span>Playing</span></button>`;
  } else if (dl) {
    primaryBtnHtml = `<button type="button" class="btn btn-primary" id="btn-detail-open-dl">${icon('arrow-down', 16)}<span>${dl.paused ? 'Download paused' : `Downloading ${dlPct}%`}</span></button>`;
  } else if (g.installed) {
    primaryBtnHtml = `<button type="button" class="btn btn-primary" id="btn-detail-play" ${isUninstalling ? 'disabled' : ''}>${icon('play', 16)}<span>Play</span></button>`;
  } else if (g.has_overlay) {
    primaryBtnHtml = `<button type="button" class="btn btn-primary" id="btn-detail-install" title="Download the game with your synced cloud save overlay">${icon('arrow-down', 16)}<span>Download with saves</span></button>`;
  } else {
    primaryBtnHtml = `<button type="button" class="btn btn-primary" id="btn-detail-install">${icon('arrow-down', 16)}<span>Install (${esc(humanBytes(g.total_size))})</span></button>`;
  }

  const secondaryBtns = [];
  if (g.installed) {
    secondaryBtns.push(`
      <button type="button" class="btn" id="btn-detail-sync" ${isSyncing || isPlaying || isUninstalling ? 'disabled' : ''}>
        ${icon('refresh-cw', 15, isSyncing ? 'spin' : '')}
        <span>${isSyncing ? 'Syncing saves…' : 'Sync save'}</span>
      </button>
    `);
    secondaryBtns.push(`
      <button type="button" class="btn btn-danger" id="btn-detail-uninstall" ${isPlaying || isUninstalling ? 'disabled' : ''}>
        ${isUninstalling ? icon('refresh-cw', 15, 'spin') : icon('trash-2', 15)}
        <span>${isUninstalling ? 'Uninstalling…' : 'Uninstall'}</span>
      </button>
    `);
  } else if (!dl && g.has_overlay) {
    secondaryBtns.push(`
      <button type="button" class="btn" id="btn-detail-fresh" title="Download a pristine archive without your account saves">
        ${icon('hard-drive', 15)}
        <span>Download clean</span>
      </button>
    `);
  }

  const protonOptions = [
    { value: '', label: isWindows ? (state.protonInstallations[0] ? `Auto (${state.protonInstallations[0].name})` : 'Auto (Proton required)') : 'Native Linux (default)' },
    ...state.protonInstallations.map((p) => ({ value: p.name, label: `${p.name} (${protonSourceLabel(p.source)})` })),
  ];

  const exeOptions = (g.discovered_executables || []).length
    ? g.discovered_executables.map((ex) => ({
        value: ex.rel_path,
        label: `${ex.rel_path} (${ex.kind === 'WindowsPe' ? 'Windows PE' : ex.kind === 'LinuxElf' ? 'Linux ELF' : 'Script'})`,
      }))
    : [{ value: '', label: g.installed ? (g.executable_rel_path || 'Auto-detect on launch') : 'Available after installation' }];

  const req = parseSystemRequirements(g.system_requirements);
  const reqHtml = req.pairs.length
    ? `<dl class="req-list">${req.pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>${req.notes.length ? `<p class="small muted" style="margin-top:10px;">${esc(req.notes.join(' '))}</p>` : ''}`
    : `<p class="muted">${esc(g.system_requirements || 'No system requirements listed.')}</p>`;

  const syncBadge = g.installed
    ? g.pending_sync
      ? `<span class="badge badge-warn">Pending save sync</span>`
      : g.last_synced_at
        ? `<span class="badge badge-accent">Synced ${esc(humanRelativeDate(g.last_synced_at))}</span>`
        : `<span class="badge badge-accent">Installed</span>`
    : g.has_overlay
      ? `<span class="badge badge-info">Cloud save available</span>`
      : `<span class="badge">Archive ready</span>`;

  const runtimeBadge = isWindows
    ? `<span class="badge">${icon('cpu', 12)}${isWindowsHost ? 'Native Windows' : 'Windows via Proton'}</span>`
    : `<span class="badge">${icon('cpu', 12)}Native Linux</span>`;

  viewEl.innerHTML = `
    <div class="detail-back">
      <button type="button" class="btn btn-ghost btn-sm" id="btn-back-library">${icon('arrow-left', 15)}<span>Back to library</span></button>
    </div>

    <div class="game-detail-header">
      <div class="game-cover-lg" id="detail-cover-box" title="Click to view full cover">
        ${coverInner}
      </div>

      <div class="game-detail-main">
        <h1 class="game-detail-title">${esc(g.name)}</h1>
        <div class="game-detail-badges">
          ${syncBadge}
          ${runtimeBadge}
          <span class="badge">${icon('hard-drive', 12)}${esc(humanBytes(g.total_size))}</span>
          ${g.uploader_name ? `<span class="badge uploader-badge">${pfpSlotHtml(active?.id, g.uploaded_by, g.uploader_pfp, 'uploader-avatar', g.uploader_name)}<span>@${esc(g.uploader_name)}</span></span>` : ''}
        </div>

        <div class="game-detail-actions">
          ${primaryBtnHtml}
          ${secondaryBtns.join('')}
        </div>

        <div class="kpi-strip">
          <div class="kpi-card">
            <div class="kpi-label">Total played</div>
            <div class="kpi-value">${esc(humanPlaytime(g.playtime?.total_secs || 0))}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Sessions</div>
            <div class="kpi-value">${esc(String(g.playtime?.session_count || 0))}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Last played</div>
            <div class="kpi-value neutral">${esc(humanRelativeDate(g.playtime?.last_played_at))}</div>
          </div>
        </div>
      </div>
    </div>

    <div class="detail-grid-2">
      <section class="panel">
        <h2>Runtime and launch</h2>
        ${needsProton ? `
          <div class="proton-alert-box">
            <div class="proton-alert-text">
              <strong>Proton required</strong><br/>
              <span class="small muted">This Windows game needs a Proton compatibility runtime to run on Linux.</span>
            </div>
            <button type="button" class="btn btn-primary btn-sm" id="btn-detail-install-proton">${icon('arrow-down', 14)}<span>Install GE-Proton</span></button>
          </div>
        ` : ''}
        <div class="field">
          <label>Compatibility runtime</label>
          <div id="detail-proton-host"></div>
        </div>
        <div class="field">
          <label>Launch executable</label>
          <div id="detail-exe-host"></div>
        </div>
        <div class="field">
          <label>Wine prefix</label>
          <div class="launch-path-row">
            <input class="input" id="detail-prefix-input" type="text" spellcheck="false"
              value="${esc(g.wine_prefix || '')}"
              placeholder="Automatic (per-game prefix)" aria-label="Wine prefix directory" />
            <button type="button" class="btn" id="btn-detail-browse-prefix" title="Choose a prefix folder">${icon('folder', 14)}<span>Browse</span></button>
          </div>
          <span class="small faint">Leave blank to use the automatic per-game prefix.</span>
        </div>
        <div class="field">
          <label>Game arguments</label>
          <input class="input" id="detail-args-input" type="text" spellcheck="false"
            value="${esc(g.launch_args || '')}"
            placeholder="-windowed --save-dir=&quot;my saves&quot;" aria-label="Game launch arguments" />
          <span class="small faint">Quotes keep spaces together in a single argument.</span>
        </div>
        <div class="field">
          <label>Environment variables</label>
          <div class="env-var-list" id="detail-env-rows"></div>
          <button type="button" class="btn btn-ghost btn-sm env-var-add" id="btn-detail-add-env">${icon('plus', 14)}<span>Add variable</span></button>
        </div>
        <div class="launch-actions-row">
          <button type="button" class="btn btn-primary btn-sm" id="btn-detail-save-launch">${icon('check', 14)}<span>Save launch options</span></button>
          <button type="button" class="btn btn-sm" id="btn-detail-show-logs">${icon('hard-drive', 14)}<span>Show logs</span></button>
        </div>
      </section>

      <section class="panel">
        <h2>System requirements</h2>
        ${reqHtml}
      </section>
    </div>

    <section class="panel">
      <h2>About</h2>
      <p>${esc(g.description || 'No description provided for this game yet.')}</p>
      ${g.install_dir ? `<p class="small muted" style="margin-top:12px;">Install folder: <code>${esc(g.install_dir)}</code></p>` : ''}
    </section>

    <section class="panel">
      <h2>Sync and launch activity</h2>
      ${(() => {
        const gameLogs = state.activityLogs.filter((l) => l.game_id === g.game_id).slice(0, 8);
        if (!gameLogs.length) {
          return '<p class="small muted">No launch or save sync events recorded for this game yet. Saves auto-sync every time the game closes.</p>';
        }
        return `<div class="activity-list" style="max-height:240px;padding:0;">${gameLogs.map(renderActivityItemHtml).join('')}</div>`;
      })()}
    </section>
  `;

  document.getElementById('btn-back-library')?.addEventListener('click', () => navigate('library'));

  document.getElementById('detail-cover-box')?.addEventListener('click', () => {
    const src = state.coverCache.get(g.game_id);
    if (src) openLightbox(src, g.name);
  });

  document.getElementById('btn-detail-play')?.addEventListener('click', () => handleLaunchGame(g));
  document.getElementById('btn-detail-install')?.addEventListener('click', () => handleStartDownload(g, false));
  document.getElementById('btn-detail-fresh')?.addEventListener('click', () => handleStartDownload(g, true));
  document.getElementById('btn-detail-open-dl')?.addEventListener('click', () => navigate('downloads'));

  document.getElementById('btn-detail-sync')?.addEventListener('click', async () => {
    await handleManualSync(g, false);
  });

  document.getElementById('btn-detail-uninstall')?.addEventListener('click', () => {
    openConfirmModal({
      title: `Uninstall ${g.name}`,
      body: 'This removes the local game files from your games directory. Any save changes are synced to the cloud first, and reinstalling restores the game and its saves to the same folder.',
      confirmLabel: 'Uninstall game',
      danger: true,
      onConfirm: async () => {
        if (state.uninstallingGameIds.has(g.game_id)) return;
        state.uninstallingGameIds.add(g.game_id);
        if (state.view === 'game-detail' && state.selectedGameId === g.game_id) {
          const btn = document.getElementById('btn-detail-uninstall');
          const playBtn = document.getElementById('btn-detail-play');
          const syncBtn = document.getElementById('btn-detail-sync');
          if (btn) {
            btn.disabled = true;
            btn.innerHTML = `${icon('refresh-cw', 15, 'spin')}<span>Uninstalling…</span>`;
          }
          if (playBtn) playBtn.disabled = true;
          if (syncBtn) syncBtn.disabled = true;
        }
        try {
          await bridge.uninstallGame(g.game_id);
          cardDomCache.delete(g.game_id);
          await refreshLibrary();
          showToast(`Uninstalled ${g.name} · saves synced to cloud`, 'accent', 'trash-2');
        } catch (err) {
          showToast(String(err?.message || err), 'danger', 'alert-triangle');
        } finally {
          state.uninstallingGameIds.delete(g.game_id);
          renderCurrentView();
        }
      },
    });
  });

  document.getElementById('btn-detail-install-proton')?.addEventListener('click', async () => {
    await quickInstallLatestGeProton();
  });

  const protonSelect = createCssSelect({
    ariaLabel: 'Compatibility runtime',
    value: g.proton_override || '',
    options: protonOptions,
    disabled: !g.installed,
    onChange: async (val) => {
      const next = val || null;
      try {
        await bridge.setGameProton(g.game_id, next);
        g.proton_override = next;
        showToast(next ? `Runtime set to ${next}` : 'Runtime reset to automatic', 'accent', 'cpu');
      } catch (err) {
        showToast(String(err?.message || err), 'danger', 'alert-triangle');
      }
    },
  });
  document.getElementById('detail-proton-host')?.appendChild(protonSelect.element);

  const exeSelect = createCssSelect({
    ariaLabel: 'Launch executable',
    value: g.executable_rel_path || '',
    options: exeOptions,
    disabled: !g.installed || !(g.discovered_executables || []).length,
    onChange: async (val) => {
      const next = val || null;
      try {
        await bridge.setGameExecutable(g.game_id, next);
        g.executable_rel_path = next;
        showToast('Launch executable updated', 'accent', 'check');
      } catch (err) {
        showToast(String(err?.message || err), 'danger', 'alert-triangle');
      }
    },
  });
  document.getElementById('detail-exe-host')?.appendChild(exeSelect.element);

  const envRowsHost = document.getElementById('detail-env-rows');
  const appendEnvVarRow = (entry = { key: '', value: '' }) => {
    if (!envRowsHost) return null;
    const row = document.createElement('div');
    row.className = 'env-var-row';
    row.innerHTML = `
      <input class="input env-var-key" type="text" spellcheck="false" aria-label="Variable name"
        placeholder="KEY" value="${esc(entry.key)}" />
      <input class="input env-var-value" type="text" spellcheck="false" aria-label="Variable value"
        placeholder="value" value="${esc(entry.value)}" />
      <button type="button" class="btn btn-ghost btn-icon env-var-remove" aria-label="Remove variable" title="Remove variable">${icon('x', 14)}</button>
    `;
    row.querySelector('.env-var-remove')?.addEventListener('click', () => row.remove());
    envRowsHost.appendChild(row);
    return row;
  };
  (g.env_vars || []).forEach((entry) => appendEnvVarRow(entry));

  document.getElementById('btn-detail-add-env')?.addEventListener('click', () => {
    const row = appendEnvVarRow();
    row?.querySelector('.env-var-key')?.focus();
  });

  document.getElementById('btn-detail-browse-prefix')?.addEventListener('click', async () => {
    try {
      const picked = await bridge.pickWinePrefixDir();
      if (picked) {
        const input = document.getElementById('detail-prefix-input');
        if (input) input.value = picked;
      }
    } catch (err) {
      showToast(String(err?.message || err), 'danger', 'alert-triangle');
    }
  });

  document.getElementById('btn-detail-save-launch')?.addEventListener('click', async () => {
    const prefixInput = document.getElementById('detail-prefix-input');
    const argsInput = document.getElementById('detail-args-input');
    const envVars = Array.from(envRowsHost?.querySelectorAll('.env-var-row') || [])
      .map((row) => ({
        key: row.querySelector('.env-var-key')?.value || '',
        value: row.querySelector('.env-var-value')?.value || '',
      }))
      .filter((v) => v.key.trim() || v.value.trim());
    const invalid = envVars.find(
      (v) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.key.trim()),
    );
    if (invalid) {
      showToast(
        'Environment variable names must use A-Z, 0-9 and _, and cannot start with a digit',
        'danger',
        'alert-triangle',
      );
      return;
    }
    const prefix = prefixInput?.value || '';
    const args = argsInput?.value || '';
    try {
      await bridge.setGameLaunchConfig(g.game_id, {
        wine_prefix: prefix,
        launch_args: args,
        env_vars: envVars,
      });
      g.wine_prefix = prefix.trim() || null;
      g.launch_args = args.trim() || null;
      g.env_vars = envVars;
      showToast('Launch options saved', 'accent', 'check');
    } catch (err) {
      showToast(String(err?.message || err), 'danger', 'alert-triangle');
    }
  });

  document.getElementById('btn-detail-show-logs')?.addEventListener('click', () => {
    openGameLogsModal(g);
  });
}

// ---------- View 3: Download Manager (60fps Waveform) ----------

const BW_PRESETS = [
  { label: 'Unlimited', bps: 0 },
  { label: '100 MB/s', bps: 100 * 1024 * 1024 },
  { label: '50 MB/s', bps: 50 * 1024 * 1024 },
  { label: '25 MB/s', bps: 25 * 1024 * 1024 },
  { label: '10 MB/s', bps: 10 * 1024 * 1024 },
];

function renderDownloadsView() {
  destroyWaveforms();

  viewEl.innerHTML = `
    <div class="page-header-row">
      <h1 class="page-title">Downloads</h1>
      <div class="bw-control">
        <label>Bandwidth limit</label>
        <div id="dl-bw-host"></div>
      </div>
    </div>
    <div id="dl-list-host"></div>
  `;

  document.getElementById('dl-bw-host')?.appendChild(
    createCssSelect({
      ariaLabel: 'Bandwidth limit',
      value: String(state.bandwidthLimitBps),
      options: BW_PRESETS.map((p) => ({ value: String(p.bps), label: p.label })),
      onChange: async (value) => {
        const bps = Number(value || 0);
        state.bandwidthLimitBps = bps;
        try {
          await bridge.setBandwidthLimit(bps);
          const match = BW_PRESETS.find((p) => p.bps === bps);
          showToast(`Bandwidth cap set to ${match ? match.label : humanSpeed(bps)}`, 'accent', 'settings');
        } catch (err) {
          showToast(String(err?.message || err), 'danger', 'alert-triangle');
        }
      },
    }).element,
  );

  syncDownloadsListDom();
}

function stageBadgeHtml(job) {
  switch (job.stage) {
    case 'downloading':
      return `<span class="badge badge-accent">Downloading</span>`;
    case 'paused':
      return `<span class="badge badge-warn">Paused</span>`;
    case 'verifying':
      return `<span class="badge badge-info">${icon('shield-check', 12)}Verifying</span>`;
    case 'completed':
      return `<span class="badge badge-accent">${icon('check', 12)}Ready</span>`;
    case 'failed':
      return `<span class="badge badge-danger">Failed</span>`;
    default:
      return `<span class="badge">Queued</span>`;
  }
}

function buildDownloadCard(job) {
  const card = document.createElement('section');
  card.className = 'dl-card';
  card.dataset.jobId = job.job_id;
  card.innerHTML = `
    <div class="dl-card-top">
      <div class="dl-title-group">
        <div class="dl-title-row">
          <span class="dl-title">${esc(job.title)}</span>
          <span class="badge">${job.kind === 'ge_proton' ? 'GE-Proton' : 'Game'}</span>
          <span data-dl-stage></span>
        </div>
        <div class="dl-subtitle" data-dl-subtitle>${esc(job.subtitle || '')}</div>
      </div>

      <div class="dl-metrics-actions">
        <div class="dl-speed-block">
          <div class="dl-speed-val" data-dl-speed></div>
          <div class="dl-eta-val" data-dl-eta></div>
        </div>
        <div class="dl-controls" data-dl-controls></div>
      </div>
    </div>

    <div class="dl-waveform-box">
      <canvas class="dl-waveform-canvas"></canvas>
    </div>

    <div class="dl-progress-track">
      <div class="dl-progress-fill" data-dl-bar></div>
    </div>

    <div class="dl-footer-row">
      <span class="dl-current-file" data-dl-file></span>
      <span data-dl-bytes></span>
    </div>
  `;

  const canvas = card.querySelector('.dl-waveform-canvas');
  const wf = new WaveformCanvas(canvas, job.speed_samples || [], job.paused || job.stage === 'paused');
  activeWaveforms.set(job.job_id, wf);

  patchDownloadCard(card, job);
  return card;
}

function patchDownloadCard(card, job) {
  const isPaused = job.paused || job.stage === 'paused';
  const isVerifying = job.stage === 'verifying';
  const isCompleted = job.stage === 'completed';
  const isMoving = job.stage === 'downloading' && !isPaused && Number(job.bytes_per_sec || 0) > 0;
  const pct = job.total_bytes > 0
    ? Math.min(100, (Number(job.bytes_downloaded || 0) / Number(job.total_bytes)) * 100)
    : (isCompleted ? 100 : 0);

  card.classList.toggle('is-active', job.stage === 'downloading' && !isPaused);
  card.classList.toggle('is-paused', isPaused);

  const stageEl = card.querySelector('[data-dl-stage]');
  if (stageEl) stageEl.innerHTML = stageBadgeHtml(job);

  const speedEl = card.querySelector('[data-dl-speed]');
  if (speedEl) {
    speedEl.textContent = isPaused
      ? 'Paused'
      : isVerifying
        ? 'Verifying'
        : isCompleted
          ? 'Completed'
          : humanSpeed(job.bytes_per_sec);
  }

  const etaEl = card.querySelector('[data-dl-eta]');
  if (etaEl) {
    etaEl.textContent = isPaused
      ? 'Transfer paused'
      : isVerifying
        ? 'Checking hashes'
        : isCompleted
          ? `${pct.toFixed(0)}% verified`
          : humanEta(job.eta_secs);
  }

  const bar = card.querySelector('[data-dl-bar]');
  if (bar) {
    bar.style.width = `${pct.toFixed(2)}%`;
    bar.dataset.moving = String(isMoving);
    bar.dataset.paused = String(isPaused);
    bar.dataset.verifying = String(isVerifying);
  }

  const fileEl = card.querySelector('[data-dl-file]');
  if (fileEl) {
    fileEl.textContent = job.error
      ? `Error: ${job.error}`
      : job.current_file
        ? `Extracting ${job.current_file}`
        : isCompleted
          ? (job.kind === 'ge_proton' ? 'Installed and verified with SHA-512' : 'Verified and ready to play')
          : 'Waiting for stream…';
  }

  const bytesEl = card.querySelector('[data-dl-bytes]');
  if (bytesEl) {
    const fileCounter = job.total_files > 1 ? `  ${job.files_extracted} of ${job.total_files} files` : '';
    bytesEl.textContent = `${humanBytes(job.bytes_downloaded)} of ${humanBytes(job.total_bytes)} (${pct.toFixed(0)}%)${fileCounter}`;
  }

  const ctrlEl = card.querySelector('[data-dl-controls]');
  if (ctrlEl) {
    const ctrlMode = isCompleted ? 'completed' : isPaused ? 'paused' : isVerifying ? 'verifying' : 'active';
    if (ctrlEl.dataset.ctrlMode !== ctrlMode) {
      ctrlEl.dataset.ctrlMode = ctrlMode;
      if (isCompleted && job.kind === 'game' && job.game_id != null) {
        ctrlEl.innerHTML = `<button type="button" class="btn btn-primary btn-sm" data-dl-play="${job.game_id}">${icon('play', 14)}<span>Play</span></button>`;
        ctrlEl.querySelector('[data-dl-play]')?.addEventListener('click', async () => {
          const g = state.library.find((x) => x.game_id === job.game_id);
          if (g) await handleLaunchGame(g);
        });
      } else if (isCompleted) {
        ctrlEl.innerHTML = `<button type="button" class="btn btn-sm" data-dl-proton>${icon('cpu', 14)}<span>Open Proton</span></button>`;
        ctrlEl.querySelector('[data-dl-proton]')?.addEventListener('click', () => navigate('settings'));
      } else if (isVerifying) {
        ctrlEl.innerHTML = `<button type="button" class="btn btn-sm" disabled>${icon('shield-check', 14)}<span>Verifying</span></button>`;
      } else if (isPaused) {
        ctrlEl.innerHTML = `
          <button type="button" class="btn btn-primary btn-sm" data-dl-resume title="Resume download">${icon('play', 14)}<span>Resume</span></button>
          <button type="button" class="btn btn-icon btn-danger" data-dl-cancel title="Cancel download" aria-label="Cancel download">${icon('x', 15)}</button>
        `;
        ctrlEl.querySelector('[data-dl-resume]')?.addEventListener('click', () => bridge.resumeDownload(job.job_id));
        ctrlEl.querySelector('[data-dl-cancel]')?.addEventListener('click', () => handleCancelDownload(job.job_id));
      } else {
        ctrlEl.innerHTML = `
          <button type="button" class="btn btn-sm" data-dl-pause title="Pause download">${icon('pause', 14)}<span>Pause</span></button>
          <button type="button" class="btn btn-icon btn-danger" data-dl-cancel title="Cancel download" aria-label="Cancel download">${icon('x', 15)}</button>
        `;
        ctrlEl.querySelector('[data-dl-pause]')?.addEventListener('click', () => bridge.pauseDownload(job.job_id));
        ctrlEl.querySelector('[data-dl-cancel]')?.addEventListener('click', () => handleCancelDownload(job.job_id));
      }
    }
  }

  const wf = activeWaveforms.get(job.job_id);
  if (wf) {
    wf.update(job.speed_samples || [], isPaused, isCompleted);
  }
}

function syncDownloadsListDom() {
  const host = document.getElementById('dl-list-host');
  if (!host) return;

  const visibleJobs = state.downloads.filter((d) => d.stage !== 'cancelled');
  if (!visibleJobs.length) {
    destroyWaveforms();
    host.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">${icon('arrow-down', 22)}</div>
        <h3>No active downloads</h3>
        <p>Install any game from your library or download GE-Proton to watch live wire-speed streaming extraction here.</p>
        <button type="button" class="btn btn-primary" id="btn-dl-to-lib">Browse library</button>
      </div>
    `;
    document.getElementById('btn-dl-to-lib')?.addEventListener('click', () => navigate('library'));
    return;
  }

  if (host.querySelector('.empty-state')) {
    host.innerHTML = '';
  }

  const keepIds = new Set(visibleJobs.map((j) => j.job_id));
  for (const card of [...host.querySelectorAll('.dl-card')]) {
    const jid = card.dataset.jobId;
    if (!keepIds.has(jid)) {
      activeWaveforms.get(jid)?.destroy();
      activeWaveforms.delete(jid);
      card.remove();
    }
  }

  for (const job of visibleJobs) {
    let card = host.querySelector(`.dl-card[data-job-id="${CSS.escape(job.job_id)}"]`);
    if (!card) {
      card = buildDownloadCard(job);
      host.appendChild(card);
    } else {
      patchDownloadCard(card, job);
    }
  }
}

// ---------- View 3b: Upload a game ----------

const UPLOAD_CHUNK_SIZE = 4 * 1024 * 1024;

function normalizeUploadJob(raw) {
  if (!raw) return null;
  const stage = String(raw.status?.state ?? raw.stage ?? 'queued').toLowerCase();
  const bps = Number(raw.bytes_per_sec || 0);
  const remaining = Math.max(0, Number(raw.total_bytes || 0) - Number(raw.bytes_uploaded || 0));
  return {
    job_id: raw.id || raw.job_id,
    name: raw.name || 'Upload',
    game_id: raw.game_id ?? null,
    stage,
    error: raw.status?.error ?? raw.error ?? null,
    bytes_uploaded: Number(raw.bytes_uploaded || 0),
    total_bytes: Number(raw.total_bytes || 0),
    files_uploaded: Number(raw.files_uploaded || 0),
    total_files: Number(raw.total_files || 0),
    current_file: raw.current_file || null,
    bytes_per_sec: bps,
    speed_samples: Array.isArray(raw.speed_samples) ? raw.speed_samples : [],
    eta_secs: stage === 'uploading' && bps > 0 ? Math.ceil(remaining / bps) : null,
  };
}

function activeUploads() {
  return state.uploads.filter(
    (j) => j.stage === 'queued' || j.stage === 'uploading' || j.stage === 'paused' || j.stage === 'indexing',
  );
}

function uploadPhaseLabel(job) {
  switch (job.stage) {
    case 'queued': return 'Queued';
    case 'uploading': return 'Uploading chunks';
    case 'indexing': return 'Indexing files';
    case 'paused': return 'Paused';
    case 'ready': return 'Ready';
    case 'cancelled': return 'Cancelled';
    case 'failed': return 'Failed';
    default: return job.stage;
  }
}

function defaultUploadForm() {
  return {
    name: '',
    description: '',
    requirements: { os: '', cpu: '', ram: '', gpu: '', storage: '' },
    folderPath: '',
    folderScan: null,
    files: [],
    coverDataUrl: '',
    coverBase64: '',
    coverContentType: '',
  };
}

// Crisp labels that mirror the web upload form: no tracked-out all-caps
// styling, with the common hardware acronyms kept as written there.
const REQUIREMENT_LABELS = { os: 'OS', cpu: 'CPU', ram: 'RAM', gpu: 'GPU', storage: 'Storage' };

function requirementLabel(key) {
  return REQUIREMENT_LABELS[key] || String(key || '').replace(/^./, (c) => c.toUpperCase());
}

function requirementsString(reqs) {
  return Object.entries(reqs || {})
    .filter(([, v]) => String(v || '').trim())
    .map(([k, v]) => `${requirementLabel(k)}: ${String(v).trim()}`)
    .join('\n');
}

function inferUploadName(pathOrFiles) {
  if (Array.isArray(pathOrFiles) && pathOrFiles.length) {
    const seg = String(pathOrFiles[0].webkitRelativePath || pathOrFiles[0].name || '').split('/')[0];
    return seg ? seg.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() : '';
  }
  const clean = String(pathOrFiles || '').trim().replace(/\/+$/, '');
  if (!clean) return '';
  return clean.split(/[\\/]/).pop().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function ensureUploadForm() {
  if (!state.uploadForm) state.uploadForm = defaultUploadForm();
  return state.uploadForm;
}

function renderUploadView() {
  const form = ensureUploadForm();
  const connected = Boolean(state.activeProfile);
  viewEl.innerHTML = `
    <div class="upload-page">
      <div class="page-header-row">
        <h1 class="page-title">Upload game</h1>
        <button type="button" class="btn btn-ghost btn-sm" id="up-back">${icon('arrow-left', 14)}<span>Library</span></button>
      </div>

      <section class="panel" id="up-form-panel">
        <div class="folder-dropzone${form.files.length || form.folderPath ? ' has-files' : ''}" id="up-folder-zone" role="button" tabindex="0">
          <div class="folder-dropzone-icon">${icon('folder', 22)}</div>
          <div class="folder-dropzone-title">${form.folderPath || form.files.length ? 'Game folder selected' : 'Drop a game folder here, or choose one'}</div>
          <div class="small muted" id="up-folder-summary">${
            form.folderPath
              ? (form.folderScan
                ? `${form.folderScan.file_count} files · ${esc(humanBytes(form.folderScan.total_bytes))}`
                : esc(form.folderPath))
              : 'Preserves folder structure with resumable 4 MB chunked uploads'
          }</div>
          <div class="upload-preview-list" id="up-preview-list" ${form.folderPath || form.files.length ? '' : 'hidden'}></div>
        </div>
        <div class="upload-path-row">
          <input type="text" class="input" id="up-folder-path" placeholder="/home/you/Games/MyGame" value="${esc(form.folderPath)}" spellcheck="false" aria-label="Game folder path" />
          <button type="button" class="btn btn-sm" id="up-folder-browse" ${connected ? '' : 'disabled'}>${icon('folder', 14)}<span>Choose folder</span></button>
          <button type="button" class="btn btn-sm btn-ghost" id="up-folder-browser" title="Browse using the WebView folder picker">${icon('layout-grid', 14)}<span>Browser</span></button>
          <button type="button" class="btn btn-sm btn-ghost" id="up-folder-clear">${icon('x', 14)}<span>Clear</span></button>
        </div>
        <input type="file" id="up-folder-input" webkitdirectory directory multiple hidden />

        <div class="upload-two-col" style="margin-top:18px;">
          <div class="field">
            <label for="up-name">Game name <span style="color:var(--danger);">*</span></label>
            <input type="text" class="input" id="up-name" placeholder="e.g. Cyber Runner 2077" value="${esc(form.name)}" />
          </div>
          <div class="field">
            <label>Cover image (optional)</label>
            <div class="cover-picker" id="up-cover-picker" role="button" tabindex="0">
              ${form.coverDataUrl ? `<img class="cover-preview" src="${esc(form.coverDataUrl)}" alt="Cover preview" decoding="async" />` : ''}
              <span class="muted small" id="up-cover-label">${form.coverDataUrl ? 'Click to replace or drop a JPG/PNG' : 'Click to choose or drop a JPG/PNG'}</span>
              ${form.coverDataUrl ? `<button type="button" class="btn btn-sm btn-ghost" id="up-cover-remove">Remove</button>` : ''}
              <input type="file" id="up-cover-input" accept="image/jpeg,image/png" hidden />
            </div>
          </div>
        </div>

        <div class="field">
          <label for="up-desc">Description (optional)</label>
          <textarea class="input" id="up-desc" rows="3" placeholder="Short overview, controls, or install notes">${esc(form.description)}</textarea>
        </div>

        <details class="req-details" id="up-req-details" ${Object.values(form.requirements).some((v) => String(v || '').trim()) ? 'open' : ''}>
          <summary>System requirements (optional)</summary>
          <div class="req-grid">
            ${['os', 'cpu', 'ram', 'gpu', 'storage'].map((k) => `
              <div class="field" style="margin-bottom:0;">
                <label for="up-req-${k}">${requirementLabel(k)}</label>
                <input type="text" class="input" id="up-req-${k}" value="${esc(form.requirements[k] || '')}" placeholder="${k === 'ram' ? '8 GB' : k === 'storage' ? '20 GB available' : 'e.g. Linux 64-bit'}" />
              </div>
            `).join('')}
          </div>
        </details>

        <div class="upload-actions" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <button type="button" class="btn btn-primary" id="up-start" ${connected ? '' : 'disabled'}>${icon('arrow-down', 15)}<span>Upload game</span></button>
          <button type="button" class="btn btn-ghost" id="up-clear">Clear form</button>
          <span class="small muted" id="up-hint">${connected ? 'Choose a folder or drop files, then enter a game name.' : 'Connect to an instance to upload.'}</span>
        </div>
        <div class="form-error" id="up-error" role="alert"></div>
      </section>

      <section class="panel" id="up-progress-panel" hidden>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
          <div style="display:flex;align-items:center;gap:10px;min-width:0;">
            <h2 style="margin:0;">Uploading</h2>
            <span class="upload-phase-badge" id="up-phase"></span>
            <span class="small muted" id="up-progress-name"></span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;" id="up-controls"></div>
        </div>
        <div class="upload-progress-track"><div class="upload-progress-fill" id="up-bar"></div></div>
        <div class="up-stats" id="up-stats"></div>
        <div class="upload-waveform-box"><canvas class="upload-waveform-canvas" id="up-waveform"></canvas></div>
        <div class="small muted" id="up-current-file"></div>
        <div class="form-error" id="up-progress-error" role="alert"></div>
      </section>
    </div>
  `;

  // Navigation
  document.getElementById('up-back')?.addEventListener('click', () => navigate('library'));

  // Folder selection
  const pathInput = document.getElementById('up-folder-path');
  const folderInput = document.getElementById('up-folder-input');
  const zone = document.getElementById('up-folder-zone');
  const summary = document.getElementById('up-folder-summary');
  const preview = document.getElementById('up-preview-list');
  const nameInput = document.getElementById('up-name');

  function renderFolderPreview() {
    const hasAny = Boolean(form.folderPath || form.files.length);
    zone.classList.toggle('has-files', hasAny);
    preview.hidden = !hasAny;
    if (!hasAny) {
      preview.replaceChildren();
      return;
    }
    const items = [];
    if (form.files.length) {
      const top = [...form.files]
        .sort((a, b) => (b.size || 0) - (a.size || 0))
        .slice(0, 12)
        .map((f) => `<div class="upload-row-name">${esc(f.webkitRelativePath || f.name)} · ${esc(humanBytes(f.size))}</div>`);
      items.push(`<div class="small muted" style="margin-bottom:4px;">${form.files.length} files · ${esc(humanBytes(form.files.reduce((s, f) => s + (f.size || 0), 0)))}</div>`, ...top);
      if (form.files.length > 12) items.push(`<div class="small faint">+ ${form.files.length - 12} more</div>`);
    } else {
      items.push(`<div class="small muted">${esc(form.folderPath)}</div>`);
    }
    preview.innerHTML = items.join('');
  }
  renderFolderPreview();

  let scanSeq = 0;
  function setFolderPath(path) {
    form.folderPath = String(path || '').trim();
    form.folderScan = null;
    form.files = [];
    pathInput.value = form.folderPath;
    zone.querySelector('.folder-dropzone-title').textContent = form.folderPath ? 'Game folder selected' : 'Drop a game folder here, or choose one';
    const seq = ++scanSeq;
    if (form.folderPath) {
      summary.textContent = 'Scanning folder…';
      bridge.scanUploadFolder?.(form.folderPath)
        .then((scan) => {
          if (seq !== scanSeq) return;
          form.folderScan = scan;
          if (!summary.isConnected) return;
          summary.textContent = `${scan.file_count} files · ${humanBytes(scan.total_bytes)}`;
          if (!form.name && scan.name) {
            form.name = scan.name;
            nameInput.value = form.name;
          }
        })
        .catch(() => {
          if (seq !== scanSeq || !summary.isConnected) return;
          summary.textContent = form.folderPath;
        });
    } else {
      summary.textContent = 'Preserves folder structure with resumable 4 MB chunked uploads';
    }
    renderFolderPreview();
  }

  activeUploadViewApi = {
    setFolderPath,
    applyNativeCover(img) {
      if (!img) return;
      form.coverDataUrl = img.data_url;
      form.coverBase64 = img.base64;
      form.coverContentType = img.content_type;
      if (state.view === 'upload') {
        renderUploadView();
        document.getElementById('up-name')?.focus();
      }
    },
  };

  document.getElementById('up-folder-browse')?.addEventListener('click', async () => {
    try {
      const picked = await bridge.pickUploadFolder();
      if (picked) setFolderPath(picked);
    } catch (err) {
      document.getElementById('up-error').textContent = String(err?.message || err);
    }
  });
  document.getElementById('up-folder-browser')?.addEventListener('click', () => folderInput.click());

  document.getElementById('up-folder-clear')?.addEventListener('click', () => {
    scanSeq += 1;
    form.folderPath = '';
    form.folderScan = null;
    form.files = [];
    pathInput.value = '';
    summary.textContent = 'Preserves folder structure with resumable 4 MB chunked uploads';
    zone.querySelector('.folder-dropzone-title').textContent = 'Drop a game folder here, or choose one';
    renderFolderPreview();
  });
  pathInput.addEventListener('change', () => setFolderPath(pathInput.value));

  folderInput.addEventListener('change', () => {
    const files = [...(folderInput.files || [])].filter((f) => f.webkitRelativePath);
    if (!files.length) return;
    applyDroppedFiles(files);
  });

  document.getElementById('up-folder-browse')?.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    folderInput.click();
  });

  let folderDragDepth = 0;
  zone.addEventListener('dragenter', (e) => {
    e.preventDefault();
    folderDragDepth += 1;
    zone.classList.add('drag-over');
  });
  zone.addEventListener('dragover', (e) => e.preventDefault());
  zone.addEventListener('dragleave', () => {
    folderDragDepth = Math.max(0, folderDragDepth - 1);
    if (folderDragDepth === 0) zone.classList.remove('drag-over');
  });
  zone.addEventListener('drop', async (e) => {
    e.preventDefault();
    folderDragDepth = 0;
    zone.classList.remove('drag-over');
    const files = await collectDroppedFiles(e.dataTransfer);
    if (files.length) applyDroppedFiles(files);
  });
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      document.getElementById('up-folder-browse')?.click();
    }
  });

  function applyDroppedFiles(files) {
    form.files = files;
    form.folderPath = '';
    form.folderScan = null;
    pathInput.value = '';
    zone.querySelector('.folder-dropzone-title').textContent = 'Game folder selected';
    summary.textContent = `${files.length} files · ${humanBytes(files.reduce((s, f) => s + (f.size || 0), 0))}`;
    if (!form.name) {
      form.name = inferUploadName(files);
      nameInput.value = form.name;
    }
    renderFolderPreview();
  }

  // Metadata fields persist across navigation
  nameInput.addEventListener('input', () => { form.name = nameInput.value; });
  document.getElementById('up-desc').addEventListener('input', (e) => { form.description = e.target.value; });
  for (const k of ['os', 'cpu', 'ram', 'gpu', 'storage']) {
    document.getElementById(`up-req-${k}`).addEventListener('input', (e) => { form.requirements[k] = e.target.value; });
  }

  // Cover picker
  const coverInput = document.getElementById('up-cover-input');
  const coverPicker = document.getElementById('up-cover-picker');
  const coverLabel = document.getElementById('up-cover-label');

  function applyCover(file) {
    if (!file) return;
    if (!/^image\/(jpeg|png)$/.test(file.type)) {
      document.getElementById('up-error').textContent = 'Cover image must be JPG or PNG.';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      const comma = text.indexOf(',');
      form.coverDataUrl = text;
      form.coverBase64 = comma >= 0 ? text.slice(comma + 1) : text;
      form.coverContentType = file.type;
      if (state.view === 'upload') {
        renderUploadView();
        document.getElementById('up-name')?.focus();
      }
    };
    reader.readAsDataURL(file);
  }
  coverInput.addEventListener('change', () => applyCover(coverInput.files?.[0]));
  coverPicker.addEventListener('click', (e) => {
    if (e.target.closest('#up-cover-remove')) return;
    coverInput.click();
  });
  coverPicker.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); coverInput.click(); }
  });
  document.getElementById('up-cover-remove')?.addEventListener('click', (e) => {
    e.stopPropagation();
    form.coverDataUrl = '';
    form.coverBase64 = '';
    form.coverContentType = '';
    renderUploadView();
  });
  let coverDragDepth = 0;
  coverPicker.addEventListener('dragenter', (e) => {
    e.preventDefault();
    coverDragDepth += 1;
    coverPicker.classList.add('drag-over');
  });
  coverPicker.addEventListener('dragover', (e) => e.preventDefault());
  coverPicker.addEventListener('dragleave', () => {
    coverDragDepth = Math.max(0, coverDragDepth - 1);
    if (coverDragDepth === 0) coverPicker.classList.remove('drag-over');
  });
  coverPicker.addEventListener('drop', (e) => {
    e.preventDefault();
    coverDragDepth = 0;
    coverPicker.classList.remove('drag-over');
    const file = [...(e.dataTransfer?.files || [])].find((f) => /^image\/(jpeg|png)$/.test(f.type));
    if (file) applyCover(file);
    else document.getElementById('up-error').textContent = 'Cover image must be JPG or PNG.';
  });

  // Clear
  document.getElementById('up-clear')?.addEventListener('click', () => {
    state.uploadForm = defaultUploadForm();
    renderUploadView();
    showToast('Upload form cleared', 'accent', 'x');
  });

  // Start
  document.getElementById('up-start')?.addEventListener('click', async () => {
    const errEl = document.getElementById('up-error');
    if (errEl) errEl.textContent = '';
    const name = String(form.name || '').trim();
    if (!name) {
      if (errEl) errEl.textContent = 'Game name is required.';
      document.getElementById('up-name')?.focus();
      return;
    }
    if (!form.folderPath && !form.files.length) {
      if (errEl) errEl.textContent = 'Choose a game folder or drop files first.';
      return;
    }
    const btn = document.getElementById('up-start');
    if (btn) btn.disabled = true;
    try {
      const jobId = await bridge.startGameUpload({
        name,
        description: form.description,
        system_requirements: requirementsString(form.requirements),
        folder: form.folderPath || null,
        cover: form.coverBase64 || null,
        cover_content_type: form.coverContentType || null,
      });
      if (!state.uploads.some((j) => j.job_id === jobId)) {
        upsertUploadInState({
          job_id: jobId,
          name,
          game_id: null,
          stage: 'queued',
          error: null,
          bytes_uploaded: 0,
          total_bytes: Number(form.folderScan?.total_bytes || 0),
          files_uploaded: 0,
          total_files: Number(form.folderScan?.file_count || form.files.length || 0),
          current_file: null,
          bytes_per_sec: 0,
          speed_samples: [],
          eta_secs: null,
        });
      }
      renderStatusStrip();
      const progressPanel = document.getElementById('up-progress-panel');
      const formPanel = document.getElementById('up-form-panel');
      if (progressPanel) progressPanel.hidden = false;
      if (formPanel) formPanel.hidden = true;
      updateUploadPanelForJob(jobId);
      showToast(`Uploading ${name}`, 'accent', 'arrow-down');
      if (!form.folderPath && form.files.length) {
        await uploadDroppedChunks(jobId, form.files);
      }
    } catch (err) {
      const msg = String(err?.message || err);
      const liveErr = document.getElementById('up-error');
      const liveBtn = document.getElementById('up-start');
      const liveProgress = document.getElementById('up-progress-panel');
      const liveForm = document.getElementById('up-form-panel');
      if (liveForm && liveProgress && !liveProgress.hidden) {
        liveProgress.hidden = true;
        liveForm.hidden = false;
      }
      if (liveErr) liveErr.textContent = msg;
      else showToast(msg, 'danger', 'alert-triangle');
      if (liveBtn) liveBtn.disabled = false;
    }
  });

  // Restore progress panel when navigating back with an active upload
  const active = activeUploads()[0];
  if (active) {
    document.getElementById('up-form-panel').hidden = true;
    document.getElementById('up-progress-panel').hidden = false;
    updateUploadPanelForJob(active.job_id);
  }
}

async function collectDroppedFiles(dataTransfer) {
  const out = [];
  if (!dataTransfer) return out;
  const entries = [...dataTransfer.items]
    .map((item) => item.webkitGetAsEntry?.() || null)
    .filter(Boolean);
  async function walk(entry, prefix) {
    if (entry.isFile) {
      const file = await new Promise((resolve) => entry.file(resolve, () => resolve(null)));
      if (!file) return;
      const rel = prefix ? `${prefix}/${file.name}` : file.name;
      try { Object.defineProperty(file, 'webkitRelativePath', { value: rel, configurable: true }); } catch { /* keep native */ }
      out.push(file);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((resolve) => reader.readEntries(resolve, () => resolve([])));
        const sub = prefix ? `${prefix}/${entry.name}` : entry.name;
        for (const child of batch) await walk(child, sub);
      } while (batch.length > 0);
    }
  }
  if (entries.length) {
    for (const entry of entries) await walk(entry, '');
  } else {
    for (const f of dataTransfer.files || []) {
      try { Object.defineProperty(f, 'webkitRelativePath', { value: f.name, configurable: true }); } catch { /* keep native */ }
      out.push(f);
    }
  }
  return out;
}

function bytesToBase64(bytes) {
  let binary = '';
  const sliceSize = 0x4000;
  for (let offset = 0; offset < bytes.length; offset += sliceSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + sliceSize));
  }
  return btoa(binary);
}

async function uploadDroppedChunks(jobId, files) {
  for (const file of files) {
    const rel = file.webkitRelativePath || file.name;
    const total = Math.max(1, Math.ceil(file.size / UPLOAD_CHUNK_SIZE));
    for (let i = 0; i < total; i++) {
      const curJob = state.uploads.find((j) => j.job_id === jobId);
      if (curJob && (curJob.stage === 'cancelled' || curJob.stage === 'failed')) {
        return;
      }
      const start = i * UPLOAD_CHUNK_SIZE;
      const end = Math.min(file.size, start + UPLOAD_CHUNK_SIZE);
      const chunk = new Uint8Array(await file.slice(start, end).arrayBuffer());
      await bridge.uploadGameChunk({
        job_id: jobId,
        rel_path: rel,
        index: i,
        total,
        size: file.size,
        chunk_base64: bytesToBase64(chunk),
      });
    }
  }
  await bridge.finalizeDroppedUpload(jobId);
}

function updateUploadPanelForJob(jobId) {
  const job = state.uploads.find((j) => j.job_id === jobId);
  const panel = document.getElementById('up-progress-panel');
  if (!panel || !job) return;
  const pct = job.total_bytes > 0 ? Math.min(100, (job.bytes_uploaded / job.total_bytes) * 100) : (job.stage === 'ready' ? 100 : 0);
  const bar = document.getElementById('up-bar');
  if (bar) bar.style.width = `${pct.toFixed(2)}%`;

  const phase = document.getElementById('up-phase');
  if (phase) {
    phase.textContent = uploadPhaseLabel(job);
    phase.classList.toggle('is-paused', job.stage === 'paused');
    phase.classList.toggle('is-failed', job.stage === 'failed');
  }
  const nameEl = document.getElementById('up-progress-name');
  if (nameEl) nameEl.textContent = `"${job.name}"`;
  const statsEl = document.getElementById('up-stats');
  if (statsEl) {
    const eta = job.stage === 'uploading' ? humanEta(job.eta_secs) : job.stage === 'indexing' ? 'Building index…' : uploadPhaseLabel(job);
    statsEl.innerHTML = `
      <span><span class="num">${pct.toFixed(0)}%</span> · ${esc(humanBytes(job.bytes_uploaded))} of ${esc(humanBytes(job.total_bytes))}</span>
      <span><span class="num">${job.files_uploaded}/${job.total_files}</span> files</span>
      <span>${job.stage === 'paused' ? 'Paused' : esc(humanSpeed(job.bytes_per_sec))}</span>
      <span>${esc(eta)}</span>
    `;
  }
  const fileEl = document.getElementById('up-current-file');
  if (fileEl) fileEl.textContent = job.current_file ? `Current file: ${job.current_file}` : '';
  const errEl = document.getElementById('up-progress-error');
  if (errEl) errEl.textContent = job.error || '';

  const controls = document.getElementById('up-controls');
  if (controls) {
    const canPause = job.stage === 'uploading' || job.stage === 'queued' || job.stage === 'indexing';
    const canResume = job.stage === 'paused';
    const canCancel = ['queued', 'uploading', 'paused', 'indexing'].includes(job.stage);
    const canRetry = job.stage === 'failed';
    const mode = `${canPause}|${canResume}|${canCancel}|${canRetry}|${job.stage}`;
    if (controls.dataset.mode !== mode) {
      controls.dataset.mode = mode;
      controls.innerHTML = `
        ${canPause ? `<button type="button" class="btn btn-sm" id="up-pause">${icon('pause', 14)}<span>Pause</span></button>` : ''}
        ${canResume ? `<button type="button" class="btn btn-sm btn-primary" id="up-resume">${icon('play', 14)}<span>Resume</span></button>` : ''}
        ${canCancel ? `<button type="button" class="btn btn-sm btn-danger" id="up-cancel">${icon('x', 14)}<span>Cancel</span></button>` : ''}
        ${canRetry ? `<button type="button" class="btn btn-sm" id="up-reset-failed">${icon('arrow-left', 14)}<span>Back to form</span></button>` : ''}
      `;
      document.getElementById('up-pause')?.addEventListener('click', () => bridge.pauseUpload(job.job_id));
      document.getElementById('up-resume')?.addEventListener('click', () => bridge.resumeUpload(job.job_id));
      document.getElementById('up-cancel')?.addEventListener('click', () => handleCancelUpload(job.job_id));
      document.getElementById('up-reset-failed')?.addEventListener('click', () => {
        for (const wf of activeUploadWaveforms.values()) wf.destroy();
        activeUploadWaveforms.clear();
        state.uploads = state.uploads.filter((j) => j.job_id !== job.job_id);
        renderStatusStrip();
        if (state.view === 'upload') renderUploadView();
      });
    }
  }

  let wf = activeUploadWaveforms.get(job.job_id);
  const canvas = document.getElementById('up-waveform');
  if (wf && canvas && wf.canvas !== canvas) {
    wf.destroy();
    activeUploadWaveforms.delete(job.job_id);
    wf = null;
  }
  if (canvas && !wf) {
    wf = new WaveformCanvas(canvas, job.speed_samples || [], job.stage === 'paused');
    activeUploadWaveforms.set(job.job_id, wf);
  }
  if (wf) wf.update(job.speed_samples || [], job.stage === 'paused', job.stage === 'ready');
}

async function handleCancelUpload(jobId) {
  try {
    await bridge.cancelUpload(jobId);
    for (const wf of activeUploadWaveforms.values()) wf.destroy();
    activeUploadWaveforms.clear();
    state.uploads = state.uploads.filter((j) => j.job_id !== jobId);
    state.uploadForm = defaultUploadForm();
    updateNavState();
    navigate('library');
    showToast('Upload cancelled', 'warn', 'x');
  } catch (err) {
    showToast(String(err?.message || err), 'danger', 'alert-triangle');
  }
}

function upsertUploadInState(job) {
  if (!job || !job.job_id) return null;
  const idx = state.uploads.findIndex((j) => j.job_id === job.job_id);
  const prev = idx !== -1 ? state.uploads[idx].stage : null;
  if (job.stage === 'cancelled') {
    if (idx !== -1) state.uploads.splice(idx, 1);
  } else if (idx !== -1) {
    state.uploads[idx] = job;
  } else {
    state.uploads.unshift(job);
  }
  return prev;
}

// ---------- Profile name (server username) ----------

async function saveProfileUsername(value, errorEl) {
  const username = String(value || '').trim();
  if (!username) {
    if (errorEl) errorEl.textContent = 'Profile name cannot be empty.';
    return false;
  }
  if (errorEl) errorEl.textContent = '';
  try {
    const profile = await bridge.changeUsername(username);
    state.activeProfile = profile || state.activeProfile;
    state.profiles = state.profiles.map((p) => (p.id === profile?.id ? { ...p, ...profile } : p));
    if (state.currentUser && profile) state.currentUser.username = profile.username;
    await refreshCurrentUser();
    renderStatusStrip();
    renderCurrentView();
    showToast(`Profile name changed to ${profile?.username || username}`, 'accent', 'check');
    return true;
  } catch (err) {
    if (errorEl) errorEl.textContent = formatAuthError(err);
    else showToast(formatAuthError(err), 'danger', 'alert-triangle');
    return false;
  }
}

function renderAccountSetting(host) {
  const username = state.currentUser?.username || state.activeProfile?.username || '';
  host.innerHTML = `
    <h2>Account / profile</h2>
    <p class="small muted">Your <strong>profile name</strong> is your OpenSync account username. It is shown to everyone on this server and used for @mentions and save sync attribution.</p>
    <div class="settings-dir-row">
      <input type="text" class="input" id="account-username" value="${esc(username)}" placeholder="Your username" aria-label="Profile name" spellcheck="false" />
      <button type="button" class="btn btn-sm btn-primary" id="account-username-save">${icon('check', 14)}<span>Save name</span></button>
    </div>
    <div class="form-error" id="account-username-error" role="alert"></div>
  `;
  const errorEl = host.querySelector('#account-username-error');
  host.querySelector('#account-username-save')?.addEventListener('click', () => {
    saveProfileUsername(host.querySelector('#account-username').value, errorEl);
  });
  host.querySelector('#account-username')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveProfileUsername(host.querySelector('#account-username').value, errorEl);
    }
  });
}

// ---------- View 4: Settings (games directory + Proton + instances) ----------

function renderSettingsView() {
  viewEl.innerHTML = `
    <div class="page-header-row">
      <h1 class="page-title">Settings</h1>
    </div>

    <section class="panel" id="settings-account"></section>
    <section class="panel" id="settings-games-dir"></section>

    <div id="settings-proton"></div>
    <div id="settings-instances"></div>
  `;
  renderAccountSetting(document.getElementById('settings-account'));
  renderGamesDirSetting(document.getElementById('settings-games-dir'));
  renderProtonSection(document.getElementById('settings-proton'));
  renderProfilesSection(document.getElementById('settings-instances'));
}

function renderGamesDirSetting(host) {
  host.innerHTML = `
    <h2>Games directory</h2>
    <p class="small muted">Where downloads from your OpenSync server are installed. <strong>Auto</strong> uses a <code>Games/OpenSync</code> folder in your home directory (creating <code>Games</code> if needed).</p>
    <div class="settings-dir-row">
      <input type="text" class="input" id="games-dir-input" value="${esc(state.gamesDir || '')}" placeholder="Auto (Games/OpenSync)" spellcheck="false" aria-label="Games directory" />
      <button type="button" class="btn btn-sm" id="games-dir-auto">${icon('refresh-cw', 14)}<span>Auto</span></button>
      <button type="button" class="btn btn-sm btn-primary" id="games-dir-save">${icon('check', 14)}<span>Apply</span></button>
    </div>
    <p class="small muted">Only new downloads use this folder — games already installed stay where they are. Changes are saved immediately.</p>
  `;
  host.querySelector('#games-dir-auto')?.addEventListener('click', () => applyGamesDir('auto'));
  host.querySelector('#games-dir-save')?.addEventListener('click', () => {
    applyGamesDir(host.querySelector('#games-dir-input').value.trim());
  });
}

async function applyGamesDir(value) {
  try {
    state.gamesDir = await bridge.setGamesDir(value);
    showToast(`Games directory: ${state.gamesDir}`, 'accent', 'folder');
    renderCurrentView();
  } catch (err) {
    showToast(String(err?.message || err), 'danger', 'alert-triangle');
  }
}

// ---------- Settings section: Proton & Compatibility ----------

function renderProtonSection(host) {
  const latest = state.latestGeProton;
  const alreadyInstalled = latest
    ? state.protonInstallations.some((p) => p.name === latest.tag_name)
    : false;

  const latestBoxHtml = latest
    ? `
      <div class="proton-row" style="margin-top:14px;">
        <div>
          <div class="proton-row-title">${esc(latest.tag_name)}</div>
          <div class="small muted">
            ${esc(latest.tarball_name)} (${esc(humanBytes(latest.tarball_size))})${latest.sha512_url ? ', SHA-512 verified' : ''}
          </div>
        </div>
        <div>
          ${alreadyInstalled
            ? `<span class="badge badge-accent">${icon('check', 13)}Installed</span>`
            : `<button type="button" class="btn btn-primary btn-sm" id="btn-install-ge-proton">${icon('arrow-down', 14)}<span>Download and install</span></button>`}
        </div>
      </div>
    `
    : state.geProtonError
      ? `<p class="form-error">${esc(state.geProtonError)}</p>`
      : '';

  const rowsHtml = state.protonInstallations.length
    ? state.protonInstallations.map((p) => `
        <div class="proton-row">
          <div>
            <div class="proton-row-title">${esc(p.name)}</div>
            <div class="proton-row-path">${esc(p.root_dir)}</div>
          </div>
          <span class="badge ${p.source === 'OpenSyncManaged' ? 'badge-accent' : ''}">${esc(protonSourceLabel(p.source))}</span>
        </div>
      `).join('')
    : `
      <div class="empty-state">
        <div class="empty-state-icon">${icon('cpu', 22)}</div>
        <h3>No Proton builds detected</h3>
        <p>Check for the latest GE-Proton release above to run Windows games with automatic per-game WINE prefix isolation.</p>
      </div>
    `;

  host.innerHTML = `
    <div class="page-header-row">
      <h2>Proton</h2>
      <button type="button" class="btn btn-sm" id="btn-rescan-proton">${icon('refresh-cw', 14)}<span>Rescan runtimes</span></button>
    </div>

    <section class="panel">
      <div class="proton-hero">
        <div>
          <h2>Check and install latest GE-Proton</h2>
          <p class="small muted">Fetches the latest GloriousEggroll GE-Proton release from GitHub, verifies its SHA-512 checksum, and installs it into OpenSync's managed runtime folder.</p>
        </div>
        <button type="button" class="btn btn-primary" id="btn-check-ge-proton" ${state.checkingGeProton ? 'disabled' : ''}>
          ${icon('refresh-cw', 15, state.checkingGeProton ? 'spin' : '')}
          <span>${state.checkingGeProton ? 'Checking GitHub…' : 'Check latest release'}</span>
        </button>
      </div>
      ${latestBoxHtml}
    </section>

    <div class="section-title">Detected runtimes (${state.protonInstallations.length})</div>
    <div class="proton-list">${rowsHtml}</div>
  `;

  document.getElementById('btn-rescan-proton')?.addEventListener('click', async () => {
    try {
      state.protonInstallations = await bridge.listProtonInstallations();
      renderProtonSection(host);
      showToast(`Found ${state.protonInstallations.length} Proton runtimes`, 'accent', 'cpu');
    } catch (err) {
      showToast(String(err?.message || err), 'danger', 'alert-triangle');
    }
  });

  document.getElementById('btn-check-ge-proton')?.addEventListener('click', async () => {
    state.checkingGeProton = true;
    state.geProtonError = null;
    renderProtonSection(host);
    try {
      state.latestGeProton = await bridge.fetchLatestGeProton();
    } catch (err) {
      state.geProtonError = String(err?.message || err);
    } finally {
      state.checkingGeProton = false;
      renderProtonSection(host);
    }
  });

  document.getElementById('btn-install-ge-proton')?.addEventListener('click', async () => {
    if (!state.latestGeProton) return;
    try {
      await bridge.downloadGeProton(state.latestGeProton);
      await refreshDownloads();
      showToast(`Downloading ${state.latestGeProton.tag_name}`, 'accent', 'arrow-down');
      navigate('downloads');
    } catch (err) {
      showToast(String(err?.message || err), 'danger', 'alert-triangle');
    }
  });
}

// ---------- Settings section: Instances ----------

function renderProfilesSection(host) {
  const activeId = state.activeProfile?.id;
  const listHtml = state.profiles.length
    ? state.profiles.map((p) => {
        const isActive = p.id === activeId;
        return `
          <div class="profile-card ${isActive ? 'active' : ''}">
            <div class="profile-card-identity">
              ${pfpSlotHtml(p.id, p.user_id, isActive ? state.currentUser?.pfp : null, 'profile-card-avatar', p.username)}
              <div>
                <div class="dl-title-row">
                  <span class="profile-menu-name">${esc(p.label)}</span>
                  ${isActive ? '<span class="badge badge-accent">Active</span>' : ''}
                  ${p.role === 'admin' ? '<span class="badge badge-admin">Admin</span>' : ''}
                </div>
                <div class="small muted">@${esc(p.username)} on ${esc(p.server_url)}</div>
              </div>
            </div>
            <div class="profile-card-actions">
              ${isActive ? `<button type="button" class="btn btn-sm" data-prof-customize="${esc(p.id)}">${icon('user', 13)}<span>Customize profile</span></button>` : `<button type="button" class="btn btn-sm btn-primary" data-prof-switch="${esc(p.id)}">Switch</button>`}
              <button type="button" class="btn btn-sm btn-danger" data-prof-delete="${esc(p.id)}" title="Remove saved instance" aria-label="Remove saved instance">${icon('trash-2', 14)}</button>
            </div>
          </div>
        `;
      }).join('')
    : `
      <div class="empty-state">
        <div class="empty-state-icon">${icon('server', 22)}</div>
        <h3>No saved instances</h3>
        <p>Connect to your OpenSync LAN server using the form on the right.</p>
      </div>
    `;

  host.innerHTML = `
    <div class="page-header-row">
      <h2>Instances</h2>
    </div>

    <div class="profiles-layout">
      <section class="panel">
        <h2>Saved profiles</h2>
        <p class="small muted" style="margin-bottom:14px;">Switch between OpenSync servers in one click. Installed games, playtime, and offline sync queues stay cleanly scoped per profile.</p>
        ${listHtml}
      </section>

      <section class="panel" id="inline-connect-panel"></section>
    </div>
  `;

  mountConnectForm(document.getElementById('inline-connect-panel'), {
    onSuccess: async () => {
      await refreshAll();
      navigate('library');
    },
  });

  host.querySelectorAll('[data-prof-switch]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await bridge.switchProfile(btn.dataset.profSwitch);
        await refreshAll();
        showToast('Switched OpenSync instance', 'accent', 'check');
      } catch (err) {
        showToast(String(err?.message || err), 'danger', 'alert-triangle');
      }
    });
  });

  host.querySelectorAll('[data-prof-customize]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await refreshCurrentUser();
      navigate('profile');
    });
  });

  host.querySelectorAll('[data-prof-delete]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const pid = btn.dataset.profDelete;
      const prof = state.profiles.find((x) => x.id === pid);
      openConfirmModal({
        title: `Remove ${prof?.label || 'profile'}`,
        body: 'Removes this saved server profile and its stored session cookie from this device. Local game folders on disk are kept intact.',
        confirmLabel: 'Remove profile',
        danger: true,
        onConfirm: async () => {
          try {
            await bridge.deleteProfile(pid);
            await refreshAll();
            showToast('Profile removed', 'accent', 'trash-2');
          } catch (err) {
            showToast(String(err?.message || err), 'danger', 'alert-triangle');
          }
        },
      });
    });
  });
}

// ---------- Profile & Avatar (WebUI parity) ----------

async function refreshCurrentUser() {
  if (!state.activeProfile) {
    state.currentUser = null;
    return;
  }
  try {
    state.currentUser = await bridge.getCurrentUserProfile();
  } catch {
    // Offline or session expired: keep the last known profile data when possible.
  }
}

function readImageAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      const comma = text.indexOf(',');
      resolve(comma >= 0 ? text.slice(comma + 1) : text);
    };
    reader.onerror = () => reject(new Error('Could not read the selected image'));
    reader.readAsDataURL(file);
  });
}

function renderProfileView() {
  if (!state.activeProfile) {
    viewEl.innerHTML = `
      <div class="panel empty-state">
        <div class="empty-state-icon">${icon('user', 22)}</div>
        <h3>Connect an instance first</h3>
        <p>Sign in to an OpenSync server to customize your profile and avatar.</p>
        <button type="button" class="btn btn-primary" id="profile-connect-btn">Sign in</button>
      </div>
    `;
    document.getElementById('profile-connect-btn')?.addEventListener('click', openConnectModal);
    return;
  }
  const user = state.currentUser;
  if (!user) {
    viewEl.innerHTML = `<div class="panel"><p class="muted">Loading profile…</p></div>`;
    return;
  }

  const profile = state.activeProfile;
  const stats = user.stats || {};
  const customPfp = !isDefaultPfp(user.pfp);
  const avatarHtml = pfpSlotHtml(profile.id, user.id, user.pfp, 'pfp-lg', user.username);

  viewEl.innerHTML = `
    <div class="page-header-row">
      <h1 class="page-title">Profile</h1>
    </div>

    <section class="panel profile-hero">
      ${avatarHtml}
      <div class="profile-hero-meta">
        <h2>@${esc(user.username)}</h2>
        <div class="profile-hero-badges">
          ${user.role === 'admin' ? '<span class="badge badge-admin">Admin</span>' : '<span class="badge">User</span>'}
          <span class="small muted">Member since ${esc(fmtDate(user.created_at))}</span>
        </div>
      </div>
    </section>

    <section class="panel" id="profile-name-panel">
      <h2>Profile name</h2>
      <p class="small muted">This is your OpenSync account username, visible across your instances.</p>
      <div class="settings-dir-row">
        <input type="text" class="input" id="profile-username-input" value="${esc(user.username)}" aria-label="Profile name" spellcheck="false" />
        <button type="button" class="btn btn-sm btn-primary" id="profile-username-save">${icon('check', 14)}<span>Save name</span></button>
      </div>
      <div class="form-error" id="username-error" role="alert"></div>
    </section>

    <section class="panel">
      <h2>Activity</h2>
      <div class="kpi-strip profile-stats">
        <div class="kpi-card">
          <div class="kpi-label">Games uploaded</div>
          <div class="kpi-value">${Number(stats.uploaded || 0)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Games downloaded</div>
          <div class="kpi-value">${Number(stats.downloaded || 0)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Saves synced</div>
          <div class="kpi-value">${Number(stats.synced || 0)}</div>
        </div>
      </div>
    </section>

    <section class="panel" id="profile-pfp-panel">
      <h2>Profile picture</h2>
      <div class="pfp-dropzone" id="pfp-dropzone" role="button" tabindex="0" aria-label="Upload profile picture">
        <div class="pfp-dropzone-icon">${icon('user', 22)}</div>
        <p class="muted small">Click to browse or drop a JPG/PNG image to update your avatar (max 8 MB).</p>
        <input type="file" id="pfp-file" accept="image/jpeg,image/png" hidden />
      </div>
      ${customPfp ? `<div class="profile-actions"><button type="button" class="btn btn-ghost btn-sm" id="pfp-remove">Remove profile picture</button></div>` : ''}
      <div class="form-error" id="pfp-error" role="alert"></div>
    </section>

    <section class="panel">
      <h2>Instance label</h2>
      <p class="small muted">A friendly name for this server shown only in this launcher's profile switcher.</p>
      <div class="settings-dir-row">
        <input type="text" class="input" id="profile-label-input" value="${esc(profile.label)}" placeholder="Home LAN" aria-label="Instance label" />
        <button type="button" class="btn btn-sm btn-primary" id="profile-label-save">${icon('check', 14)}<span>Save</span></button>
      </div>
      <div class="form-error" id="label-error" role="alert"></div>
    </section>

    <section class="panel danger-zone">
      <h2>Danger zone</h2>
      <p class="small muted">Permanently deletes your account and save syncs on the server. Games you uploaded stay on the server.</p>
      <button type="button" class="btn btn-danger" id="profile-delete">${icon('trash-2', 14)}<span>Delete account</span></button>
      <div class="form-error" id="danger-error" role="alert">${esc(state.profileDangerError || '')}</div>
    </section>
  `;

  const dropzone = document.getElementById('pfp-dropzone');
  const fileInput = document.getElementById('pfp-file');
  const pfpError = document.getElementById('pfp-error');
  let busy = false;

  async function uploadFile(file) {
    if (!file || busy) return;
    pfpError.textContent = '';
    if (!/^image\/(jpeg|png)$/.test(file.type)) {
      pfpError.textContent = 'Profile picture must be a JPG or PNG image.';
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      pfpError.textContent = 'Profile picture is too large (max 8 MB).';
      return;
    }
    busy = true;
    dropzone.classList.add('is-busy');
    const hint = dropzone.querySelector('p');
    const originalHint = hint.textContent;
    hint.textContent = 'Uploading…';
    try {
      const base64 = await readImageAsBase64(file);
      await bridge.uploadProfilePfp(base64, file.type);
      invalidateUserPfp(profile.id, user.id);
      state.profileDangerError = null;
      await refreshAll();
      showToast('Profile picture saved', 'accent', 'check');
    } catch (err) {
      pfpError.textContent = formatAuthError(err);
      hint.textContent = originalHint;
      dropzone.classList.remove('is-busy');
    } finally {
      busy = false;
    }
  }

  dropzone.addEventListener('click', () => {
    if (!busy) fileInput.click();
  });
  dropzone.addEventListener('keydown', (e) => {
    if (!busy && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) uploadFile(file);
  });

  let dragDepth = 0;
  const panel = document.getElementById('profile-pfp-panel');
  panel.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (busy) return;
    dragDepth += 1;
    panel.classList.add('drag-over');
  });
  panel.addEventListener('dragover', (e) => e.preventDefault());
  panel.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) panel.classList.remove('drag-over');
  });
  panel.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    panel.classList.remove('drag-over');
    const files = [...(e.dataTransfer?.files || [])];
    const file = files.find((f) => /^image\/(jpeg|png)$/.test(f.type)) || files[0];
    if (file) uploadFile(file);
    else pfpError.textContent = 'Profile picture must be a JPG or PNG image.';
  });

  document.getElementById('pfp-remove')?.addEventListener('click', async () => {
    pfpError.textContent = '';
    try {
      await bridge.removeProfilePfp();
      invalidateUserPfp(profile.id, user.id);
      await refreshAll();
      showToast('Profile picture removed', 'accent', 'check');
    } catch (err) {
      pfpError.textContent = formatAuthError(err);
    }
  });

  const usernameError = document.getElementById('username-error');
  const usernameInput = document.getElementById('profile-username-input');
  const saveUsername = () => saveProfileUsername(usernameInput.value, usernameError);
  document.getElementById('profile-username-save')?.addEventListener('click', saveUsername);
  usernameInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveUsername(); }
  });

  const labelError = document.getElementById('label-error');
  document.getElementById('profile-label-save')?.addEventListener('click', async () => {
    const value = document.getElementById('profile-label-input').value.trim();
    labelError.textContent = '';
    if (!value) {
      labelError.textContent = 'Instance label cannot be empty.';
      return;
    }
    try {
      await bridge.renameProfile(value);
      await refreshAll();
      showToast(`Instance renamed to ${value}`, 'accent', 'check');
    } catch (err) {
      labelError.textContent = formatAuthError(err);
    }
  });

  document.getElementById('profile-delete')?.addEventListener('click', () => {
    state.profileDangerError = null;
    openConfirmModal({
      title: 'Delete account',
      body: 'This permanently deletes your account and save syncs. Games you uploaded stay on the server. Continue?',
      confirmLabel: 'Delete account',
      danger: true,
      onConfirm: async () => {
        try {
          await bridge.deleteServerAccount();
          invalidateUserPfp(profile.id, user.id);
          state.profileDangerError = null;
          await refreshAll();
          navigate('library');
          showToast('Account deleted', 'accent', 'check');
        } catch (err) {
          state.profileDangerError = formatAuthError(err);
          renderCurrentView();
        }
      },
    });
  });
}

function formatAuthError(err) {
  let msg = String(err?.message || err || '').trim();
  msg = msg.replace(/^api error:\s*/i, '').replace(/^server returned \d+:\s*/i, '').trim();
  const lower = msg.toLowerCase();
  if (lower.includes('invalid username or password') || lower.includes('invalid credentials')) {
    return 'Invalid username or password. Check your credentials or use Create account.';
  }
  if (lower.includes('username already taken')) {
    return 'That username is already taken on this server. Try Sign in instead.';
  }
  if (lower.startsWith('network error')) {
    return 'Could not reach the server. Check the URL and that OpenSync is running.';
  }
  if (!msg) return 'Sign in failed.';
  return msg.charAt(0).toUpperCase() + msg.slice(1);
}

function mountConnectForm(container, { onSuccess, onCancel = null, fullWidthSubmit = false }) {
  let mode = 'login'; // 'login' | 'register'
  let showPw = false;
  let savedUrl = '';
  let savedLabel = '';
  let savedUser = '';
  let savedPass = '';

  container.innerHTML = `
    <div class="auth-tabs" role="tablist">
      <button type="button" class="active" data-auth-tab="login">Sign in</button>
      <button type="button" data-auth-tab="register">Create account</button>
    </div>
    <div id="auth-body"></div>
  `;

  const loginTab = container.querySelector('[data-auth-tab="login"]');
  const registerTab = container.querySelector('[data-auth-tab="register"]');
  const bodyEl = container.querySelector('#auth-body');

  const syncTabs = () => {
    const isLogin = mode === 'login';
    loginTab?.classList.toggle('active', isLogin);
    registerTab?.classList.toggle('active', !isLogin);
  };

  const renderBody = (isSwitch = false) => {
    if (isSwitch) {
      savedUrl = bodyEl.querySelector('#cf-url')?.value || savedUrl;
      savedLabel = bodyEl.querySelector('#cf-label')?.value || savedLabel;
      savedUser = bodyEl.querySelector('#cf-user')?.value || savedUser;
      savedPass = bodyEl.querySelector('#cf-pass')?.value || savedPass;
    }
    const prevH = bodyEl.offsetHeight;

    bodyEl.innerHTML = `
      <form id="connect-profile-form" novalidate>
        <div class="field">
          <label for="cf-url">Server URL</label>
          <input id="cf-url" class="input" type="text" placeholder="http://127.0.0.1:3000" value="${esc(savedUrl)}" required />
        </div>
        <div class="field">
          <label for="cf-label">Instance label</label>
          <input id="cf-label" class="input" type="text" placeholder="Home LAN" value="${esc(savedLabel)}" />
        </div>
        <div class="field">
          <label for="cf-user">Username</label>
          <input id="cf-user" class="input" type="text" placeholder="your handle" value="${esc(savedUser)}" autocomplete="username" required />
        </div>
        <div class="field">
          <label for="cf-pass">Password</label>
          <div class="input-pw-wrap">
            <input id="cf-pass" class="input" type="${showPw ? 'text' : 'password'}" placeholder="${mode === 'register' ? 'At least 6 characters' : 'Enter password'}" value="${esc(savedPass)}" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" required />
            <button type="button" class="pw-toggle" id="cf-pw-toggle" aria-label="${showPw ? 'Hide password' : 'Show password'}" title="${showPw ? 'Hide password' : 'Show password'}">
              ${icon(showPw ? 'eye-off' : 'eye', 16)}
            </button>
          </div>
        </div>
        <div class="form-error" id="cf-err" role="alert"></div>
        <div class="modal-actions">
          ${onCancel ? '<button type="button" class="btn btn-ghost" id="cf-cancel">Cancel</button>' : ''}
          <button type="submit" class="btn btn-primary${fullWidthSubmit && !onCancel ? ' btn-full' : ''}" id="cf-submit">
            ${mode === 'register' ? 'Create account and connect' : 'Sign in and connect'}
          </button>
        </div>
        <p class="faint small auth-switch">
          ${mode === 'login' ? 'No account yet? ' : 'Already have an account? '}
          <button type="button" class="link-btn" id="cf-mode-switch">${mode === 'login' ? 'Create one' : 'Sign in'}</button>
        </p>
      </form>
    `;

    const targetH = bodyEl.scrollHeight;
    if (isSwitch && prevH > 0 && targetH !== prevH) {
      bodyEl.style.height = `${prevH}px`;
      void bodyEl.offsetHeight;
      bodyEl.style.height = `${targetH}px`;
      bodyEl.addEventListener('transitionend', () => { bodyEl.style.height = ''; }, { once: true });
    } else {
      bodyEl.style.height = '';
    }

    const errEl = bodyEl.querySelector('#cf-err');
    const showError = (msg) => {
      if (!errEl) return;
      errEl.textContent = msg;
      errEl.classList.remove('shake');
      void errEl.offsetWidth;
      if (msg) errEl.classList.add('shake');
    };

    bodyEl.querySelector('#cf-mode-switch')?.addEventListener('click', () => {
      const next = mode === 'login' ? 'register' : 'login';
      if (mode !== next) {
        mode = next;
        syncTabs();
        renderBody(true);
      }
    });

    bodyEl.querySelector('#cf-pw-toggle')?.addEventListener('click', () => {
      const pwInput = bodyEl.querySelector('#cf-pass');
      showPw = !showPw;
      if (pwInput) {
        pwInput.type = showPw ? 'text' : 'password';
        pwInput.focus();
      }
      const btn = bodyEl.querySelector('#cf-pw-toggle');
      if (btn) {
        btn.innerHTML = icon(showPw ? 'eye-off' : 'eye', 16);
        btn.setAttribute('aria-label', showPw ? 'Hide password' : 'Show password');
        btn.title = showPw ? 'Hide password' : 'Show password';
      }
    });

    if (onCancel) {
      bodyEl.querySelector('#cf-cancel')?.addEventListener('click', onCancel);
    }

    bodyEl.querySelector('#connect-profile-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const submitBtn = bodyEl.querySelector('#cf-submit');
      showError('');

      const rawUrl = bodyEl.querySelector('#cf-url').value.trim();
      const server_url = normalizeServerUrl(rawUrl);
      const label = bodyEl.querySelector('#cf-label').value.trim() || server_url.replace(/^https?:\/\//, '');
      const username = bodyEl.querySelector('#cf-user').value.trim();
      const password = bodyEl.querySelector('#cf-pass').value;

      if (!server_url) {
        showError('Server URL is required.');
        bodyEl.querySelector('#cf-url')?.focus();
        return;
      }
      if (!username) {
        showError('Username is required.');
        bodyEl.querySelector('#cf-user')?.focus();
        return;
      }
      if (!password) {
        showError('Password is required.');
        bodyEl.querySelector('#cf-pass')?.focus();
        return;
      }

      const busyText = mode === 'register' ? 'Creating account…' : 'Signing in…';
      const idleText = mode === 'register' ? 'Create account and connect' : 'Sign in and connect';
      submitBtn.disabled = true;
      submitBtn.textContent = busyText;
      try {
        await bridge.connectProfile({
          label,
          server_url,
          username,
          password,
          register: mode === 'register',
        });
        showToast(`Connected to ${label}`, 'accent', 'wifi');
        await onSuccess();
      } catch (err) {
        showError(formatAuthError(err));
      } finally {
        if (submitBtn.isConnected) {
          submitBtn.disabled = false;
          submitBtn.textContent = idleText;
        }
      }
    });

    if (isSwitch) {
      const uIn = bodyEl.querySelector('#cf-user');
      const pIn = bodyEl.querySelector('#cf-pass');
      if (uIn && !uIn.value) uIn.focus();
      else if (pIn && !pIn.value) pIn.focus();
      else uIn?.focus();
    }
  };

  [loginTab, registerTab].forEach((tab) => {
    tab?.addEventListener('click', () => {
      const next = tab.dataset.authTab;
      if (!next || next === mode) return;
      mode = next;
      syncTabs();
      renderBody(true);
    });
  });

  syncTabs();
  renderBody(false);
}

// ---------- Modals & Lightbox ----------

function closeModal() {
  modalRoot.innerHTML = '';
  gamepadCtrl?.onViewRendered();
}

function openConnectModal() {
  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="connect-modal-bg">
      <div class="modal-card" role="dialog" aria-modal="true" aria-label="Connect OpenSync instance">
        <div class="modal-header">
          <h2>Connect OpenSync instance</h2>
          <button type="button" class="btn btn-ghost btn-icon" id="modal-close-x" aria-label="Close">${icon('x', 16)}</button>
        </div>
        <div id="modal-connect-host"></div>
      </div>
    </div>
  `;
  document.getElementById('modal-close-x')?.addEventListener('click', closeModal);
  document.getElementById('connect-modal-bg')?.addEventListener('click', (e) => {
    if (e.target.id === 'connect-modal-bg') closeModal();
  });
  mountConnectForm(document.getElementById('modal-connect-host'), {
    onCancel: closeModal,
    onSuccess: async () => {
      closeModal();
      await refreshAll();
      navigate('library');
    },
  });
  gamepadCtrl?.onViewRendered();
}

function openDownloadChoiceModal(game) {
  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="dl-choice-modal-bg">
      <div class="modal-card" role="dialog" aria-modal="true" aria-label="Download ${esc(game.name)}">
        <div class="modal-header">
          <h2>Download ${esc(game.name)}</h2>
          <button type="button" class="btn btn-ghost btn-icon" id="dl-choice-close-x" aria-label="Close">${icon('x', 16)}</button>
        </div>
        <p class="muted" style="margin:0;">You have synced cloud saves for this game. Choose whether to include your save overlay or download a clean archive.</p>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="dl-choice-cancel">Cancel</button>
          <button type="button" class="btn" id="dl-choice-clean" title="Pristine archive without your account saves">Download clean</button>
          <button type="button" class="btn btn-primary" id="dl-choice-saves" title="Includes your synced cloud save overlay">Download with your saves</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById('dl-choice-close-x')?.addEventListener('click', closeModal);
  document.getElementById('dl-choice-cancel')?.addEventListener('click', closeModal);
  document.getElementById('dl-choice-modal-bg')?.addEventListener('click', (e) => {
    if (e.target.id === 'dl-choice-modal-bg') closeModal();
  });
  document.getElementById('dl-choice-clean')?.addEventListener('click', async () => {
    closeModal();
    await handleStartDownload(game, true);
  });
  document.getElementById('dl-choice-saves')?.addEventListener('click', async () => {
    closeModal();
    await handleStartDownload(game, false);
  });
  gamepadCtrl?.onViewRendered();
}

function openConfirmModal({ title, body, confirmLabel = 'Confirm', danger = false, onConfirm }) {
  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="confirm-modal-bg">
      <div class="modal-card" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="modal-header">
          <h2>${esc(title)}</h2>
          <button type="button" class="btn btn-ghost btn-icon" id="confirm-close-x" aria-label="Close">${icon('x', 16)}</button>
        </div>
        <p class="muted" style="margin:0;">${esc(body)}</p>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="confirm-cancel">Cancel</button>
          <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="confirm-ok">${esc(confirmLabel)}</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById('confirm-close-x')?.addEventListener('click', closeModal);
  document.getElementById('confirm-cancel')?.addEventListener('click', closeModal);
  document.getElementById('confirm-modal-bg')?.addEventListener('click', (e) => {
    if (e.target.id === 'confirm-modal-bg') closeModal();
  });
  document.getElementById('confirm-ok')?.addEventListener('click', async () => {
    closeModal();
    await onConfirm();
  });
  gamepadCtrl?.onViewRendered();
}

function openLightbox(src, alt) {
  lightboxRoot.innerHTML = `
    <div class="modal-backdrop" id="lightbox-bg">
      <div class="lightbox-frame">
        <img src="${esc(src)}" alt="${esc(alt)}" />
        <button type="button" class="btn btn-icon lightbox-close" id="lightbox-close-btn" aria-label="Close lightbox">${icon('x', 16)}</button>
      </div>
    </div>
  `;
  const close = () => {
    lightboxRoot.innerHTML = '';
    gamepadCtrl?.onViewRendered();
  };
  document.getElementById('lightbox-close-btn')?.addEventListener('click', close);
  document.getElementById('lightbox-bg')?.addEventListener('click', (e) => {
    if (e.target.id === 'lightbox-bg') close();
  });
  gamepadCtrl?.onViewRendered();
}

function openGameLogsModal(game) {
  const renderActivity = () => {
    const host = document.getElementById('game-log-activity');
    if (!host) return;
    const entries = state.activityLogs.filter((l) => l.game_id === game.game_id);
    host.innerHTML = entries.length
      ? `<div class="activity-list">${entries.map(renderActivityItemHtml).join('')}</div>`
      : '<p class="small muted">No launch or save sync events recorded for this game yet.</p>';
  };
  const loadOutput = async () => {
    const host = document.getElementById('game-log-output');
    if (!host) return;
    try {
      const text = await bridge.getGameLog(game.game_id);
      host.textContent = text || 'No game output captured yet. Launch the game to generate a log.';
      host.classList.toggle('is-empty', !text);
    } catch (err) {
      host.textContent = `Could not read the game log: ${err?.message || err}`;
      host.classList.add('is-empty');
    }
  };

  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="game-logs-modal-bg">
      <div class="modal-card modal-card-wide" role="dialog" aria-modal="true" aria-label="Logs for ${esc(game.name)}">
        <div class="modal-header">
          <h2>Logs · ${esc(game.name)}</h2>
          <button type="button" class="btn btn-ghost btn-icon" id="game-logs-close-x" aria-label="Close">${icon('x', 16)}</button>
        </div>
        <div class="game-log-section">
          <div class="game-log-section-head">
            <h3>Game output</h3>
            <div class="game-log-tools">
              <button type="button" class="btn btn-ghost btn-sm" id="btn-game-log-refresh">${icon('refresh-cw', 13)}<span>Refresh</span></button>
              <button type="button" class="btn btn-ghost btn-sm" id="btn-game-log-clear">${icon('trash-2', 13)}<span>Clear</span></button>
            </div>
          </div>
          <pre class="game-log-output" id="game-log-output">Loading…</pre>
          <p class="small faint">Captures stdout and stderr from the last game launch (most recent 64 KB).</p>
        </div>
        <div class="game-log-section">
          <div class="game-log-section-head">
            <h3>Sync and launch activity</h3>
          </div>
          <div id="game-log-activity"></div>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn" id="game-logs-done">Done</button>
        </div>
      </div>
    </div>
  `;

  renderActivity();
  loadOutput();
  document.getElementById('game-logs-close-x')?.addEventListener('click', closeModal);
  document.getElementById('game-logs-done')?.addEventListener('click', closeModal);
  document.getElementById('game-logs-modal-bg')?.addEventListener('click', (e) => {
    if (e.target.id === 'game-logs-modal-bg') closeModal();
  });
  document.getElementById('btn-game-log-refresh')?.addEventListener('click', async () => {
    await loadOutput();
    try {
      state.activityLogs = await bridge.listActivityLogs(80);
      renderActivity();
    } catch (err) {
      showToast(String(err?.message || err), 'danger', 'alert-triangle');
    }
  });
  document.getElementById('btn-game-log-clear')?.addEventListener('click', async () => {
    try {
      await bridge.clearGameLog(game.game_id);
      await loadOutput();
      showToast('Game output cleared', 'accent', 'trash-2');
    } catch (err) {
      showToast(String(err?.message || err), 'danger', 'alert-triangle');
    }
  });
  gamepadCtrl?.onViewRendered();
}

// ---------- Core Action Handlers ----------

async function handleLaunchGame(game) {
  if (state.playingGameIds.has(game.game_id)) return;
  try {
    state.playingGameIds.add(game.game_id);
    renderCurrentView();
    await bridge.launchGame(game.game_id);
    showToast(`Launching ${game.name}`, 'accent', 'play');
  } catch (err) {
    state.playingGameIds.delete(game.game_id);
    renderCurrentView();
    showToast(String(err?.message || err), 'danger', 'alert-triangle');
  }
}

async function handleStartDownload(game, fresh = false) {
  try {
    await bridge.startGameDownload(game.game_id, fresh);
    await refreshDownloads();
    updateNavState();
    showToast(`Downloading ${game.name}`, 'accent', 'arrow-down');
    if (state.view === 'library') renderLibraryGrid();
    else if (state.view === 'game-detail') renderGameDetailView();
  } catch (err) {
    showToast(String(err?.message || err), 'danger', 'alert-triangle');
  }
}

async function handleCancelDownload(jobId) {
  try {
    await bridge.cancelDownload(jobId);
    state.downloads = state.downloads.filter((d) => d.job_id !== jobId);
    updateNavState();
    if (state.view === 'downloads') syncDownloadsListDom();
    else if (state.view === 'library') renderLibraryGrid();
    showToast('Download cancelled', 'warn', 'x');
  } catch (err) {
    showToast(String(err?.message || err), 'danger', 'alert-triangle');
  }
}

async function handleManualSync(game, force = false) {
  state.syncingGameIds.add(game.game_id);
  renderCurrentView();
  try {
    const report = await bridge.syncGameNow(game.game_id, force);
    state.syncingGameIds.delete(game.game_id);
    await refreshAll();
    const count = (report?.uploaded_files || 0) + (report?.deleted_paths || 0);
    showToast(
      count > 0 ? `Synced ${report.uploaded_files} files for ${game.name}` : `${game.name} saves are already up to date`,
      'accent',
      'check',
    );
  } catch (err) {
    state.syncingGameIds.delete(game.game_id);
    renderCurrentView();
    const msg = String(err?.message || err);
    if (!force && msg.toLowerCase().includes('mass deletion')) {
      openConfirmModal({
        title: 'Confirm large save deletion',
        body: `${msg}. Proceed with force sync?`,
        confirmLabel: 'Force sync',
        danger: true,
        onConfirm: () => handleManualSync(game, true),
      });
      return;
    }
    showToast(msg, 'danger', 'alert-triangle');
  }
}

async function quickInstallLatestGeProton() {
  try {
    showToast('Checking latest GE-Proton release…', 'accent', 'refresh-cw');
    const rel = await bridge.fetchLatestGeProton();
    state.latestGeProton = rel;
    await bridge.downloadGeProton(rel);
    await refreshDownloads();
    showToast(`Downloading ${rel.tag_name}`, 'accent', 'arrow-down');
    navigate('downloads');
  } catch (err) {
    showToast(`GE-Proton fetch failed: ${err?.message || err}`, 'danger', 'alert-triangle');
  }
}

// ---------- Data Sync & Live Events ----------

async function refreshDownloads() {
  try {
    const raw = await bridge.listDownloads();
    state.downloads = (raw || []).map(normalizeDownloadJob).filter(Boolean);
    updateNavState();
    if (state.view === 'downloads') syncDownloadsListDom();
  } catch {
    // ignore transient error
  }
}

async function refreshLibrary() {
  if (!state.activeProfile) {
    state.library = [];
    return;
  }
  try {
    state.library = await bridge.listLibrary();
  } catch {
    // keep cached library when offline
  }
}

// ---------- Force-Quit Save Recovery & Safe Shutdown Modals ----------

function maybePromptInterruptedSession() {
  const next = state.interruptedSessions.find(
    (s) => s.has_unsynced_saves && !state.promptedInterruptedGameIds.has(s.game_id),
  );
  if (!next) return;
  if (modalRoot.innerHTML.trim() !== '') return;
  state.promptedInterruptedGameIds.add(next.game_id);
  openInterruptedSessionModal(next);
}

function openInterruptedSessionModal(session) {
  const count = Number(session.changed_files || 0) + Number(session.deleted_files || 0);
  const sampleHtml = Array.isArray(session.sample_paths) && session.sample_paths.length
    ? `
      <div class="recovery-file-list">
        ${session.sample_paths.map((p) => `<div class="recovery-file-item">${icon('file', 13)}<span>${esc(p)}</span></div>`).join('')}
      </div>
    `
    : '';

  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="recovery-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="recovery-modal-title">
      <div class="modal-card" style="max-width:480px;">
        <div class="modal-header">
          <h2 id="recovery-modal-title" style="margin:0;display:inline-flex;align-items:center;gap:9px;">
            <span style="color:var(--warn);display:inline-flex;">${icon('alert-triangle', 18)}</span>
            <span>Interrupted game session detected</span>
          </h2>
          <button type="button" class="btn btn-ghost btn-icon" id="btn-close-recovery-modal" aria-label="Close">${icon('x', 16)}</button>
        </div>
        <p style="margin:0 0 10px;color:var(--muted);line-height:1.5;">
          OpenSync Launcher was force-closed while <strong style="color:var(--fg);">${esc(session.game_name)}</strong> was running.
          We detected <strong style="color:var(--accent);">${count} modified save ${count === 1 ? 'file' : 'files'} (${humanBytes(session.changed_bytes || 0)})</strong> in the game folder.
        </p>
        ${sampleHtml}
        <p class="small muted" style="margin:8px 0 0;">Would you like to sync these save changes to your OpenSync server now?</p>
        <div class="modal-actions">
          <button type="button" class="btn" id="btn-skip-recovery-sync">Skip save sync</button>
          <button type="button" class="btn btn-primary" id="btn-accept-recovery-sync">${icon('refresh-cw', 14)}<span>Sync saves now</span></button>
        </div>
      </div>
    </div>
  `;

  gamepadCtrl?.onViewRendered();

  const removeSessionFromState = () => {
    state.interruptedSessions = state.interruptedSessions.filter((s) => s.game_id !== session.game_id);
  };

  document.getElementById('btn-close-recovery-modal')?.addEventListener('click', () => {
    closeModal();
  });

  document.getElementById('btn-skip-recovery-sync')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-skip-recovery-sync');
    if (btn) btn.disabled = true;
    try {
      await bridge.resolveInterruptedSession(session.game_id, false, false);
      removeSessionFromState();
      closeModal();
      showToast(`Skipped save recovery for ${session.game_name}`, 'warn', 'clock');
      await refreshAll();
    } catch (err) {
      showToast(String(err?.message || err), 'danger', 'alert-triangle');
      closeModal();
    }
  });

  document.getElementById('btn-accept-recovery-sync')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-accept-recovery-sync');
    const skipBtn = document.getElementById('btn-skip-recovery-sync');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<span class="spin-icon">${icon('refresh-cw', 14)}</span><span>Syncing saves…</span>`;
    }
    if (skipBtn) skipBtn.disabled = true;
    try {
      const report = await bridge.resolveInterruptedSession(session.game_id, true, false);
      removeSessionFromState();
      closeModal();
      const uploaded = report?.uploaded_files || session.changed_files || 1;
      showToast(`Recovered & synced ${uploaded} save ${uploaded === 1 ? 'file' : 'files'} for ${session.game_name}`, 'accent', 'check');
      await refreshAll();
    } catch (err) {
      showToast(String(err?.message || err), 'danger', 'alert-triangle');
      closeModal();
    }
  });
}

async function triggerSafeShutdownRequest() {
  try {
    const status = await bridge.getShutdownStatus();
    openSafeShutdownModal(status);
  } catch (err) {
    showToast(String(err?.message || err), 'danger', 'alert-triangle');
  }
}

function openSafeShutdownModal(status = {}) {
  const playingGames = Array.isArray(status.playing_games) ? status.playing_games : [];
  const activeSyncs = Number(status.active_syncs || 0);
  const activeDls = Number(status.active_downloads || 0);
  const activeUps = Number(status.active_uploads || 0);
  const hasPlaying = playingGames.length > 0;
  const autoWaitOnly = !hasPlaying && activeSyncs > 0 && activeDls === 0 && activeUps === 0;

  let statusSummary = 'All save syncs are idle. Safe shutdown will checkpoint the SQLite database before exiting.';
  if (hasPlaying) {
    statusSummary = `${playingGames.join(', ')} is currently running. If you quit now, your active session is preserved in SQLite and OpenSync will offer to sync any modified saves on next startup.`;
  } else if (activeSyncs > 0) {
    statusSummary = `Waiting for ${activeSyncs} active save ${activeSyncs === 1 ? 'sync' : 'syncs'} to finish uploading before closing…`;
  } else if (activeDls > 0 || activeUps > 0) {
    statusSummary = `${activeDls + activeUps} active transfer(s) will be paused cleanly and SQLite WAL will be checkpointed before exit.`;
  }

  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="shutdown-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="shutdown-modal-title">
      <div class="modal-card" style="max-width:460px;">
        <div class="modal-header">
          <h2 id="shutdown-modal-title" style="margin:0;display:inline-flex;align-items:center;gap:9px;">
            <span style="color:var(--accent);display:inline-flex;">${icon('shield-check', 18)}</span>
            <span>Safe shutdown</span>
          </h2>
          <button type="button" class="btn btn-ghost btn-icon" id="btn-close-shutdown-modal" aria-label="Close">${icon('x', 16)}</button>
        </div>
        <div class="shutdown-status-box ${hasPlaying ? 'is-warn' : ''}" id="shutdown-status-box">
          <span id="shutdown-status-icon">${activeSyncs > 0 ? `<span class="spin-icon">${icon('refresh-cw', 18)}</span>` : icon('shield-check', 18)}</span>
          <span id="shutdown-status-msg">${esc(statusSummary)}</span>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn" id="btn-cancel-safe-shutdown">Keep launcher open</button>
          <button type="button" class="btn ${hasPlaying ? 'btn-danger' : 'btn-primary'}" id="btn-confirm-safe-shutdown">
            ${icon('shield-check', 14)}<span>${hasPlaying ? 'Safe quit anyway' : 'Flush &amp; quit safely'}</span>
          </button>
        </div>
      </div>
    </div>
  `;

  gamepadCtrl?.onViewRendered();

  document.getElementById('btn-close-shutdown-modal')?.addEventListener('click', closeModal);
  document.getElementById('btn-cancel-safe-shutdown')?.addEventListener('click', closeModal);

  const runShutdown = async (forceWhilePlaying) => {
    const confirmBtn = document.getElementById('btn-confirm-safe-shutdown');
    const cancelBtn = document.getElementById('btn-cancel-safe-shutdown');
    const msgEl = document.getElementById('shutdown-status-msg');
    const iconEl = document.getElementById('shutdown-status-icon');
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.innerHTML = `<span class="spin-icon">${icon('refresh-cw', 14)}</span><span>Finishing save sync…</span>`;
    }
    if (cancelBtn) cancelBtn.disabled = true;
    if (iconEl) iconEl.innerHTML = `<span class="spin-icon">${icon('refresh-cw', 18)}</span>`;
    if (msgEl) msgEl.textContent = 'Flushing in-flight save syncs and checkpointing SQLite WAL…';

    try {
      const res = await bridge.confirmSafeShutdown(forceWhilePlaying);
      if (res?.completed) {
        if (iconEl) iconEl.innerHTML = icon('check', 18);
        if (msgEl) msgEl.textContent = 'Safe shutdown complete — SQLite WAL checkpointed.';
        showToast('Safe shutdown complete', 'accent', 'shield-check');
        setTimeout(() => closeModal(), 650);
      }
    } catch (err) {
      showToast(String(err?.message || err), 'danger', 'alert-triangle');
      closeModal();
    }
  };

  document.getElementById('btn-confirm-safe-shutdown')?.addEventListener('click', () => {
    runShutdown(true);
  });

  if (autoWaitOnly) {
    runShutdown(false);
  }
}

async function refreshAll() {
  const boot = await bridge.getBootstrapState();
  state.activeProfile = boot.active_profile || null;
  state.profiles = boot.profiles || [];
  state.connectionState = normalizeConnectionState(boot.connection_state);
  state.protonInstallations = boot.proton_installations || [];
  state.pendingSyncs = boot.pending_syncs || [];
  state.downloads = (boot.downloads || []).map(normalizeDownloadJob).filter(Boolean);
  state.bandwidthLimitBps = Number(boot.bandwidth_limit_bps || 0);
  state.gamesDir = boot.games_dir || '';
  if (Array.isArray(boot.activity_logs)) {
    state.activityLogs = boot.activity_logs;
  }
  if (Array.isArray(boot.interrupted_sessions)) {
    state.interruptedSessions = boot.interrupted_sessions;
  }
  const [, , rawUploads] = await Promise.all([
    refreshCurrentUser(),
    refreshLibrary(),
    Promise.resolve(bridge.listUploads?.()).catch(() => null),
  ]);
  if (rawUploads) {
    state.uploads = rawUploads.map(normalizeUploadJob).filter(Boolean);
  }
  updateNavState();
  renderStatusStrip();
  renderCurrentView();
  maybePromptInterruptedSession();
}

function upsertDownloadInState(job) {
  if (!job || !job.job_id) return null;
  const idx = state.downloads.findIndex((d) => d.job_id === job.job_id);
  const prevStage = idx !== -1 ? state.downloads[idx].stage : null;
  if (job.stage === 'cancelled') {
    if (idx !== -1) state.downloads.splice(idx, 1);
  } else if (idx !== -1) {
    state.downloads[idx] = job;
  } else {
    state.downloads.unshift(job);
  }
  return prevStage;
}

function handleLauncherEvent(evt) {
  if (!evt || typeof evt !== 'object') return;
  const type = String(evt.type || '').toLowerCase();

  switch (type) {
    case 'connection_changed':
    case 'connectionchanged': {
      state.connectionState = normalizeConnectionState(evt.state);
      renderStatusStrip();
      break;
    }
    case 'download_updated':
    case 'downloadupdated': {
      const job = normalizeDownloadJob(evt.job);
      if (!job) break;
      const prevStage = upsertDownloadInState(job);
      updateNavState();

      if (job.stage === 'completed' && prevStage !== 'completed') {
        showToast(`${job.title} is ready`, 'accent', 'check');
        if (job.kind === 'game' && job.game_id != null) cardDomCache.delete(job.game_id);
        refreshLibrary().then(() => {
          if (job.kind === 'game' && job.game_id != null) cardDomCache.delete(job.game_id);
          if (state.view === 'downloads') syncDownloadsListDom();
          else renderCurrentView();
        });
        break;
      }

      if (job.stage === 'failed' && prevStage !== 'failed') {
        showToast(`Download failed: ${job.error || 'Unknown error'}`, 'danger', 'alert-triangle');
      }

      if (state.view === 'downloads') {
        syncDownloadsListDom();
      } else if (state.view === 'library' && job.kind === 'game' && job.game_id != null) {
        const card = document.querySelector(`.card[data-game-id="${job.game_id}"]`);
        if (card) {
          const pct = job.total_bytes > 0
            ? Math.min(100, Math.round((job.bytes_downloaded / job.total_bytes) * 100))
            : 0;
          const pctEl = card.querySelector('.card-dl-pct');
          if (pctEl) pctEl.textContent = `${pct}%`;
          const pill = card.querySelector('.card-top-pill.downloading');
          if (pill) pill.textContent = job.paused ? 'Paused' : `${pct}%`;
        }
      }
      break;
    }
    case 'game_session_started':
    case 'gamesessionstarted': {
      state.playingGameIds.add(evt.game_id);
      renderStatusStrip();
      renderCurrentView();
      break;
    }
    case 'sync_started':
    case 'syncstarted':
    case 'game_sync_started':
    case 'gamesyncstarted': {
      state.playingGameIds.delete(evt.game_id);
      state.syncingGameIds.add(evt.game_id);
      const g = state.library.find((x) => x.game_id === evt.game_id);
      const gName = evt.name || (g ? g.name : 'Game');
      showLiveSyncBanner(evt.game_id, gName, evt.trigger || 'post_exit');
      renderStatusStrip();
      if (!state.uninstallingGameIds.has(evt.game_id)) {
        if (state.view === 'library') renderLibraryGrid();
        else if (state.view === 'game-detail' && state.selectedGameId === evt.game_id) renderGameDetailView();
      }
      break;
    }
    case 'game_sync_completed':
    case 'gamesynccompleted': {
      state.syncingGameIds.delete(evt.game_id);
      const g = state.library.find((x) => x.game_id === evt.game_id);
      const gName = evt.name || (g ? g.name : 'Game');
      completeLiveSyncBanner(evt.game_id, gName, {
        uploadedFiles: evt.uploaded_files || 0,
        uploadedBytes: evt.uploaded_bytes || 0,
        deletedPaths: evt.deleted_paths || 0,
      });
      renderStatusStrip();
      if (!state.uninstallingGameIds.has(evt.game_id)) {
        if (state.view === 'library') renderLibraryGrid();
        else if (state.view === 'game-detail' && state.selectedGameId === evt.game_id) renderGameDetailView();
      }
      break;
    }
    case 'game_session_ended':
    case 'gamesessionended': {
      state.playingGameIds.delete(evt.game_id);
      state.syncingGameIds.delete(evt.game_id);
      const g = state.library.find((x) => x.game_id === evt.game_id);
      const gName = evt.name || (g ? g.name : 'game');
      if (evt.error) {
        completeLiveSyncBanner(evt.game_id, gName, { error: evt.error });
        showToast(`Save sync queued for ${gName}: ${evt.error}`, 'warn', 'wifi-off');
      } else if (evt.synced) {
        completeLiveSyncBanner(evt.game_id, gName, {
          uploadedFiles: evt.uploaded_files || 0,
          uploadedBytes: evt.uploaded_bytes || 0,
          deletedPaths: evt.deleted_paths || 0,
        });
      }
      refreshAll();
      break;
    }
    case 'activity_logged':
    case 'activitylogged': {
      if (evt.entry) {
        state.activityLogs = [
          evt.entry,
          ...state.activityLogs.filter((l) => l.id !== evt.entry.id),
        ].slice(0, 120);
        renderStatusStrip();
        if (
          state.view === 'game-detail'
          && state.selectedGameId === evt.entry.game_id
          && !state.uninstallingGameIds.has(evt.entry.game_id)
        ) {
          renderGameDetailView();
        }
      }
      break;
    }
    case 'interrupted_session_detected':
    case 'interruptedsessiondetected': {
      if (evt.session) {
        const exists = state.interruptedSessions.some((s) => s.game_id === evt.session.game_id);
        if (!exists) state.interruptedSessions.push(evt.session);
        maybePromptInterruptedSession();
      }
      break;
    }
    case 'shutdown_requested':
    case 'shutdownrequested': {
      openSafeShutdownModal(evt.status || {});
      break;
    }
    case 'shutdown_progress':
    case 'shutdownprogress': {
      const msgEl = document.getElementById('shutdown-status-msg');
      if (msgEl && evt.message) {
        msgEl.textContent = evt.message;
      }
      break;
    }
    case 'upload_updated':
    case 'uploadupdated': {
      const job = normalizeUploadJob(evt.job);
      if (!job) break;
      const prevStage = upsertUploadInState(job);
      if (prevStage === job.stage && job.stage !== 'ready' && job.stage !== 'failed' && job.stage !== 'cancelled') {
        updateUploadStatusPill();
      } else {
        renderStatusStrip();
      }

      if (job.stage === 'ready' && prevStage !== 'ready') {
        for (const wf of activeUploadWaveforms.values()) wf.destroy();
        activeUploadWaveforms.clear();
        state.uploadForm = defaultUploadForm();
        const uploadedGameId = job.game_id;
        if (uploadedGameId != null) cardDomCache.delete(uploadedGameId);
        // The backend moves the uploaded folder into the OpenSync games
        // directory and reports it installed, so refetch before rendering.
        Promise.all([refreshLibrary(), refreshDownloads()])
          .then(() => {
            if (uploadedGameId != null) cardDomCache.delete(uploadedGameId);
            const installedGame = state.library.find(
              (g) => g.game_id === uploadedGameId && g.installed,
            );
            showToast(
              installedGame
                ? `${job.name} is installed and ready to play`
                : `${job.name} uploaded successfully`,
              'accent',
              installedGame ? 'play' : 'check',
            );
            if (uploadedGameId != null) navigate('game-detail', { gameId: uploadedGameId });
            else renderCurrentView();
          })
          .catch(() => {
            showToast(`${job.name} uploaded successfully`, 'accent', 'check');
            renderCurrentView();
          });
        break;
      }
      if (job.stage === 'failed' && prevStage !== 'failed') {
        showToast(`Upload failed: ${job.error || 'Unknown error'}`, 'danger', 'alert-triangle');
      }
      if (job.stage === 'cancelled' && prevStage !== 'cancelled') {
        showToast('Upload cancelled', 'warn', 'x');
      }
      if (state.view === 'upload' && (activeUploads().some((j) => j.job_id === job.job_id) || job.stage === 'failed')) {
        updateUploadPanelForJob(job.job_id);
      }
      break;
    }
    case 'profile_updated':
    case 'profileupdated': {
      refreshCurrentUser()
        .then(() => refreshLibrary())
        .then(() => {
          renderStatusStrip();
          if (state.view !== 'profile' || document.activeElement?.tagName !== 'INPUT') {
            renderCurrentView();
          }
        });
      break;
    }
    case 'background_sync_completed':
    case 'backgroundsynccompleted': {
      const changed = (evt.synced_games || 0) > 0
        || (evt.flushed_pending || 0) > 0
        || state.pendingSyncs.length > 0
        || state.connectionState?.status !== 'connected';
      if (!changed) break;
      bridge
        .getBootstrapState()
        .then((boot) => {
          state.pendingSyncs = boot.pending_syncs || [];
          state.connectionState = normalizeConnectionState(boot.connection_state);
          return refreshLibrary();
        })
        .then(() => {
          renderStatusStrip();
          if (state.view === 'library' || state.view === 'game-detail') {
            renderCurrentView();
          }
        })
        .catch(() => {});
      break;
    }
    case 'proton_installed':
    case 'protoninstalled': {
      if (evt.installation) {
        const exists = state.protonInstallations.some((p) => p.name === evt.installation.name);
        if (!exists) state.protonInstallations.unshift(evt.installation);
        showToast(`${evt.installation.name} installed`, 'accent', 'cpu');
      }
      if (state.view === 'settings' || state.view === 'game-detail') {
        renderCurrentView();
      }
      break;
    }
    default:
      break;
  }
}

// ---------- Controller / Gamepad Wiring ----------

function initGamepad() {
  gamepadCtrl = createGamepadController({
    getView: () => state.view,
    onCardPrimary: (gameId) => {
      const g = state.library.find((x) => x.game_id === gameId);
      if (g) runCardPrimaryAction(g);
    },
    onCardDetails: (gameId) => {
      navigate('game-detail', { gameId });
    },
    onSecondaryAction: () => {
      if (state.view === 'game-detail') {
        const syncBtn = document.getElementById('btn-detail-sync');
        if (syncBtn && !syncBtn.disabled) {
          syncBtn.click();
          return;
        }
        document.getElementById('btn-detail-fresh')?.click();
      }
    },
    onBack: () => {
      if (state.cssSelectOpen) {
        closeCssSelect();
        return;
      }
      if (lightboxRoot.innerHTML) {
        lightboxRoot.innerHTML = '';
        gamepadCtrl?.onViewRendered();
        return;
      }
      if (modalRoot.innerHTML) {
        closeModal();
        return;
      }
      if (state.profileMenuOpen) {
        state.profileMenuOpen = false;
        renderStatusStrip();
        gamepadCtrl?.onViewRendered();
        return;
      }
      if (state.view === 'game-detail') {
        navigate('library');
        return;
      }
      if (state.view === 'profile' || state.view === 'upload') {
        navigate('library');
        return;
      }
      if (document.activeElement?.tagName === 'INPUT') {
        document.activeElement.blur();
      }
    },
    onYAction: () => {
      if (state.view === 'library') {
        const search = document.getElementById('lib-search');
        if (search) {
          search.focus();
          search.select();
        }
      } else if (state.view === 'settings') {
        document.getElementById('btn-rescan-proton')?.click();
      }
    },
    onCycleTab: (delta) => {
      if (modalRoot.innerHTML || lightboxRoot.innerHTML) return;
      const curTab = state.view === 'game-detail' ? 'library' : state.view;
      const idx = Math.max(0, TAB_ORDER.indexOf(curTab));
      const next = TAB_ORDER[(idx + delta + TAB_ORDER.length) % TAB_ORDER.length];
      navigate(next);
    },
    onToggleProfileMenu: () => {
      state.profileMenuOpen = !state.profileMenuOpen;
      renderStatusStrip();
      gamepadCtrl?.onViewRendered();
    },
    onGamepadConnected: () => {
      showToast('Controller connected', 'accent', 'gamepad-2');
    },
  });
}

// ---------- Native OS Drag-and-Drop (Tauri v2 WindowEvent::DragDrop) ----------

function clearNativeDragHighlights() {
  document.querySelectorAll('#up-folder-zone.drag-over, #up-cover-picker.drag-over, #profile-pfp-panel.drag-over')
    .forEach((el) => el.classList.remove('drag-over'));
}

function hitTestNativeDropTarget(x, y) {
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  const selector = '#up-cover-picker, #up-folder-zone, #profile-pfp-panel';
  const direct = document.elementFromPoint(x, y)?.closest(selector);
  if (direct) return direct;
  const dpr = window.devicePixelRatio || 1;
  if (dpr !== 1) {
    return document.elementFromPoint(x / dpr, y / dpr)?.closest(selector) || null;
  }
  return null;
}

async function handleNativeDragDrop(payload) {
  if (!payload || typeof payload !== 'object') return;
  const kind = String(payload.kind || '').toLowerCase();

  if (kind === 'leave') {
    clearNativeDragHighlights();
    return;
  }

  if (!state.activeProfile) {
    clearNativeDragHighlights();
    return;
  }

  if (kind === 'enter' || kind === 'over') {
    clearNativeDragHighlights();
    const target = hitTestNativeDropTarget(payload.x, payload.y);
    if (target) {
      if (target.id === 'up-folder-zone' || target.id === 'up-cover-picker') {
        const formPanel = document.getElementById('up-form-panel');
        if (formPanel && !formPanel.hidden) target.classList.add('drag-over');
      } else {
        target.classList.add('drag-over');
      }
      return;
    }
    if (state.view === 'upload') {
      const formPanel = document.getElementById('up-form-panel');
      if (formPanel && !formPanel.hidden) {
        document.getElementById('up-folder-zone')?.classList.add('drag-over');
      }
    } else if (state.view === 'profile') {
      document.getElementById('profile-pfp-panel')?.classList.add('drag-over');
    }
    return;
  }

  if (kind !== 'drop') return;
  clearNativeDragHighlights();

  const rawPaths = Array.isArray(payload.paths) ? payload.paths : [];
  if (!rawPaths.length) return;

  const target = hitTestNativeDropTarget(payload.x, payload.y);
  let items = [];
  try {
    items = (await bridge.inspectDroppedPaths(rawPaths)) || [];
  } catch (err) {
    showToast(String(err?.message || err), 'danger', 'alert-triangle');
    return;
  }
  if (!items.length) return;

  const dir = items.find((i) => i.is_dir);
  const img = items.find((i) => i.is_image);

  // Profile view: dropping a JPG/PNG updates avatar directly; dropping a folder opens Upload.
  if (state.view === 'profile') {
    if (img) {
      try {
        const local = await bridge.readLocalImage(img.path);
        await bridge.uploadProfilePfp(local.base64, local.content_type);
        if (state.activeProfile && state.currentUser) {
          invalidateUserPfp(state.activeProfile.id, state.currentUser.id);
        }
        state.profileDangerError = null;
        await refreshAll();
        showToast('Profile picture updated', 'accent', 'check');
      } catch (err) {
        const pfpErr = document.getElementById('pfp-error');
        const msg = formatAuthError(err);
        if (pfpErr) pfpErr.textContent = msg;
        showToast(msg, 'danger', 'alert-triangle');
      }
      return;
    }
    if (dir) {
      navigate('upload');
      activeUploadViewApi?.setFolderPath(dir.path);
      return;
    }
    showToast('Profile picture must be a JPG or PNG image.', 'warn', 'alert-triangle');
    return;
  }

  // Upload view: handle cover drops, folder drops, or both.
  if (state.view === 'upload') {
    const formPanel = document.getElementById('up-form-panel');
    if (formPanel && formPanel.hidden) {
      showToast('Wait for the current upload to finish or cancel it first.', 'warn', 'alert-triangle');
      return;
    }
    if (target?.id === 'up-cover-picker') {
      if (img) {
        try {
          const local = await bridge.readLocalImage(img.path);
          activeUploadViewApi?.applyNativeCover(local);
          showToast(`Cover set from ${local.name}`, 'accent', 'check');
        } catch (err) {
          const errEl = document.getElementById('up-error');
          const msg = String(err?.message || err);
          if (errEl) errEl.textContent = msg;
          showToast(msg, 'danger', 'alert-triangle');
        }
      } else {
        showToast('Cover image must be a JPG or PNG image.', 'warn', 'alert-triangle');
      }
      return;
    }

    if (dir) {
      activeUploadViewApi?.setFolderPath(dir.path);
      if (img) {
        try {
          const local = await bridge.readLocalImage(img.path);
          activeUploadViewApi?.applyNativeCover(local);
        } catch {
          // ignore cover read error if folder succeeded
        }
      }
      return;
    }

    if (img) {
      try {
        const local = await bridge.readLocalImage(img.path);
        activeUploadViewApi?.applyNativeCover(local);
        showToast(`Cover set from ${local.name}`, 'accent', 'check');
      } catch (err) {
        const errEl = document.getElementById('up-error');
        const msg = String(err?.message || err);
        if (errEl) errEl.textContent = msg;
        showToast(msg, 'danger', 'alert-triangle');
      }
      return;
    }

    showToast('Drop a game folder (not a single file) or a JPG/PNG cover image.', 'warn', 'alert-triangle');
    return;
  }

  // Library / Downloads / Settings / Game detail: dropping a game folder or cover image jumps to Upload.
  if (activeUploads().length > 0) {
    showToast('An upload is already in progress.', 'warn', 'alert-triangle');
    navigate('upload');
    return;
  }
  if (dir) {
    navigate('upload');
    activeUploadViewApi?.setFolderPath(dir.path);
    if (img) {
      try {
        const local = await bridge.readLocalImage(img.path);
        activeUploadViewApi?.applyNativeCover(local);
      } catch {
        // ignore optional cover
      }
    }
    showToast(`Selected folder: ${dir.name}`, 'accent', 'folder');
    return;
  }
  if (img) {
    try {
      const local = await bridge.readLocalImage(img.path);
      navigate('upload');
      activeUploadViewApi?.applyNativeCover(local);
      showToast(`Cover set from ${local.name}`, 'accent', 'check');
    } catch (err) {
      showToast(String(err?.message || err), 'danger', 'alert-triangle');
    }
    return;
  }
  showToast('Drop a game folder to upload, or an image on Profile/Upload.', 'warn', 'alert-triangle');
}

// ---------- Boot ----------

async function boot() {
  initTopbarNav();
  initGamepad();
  initScrollPerf();
  await listenEvents(handleLauncherEvent);
  await listenDragDrop(handleNativeDragDrop);
  await refreshAll();
}

boot();
