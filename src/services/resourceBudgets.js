/**
 * How much of the machine the app may use: CPU workers and GPU work for the
 * viewshed, and how much RAM the tile and height caches may hold.
 *
 * Four profiles (light, balanced, high, max); `balanced` is what upstream
 * shipped, `high` is the default. Any single budget can be overridden on top
 * of a profile. The choice is kept in localStorage so it survives reloads.
 * GUI: VIEWSHED → Machine use. Features Code: `budget …`.
 *
 * Budgets are read when work starts (a viewshed run, a tileset or tile
 * source being created); changing them applies from the next run, and the
 * Google 3D tileset cache is resized live by the app (controls.js).
 */

const MB = 1024 * 1024;
const STORAGE_KEY = 'omni.resourceBudgets.v1';

/**
 * Every budget, per profile. `cpuWorkers: 'auto'` resolves from the core
 * count (see resolveWorkers).
 */
export const BUDGET_PROFILES = Object.freeze({
  light: Object.freeze({
    cpuWorkers: 'auto',
    hybrid: false,
    gpuWorkScale: 0.5,
    gpuBatchCells: 131_072,
    maxObservers: 1000,
    pointCellsGpu: 500_000,
    wideCellsGpu: 2_000_000,
    cpuCells: 100_000,
    meshCells: 150_000,
    demConcurrency: 2,
    sampleConcurrency: 2,
    gridCacheMB: 64,
    tilesetCacheMB: 512,
    tilesetOverflowMB: 512,
    globeTileCache: 100,
    terrainHeightEntries: 10_000,
  }),
  balanced: Object.freeze({
    cpuWorkers: 'auto',
    hybrid: false,
    gpuWorkScale: 1,
    gpuBatchCells: 262_144,
    maxObservers: 2000,
    pointCellsGpu: 1_000_000,
    wideCellsGpu: 4_000_000,
    cpuCells: 250_000,
    meshCells: 250_000,
    demConcurrency: 4,
    sampleConcurrency: 4,
    gridCacheMB: 128,
    tilesetCacheMB: 1536,
    tilesetOverflowMB: 1024,
    globeTileCache: 100,
    terrainHeightEntries: 20_000,
  }),
  high: Object.freeze({
    cpuWorkers: 'auto',
    hybrid: true,
    gpuWorkScale: 4,
    gpuBatchCells: 1_048_576,
    maxObservers: 8000,
    pointCellsGpu: 4_000_000,
    wideCellsGpu: 16_000_000,
    cpuCells: 1_000_000,
    meshCells: 600_000,
    demConcurrency: 8,
    sampleConcurrency: 8,
    gridCacheMB: 768,
    tilesetCacheMB: 4096,
    tilesetOverflowMB: 2048,
    globeTileCache: 1000,
    terrainHeightEntries: 100_000,
  }),
  max: Object.freeze({
    cpuWorkers: 'auto',
    hybrid: true,
    gpuWorkScale: 12,
    gpuBatchCells: 4_194_304,
    maxObservers: 20_000,
    pointCellsGpu: 16_000_000,
    wideCellsGpu: 36_000_000,
    cpuCells: 2_000_000,
    meshCells: 1_200_000,
    demConcurrency: 12,
    sampleConcurrency: 12,
    gridCacheMB: 2048,
    tilesetCacheMB: 8192,
    tilesetOverflowMB: 4096,
    globeTileCache: 4000,
    terrainHeightEntries: 400_000,
  }),
});

export const DEFAULT_PROFILE = 'high';

/** Allowed range per numeric budget; set() clamps into it. */
export const BUDGET_LIMITS = Object.freeze({
  cpuWorkers: [1, 64],
  gpuWorkScale: [0.1, 64],
  gpuBatchCells: [16_384, 16_777_216],
  maxObservers: [8, 100_000],
  pointCellsGpu: [10_000, 64_000_000],
  wideCellsGpu: [10_000, 64_000_000],
  cpuCells: [10_000, 16_000_000],
  meshCells: [10_000, 8_000_000],
  demConcurrency: [1, 32],
  sampleConcurrency: [1, 32],
  gridCacheMB: [16, 16_384],
  tilesetCacheMB: [128, 32_768],
  tilesetOverflowMB: [0, 32_768],
  globeTileCache: [50, 20_000],
  terrainHeightEntries: [1000, 5_000_000],
});

