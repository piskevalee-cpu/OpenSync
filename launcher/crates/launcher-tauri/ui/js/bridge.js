// Unified Tauri v2 + interactive browser preview bridge for OpenSync Launcher.

// With `withGlobalTauri: false` we deliberately do not expose the full
// `window.__TAURI__` API to page scripts. Tauri still injects the low-level
// `__TAURI_INTERNALS__` bridge, which is all this module needs. Keeping the
// narrowed surface means injected markup cannot reach every IPC command.
const tauriInternals = typeof window !== 'undefined' ? window.__TAURI_INTERNALS__ : null;
const isTauri = Boolean(
  tauriInternals
  && typeof tauriInternals.invoke === 'function',
);

export function isDesktopRuntime() {
  return isTauri;
}

// ---------- Procedural 2:3 cover art for browser preview fallback ----------

function svgDataUrl(svg) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.trim())}`;
}

function mockPfpDataUrl(label, hue = 140) {
  const initial = String(label || 'U').trim().slice(0, 1).toUpperCase();
  return svgDataUrl(`
    <svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="hsl(${hue}, 62%, 32%)"/>
          <stop offset="100%" stop-color="#0b1412"/>
        </linearGradient>
      </defs>
      <rect width="96" height="96" rx="48" fill="url(#g)"/>
      <text x="48" y="61" text-anchor="middle" font-family="Inter, sans-serif" font-size="40" font-weight="700" fill="#d9ffe4">${initial}</text>
    </svg>
  `);
}

const PREVIEW_COVERS = {
  1: svgDataUrl(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 900">
      <defs>
        <linearGradient id="bg1" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#0d1b1e"/>
          <stop offset="52%" stop-color="#14302c"/>
          <stop offset="100%" stop-color="#080c0d"/>
        </linearGradient>
        <radialGradient id="mist1" cx="52%" cy="32%" r="48%">
          <stop offset="0%" stop-color="#7dfa9b" stop-opacity="0.34"/>
          <stop offset="60%" stop-color="#29594b" stop-opacity="0.14"/>
          <stop offset="100%" stop-color="#080c0d" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="600" height="900" fill="url(#bg1)"/>
      <rect width="600" height="900" fill="url(#mist1)"/>
      <circle cx="310" cy="255" r="78" fill="#7dfa9b" opacity="0.16"/>
      <circle cx="310" cy="255" r="46" fill="#d9ffe4" opacity="0.82"/>
      <path d="M0 540 L120 430 L215 480 L345 360 L485 455 L600 390 L600 900 L0 900 Z" fill="#0d1919"/>
      <path d="M0 630 L95 545 L175 590 L285 495 L410 580 L520 515 L600 570 L600 900 L0 900 Z" fill="#091112"/>
      <g stroke="#7dfa9b" stroke-width="3" fill="none" opacity="0.78">
        <line x1="345" y1="210" x2="345" y2="395"/>
        <line x1="322" y1="395" x2="345" y2="235"/>
        <line x1="368" y1="395" x2="345" y2="235"/>
        <line x1="330" y1="310" x2="360" y2="310"/>
        <line x1="324" y1="355" x2="366" y2="355"/>
        <circle cx="345" cy="204" r="6" fill="#7dfa9b"/>
        <path d="M312 184 Q345 158 378 184" opacity="0.5"/>
        <path d="M294 166 Q345 128 396 166" opacity="0.3"/>
      </g>
      <path d="M0 670 Q150 610 300 660 T600 640 L600 900 L0 900 Z" fill="#7dfa9b" opacity="0.06"/>
      <text x="48" y="106" fill="#d8ffe1" font-family="Inter, sans-serif" font-weight="800" font-size="48" letter-spacing="4" opacity="0.92">FOGWOODS</text>
      <text x="50" y="138" fill="#7dfa9b" font-family="Inter, sans-serif" font-weight="600" font-size="16" letter-spacing="3" opacity="0.72">RIDGE WATCH ARCHIVE</text>
    </svg>
  `),
  2: svgDataUrl(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 900">
      <defs>
        <linearGradient id="bg2" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#140c24"/>
          <stop offset="50%" stop-color="#1f1136"/>
          <stop offset="100%" stop-color="#090a12"/>
        </linearGradient>
        <radialGradient id="glow2" cx="68%" cy="30%" r="55%">
          <stop offset="0%" stop-color="#ff4d94" stop-opacity="0.38"/>
          <stop offset="55%" stop-color="#5a3bff" stop-opacity="0.16"/>
          <stop offset="100%" stop-color="#090a12" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="600" height="900" fill="url(#bg2)"/>
      <rect width="600" height="900" fill="url(#glow2)"/>
      <g fill="#0c0b16">
        <rect x="42" y="360" width="84" height="540"/>
        <rect x="140" y="290" width="96" height="610"/>
        <rect x="255" y="210" width="110" height="690"/>
        <rect x="385" y="320" width="88" height="580"/>
        <rect x="488" y="265" width="90" height="635"/>
      </g>
      <g fill="#6bb3ff" opacity="0.72">
        <rect x="275" y="245" width="18" height="6"/>
        <rect x="305" y="245" width="38" height="6"/>
        <rect x="275" y="270" width="68" height="5"/>
        <rect x="160" y="330" width="54" height="5"/>
        <rect x="160" y="352" width="32" height="5"/>
        <rect x="506" y="305" width="46" height="6"/>
      </g>
      <line x1="0" y1="620" x2="600" y2="540" stroke="#7dfa9b" stroke-width="3" opacity="0.75"/>
      <line x1="0" y1="646" x2="600" y2="574" stroke="#ff6b9e" stroke-width="2" opacity="0.65"/>
      <text x="44" y="106" fill="#ffffff" font-family="Inter, sans-serif" font-weight="800" font-size="44" letter-spacing="2">CYBER RUNNER</text>
      <text x="46" y="156" fill="#7dfa9b" font-family="Inter, sans-serif" font-weight="800" font-size="38" letter-spacing="6">2077</text>
    </svg>
  `),
  3: svgDataUrl(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 900">
      <defs>
        <linearGradient id="bg3" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#11131e"/>
          <stop offset="55%" stop-color="#1b2033"/>
          <stop offset="100%" stop-color="#090a0f"/>
        </linearGradient>
        <radialGradient id="moon3" cx="50%" cy="28%" r="42%">
          <stop offset="0%" stop-color="#6bb3ff" stop-opacity="0.34"/>
          <stop offset="100%" stop-color="#090a0f" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="600" height="900" fill="url(#bg3)"/>
      <rect width="600" height="900" fill="url(#moon3)"/>
      <circle cx="300" cy="260" r="96" fill="#e6f2ff" opacity="0.88"/>
      <circle cx="332" cy="240" r="88" fill="#171b2b"/>
      <path d="M240 900 L272 340 L300 220 L328 340 L360 900 Z" fill="#0b0d14"/>
      <path d="M135 900 L175 490 L215 900 Z" fill="#0e111a"/>
      <path d="M385 900 L425 460 L465 900 Z" fill="#0e111a"/>
      <circle cx="300" cy="400" r="10" fill="#6bb3ff"/>
      <text x="48" y="102" fill="#e8f1ff" font-family="Inter, sans-serif" font-weight="800" font-size="44" letter-spacing="3">HOLLOW SPIRE</text>
      <text x="50" y="134" fill="#6bb3ff" font-family="Inter, sans-serif" font-weight="600" font-size="15" letter-spacing="3" opacity="0.8">CITADEL EDITION</text>
    </svg>
  `),
  4: svgDataUrl(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 900">
      <defs>
        <linearGradient id="bg4" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#0a131c"/>
          <stop offset="100%" stop-color="#090a0e"/>
        </linearGradient>
      </defs>
      <rect width="600" height="900" fill="url(#bg4)"/>
      <g fill="none" stroke="#6bb3ff" opacity="0.28">
        <circle cx="300" cy="430" r="240" stroke-width="1.5"/>
        <circle cx="300" cy="430" r="180" stroke-width="2" stroke-dasharray="10 8"/>
        <circle cx="300" cy="430" r="120" stroke-width="2.5" stroke="#7dfa9b" opacity="0.65"/>
        <circle cx="300" cy="430" r="60" stroke-width="1.5"/>
      </g>
      <circle cx="420" cy="430" r="14" fill="#7dfa9b"/>
      <circle cx="196" cy="282" r="9" fill="#6bb3ff"/>
      <text x="48" y="108" fill="#e6e6e6" font-family="Inter, sans-serif" font-weight="800" font-size="44" letter-spacing="3">SIGNAL DRIFT</text>
      <text x="50" y="140" fill="#7dfa9b" font-family="Inter, sans-serif" font-weight="600" font-size="15" letter-spacing="3">ORBITAL TELEMETRY</text>
    </svg>
  `),
  5: svgDataUrl(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 900">
      <defs>
        <linearGradient id="bg5" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#1e150c"/>
          <stop offset="55%" stop-color="#2b1b10"/>
          <stop offset="100%" stop-color="#0c0a09"/>
        </linearGradient>
        <radialGradient id="forge5" cx="50%" cy="62%" r="48%">
          <stop offset="0%" stop-color="#ffd166" stop-opacity="0.42"/>
          <stop offset="100%" stop-color="#0c0a09" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="600" height="900" fill="url(#bg5)"/>
      <rect width="600" height="900" fill="url(#forge5)"/>
      <polygon points="300,260 440,510 160,510" fill="none" stroke="#ffd166" stroke-width="4" opacity="0.72"/>
      <polygon points="300,325 390,485 210,485" fill="#ffd166" opacity="0.16"/>
      <rect x="110" y="555" width="380" height="14" rx="7" fill="#ffd166" opacity="0.65"/>
      <text x="48" y="104" fill="#fff5dd" font-family="Inter, sans-serif" font-weight="800" font-size="40" letter-spacing="2">STARLIGHT</text>
      <text x="48" y="150" fill="#ffd166" font-family="Inter, sans-serif" font-weight="800" font-size="40" letter-spacing="4">FOUNDRY</text>
    </svg>
  `),
  6: svgDataUrl(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 900">
      <defs>
        <linearGradient id="bg6" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#22101a"/>
          <stop offset="60%" stop-color="#150d17"/>
          <stop offset="100%" stop-color="#0a0a0c"/>
        </linearGradient>
      </defs>
      <rect width="600" height="900" fill="url(#bg6)"/>
      <path d="M0 440 Q150 360 300 440 T600 440" fill="none" stroke="#ff6b6b" stroke-width="4" opacity="0.72"/>
      <path d="M0 485 Q150 405 300 485 T600 485" fill="none" stroke="#ff6b6b" stroke-width="2.5" opacity="0.45"/>
      <path d="M0 530 Q150 450 300 530 T600 530" fill="none" stroke="#7dfa9b" stroke-width="2" opacity="0.45"/>
      <circle cx="300" cy="465" r="82" fill="none" stroke="#ffffff" stroke-width="2" opacity="0.22"/>
      <text x="48" y="108" fill="#ffe6ec" font-family="Inter, sans-serif" font-weight="800" font-size="42" letter-spacing="2">VELVET ECHOES</text>
      <text x="50" y="140" fill="#ff8585" font-family="Inter, sans-serif" font-weight="600" font-size="15" letter-spacing="3">NOCTURNE SYNTH</text>
    </svg>
  `),
};

// ---------- Interactive Mock Backend (Browser Preview) ----------

function makeInitialSamples(baseBps, count = 44) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const wave = Math.sin(i * 0.35) * 0.12 + Math.cos(i * 0.17) * 0.08;
    const ramp = Math.min(1, (i + 6) / 14);
    out.push({
      elapsed_ms: i * 100,
      bytes_per_sec: Math.max(0, baseBps * ramp * (0.94 + wave)),
    });
  }
  return out;
}

function createMockRuntime() {
  const listeners = new Set();
  const emit = (evt) => {
    for (const fn of listeners) {
      try {
        fn(evt);
      } catch {
        // ignore listener error
      }
    }
  };

  let bandwidthLimit = 0;
  let discordRpcEnabled = true;
  let gamesDir = '/home/user/Games/OpenSync';
  let nextJobSeq = 2;
  const uploads = [];
  let nextUploadSeq = 1;
  // Per-game stdout/stderr preview, keyed by game id.
  const gameLogs = new Map([
    [
      1,
      [
        '===== session · Fogwoods · runtime: native =====',
        'Initializing renderer…',
        'Audio device: default',
        'Save directory ready.',
      ],
    ],
  ]);

  const profiles = [
    {
      id: 'prof-home-lan',
      label: 'Home LAN',
      server_url: 'http://192.168.1.42:3000',
      username: 'valerio',
      user_id: 1,
      role: 'admin',
      created_at: '2026-08-14T18:20:00Z',
      last_connected_at: new Date().toISOString(),
    },
    {
      id: 'prof-studio-nas',
      label: 'Studio NAS',
      server_url: 'http://10.0.0.18:3000',
      username: 'valerio',
      user_id: 2,
      role: 'user',
      created_at: '2026-09-02T11:10:00Z',
      last_connected_at: '2026-11-19T21:05:00Z',
    },
  ];

  let activeProfileId = profiles[0].id;
  let connectionState = { status: 'connected' };

  // Cached avatars keyed by (profile_id, user_id), mirroring the Rust disk cache.
  const pfpStore = new Map();
  pfpStore.set(`${profiles[0].id}_1`, mockPfpDataUrl('valerio'));
  pfpStore.set(`${profiles[0].id}_3`, mockPfpDataUrl('marco', 210));
  pfpStore.set(`${profiles[0].id}_4`, mockPfpDataUrl('elena', 320));

  let currentUser = {
    id: 1,
    username: 'valerio',
    role: 'admin',
    created_at: profiles[0].created_at,
    pfp: '/api/auth/users/1/pfp',
    stats: { uploaded: 12, downloaded: 28, synced: 9 },
  };

  function syncCurrentUser() {
    const active = profiles.find((p) => p.id === activeProfileId);
    if (!active) {
      currentUser = null;
      return;
    }
    const hasPfp = pfpStore.has(`${active.id}_${active.user_id}`);
    currentUser = {
      id: active.user_id,
      username: active.username,
      role: active.role,
      created_at: active.created_at,
      pfp: hasPfp ? `/api/auth/users/${active.user_id}/pfp` : '/img/blankpfp.jpg',
      stats: currentUser?.stats || { uploaded: 0, downloaded: 0, synced: 0 },
    };
  }

  const protonInstallations = [
    {
      name: 'GE-Proton9-25',
      root_dir: '/home/valerio/.local/share/opensync-launcher/proton/GE-Proton9-25',
      proton_script: '/home/valerio/.local/share/opensync-launcher/proton/GE-Proton9-25/proton',
      source: 'OpenSyncManaged',
    },
    {
      name: 'Proton 9.0-4',
      root_dir: '/home/valerio/.local/share/Steam/steamapps/common/Proton 9.0-4',
      proton_script: '/home/valerio/.local/share/Steam/steamapps/common/Proton 9.0-4/proton',
      source: 'SteamCommon',
    },
    {
      name: 'Proton Experimental',
      root_dir: '/home/valerio/.local/share/Steam/steamapps/common/Proton - Experimental',
      proton_script: '/home/valerio/.local/share/Steam/steamapps/common/Proton - Experimental/proton',
      source: 'SteamCommon',
    },
  ];

  const pendingSyncs = [
    {
      id: 1,
      profile_id: 'prof-home-lan',
      game_id: 3,
      queued_at: new Date(Date.now() - 18 * 60 * 1000).toISOString(),
      reason: 'Server unreachable at session exit',
    },
  ];

  let nextLogId = 4;
  const activityLogs = [
    {
      id: 3,
      profile_id: 'prof-home-lan',
      game_id: 1,
      game_name: 'Fogwoods',
      kind: 'sync_complete',
      level: 'accent',
      title: 'Auto-synced Fogwoods',
      detail: '2 uploaded (184.0 KB) · 312 unchanged',
      created_at: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
    },
    {
      id: 2,
      profile_id: 'prof-home-lan',
      game_id: 1,
      game_name: 'Fogwoods',
      kind: 'game_close',
      level: 'info',
      title: 'Closed Fogwoods',
      detail: 'Played 42m 15s · Auto-syncing saves…',
      created_at: new Date(Date.now() - 12 * 60 * 1000 - 2000).toISOString(),
    },
    {
      id: 1,
      profile_id: 'prof-home-lan',
      game_id: 1,
      game_name: 'Fogwoods',
      kind: 'game_start',
      level: 'info',
      title: 'Started Fogwoods',
      detail: 'Runtime: native',
      created_at: new Date(Date.now() - 54 * 60 * 1000).toISOString(),
    },
  ];

  const interruptedSessions = [];
  const playingMockGames = new Set();

  function pushMockActivity({ game_id = null, game_name = null, kind, level = 'info', title, detail = '' }) {
    const entry = {
      id: nextLogId++,
      profile_id: activeProfileId || 'prof-home-lan',
      game_id,
      game_name,
      kind,
      level,
      title,
      detail,
      created_at: new Date().toISOString(),
    };
    activityLogs.unshift(entry);
    emit({ type: 'activity_logged', entry: { ...entry } });
    return entry;
  }

  const games = [
    {
      game_id: 1,
      name: 'Fogwoods',
      slug: 'fogwoods',
      description: 'Explore mist-covered timberlines, tune forgotten radio towers, and uncover what happened to the ridge watch. Full differential save sync keeps your field journals and signal logs backed up across every machine on your LAN.',
      system_requirements: 'OS: Linux 64-bit\nCPU: Quad-core 2.6 GHz\nRAM: 8 GB\nGPU: Vulkan 1.2 compatible\nStorage: 2 GB available space',
      uploader_name: 'valerio',
      created_at: '2026-11-12T16:40:00Z',
      status: 'ready',
      total_size: 1975684956,
      download_count: 14,
      has_cover: true,
      has_overlay: true,
      installed: true,
      install_dir: '/home/valerio/.local/share/opensync-launcher/games/prof-home-lan/fogwoods',
      executable_rel_path: 'fogwoods.x86_64',
      discovered_executables: [
        { rel_path: 'fogwoods.x86_64', kind: 'LinuxElf', size: 48234496 },
        { rel_path: 'tools/tower-diag.sh', kind: 'ShellScript', size: 4210 },
      ],
      binary_kind: 'LinuxElf',
      proton_override: null,
      wine_prefix: null,
      launch_args: null,
      env_vars: [],
      last_synced_at: new Date(Date.now() - 32 * 60 * 1000).toISOString(),
      pending_sync: false,
      playtime: {
        total_secs: 15720,
        session_count: 9,
        last_played_at: new Date(Date.now() - 35 * 60 * 1000).toISOString(),
      },
    },
    {
      game_id: 2,
      name: 'Cyber Runner 2077',
      slug: 'cyber-runner-2077',
      description: 'High-speed neon parkour and tactical infiltration across a sprawling vertical megacity. Supports Windows PE launch via GE-Proton with automatic per-game WINE prefix isolation.',
      system_requirements: 'OS: Linux via Proton 9+\nCPU: 6-core 3.4 GHz\nRAM: 16 GB\nGPU: RTX 2060 / RX 6600\nStorage: 30 GB NVMe SSD',
      uploader_name: 'marco',
      created_at: '2026-11-18T20:15:00Z',
      status: 'ready',
      total_size: 30709016166,
      download_count: 9,
      has_cover: true,
      has_overlay: true,
      installed: false,
      install_dir: null,
      executable_rel_path: null,
      discovered_executables: [
        { rel_path: 'bin/x64/CyberRunner2077.exe', kind: 'WindowsPe', size: 92412000 },
      ],
      binary_kind: 'WindowsPe',
      proton_override: null,
      wine_prefix: null,
      launch_args: null,
      env_vars: [],
      last_synced_at: null,
      pending_sync: false,
      playtime: {
        total_secs: 0,
        session_count: 0,
        last_played_at: null,
      },
    },
    {
      game_id: 3,
      name: 'Hollow Spire',
      slug: 'hollow-spire',
      description: 'Ascend a fractured obsidian citadel where every floor shifts on each lunar cycle. Built for tight controller combat and instant save checkpoints.',
      system_requirements: 'OS: Linux via Proton\nCPU: Dual-core 2.4 GHz\nRAM: 8 GB\nGPU: DirectX 11 / DXVK\nStorage: 5 GB available space',
      uploader_name: 'elena',
      created_at: '2026-11-05T14:00:00Z',
      status: 'ready',
      total_size: 4423816806,
      download_count: 21,
      has_cover: true,
      has_overlay: true,
      installed: true,
      install_dir: '/home/valerio/.local/share/opensync-launcher/games/prof-home-lan/hollow-spire',
      executable_rel_path: 'HollowSpire.exe',
      discovered_executables: [
        { rel_path: 'HollowSpire.exe', kind: 'WindowsPe', size: 64120320 },
        { rel_path: 'ConfigTool.exe', kind: 'WindowsPe', size: 3120400 },
      ],
      binary_kind: 'WindowsPe',
      proton_override: 'GE-Proton9-25',
      wine_prefix: null,
      launch_args: '--windowed',
      env_vars: [{ key: 'DXVK_HUD', value: 'full' }],
      last_synced_at: new Date(Date.now() - 4 * 3600 * 1000).toISOString(),
      pending_sync: true,
      playtime: {
        total_secs: 42480,
        session_count: 16,
        last_played_at: new Date(Date.now() - 25 * 60 * 1000).toISOString(),
      },
    },
    {
      game_id: 4,
      name: 'Signal Drift',
      slug: 'signal-drift',
      description: 'Guide an autonomous relay probe through deep orbital debris fields using vector thrusters and acoustic radar.',
      system_requirements: 'OS: Linux 64-bit\nCPU: Dual-core 2.0 GHz\nRAM: 4 GB\nGPU: OpenGL 3.3\nStorage: 1 GB available space',
      uploader_name: 'valerio',
      created_at: '2026-10-29T09:12:00Z',
      status: 'ready',
      total_size: 964689920,
      download_count: 6,
      has_cover: true,
      has_overlay: false,
      installed: false,
      install_dir: null,
      executable_rel_path: null,
      discovered_executables: [],
      binary_kind: 'LinuxElf',
      proton_override: null,
      wine_prefix: null,
      launch_args: null,
      env_vars: [],
      last_synced_at: null,
      pending_sync: false,
      playtime: {
        total_secs: 0,
        session_count: 0,
        last_played_at: null,
      },
    },
    {
      game_id: 5,
      name: 'Starlight Foundry',
      slug: 'starlight-foundry',
      description: 'Automate orbital smelters, route hyper-rail logistics, and balance thermal grids across a tidally locked iron moon.',
      system_requirements: 'OS: Linux via Proton\nCPU: Quad-core 3.0 GHz\nRAM: 16 GB\nGPU: GTX 1660 / RX 5600\nStorage: 7 GB available space',
      uploader_name: 'marco',
      created_at: '2026-10-18T19:30:00Z',
      status: 'ready',
      total_size: 6925634764,
      download_count: 11,
      has_cover: true,
      has_overlay: false,
      installed: false,
      install_dir: null,
      executable_rel_path: null,
      discovered_executables: [],
      binary_kind: 'WindowsPe',
      proton_override: null,
      wine_prefix: null,
      launch_args: null,
      env_vars: [],
      last_synced_at: null,
      pending_sync: false,
      playtime: {
        total_secs: 0,
        session_count: 0,
        last_played_at: null,
      },
    },
    {
      game_id: 6,
      name: 'Velvet Echoes',
      slug: 'velvet-echoes',
      description: 'Late-night synth detective adventure set inside a rain-soaked coastal broadcast station. Every tape you splice changes the ending.',
      system_requirements: 'OS: Linux 64-bit\nCPU: Dual-core 2.2 GHz\nRAM: 8 GB\nGPU: Vulkan 1.1\nStorage: 2.5 GB available space',
      uploader_name: 'elena',
      created_at: '2026-10-04T22:00:00Z',
      status: 'ready',
      total_size: 2469606195,
      download_count: 8,
      has_cover: true,
      has_overlay: true,
      installed: true,
      install_dir: '/home/valerio/.local/share/opensync-launcher/games/prof-home-lan/velvet-echoes',
      executable_rel_path: 'velvet_echoes.x86_64',
      discovered_executables: [
        { rel_path: 'velvet_echoes.x86_64', kind: 'LinuxElf', size: 31802000 },
      ],
      binary_kind: 'LinuxElf',
      proton_override: null,
      wine_prefix: null,
      launch_args: null,
      env_vars: [],
      last_synced_at: new Date(Date.now() - 2 * 86400 * 1000).toISOString(),
      pending_sync: false,
      playtime: {
        total_secs: 4500,
        session_count: 3,
        last_played_at: new Date(Date.now() - 2 * 86400 * 1000).toISOString(),
      },
    },
  ];

  for (const game of games) {
    const uploaderId = game.uploader_name === 'valerio'
      ? 1
      : game.uploader_name === 'marco'
        ? 3
        : 4;
    game.uploaded_by = uploaderId;
    game.uploader_pfp = pfpStore.has(`${activeProfileId}_${uploaderId}`)
      ? `/api/auth/users/${uploaderId}/pfp`
      : '/img/blankpfp.jpg';
  }

  const sampleFiles = [
    'Data/Pak/city_night_04.pak',
    'Data/Pak/sector_09_lighting.pak',
    'Data/Audio/synth_stems_hq.bank',
    'Data/Textures/wet_asphalt_4k.dds',
    'Bin/x64/CyberRunner2077.exe',
    'Data/Shaders/ray_reflections.spv',
  ];

  const downloads = [
    {
      id: 'dl-1',
      name: 'Cyber Runner 2077',
      kind: { type: 'game', game_id: 2, fresh: false },
      status: { state: 'downloading' },
      bytes_downloaded: Math.round(30709016166 * 0.64),
      total_bytes: 30709016166,
      files_extracted: 142,
      total_files: 218,
      current_file: 'Data/Pak/city_night_04.pak',
      bytes_per_sec: 98_400_000,
      speed_samples: makeInitialSamples(96_000_000, 48),
      _phase: 0,
      _release: null,
    },
  ];

  function cloneJob(j) {
    return {
      id: j.id,
      name: j.name,
      kind: { ...j.kind },
      status: { ...j.status },
      bytes_downloaded: j.bytes_downloaded,
      total_bytes: j.total_bytes,
      files_extracted: j.files_extracted,
      total_files: j.total_files,
      current_file: j.current_file,
      bytes_per_sec: j.bytes_per_sec,
      speed_samples: j.speed_samples.slice(-60),
    };
  }

  // Live 250ms simulation tick for active downloads
  setInterval(() => {
    for (const job of downloads) {
      if (job.status.state === 'downloading') {
        job._phase += 0.35;
        const base = job.kind.type === 'proton' ? 54_000_000 : 96_000_000;
        const wave = Math.sin(job._phase) * 0.12 + Math.cos(job._phase * 0.43) * 0.08 + (Math.random() - 0.5) * 0.05;
        let bps = Math.max(4_000_000, base * (0.96 + wave));
        if (bandwidthLimit > 0) {
          bps = Math.min(bps, bandwidthLimit * (0.94 + Math.random() * 0.06));
        }
        const delta = Math.round(bps * 0.25);
        job.bytes_downloaded = Math.min(job.total_bytes, job.bytes_downloaded + delta);
        job.bytes_per_sec = bps;
        const pct = job.total_bytes > 0 ? job.bytes_downloaded / job.total_bytes : 1;
        job.files_extracted = Math.min(job.total_files, Math.floor(pct * job.total_files));
        if (job.kind.type === 'game') {
          job.current_file = sampleFiles[Math.floor(job._phase * 0.4) % sampleFiles.length];
        } else {
          job.current_file = pct < 0.85 ? `${job.name}.tar.gz` : 'Verifying SHA-512 checksum…';
        }
        const lastElapsed = job.speed_samples.length
          ? job.speed_samples[job.speed_samples.length - 1].elapsed_ms
          : 0;
        job.speed_samples.push({ elapsed_ms: lastElapsed + 250, bytes_per_sec: bps });
        if (job.speed_samples.length > 60) job.speed_samples.shift();

        if (job.bytes_downloaded >= job.total_bytes) {
          job.status = { state: 'verifying' };
          job.bytes_per_sec = 0;
          job.current_file = job.kind.type === 'proton'
            ? 'Verifying SHA-512 & unpacking Proton…'
            : 'Verifying SHA-256 manifest hashes…';
          emit({ type: 'download_updated', job: cloneJob(job) });
          setTimeout(() => {
            if (job.status.state !== 'verifying') return;
            job.status = { state: 'completed' };
            job.files_extracted = job.total_files;
            job.current_file = null;
            if (job.kind.type === 'game' && job.kind.game_id != null) {
              const g = games.find((x) => x.game_id === job.kind.game_id);
              if (g) {
                g.installed = true;
                g.install_dir = `/home/valerio/.local/share/opensync-launcher/games/${activeProfileId}/${g.slug}`;
                if (!g.executable_rel_path) {
                  g.executable_rel_path = g.binary_kind === 'WindowsPe' ? `${g.slug}.exe` : `${g.slug}.x86_64`;
                  g.discovered_executables = [
                    { rel_path: g.executable_rel_path, kind: g.binary_kind || 'LinuxElf', size: 42_000_000 },
                  ];
                }
                g.last_synced_at = new Date().toISOString();
                g.has_overlay = true;
              }
            } else if (job.kind.type === 'proton' && job._release) {
              const name = job._release.tag_name;
              const installation = {
                name,
                root_dir: `/home/valerio/.local/share/opensync-launcher/proton/${name}`,
                proton_script: `/home/valerio/.local/share/opensync-launcher/proton/${name}/proton`,
                source: 'OpenSyncManaged',
              };
              if (!protonInstallations.some((p) => p.name === name)) {
                protonInstallations.unshift(installation);
              }
              emit({ type: 'proton_installed', installation });
            }
            emit({ type: 'download_updated', job: cloneJob(job) });
          }, 1300);
        } else {
          emit({ type: 'download_updated', job: cloneJob(job) });
        }
      }
    }
  }, 250);

  // Live 200ms simulation tick for active uploads (browser preview only).
  function mockUploadSamples(baseBps, count = 12) {
    const out = [];
    for (let i = 0; i < count; i++) {
      const wave = Math.sin(i * 0.4) * 0.1 + Math.cos(i * 0.19) * 0.06;
      out.push({ elapsed_ms: i * 200, bytes_per_sec: Math.max(0, baseBps * (0.9 + wave)) });
    }
    return out;
  }

  setInterval(() => {
    for (const job of uploads) {
      if (job.status.state !== 'uploading') continue;
      const base = 48_000_000;
      const wave = Math.sin(job._phase * 0.5) * 0.12 + (Math.random() - 0.5) * 0.05;
      const bps = Math.max(4_000_000, base * (0.95 + wave));
      const delta = Math.round(bps * 0.2);
      job.bytes_uploaded = Math.min(job.total_bytes, job.bytes_uploaded + delta);
      job.bytes_per_sec = bps;
      job.files_uploaded = Math.min(job.total_files, Math.floor((job.bytes_uploaded / Math.max(1, job.total_bytes)) * job.total_files));
      const lastElapsed = job.speed_samples.length ? job.speed_samples[job.speed_samples.length - 1].elapsed_ms : 0;
      job.speed_samples.push({ elapsed_ms: lastElapsed + 200, bytes_per_sec: bps });
      if (job.speed_samples.length > 60) job.speed_samples.shift();
      job._phase += 1;
      if (job.bytes_uploaded >= job.total_bytes) {
        job.status = { state: 'indexing' };
        job.bytes_per_sec = 0;
        job.current_file = 'Building manifest…';
        emit({ type: 'upload_updated', job: cloneUploadJob(job) });
        setTimeout(() => {
          if (job.status.state !== 'indexing') return;
          job.status = { state: 'ready' };
          job.current_file = null;
          if (!job.game_id) {
            const gid = Math.max(0, ...games.map((g) => g.game_id)) + 1;
            job.game_id = gid;
            games.unshift({
              game_id: gid,
              name: job.name,
              slug: String(job.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `game-${gid}`,
              description: job.description || '',
              system_requirements: job.system_requirements || '',
              uploader_name: currentUser?.username || 'you',
              uploaded_by: currentUser?.id || 1,
              created_at: new Date().toISOString(),
              status: 'ready',
              total_size: job.total_bytes,
              download_count: 0,
              has_cover: Boolean(job.cover),
              has_overlay: false,
              installed: false,
              install_dir: null,
              executable_rel_path: null,
              discovered_executables: [],
              binary_kind: 'LinuxElf',
              proton_override: null,
              wine_prefix: null,
              launch_args: null,
              env_vars: [],
              last_synced_at: null,
              pending_sync: false,
              playtime: { total_secs: 0, session_count: 0, last_played_at: null },
            });
          }
          emit({ type: 'upload_updated', job: cloneUploadJob(job) });
        }, 1100);
      } else {
        emit({ type: 'upload_updated', job: cloneUploadJob(job) });
      }
    }
  }, 200);

  function cloneUploadJob(j) {
    return {
      id: j.id,
      name: j.name,
      game_id: j.game_id,
      status: { ...j.status },
      bytes_uploaded: j.bytes_uploaded,
      total_bytes: j.total_bytes,
      files_uploaded: j.files_uploaded,
      total_files: j.total_files,
      current_file: j.current_file,
      bytes_per_sec: j.bytes_per_sec,
      speed_samples: j.speed_samples.slice(-60),
    };
  }

  return {
    async invoke(cmd, args = {}) {
      switch (cmd) {
        case 'get_bootstrap_state': {
          const active = profiles.find((p) => p.id === activeProfileId) || null;
          return {
            active_profile: active ? { ...active } : null,
            profiles: profiles.map((p) => ({ ...p })),
            connection_state: { ...connectionState },
            proton_installations: protonInstallations.map((p) => ({ ...p })),
            pending_syncs: pendingSyncs
              .filter((s) => s.profile_id === activeProfileId)
              .map((s) => ({ ...s })),
            downloads: downloads.map(cloneJob),
            bandwidth_limit_bps: bandwidthLimit,
            games_dir: gamesDir,
            discord_rpc_enabled: discordRpcEnabled,
            activity_logs: activityLogs
              .filter((l) => l.profile_id === activeProfileId)
              .map((l) => ({ ...l })),
            interrupted_sessions: interruptedSessions
              .filter((s) => s.profile_id === activeProfileId)
              .map((s) => ({ ...s, sample_paths: [...(s.sample_paths || [])] })),
          };
        }

        case 'get_games_dir':
          return gamesDir;

        case 'set_games_dir': {
          const raw = String(args.path || '').trim();
          if (!raw) throw new Error('Games directory cannot be empty');
          gamesDir = raw === 'auto' ? '/home/user/Games/OpenSync' : raw;
          return gamesDir;
        }

        case 'get_discord_rpc_enabled':
          return discordRpcEnabled;

        case 'set_discord_rpc_enabled': {
          discordRpcEnabled = Boolean(args.enabled);
          return discordRpcEnabled;
        }

        case 'connect_profile': {
          const url = String(args.server_url || '').trim().replace(/\/+$/, '');
          if (!url.startsWith('http://') && !url.startsWith('https://')) {
            throw new Error('Server URL must start with http:// or https://');
          }
          const username = String(args.username || '').trim();
          if (!username) throw new Error('Username is required');
          const label = String(args.label || '').trim() || new URL(url).host;
          const existing = profiles.find(
            (p) => p.server_url === url && p.username.toLowerCase() === username.toLowerCase(),
          );
          if (existing) {
            existing.label = label;
            existing.last_connected_at = new Date().toISOString();
            activeProfileId = existing.id;
            syncCurrentUser();
            connectionState = { status: 'connected' };
            emit({ type: 'connection_changed', state: { ...connectionState } });
            return { ...existing };
          }
          const prof = {
            id: `prof-${Date.now()}`,
            label,
            server_url: url,
            username,
            user_id: profiles.length + 1,
            role: args.register ? 'user' : 'admin',
            created_at: new Date().toISOString(),
            last_connected_at: new Date().toISOString(),
          };
          profiles.unshift(prof);
          activeProfileId = prof.id;
          syncCurrentUser();
          connectionState = { status: 'connected' };
          emit({ type: 'connection_changed', state: { ...connectionState } });
          return { ...prof };
        }

        case 'switch_profile': {
          const found = profiles.find((p) => p.id === args.profile_id);
          if (!found) throw new Error('Profile not found');
          activeProfileId = found.id;
          found.last_connected_at = new Date().toISOString();
          syncCurrentUser();
          connectionState = { status: 'connected' };
          emit({ type: 'connection_changed', state: { ...connectionState } });
          return { ...found };
        }

        case 'delete_profile': {
          const idx = profiles.findIndex((p) => p.id === args.profile_id);
          if (idx !== -1) profiles.splice(idx, 1);
          if (activeProfileId === args.profile_id) {
            activeProfileId = profiles[0]?.id || null;
            syncCurrentUser();
            connectionState = activeProfileId ? { status: 'connected' } : { status: 'disconnected' };
            emit({ type: 'connection_changed', state: { ...connectionState } });
          }
          return true;
        }

        case 'get_current_user_profile': {
          if (!currentUser) throw new Error('Not connected to an instance');
          return { ...currentUser, stats: { ...currentUser.stats } };
        }

        case 'get_user_pfp_data_url': {
          return pfpStore.get(`${activeProfileId}_${args.user_id}`) || null;
        }

        case 'upload_profile_pfp': {
          if (!currentUser) throw new Error('Not connected to an instance');
          let bytes;
          if (Array.isArray(args.payload)) {
            bytes = Uint8Array.from(args.payload);
          } else {
            const raw = String(args.payload || '').trim();
            const b64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
            const decoded = atob(b64);
            bytes = Uint8Array.from(decoded, (c) => c.charCodeAt(0));
          }
          if (!bytes.length) throw new Error('profile picture is empty');
          if (bytes.length > 8 * 1024 * 1024) {
            throw new Error('profile picture too large (max 8 MB)');
          }
          const ct = String(args.content_type || '').toLowerCase();
          if (ct !== 'image/jpeg' && ct !== 'image/png') {
            throw new Error('profile picture must be image/jpeg or image/png');
          }
          let binary = '';
          for (const b of bytes) binary += String.fromCharCode(b);
          const dataUrl = `data:${ct};base64,${btoa(binary)}`;
          pfpStore.set(`${activeProfileId}_${currentUser.id}`, dataUrl);
          currentUser.pfp = `/api/auth/users/${currentUser.id}/pfp`;
          for (const g of games) {
            if (g.uploaded_by === currentUser.id) g.uploader_pfp = currentUser.pfp;
          }
          emit({ type: 'profile_updated', profile: profiles.find((p) => p.id === activeProfileId) });
          return currentUser.pfp;
        }

        case 'remove_profile_pfp': {
          if (!currentUser) throw new Error('Not connected to an instance');
          pfpStore.delete(`${activeProfileId}_${currentUser.id}`);
          currentUser.pfp = '/img/blankpfp.jpg';
          for (const g of games) {
            if (g.uploaded_by === currentUser.id) g.uploader_pfp = currentUser.pfp;
          }
          emit({ type: 'profile_updated', profile: profiles.find((p) => p.id === activeProfileId) });
          return currentUser.pfp;
        }

        case 'delete_server_account': {
          if (!currentUser) throw new Error('Not connected to an instance');
          const admins = profiles.filter((p) => p.role === 'admin');
          if (currentUser.role === 'admin' && admins.length <= 1) {
            throw new Error('api error: server returned 400: cannot delete the last admin');
          }
          const idx = profiles.findIndex((p) => p.id === activeProfileId);
          if (idx !== -1) profiles.splice(idx, 1);
          pfpStore.delete(`${activeProfileId}_${currentUser.id}`);
          activeProfileId = profiles[0]?.id || null;
          syncCurrentUser();
          connectionState = activeProfileId ? { status: 'connected' } : { status: 'disconnected' };
          emit({ type: 'connection_changed', state: { ...connectionState } });
          return true;
        }

        case 'rename_profile': {
          const target = profiles.find((p) => p.id === activeProfileId);
          if (!target) throw new Error('No active profile');
          const label = String(args.label || '').trim();
          if (!label) throw new Error('Instance label cannot be empty');
          target.label = label;
          const updated = { ...target };
          emit({ type: 'profile_updated', profile: updated });
          return updated;
        }

        case 'reconnect_now': {
          connectionState = { status: 'reconnecting', attempt: 1 };
          emit({ type: 'connection_changed', state: { ...connectionState } });
          await new Promise((r) => setTimeout(r, 550));
          connectionState = { status: 'connected' };
          emit({ type: 'connection_changed', state: { ...connectionState } });
          return { attempts: 1, flushed_syncs: 0 };
        }

        case 'list_library': {
          return games.map((g) => ({
            ...g,
            playtime: { ...g.playtime },
            discovered_executables: g.discovered_executables.map((e) => ({ ...e })),
          }));
        }

        case 'get_game_cover_data_url': {
          return PREVIEW_COVERS[args.game_id] || null;
        }

        case 'start_game_download': {
          const g = games.find((x) => x.game_id === args.game_id);
          if (!g) throw new Error('Game not found');
          const existing = downloads.find(
            (d) => d.kind.type === 'game' && d.kind.game_id === g.game_id
              && (d.status.state === 'downloading' || d.status.state === 'paused' || d.status.state === 'verifying'),
          );
          if (existing) {
            existing.status = { state: 'downloading' };
            emit({ type: 'download_updated', job: cloneJob(existing) });
            return existing.id;
          }
          const job = {
            id: `dl-${nextJobSeq++}`,
            name: g.name,
            kind: { type: 'game', game_id: g.game_id, fresh: Boolean(args.fresh) },
            status: { state: 'downloading' },
            bytes_downloaded: 0,
            total_bytes: Math.max(g.total_size, 320_000_000),
            files_extracted: 0,
            total_files: 64,
            current_file: 'Preparing streaming archive…',
            bytes_per_sec: 84_000_000,
            speed_samples: makeInitialSamples(84_000_000, 12),
            _phase: 0,
            _release: null,
          };
          downloads.unshift(job);
          emit({ type: 'download_updated', job: cloneJob(job) });
          return job.id;
        }

        case 'pause_download': {
          const job = downloads.find((d) => d.id === args.job_id);
          if (job && job.status.state === 'downloading') {
            job.status = { state: 'paused' };
            job.bytes_per_sec = 0;
            emit({ type: 'download_updated', job: cloneJob(job) });
            return true;
          }
          return false;
        }

        case 'resume_download': {
          const job = downloads.find((d) => d.id === args.job_id);
          if (job && job.status.state === 'paused') {
            job.status = { state: 'downloading' };
            emit({ type: 'download_updated', job: cloneJob(job) });
            return true;
          }
          return false;
        }

        case 'cancel_download': {
          const idx = downloads.findIndex((d) => d.id === args.job_id);
          if (idx !== -1) {
            const [job] = downloads.splice(idx, 1);
            job.status = { state: 'cancelled' };
            job.bytes_per_sec = 0;
            emit({ type: 'download_updated', job: cloneJob(job) });
            return true;
          }
          return false;
        }

        case 'set_bandwidth_limit': {
          bandwidthLimit = Math.max(0, Number(args.bytes_per_sec || 0));
          return bandwidthLimit;
        }

        case 'list_downloads': {
          return downloads.map(cloneJob);
        }

        case 'launch_game': {
          const g = games.find((x) => x.game_id === args.game_id);
          if (!g || !g.installed) throw new Error('Game is not installed');
          playingMockGames.add(g.game_id);
          const runtime = g.proton_override || (g.binary_kind === 'windows_pe' ? 'GE-Proton9-25' : 'native');
          const lines = gameLogs.get(g.game_id) || [];
          lines.push(
            `===== ${new Date().toISOString()} · ${g.name} · runtime: ${runtime} =====`,
            `Launch arguments: ${g.launch_args || '(none)'}`,
            `Custom prefix: ${g.wine_prefix || '(automatic)'}`,
            ...(g.env_vars || []).map((v) => `${v.key}=${v.value}`),
            'Process started.',
          );
          gameLogs.set(g.game_id, lines.slice(-400));
          pushMockActivity({
            game_id: g.game_id,
            game_name: g.name,
            kind: 'game_start',
            level: 'info',
            title: `Started ${g.name}`,
            detail: `Runtime: ${runtime}`,
          });
          emit({
            type: 'game_session_started',
            game_id: g.game_id,
            name: g.name,
          });
          // Simulate a live play session that exits after 2.6s and auto-syncs saves
          setTimeout(() => {
            playingMockGames.delete(g.game_id);
            pushMockActivity({
              game_id: g.game_id,
              game_name: g.name,
              kind: 'game_close',
              level: 'info',
              title: `Closed ${g.name}`,
              detail: 'Played 4m · Auto-syncing saves…',
            });
            emit({
              type: 'game_sync_started',
              game_id: g.game_id,
              name: g.name,
              trigger: 'post_exit',
            });
            setTimeout(() => {
              const durationSecs = 240;
              g.playtime.total_secs += durationSecs;
              g.playtime.session_count += 1;
              g.playtime.last_played_at = new Date().toISOString();
              g.last_synced_at = new Date().toISOString();
              g.pending_sync = false;
              g.has_overlay = true;
              const pIdx = pendingSyncs.findIndex((p) => p.game_id === g.game_id);
              if (pIdx !== -1) pendingSyncs.splice(pIdx, 1);

              pushMockActivity({
                game_id: g.game_id,
                game_name: g.name,
                kind: 'sync_complete',
                level: 'accent',
                title: `Auto-synced ${g.name}`,
                detail: '2 uploaded (184.0 KB) · 148 unchanged',
              });
              emit({
                type: 'game_sync_completed',
                game_id: g.game_id,
                name: g.name,
                trigger: 'post_exit',
                uploaded_files: 2,
                uploaded_bytes: 188416,
                deleted_paths: 0,
              });
              emit({
                type: 'game_session_ended',
                game_id: g.game_id,
                name: g.name,
                duration_secs: durationSecs,
                synced: true,
                uploaded_files: 2,
                uploaded_bytes: 188416,
                deleted_paths: 0,
                error: null,
              });
            }, 1350);
          }, 2600);
          return true;
        }

        case 'sync_game_now': {
          const g = games.find((x) => x.game_id === args.game_id);
          if (!g || !g.installed) throw new Error('Game is not installed');
          emit({
            type: 'game_sync_started',
            game_id: g.game_id,
            name: g.name,
            trigger: 'manual',
          });
          await new Promise((r) => setTimeout(r, 900));
          g.last_synced_at = new Date().toISOString();
          g.pending_sync = false;
          g.has_overlay = true;
          const pIdx = pendingSyncs.findIndex((p) => p.game_id === g.game_id);
          if (pIdx !== -1) pendingSyncs.splice(pIdx, 1);
          pushMockActivity({
            game_id: g.game_id,
            game_name: g.name,
            kind: 'sync_complete',
            level: 'accent',
            title: `Synced saves for ${g.name}`,
            detail: '3 uploaded (288.0 KB) · 148 unchanged',
          });
          emit({
            type: 'game_sync_completed',
            game_id: g.game_id,
            name: g.name,
            trigger: 'manual',
            uploaded_files: 3,
            uploaded_bytes: 294912,
            deleted_paths: 0,
          });
          return {
            uploaded_files: 3,
            uploaded_bytes: 294912,
            deleted_paths: 0,
            skipped_unchanged: 148,
          };
        }

        case 'uninstall_game': {
          const g = games.find((x) => x.game_id === args.game_id);
          if (!g) throw new Error('Game not found');
          g.installed = false;
          g.install_dir = null;
          g.pending_sync = false;
          return true;
        }

        case 'set_game_executable': {
          const g = games.find((x) => x.game_id === args.game_id);
          if (!g) throw new Error('Game not found');
          g.executable_rel_path = args.rel_path || null;
          const match = g.discovered_executables.find((e) => e.rel_path === args.rel_path);
          if (match) g.binary_kind = match.kind;
          return true;
        }

        case 'set_game_proton': {
          const g = games.find((x) => x.game_id === args.game_id);
          if (!g) throw new Error('Game not found');
          g.proton_override = args.proton_name || null;
          return true;
        }

        case 'set_game_launch_config': {
          const g = games.find((x) => x.game_id === args.game_id);
          if (!g) throw new Error('Game not found');
          const config = args.config || {};
          if ((config.wine_prefix || '').includes('\0')) {
            throw new Error('Wine prefix path cannot contain NUL bytes');
          }
          if ((config.launch_args || '').includes('\0')) {
            throw new Error('Launch arguments cannot contain NUL bytes');
          }
          const normalizedEnv = [];
          for (const v of config.env_vars || []) {
            const key = (v.key || '').trim();
            const value = String(v.value ?? '');
            if (value.includes('\0')) {
              throw new Error(`Value for ${key} cannot contain NUL bytes`);
            }
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
              throw new Error(`Invalid environment variable name: ${v.key}`);
            }
            const existing = normalizedEnv.find((e) => e.key === key);
            if (existing) existing.value = value;
            else normalizedEnv.push({ key, value });
          }
          const rawPrefix = (config.wine_prefix || '').trim();
          const expandedPrefix = rawPrefix === '~'
            ? '/home/valerio'
            : rawPrefix.startsWith('~/')
              ? `/home/valerio/${rawPrefix.slice(2)}`
              : rawPrefix;
          g.wine_prefix = expandedPrefix || null;
          g.launch_args = (config.launch_args || '').trim() || null;
          g.env_vars = normalizedEnv;
          return {
            profile_id: activeProfileId || 'prof-home-lan',
            game_id: g.game_id,
            wine_prefix: g.wine_prefix,
            launch_args: g.launch_args,
            env_vars: g.env_vars,
          };
        }

        case 'pick_wine_prefix_dir': {
          return '/home/user/Games/OpenSync/prefixes';
        }

        case 'get_game_log': {
          const lines = gameLogs.get(args.game_id) || [];
          return lines.length ? lines.slice(-400).join('\n') : null;
        }

        case 'clear_game_log': {
          gameLogs.delete(args.game_id);
          return true;
        }

        case 'list_proton_installations': {
          return protonInstallations.map((p) => ({ ...p }));
        }

        case 'fetch_latest_ge_proton': {
          await new Promise((r) => setTimeout(r, 420));
          return {
            tag_name: 'GE-Proton9-27',
            tarball_url: 'https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton9-27/GE-Proton9-27.tar.gz',
            tarball_name: 'GE-Proton9-27.tar.gz',
            tarball_size: 490_733_568,
            sha512_url: 'https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton9-27/GE-Proton9-27.sha512sum',
          };
        }

        case 'download_ge_proton': {
          const rel = args.release;
          if (!rel || !rel.tag_name) throw new Error('Missing GE-Proton release payload');
          const job = {
            id: `dl-${nextJobSeq++}`,
            name: rel.tag_name,
            kind: { type: 'proton', tag_name: rel.tag_name },
            status: { state: 'downloading' },
            bytes_downloaded: 0,
            total_bytes: rel.tarball_size || 490_733_568,
            files_extracted: 0,
            total_files: 1,
            current_file: rel.tarball_name,
            bytes_per_sec: 56_000_000,
            speed_samples: makeInitialSamples(54_000_000, 10),
            _phase: 0,
            _release: rel,
          };
          downloads.unshift(job);
          emit({ type: 'download_updated', job: cloneJob(job) });
          return job.id;
        }

        case 'change_username': {
          if (!currentUser) throw new Error('Not connected to an instance');
          const next = String(args.username || '').trim();
          if (!next) throw new Error('Profile name cannot be empty');
          if (profiles.some((p) => p.id !== activeProfileId && p.username.toLowerCase() === next.toLowerCase())) {
            throw new Error('server returned 409: username already taken');
          }
          currentUser.username = next;
          for (const p of profiles) {
            if (p.id === activeProfileId || p.user_id === currentUser.id) p.username = next;
          }
          const updated = profiles.find((p) => p.id === activeProfileId);
          emit({ type: 'profile_updated', profile: updated });
          return updated;
        }

        case 'pick_upload_folder': {
          return '/home/user/Games/My Game';
        }

        case 'scan_upload_folder': {
          const raw = String(args.path || '').trim();
          if (!raw) throw new Error('Folder path is empty');
          const name = raw.replace(/\/+$/, '').split(/[\\/]/).pop() || 'Game';
          return {
            file_count: 42,
            total_bytes: 1_374_000_000,
            name: name.replace(/[_-]+/g, ' ').trim(),
            top_files: [
              'Data/Pak/main.pak',
              'Data/Textures/hd_4k.dds',
              'Bin/game.exe',
              'Data/Audio/ost.bank',
            ],
          };
        }

        case 'inspect_dropped_paths': {
          const paths = Array.isArray(args.paths) ? args.paths : [];
          return paths.map((raw) => {
            const p = String(raw || '').trim();
            const name = p.replace(/\/+$/, '').split(/[\\/]/).pop() || p;
            const is_image = /\.(jpe?g|png)$/i.test(name);
            const hasFileExt = /\.[a-z0-9]{1,8}$/i.test(name);
            return {
              path: p,
              name,
              is_dir: !is_image && !hasFileExt,
              is_image,
              size: is_image ? 2048 : 0,
            };
          });
        }

        case 'read_local_image': {
          throw new Error('Local filesystem image paths require desktop runtime');
        }

        case 'start_game_upload': {
          if (!currentUser) throw new Error('Not connected to an instance');
          const name = String(args.name || '').trim();
          if (!name) throw new Error('Game name is required');
          const total = 320_000_000 + Math.floor(Math.random() * 180_000_000);
          const job = {
            id: `up-${nextUploadSeq++}`,
            name,
            game_id: null,
            description: String(args.description || ''),
            system_requirements: String(args.system_requirements || ''),
            cover: Boolean(args.cover),
            status: { state: 'uploading' },
            bytes_uploaded: 0,
            total_bytes: total,
            files_uploaded: 0,
            total_files: 48,
            current_file: 'Data/Pak/main.pak',
            bytes_per_sec: 48_000_000,
            speed_samples: mockUploadSamples(48_000_000, 10),
            _phase: 0,
          };
          uploads.unshift(job);
          emit({ type: 'upload_updated', job: cloneUploadJob(job) });
          return job.id;
        }

        case 'upload_game_chunk': {
          const job = uploads.find((u) => u.id === args.job_id);
          if (!job) throw new Error('Upload job not found');
          return true;
        }

        case 'finalize_dropped_upload': {
          const job = uploads.find((u) => u.id === args.job_id);
          if (!job) throw new Error('Upload job not found');
          return true;
        }

        case 'pause_upload': {
          const job = uploads.find((u) => u.id === args.job_id);
          if (job && (job.status.state === 'uploading' || job.status.state === 'queued')) {
            job.status = { state: 'paused' };
            job.bytes_per_sec = 0;
            emit({ type: 'upload_updated', job: cloneUploadJob(job) });
            return true;
          }
          return false;
        }

        case 'resume_upload': {
          const job = uploads.find((u) => u.id === args.job_id);
          if (job && job.status.state === 'paused') {
            job.status = { state: 'uploading' };
            emit({ type: 'upload_updated', job: cloneUploadJob(job) });
            return true;
          }
          return false;
        }

        case 'cancel_upload': {
          const idx = uploads.findIndex((u) => u.id === args.job_id);
          if (idx !== -1) {
            const [job] = uploads.splice(idx, 1);
            job.status = { state: 'cancelled' };
            job.bytes_per_sec = 0;
            emit({ type: 'upload_updated', job: cloneUploadJob(job) });
            return true;
          }
          return false;
        }

        case 'list_uploads': {
          return uploads.map(cloneUploadJob);
        }

        case 'list_activity_logs': {
          const limit = Number(args.limit || 80);
          return activityLogs
            .filter((l) => l.profile_id === activeProfileId)
            .slice(0, limit)
            .map((l) => ({ ...l }));
        }

        case 'clear_activity_logs': {
          for (let i = activityLogs.length - 1; i >= 0; i--) {
            if (activityLogs[i].profile_id === activeProfileId) {
              activityLogs.splice(i, 1);
            }
          }
          return true;
        }

        case 'list_interrupted_sessions': {
          return interruptedSessions
            .filter((s) => s.profile_id === activeProfileId)
            .map((s) => ({ ...s, sample_paths: [...(s.sample_paths || [])] }));
        }

        case 'resolve_interrupted_session': {
          const idx = interruptedSessions.findIndex((s) => s.game_id === args.game_id);
          const session = idx !== -1 ? interruptedSessions.splice(idx, 1)[0] : null;
          const g = games.find((x) => x.game_id === args.game_id);
          const gName = session?.game_name || g?.name || `Game #${args.game_id}`;
          if (!args.sync_saves) {
            pushMockActivity({
              game_id: args.game_id,
              game_name: gName,
              kind: 'crash_resolved',
              level: 'info',
              title: `Dismissed save recovery for ${gName}`,
              detail: 'Local save files kept on disk without uploading',
            });
            return null;
          }
          emit({
            type: 'game_sync_started',
            game_id: args.game_id,
            name: gName,
            trigger: 'recovery',
          });
          await new Promise((r) => setTimeout(r, 950));
          if (g) {
            g.last_synced_at = new Date().toISOString();
            g.pending_sync = false;
            g.has_overlay = true;
          }
          const uploadedFiles = session?.changed_files || 2;
          const uploadedBytes = session?.changed_bytes || 245760;
          pushMockActivity({
            game_id: args.game_id,
            game_name: gName,
            kind: 'sync_complete',
            level: 'accent',
            title: `Recovered & synced saves for ${gName}`,
            detail: `${uploadedFiles} uploaded (${(uploadedBytes / 1024).toFixed(1)} KB)`,
          });
          emit({
            type: 'game_sync_completed',
            game_id: args.game_id,
            name: gName,
            trigger: 'recovery',
            uploaded_files: uploadedFiles,
            uploaded_bytes: uploadedBytes,
            deleted_paths: 0,
          });
          return {
            uploaded_files: uploadedFiles,
            uploaded_bytes: uploadedBytes,
            deleted_paths: 0,
            skipped_unchanged: 120,
          };
        }

        case 'get_shutdown_status': {
          const playingNames = [...playingMockGames].map(
            (id) => games.find((g) => g.game_id === id)?.name || `Game #${id}`,
          );
          const activeDls = downloads.filter((d) =>
            ['queued', 'downloading', 'verifying'].includes(d.status?.state),
          ).length;
          const activeUps = uploads.filter((u) =>
            ['queued', 'uploading', 'indexing'].includes(u.status?.state),
          ).length;
          return {
            active_syncs: 0,
            playing_games: playingNames,
            active_downloads: activeDls,
            active_uploads: activeUps,
            ready_to_exit: playingNames.length === 0 && activeDls === 0 && activeUps === 0,
          };
        }

        case 'confirm_safe_shutdown': {
          const playingNames = [...playingMockGames].map(
            (id) => games.find((g) => g.game_id === id)?.name || `Game #${id}`,
          );
          if (!args.force_while_playing && playingNames.length > 0) {
            return {
              completed: false,
              active_syncs_remaining: 0,
              playing_games: playingNames,
              wal_checkpointed: false,
            };
          }
          emit({
            type: 'shutdown_progress',
            stage: 'waiting_for_sync',
            active_syncs: 0,
            message: 'Checkpointing SQLite WAL and flushing session state…',
          });
          await new Promise((r) => setTimeout(r, 450));
          pushMockActivity({
            kind: 'safe_shutdown',
            level: 'info',
            title: 'Safe shutdown completed',
            detail: 'In-flight save syncs flushed and SQLite WAL checkpointed',
          });
          emit({
            type: 'shutdown_progress',
            stage: 'ready',
            active_syncs: 0,
            message: 'Safe shutdown complete',
          });
          return {
            completed: true,
            active_syncs_remaining: 0,
            playing_games: playingNames,
            wal_checkpointed: true,
          };
        }

        case 'simulate_interrupted_session': {
          const g = games.find((x) => x.game_id === (args.game_id || 1)) || games[0];
          const dto = {
            profile_id: activeProfileId || 'prof-home-lan',
            game_id: g.game_id,
            game_name: g.name,
            install_dir: g.install_dir || `/home/user/Games/OpenSync/${g.slug}`,
            runtime: g.proton_override || 'native',
            started_at: new Date(Date.now() - 25 * 60 * 1000).toISOString(),
            last_heartbeat_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
            active_secs: 1380,
            has_unsynced_saves: true,
            changed_files: 2,
            deleted_files: 0,
            changed_bytes: 245760,
            sample_paths: ['saves/slot1.sav', 'saves/autosave_checkpoint.dat'],
          };
          interruptedSessions.push(dto);
          pushMockActivity({
            game_id: g.game_id,
            game_name: g.name,
            kind: 'crash_detected',
            level: 'warn',
            title: `Interrupted session detected for ${g.name}`,
            detail: '2 unsynced save file(s) (240.0 KB) found after unexpected close',
          });
          emit({ type: 'interrupted_session_detected', session: { ...dto } });
          return dto;
        }

        default:
          throw new Error(`Unknown command: ${cmd}`);
      }
    },

    async listen(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };
}

