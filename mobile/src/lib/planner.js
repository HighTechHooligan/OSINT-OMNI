import { routeAroundCameras, camerasOnRoute } from './avoid.js';
import { buildRouteRequest, requestRoute } from './valhalla.js';
import { shouldReuse } from './routeCache.js';

/**
 * One trip request, end to end: reuse a kept route when allowed, otherwise
 * route (around cameras if asked), and keep the result on the phone.
 */
export function createPlanner({
  routes,
  cameras,
  settings,
  connection,
  fetchImpl = fetch,
  now = Date.now,
}) {
  const routeOnce = (from, to, costing) => (excludes) =>
    requestRoute(
      settings().routerUrl,
      buildRouteRequest({ from, to, costing, excludes, units: settings().units }),
      { fetchImpl },
    );

  const loadCameras = async (line) => {
    const { online } = connection();
    const s = settings();
    const r = await cameras.forLine(line, {
      preferCache: !online || (s.cellularSaver && connection().onCellular),
    });
    return r.cameras;
  };

  return {
    /**
     * @returns {Promise<{record: object, from: 'cache'|'network'}>}
     */
    async plan({ from, to, fromLabel = '', toLabel = '', force = false }) {
      const s = settings();
      const costing = s.costing;
      const avoid = s.avoidCameras;
      const conn = connection();
      const kept = await routes.find({ from, to, costing, avoid });
      if (
        !force &&
        shouldReuse(kept, {
          now: now(),
          maxAgeMs: s.routeMaxAgeHours * 3600_000,
          cellularSaver: s.cellularSaver,
          onCellular: conn.onCellular,
          online: conn.online,
        })
      )
        return { record: kept, from: 'cache' };
      if (!conn.online)
        throw new Error('Offline, and no kept route matches this trip. Save routes before you lose signal.');

      const route = routeOnce(from, to, costing);
      let result;
      if (avoid) {
        result = await routeAroundCameras({
          from,
          to,
          loadCameras,
          route,
          bufferM: s.cameraBufferM,
        });
      } else {
        const r = await route([]);
        const cams = await loadCameras(r.coords).catch(() => []);
        const hits = camerasOnRoute(r.coords, cams, s.cameraBufferM);
        result = {
          cameras: cams,
          route: r,
          baseline: r,
          baselineHits: hits,
          remaining: hits,
          unavoidable: [],
          excluded: [],
          passes: 1,
          stopReason: 'not-avoiding',
          extraTime: 0,
          extraLength: 0,
        };
      }
      const record = await routes.put({
        // A refresh replaces the kept route in place (saved stays saved).
        id: kept?.id,
        name: kept?.name,
        from,
        to,
        fromLabel,
        toLabel,
        costing,
        avoid,
        route: result.route,
        baseline: result.baseline === result.route ? null : result.baseline,
        cameras: result.remaining,
        baselineCameraCount: result.baselineHits.length,
        excludedCount: result.excluded.length,
        unavoidableCount: result.unavoidable.length,
        stopReason: result.stopReason,
        extraTime: result.extraTime,
        extraLength: result.extraLength,
        saved: Boolean(kept?.saved),
        at: now(),
      });
      return { record, from: 'network' };
    },
  };
}
