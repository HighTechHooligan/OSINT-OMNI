import { bboxOf, distanceToLineM, haversineM, inBbox } from './geo.js';
import { MAX_EXCLUDES } from './valhalla.js';

/**
 * Camera-aware routing. Valhalla is asked for a normal route, every mapped
 * camera within `bufferM` of it is added to `exclude_locations` (which bans
 * the road edges the camera sits on), and the route is requested again until
 * it passes no cameras, the exclude budget runs out, or no path is left.
 * Cameras on the start or destination street, and any camera with no way
 * around it, are reported instead of excluded.
 */
export const DEFAULTS = Object.freeze({
  bufferM: 40,
  endpointGuardM: 150,
  maxPasses: 6,
  maxExcludes: MAX_EXCLUDES,
});

/** Cameras within bufferM of a route line, in the order the route meets them. */
export function camerasOnRoute(line, cameras, bufferM = DEFAULTS.bufferM) {
  if (!line.length || !cameras.length) return [];
  const box = bboxOf(line, bufferM + 10);
  const hits = [];
  for (const cam of cameras) {
    const p = [cam.lon, cam.lat];
    if (!inBbox(p, box)) continue;
    const { distance, index } = distanceToLineM(p, line);
    if (distance <= bufferM) hits.push({ ...cam, distance, index });
  }
  return hits.sort((a, b) => a.index - b.index);
}

/**
 * @param {object} opts
 * @param {[number,number]} opts.from
 * @param {[number,number]} opts.to
 * @param {Array<{id:any, lon:number, lat:number}>} [opts.cameras] known cameras
 * @param {(line: Array) => Promise<Array>} [opts.loadCameras] cameras along a
 *   line; called for every candidate route, since a detour can enter areas the
 *   first route never touched
 * @param {(excludes: Array<[number,number]>) => Promise<{coords:Array}>} opts.route
 */
export async function routeAroundCameras({
  from,
  to,
  cameras: known = [],
  loadCameras = null,
  route,
  ...options
}) {
  const o = { ...DEFAULTS, ...options };
  const byId = new Map(known.map((c) => [c.id, c]));
  const learn = async (line) => {
    if (loadCameras) for (const c of await loadCameras(line)) byId.set(c.id, c);
    return [...byId.values()];
  };
  const nearEnd = (cam) =>
    haversineM([cam.lon, cam.lat], from) < o.endpointGuardM ||
    haversineM([cam.lon, cam.lat], to) < o.endpointGuardM;

  const baseline = await route([]);
  let cameras = await learn(baseline.coords);
  const baselineHits = camerasOnRoute(baseline.coords, cameras, o.bufferM);
  let best = baseline;
  let excluded = [];
  let passes = 1;
  let stopReason = baselineHits.length ? null : 'clear';
  let batchCap = Infinity;
  const blocked = new Set();

  while (!stopReason && passes < o.maxPasses) {
    const have = new Set(excluded.map((c) => c.id));
    const fresh = camerasOnRoute(best.coords, cameras, o.bufferM).filter(
      (c) => !have.has(c.id) && !blocked.has(c.id) && !nearEnd(c),
    );
    if (!fresh.length) {
      stopReason = 'clear';
      break;
    }
    const room = o.maxExcludes - excluded.length;
    if (room <= 0) {
      stopReason = 'exclude-limit';
      break;
    }
    const batch = fresh.slice(0, Math.min(room, batchCap));
    const next = [...excluded, ...batch];
    passes++;
    try {
      const candidate = await route(next.map((c) => [c.lon, c.lat]));
      excluded = next;
      best = candidate;
      cameras = await learn(best.coords);
    } catch (error) {
      if (!error?.noPath) throw error;
      // Banning a whole batch can cut every way through; try fewer at once.
      // A single camera with no way around it stays on the route.
      if (batch.length > 1) batchCap = Math.floor(batch.length / 2);
      else blocked.add(batch[0].id);
    }
  }
  if (!stopReason) stopReason = 'pass-limit';

  const remaining = camerasOnRoute(best.coords, cameras, o.bufferM);
  return {
    cameras,
    route: best,
    baseline,
    baselineHits,
    remaining,
    unavoidable: remaining.filter((c) => nearEnd(c) || blocked.has(c.id)),
    excluded,
    passes,
    stopReason,
    extraTime: best.time - baseline.time,
    extraLength: best.length - baseline.length,
  };
}