/** Short names accepted by set() and Features Code `budget <name> <value>`. */
export const BUDGET_ALIASES = Object.freeze({
  workers: 'cpuWorkers',
  cpu: 'cpuWorkers',
  hybrid: 'hybrid',
  gpu: 'gpuWorkScale',
  work: 'gpuWorkScale',
  batch: 'gpuBatchCells',
  observers: 'maxObservers',
  cells: 'pointCellsGpu',
  wide: 'wideCellsGpu',
  mesh: 'meshCells',
  fetch: 'demConcurrency',
  grids: 'gridCacheMB',
  cache: 'tilesetCacheMB',
  tiles: 'tilesetCacheMB',
  overflow: 'tilesetOverflowMB',
  globe: 'globeTileCache',
  heights: 'terrainHeightEntries',
});

/** CPU workers for a profile on a machine with `cores` logical cores. */
export function resolveWorkers(profile, cores) {
  const c = Math.max(1, Math.floor(Number(cores) || 4));
  if (profile === 'light') return Math.min(2, c);
  if (profile === 'balanced') return Math.max(1, Math.min(8, c - 1));
  if (profile === 'max') return c;
  return Math.max(1, c - 1); // high: every core but one, for the page
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

function defaultStorage() {
  try {
    const s = globalThis.localStorage;
    if (s && typeof s.getItem === 'function') return s;
  } catch {
    // blocked storage: fall through
  }
  return memoryStorage();
}

function parseBool(v) {
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['on', 'true', 'yes', '1'].includes(s)) return true;
  if (['off', 'false', 'no', '0'].includes(s)) return false;
  return null;
}

/** "4 GB", "4096", "4096mb", "1.5g", "2M", "250k" → a number (MB for *MB keys). */
export function parseBudgetValue(key, value) {
  if (key === 'hybrid') return parseBool(value);
  if (key === 'cpuWorkers' && String(value).trim().toLowerCase() === 'auto')
    return 'auto';
  const m = /^\s*([\d.]+)\s*([a-z]*)\s*$/i.exec(String(value));
  if (!m) return null;
  let n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2].toLowerCase();
  if (key.endsWith('MB')) {
    if (unit === 'g' || unit === 'gb') n *= 1024;
    else if (unit && unit !== 'm' && unit !== 'mb') return null;
  } else if (unit === 'k') n *= 1e3;
  else if (unit === 'm') n *= 1e6;
  else if (unit && unit !== 'x') return null;
  return n;
}

