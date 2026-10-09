/**
 * Counts bytes the app pulls over the network, split by what it was for and
 * by connection type, so the cellular budget is visible. Cache hits cost 0.
 */
export function createNetMeter({ load = () => null, save = () => {}, connection = () => 'unknown' } = {}) {
  let state = load() || { since: Date.now(), bytes: {}, saved: {} };
  const bump = (bucket, key, n) => {
    bucket[key] = (bucket[key] || 0) + n;
  };
  return {
    /** Bytes downloaded for a category (tiles, routes, cameras, search). */
    add(category, bytes) {
      const kind = connection();
      bump(state.bytes, `${kind}:${category}`, bytes);
      bump(state.bytes, kind, bytes);
      save(state);
    },
    /** Bytes a cache hit avoided downloading. */
    saved(category, bytes) {
      bump(state.saved, category, bytes);
      bump(state.saved, 'all', bytes);
      save(state);
    },
    snapshot() {
      return structuredClone(state);
    },
    reset() {
      state = { since: Date.now(), bytes: {}, saved: {} };
      save(state);
    },
  };
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
