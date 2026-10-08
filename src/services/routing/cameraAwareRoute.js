import { mergeWays } from './overpassRoads.js';
import { haversineM, tilesNearLine } from './routeGeo.js';
import { classifyPassed } from './solveRoute.js';

/**
 * Plan a camera-aware route with no distance limit. Roads are loaded only in
 * a corridor around a guide line (the router's ordinary route when there is
 * one, else the straight line): every road near the line and near both ends,
 * and through roads in a wider margin. If the best route in that corridor
 * still passes a camera, the corridor widens once.
 *
 * Loading (network, cache) and solving (CPU) are injected so the phone can
 * run the solve in a worker and the desktop on its own thread.
 */
export const ROAD_ZOOM_FULL = 12;
export const ROAD_ZOOM_MAJOR = 11;

export function corridorPlan(line, from, to, wide = false) {
  const lengthM = line.reduce(
    (sum, p, i) => (i ? sum + haversineM(line[i - 1], p) : 0),
    0,
  );
  const fullPad = wide ? 4000 : 1500;
  const majorPad = Math.min(
    wide ? 40_000 : 15_000,
    Math.max(wide ? 12_000 : 5000, lengthM * (wide ? 0.25 : 0.1)),
  );
  const full = new Map();
  for (const t of [
    ...tilesNearLine(line, ROAD_ZOOM_FULL, fullPad),
    ...tilesNearLine([from], ROAD_ZOOM_FULL, wide ? 8000 : 4000),
    ...tilesNearLine([to], ROAD_ZOOM_FULL, wide ? 8000 : 4000),
  ])
    full.set(`${t.x}/${t.y}`, t);
  return {
    lengthM,
    full: [...full.values()],
    major: tilesNearLine(line, ROAD_ZOOM_MAJOR, majorPad),
    cameraPadM: majorPad,
  };
}

/**
 * @param {object} o
 * @param {[number,number]} o.from
 * @param {[number,number]} o.to
 * @param {object} o.profile
 * @param {Array} [o.guide] coordinates of an ordinary route between the ends
 * @param {(tiles: object[], tier: 'full'|'major', profile: object, progress: Function) => Promise<Array[]>} o.loadRoads
 * @param {(line: Array, padM: number) => Promise<Array>} o.loadCameras
 * @param {(input: object) => Promise<object>|object} o.solve solveRoute or a worker proxy
 * @param {boolean} [o.avoid]
 * @param {object} [o.view]
 * @param {string} [o.units]
 * @param {(stage: string, done?: number, total?: number) => void} [o.onProgress]
 */
export async function cameraAwareRoute({
  from,
  to,
  profile,
  guide = null,
  loadRoads,
  loadCameras,
  solve,
  avoid = true,
  view = {},
  units = 'miles',
  onProgress = () => {},
}) {
  const line = guide?.length >= 2 ? guide : [from, to];
  let result = null;
  for (const wide of avoid ? [false, true] : [false]) {
    const plan = corridorPlan(line, from, to, wide);
    onProgress(
      wide ? 'Widening the search around cameras' : 'Loading roads',
      0,
      plan.full.length + plan.major.length,
    );
    let done = 0;
    const tick = () =>
      onProgress(
        wide ? 'Widening the search around cameras' : 'Loading roads',
        ++done,
        plan.full.length + plan.major.length,
      );
    const fullWays = await loadRoads(plan.full, 'full', profile, tick);
    const majorWays = await loadRoads(plan.major, 'major', profile, tick);
    onProgress('Loading cameras');
    const cameras = await loadCameras(line, plan.cameraPadM);
    onProgress('Finding the route');
    const ways = mergeWays([...fullWays, ...majorWays]);
    const solved = await solve({
      ways,
      cameras,
      from,
      to,
      profileId: profile.id,
      view,
      avoid,
      units,
    });
    if (!solved.ok) {
      if (!wide && avoid) continue;
      return { ...solved, corridor: plan };
    }
    const classes = classifyPassed(solved.passed, from, to);
    result = {
      ...solved,
      ...classes,
      corridor: plan,
      widened: wide,
      cameraCount: cameras.length,
    };
    // Any camera left means the narrow corridor had no way round; look wider once.
    if (!avoid || !solved.passed.length) break;
  }
  return result;
}

/** One sentence about the cameras on a solved route, for the route card. */
export function cameraMessage(r, { baselineCount = null } = {}) {
  if (!r?.ok) return '';
  const n = (k) => `${k} camera${k === 1 ? '' : 's'}`;
  const avoided =
    baselineCount != null && baselineCount > r.passed.length
      ? ` Avoids ${n(baselineCount - r.passed.length)} on the usual route.`
      : '';
  if (!r.passed.length)
    return baselineCount
      ? `No mapped camera reads your plate on this route.${avoided}`
      : 'No mapped camera reads your plate on this route.';
  const parts = [];
  if (r.atEnd.length)
    parts.push(
      `your destination can only be reached past ${n(r.atEnd.length)} (dead end)`,
    );
  if (r.atStart.length)
    parts.push(
      `your start can only be left past ${n(r.atStart.length)} (dead end)`,
    );
  if (r.elsewhere.length)
    parts.push(
      `${n(r.elsewhere.length)} could not be avoided on any road near the route`,
    );
  const text = parts.join('; ');
  return `${text[0].toUpperCase()}${text.slice(1)}.${avoided}`;
}