const mock = isTauri ? null : createMockRuntime();

async function invokeCmd(cmd, args = {}) {
  if (isTauri) {
    return tauriInternals.invoke(cmd, args);
  }
  return mock.invoke(cmd, args);
}

// Minimal equivalent of `@tauri-apps/api/event`'s listen(), built on the
// low-level internals that Tauri always injects (no global API object needed).
async function tauriListen(event, handler) {
  const internals = tauriInternals;
  const callbackId = internals.transformCallback((e) => handler(e.payload));
  const eventId = await internals.invoke('plugin:event|listen', {
    event,
    target: { kind: 'Any' },
    handler: callbackId,
  });
  return async () => {
    internals.unregisterCallback(callbackId);
    window.__TAURI_EVENT_PLUGIN_INTERNALS__?.unregisterListener?.(event, eventId);
    await internals.invoke('plugin:event|unlisten', { event, eventId }).catch(() => {});
  };
}

export async function listenEvents(handler) {
  if (isTauri) {
    return tauriListen('launcher-event', handler);
  }
  return mock.listen(handler);
}

export async function listenDragDrop(handler) {
  if (isTauri) {
    return tauriListen('launcher-drag-drop', handler);
  }
  return () => {};
}

export const bridge = {
  getBootstrapState: () => invokeCmd('get_bootstrap_state'),
  getGamesDir: () => invokeCmd('get_games_dir'),
  setGamesDir: (path) => invokeCmd('set_games_dir', { path }),
  getDiscordRpcEnabled: () => invokeCmd('get_discord_rpc_enabled'),
  setDiscordRpcEnabled: (enabled) => invokeCmd('set_discord_rpc_enabled', { enabled }),
  connectProfile: ({ label, server_url, username, password, register = false }) =>
    invokeCmd('connect_profile', { label, server_url, username, password, register }),
  switchProfile: (profile_id) => invokeCmd('switch_profile', { profile_id }),
  deleteProfile: (profile_id) => invokeCmd('delete_profile', { profile_id }),
  getCurrentUserProfile: () => invokeCmd('get_current_user_profile'),
  getUserPfpDataUrl: (pfp_path, user_id) =>
    invokeCmd('get_user_pfp_data_url', { pfp_path, user_id }),
  uploadProfilePfp: (payload, content_type) =>
    invokeCmd('upload_profile_pfp', { payload, content_type }),
  removeProfilePfp: () => invokeCmd('remove_profile_pfp'),
  deleteServerAccount: () => invokeCmd('delete_server_account'),
  renameProfile: (label) => invokeCmd('rename_profile', { label }),
  reconnectNow: () => invokeCmd('reconnect_now'),
  listLibrary: () => invokeCmd('list_library'),
  getGameCoverDataUrl: (game_id) => invokeCmd('get_game_cover_data_url', { game_id }),
  startGameDownload: (game_id, fresh = false) =>
    invokeCmd('start_game_download', { game_id, fresh }),
  pauseDownload: (job_id) => invokeCmd('pause_download', { job_id }),
  resumeDownload: (job_id) => invokeCmd('resume_download', { job_id }),
  cancelDownload: (job_id) => invokeCmd('cancel_download', { job_id }),
  setBandwidthLimit: (bytes_per_sec) =>
    invokeCmd('set_bandwidth_limit', { bytes_per_sec }),
  listDownloads: () => invokeCmd('list_downloads'),
  launchGame: (game_id) => invokeCmd('launch_game', { game_id }),
  syncGameNow: (game_id, force = false) =>
    invokeCmd('sync_game_now', { game_id, force }),
  uninstallGame: (game_id) => invokeCmd('uninstall_game', { game_id }),
  setGameExecutable: (game_id, rel_path) =>
    invokeCmd('set_game_executable', { game_id, rel_path }),
  setGameProton: (game_id, proton_name) =>
    invokeCmd('set_game_proton', { game_id, proton_name }),
  setGameLaunchConfig: (game_id, config) =>
    invokeCmd('set_game_launch_config', { game_id, config }),
  pickWinePrefixDir: () => invokeCmd('pick_wine_prefix_dir'),
  getGameLog: (game_id, max_bytes = 64 * 1024) =>
    invokeCmd('get_game_log', { game_id, max_bytes }),
  clearGameLog: (game_id) => invokeCmd('clear_game_log', { game_id }),
  listProtonInstallations: () => invokeCmd('list_proton_installations'),
  fetchLatestGeProton: () => invokeCmd('fetch_latest_ge_proton'),
  downloadGeProton: (release) => invokeCmd('download_ge_proton', { release }),
  changeUsername: (username) => invokeCmd('change_username', { username }),
  pickUploadFolder: () => invokeCmd('pick_upload_folder'),
  scanUploadFolder: (path) => invokeCmd('scan_upload_folder', { path }),
  inspectDroppedPaths: (paths) => invokeCmd('inspect_dropped_paths', { paths }),
  readLocalImage: (path) => invokeCmd('read_local_image', { path }),
  startGameUpload: ({ name, description, system_requirements, folder, cover, cover_content_type }) =>
    invokeCmd('start_game_upload', {
      name,
      description,
      system_requirements,
      folder,
      cover,
      cover_content_type,
    }),
  uploadGameChunk: ({ job_id, rel_path, index, total, size, chunk = null, chunk_base64 = null }) =>
    invokeCmd('upload_game_chunk', { job_id, rel_path, index, total, size, chunk, chunk_base64 }),
  finalizeDroppedUpload: (job_id) => invokeCmd('finalize_dropped_upload', { job_id }),
  pauseUpload: (job_id) => invokeCmd('pause_upload', { job_id }),
  resumeUpload: (job_id) => invokeCmd('resume_upload', { job_id }),
  cancelUpload: (job_id) => invokeCmd('cancel_upload', { job_id }),
  listUploads: () => invokeCmd('list_uploads'),
  listActivityLogs: (limit = 80) => invokeCmd('list_activity_logs', { limit }),
  clearActivityLogs: () => invokeCmd('clear_activity_logs'),
  listInterruptedSessions: () => invokeCmd('list_interrupted_sessions'),
  resolveInterruptedSession: (game_id, sync_saves = true, force = false) =>
    invokeCmd('resolve_interrupted_session', { game_id, sync_saves, force }),
  getShutdownStatus: () => invokeCmd('get_shutdown_status'),
  confirmSafeShutdown: (force_while_playing = false) =>
    invokeCmd('confirm_safe_shutdown', { force_while_playing }),
  simulateInterruptedSession: (game_id = 1) =>
    invokeCmd('simulate_interrupted_session', { game_id }),
};
