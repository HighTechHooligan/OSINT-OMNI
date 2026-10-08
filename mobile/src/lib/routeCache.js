import { haversineM } from './geo.js';

/**
 * Routes kept on the phone. A new request whose start and end fall within
 * `matchM` of a kept route (same mode and camera setting) reuses it instead of
 * asking the router again. Saved routes are kept until deleted; recent
 * unsaved ones roll off after `recentLimit`.
 */
export const MATCH_M = 200;
export const RECENT_LIMIT = 30;

export function routeId() {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function createRouteCache({ store, now = Date.now, matchM = MATCH_M, recentLimit = RECENT_LIMIT }) {
  async function all() {
    return (await store.entries('routes')).map(([, r]) => r).sort((a, b) => b.at - a.at);
  }
  return {
    all,
    async find({ from, to, costing, avoid }) {
      let best = null;
      for (const r of await all()) {
        if (r.costing !== costing || Boolean(r.avoid) !== Boolean(avoid)) continue;
        const d = haversineM(r.from, from) + haversineM(r.to, to);
        if (haversineM(r.from, from) <= matchM && haversineM(r.to, to) <= matchM)
          if (!best || d < best.d) best = { d, record: r };
      }
      return best?.record || null;
    },
    async put(record) {
      const rec = { saved: false, ...record, id: record.id || routeId(), at: record.at ?? now() };
      await store.put('routes', rec.id, rec);
      const recent = (await all()).filter((r) => !r.saved);
      for (const old of recent.slice(recentLimit)) await store.delete('routes', old.id);
      return rec;
    },
    async setSaved(id, saved, name) {
      const rec = await store.get('routes', id);
      if (!rec) return null;
      const next = { ...rec, saved, name: name ?? rec.name };
      await store.put('routes', id, next);
      return next;
    },
    remove: (id) => store.delete('routes', id),
    get: (id) => store.get('routes', id),
  };
}

/** Whether a kept route may be reused without asking the network. */
export function shouldReuse(record, { now = Date.now(), maxAgeMs, cellularSaver, onCellular, online }) {
  if (!record) return false;
  if (!online) return true;
  if (record.saved) return true;
  if (cellularSaver && onCellular) return true;
  return now - record.at < maxAgeMs;
}