export function createResourceBudgets({
  storage = defaultStorage(),
  cores = globalThis.navigator?.hardwareConcurrency,
  memoryGB = globalThis.navigator?.deviceMemory,
} = {}) {
  let profile = DEFAULT_PROFILE;
  let overrides = {};
  const listeners = new Set();

  try {
    const saved = JSON.parse(storage.getItem(STORAGE_KEY) || 'null');
    if (saved && saved.profile in BUDGET_PROFILES) profile = saved.profile;
    if (saved?.overrides && typeof saved.overrides === 'object')
      for (const [k, v] of Object.entries(saved.overrides))
        if (k in BUDGET_PROFILES.balanced) overrides[k] = v;
  } catch {
    // unreadable: defaults
  }

  function save() {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify({ profile, overrides }));
    } catch {
      // full or blocked storage: keep the in-memory choice
    }
  }

  function emit() {
    const b = get();
    for (const fn of listeners) {
      try {
        fn(b);
      } catch {
        // a broken listener must not stop the others
      }
    }
  }

  /** The budgets in force: profile + overrides, workers resolved. */
  function get() {
    const b = { ...BUDGET_PROFILES[profile], ...overrides };
    if (b.cpuWorkers === 'auto') b.cpuWorkers = resolveWorkers(profile, cores);
    return Object.freeze({
      ...b,
      profile,
      cores: Math.max(1, Math.floor(Number(cores) || 4)),
      memoryGB: Number(memoryGB) || null,
      overridden: Object.freeze(Object.keys(overrides)),
    });
  }

  function setProfile(name) {
    if (!(name in BUDGET_PROFILES))
      throw new Error(
        `Unknown profile "${name}": ${Object.keys(BUDGET_PROFILES).join(', ')}`,
      );
    profile = name;
    overrides = {};
    save();
    emit();
    return get();
  }

  /** Override one budget (alias or full name). `value` may carry units. */
  function set(name, value) {
    const key = BUDGET_ALIASES[name] ?? name;
    if (!(key in BUDGET_PROFILES.balanced))
      throw new Error(
        `Unknown budget "${name}": ${Object.keys(BUDGET_ALIASES).join(', ')}`,
      );
    let v = parseBudgetValue(key, value);
    if (v === null || v === undefined)
      throw new Error(`Bad value for ${name}: ${value}`);
    if (typeof v === 'number') {
      const [lo, hi] = BUDGET_LIMITS[key];
      v = Math.min(hi, Math.max(lo, v));
      if (!['gpuWorkScale'].includes(key)) v = Math.round(v);
    }
    overrides = { ...overrides, [key]: v };
    save();
    emit();
    return get();
  }

  function reset() {
    return setProfile(DEFAULT_PROFILE);
  }

  return {
    get,
    setProfile,
    set,
    reset,
    get profile() {
      return profile;
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Bytes helpers for callers that take bytes. */
    bytes(key) {
      return get()[key] * MB;
    },
  };
}

/** One-line summary for the status line and Features Code. */
export function budgetLine(b) {
  const gb = (mb) =>
    mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 ? 1 : 0)} GB` : `${mb} MB`;
  return `${b.profile}${b.overridden.length ? ' (custom)' : ''} · ${b.cpuWorkers} of ${b.cores} CPU threads${b.hybrid ? ' alongside the GPU' : ''} · GPU work ×${b.gpuWorkScale} · up to ${(b.pointCellsGpu / 1e6).toFixed(1)}M cells (${(b.wideCellsGpu / 1e6).toFixed(0)}M for routes) · 3D tiles cache ${gb(b.tilesetCacheMB)} + ${gb(b.tilesetOverflowMB)} · viewshed grids ${gb(b.gridCacheMB)}`;
}

/**
 * Keep a Cesium scene on the RAM budgets: every 3D tileset's cache
 * (tilesetCacheMB + tilesetOverflowMB, including tilesets added later) and
 * the globe's tile cache (globeTileCache, imagery and terrain tiles).
 * Duck-typed so it needs no Cesium import. Returns a detach function.
 */
export function attachSceneBudgets(scene, budgets = resourceBudgets) {
  const apply = (b = budgets.get()) => {
    const set = (p) => {
      if (typeof p?.cacheBytes !== 'number') return;
      p.cacheBytes = b.tilesetCacheMB * MB;
      p.maximumCacheOverflowBytes = b.tilesetOverflowMB * MB;
    };
    const list = scene?.primitives;
    for (let i = 0; i < (list?.length ?? 0); i++) set(list.get(i));
    if (scene?.globe && 'tileCacheSize' in scene.globe)
      scene.globe.tileCacheSize = b.globeTileCache;
    return set;
  };
  apply();
  const offAdded = scene?.primitives?.primitiveAdded?.addEventListener?.((p) =>
    apply()(p),
  );
  const offChange = budgets.onChange((b) => apply(b));
  return () => {
    offAdded?.();
    offChange();
  };
}

/** The app-wide instance. */
export const resourceBudgets = createResourceBudgets();
