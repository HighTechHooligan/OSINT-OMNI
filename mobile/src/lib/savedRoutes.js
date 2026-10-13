import { loadBasemap, planLine } from './mapStyle.js';

/**
 * Saved routes: kept until deleted, with the map along them pinned on the
 * phone (and their cameras cached), so they open and navigate with no signal.
 * Rename, delete, refresh and reverse all go through here.
 */
export const routeRegion = (id) => `route:${id}`;
const short = (label = '') => String(label).split(',')[0].trim() || 'Place';

export function createSavedRoutes({ routes, tiles, cameras, planner, styleUrl, now = Date.now }) {
  /** Pin the basemap along a route; returns {tiles, bytes, failed}. */
  async function keepMap(record, onProgress = () => {}) {
    const region = routeRegion(record.id);
    const { style, tileJsons } = await loadBasemap(tiles, styleUrl(), { region });
    const plan = planLine({ style, styleUrl: styleUrl(), tileJsons, line: record.route.coords });
    const urls = plan.urls();
    let done = 0;
    let failed = 0;
    let bytes = 0;
    const worker = async () => {
      for (let next = urls.next(); !next.done; next = urls.next()) {
        try {
          bytes += (await tiles.get(next.value, { category: 'tiles', region })).byteLength;
        } catch {
          failed++;
        }
        onProgress(++done, plan.tileCount + plan.extras.length);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    await cameras.forLine(record.route.coords, { padM: 200 }).catch(() => null);
    return { tiles: done, bytes, failed, at: now() };
  }

  const api = {
    async list() {
      const all = await routes.all();
      return { saved: all.filter((r) => r.saved), recent: all.filter((r) => !r.saved) };
    },
    async save(id, { name, onProgress } = {}) {
      const rec = await routes.get(id);
      if (!rec) throw new Error('That route is no longer on this phone.');
      const saved = await routes.setSaved(id, true, name || rec.name || `${short(rec.fromLabel)} → ${short(rec.toLabel)}`);
      // The map download runs on; the route itself is already kept for good.
      keepMap(saved, onProgress)
        .then(async (offline) => routes.put({ ...(await routes.get(id)), offline }))
        .catch(() => {});
      return saved;
    },
    async unsave(id) {
      await tiles.unpinRegion(routeRegion(id));
      const rec = await routes.get(id);
      return routes.put({ ...rec, saved: false, offline: null });
    },
    async rename(id, name) {
      const clean = String(name || '').trim().slice(0, 80);
      if (!clean) throw new Error('Give the route a name.');
      const rec = await routes.get(id);
      return routes.put({ ...rec, name: clean });
    },
    async remove(id) {
      await tiles.unpinRegion(routeRegion(id));
      await routes.remove(id);
    },
    async clearRecent() {
      for (const r of (await routes.all()).filter((x) => !x.saved)) await routes.remove(r.id);
    },
    /** Re-plan with today's roads and cameras; a saved route keeps its name and map. */
    async refresh(id, { onProgress } = {}) {
      const rec = await routes.get(id);
      const { record } = await planner.plan({ from: rec.from, to: rec.to, fromLabel: rec.fromLabel, toLabel: rec.toLabel, force: true, onProgress });
      if (record.saved) keepMap(record).then((offline) => routes.put({ ...record, offline })).catch(() => {});
      return record;
    },
    async reverse(id, { onProgress } = {}) {
      const rec = await routes.get(id);
      const { record } = await planner.plan({ from: rec.to, to: rec.from, fromLabel: rec.toLabel, toLabel: rec.fromLabel, onProgress });
      return record;
    },
    keepMap,
  };
  return api;
}
