import { cameraAwareRoute, cameraMessage } from '../../../src/services/routing/cameraAwareRoute.js';
import { camerasAlongLine } from '../../../src/services/routing/cameraView.js';
import { profileFor } from '../../../src/services/routing/roadProfiles.js';
import { buildRouteRequest, requestRoute } from './valhalla.js';
import { shouldReuse } from './routeCache.js';

/**
 * One trip request, end to end: reuse a kept route when allowed; otherwise
 * ask Valhalla for the usual route, and (with Avoid cameras on) compute our
 * own route over OpenStreetMap roads that minimises how many cameras can read
 * the plate, using each camera's mapped facing. No distance limit.
 */
export function createPlanner({ routes, cameras, roads, solve, settings, connection, fetchImpl = fetch, now = Date.now }) {
  const view = () => ({ rangeM: settings().cameraRangeM, frontPlates: settings().cameraFrontPlates });

  const loadCameras = async (line, padM) => {
    const conn = connection();
    const r = await cameras.forLine(line, { padM, preferCache: !conn.online || (settings().cellularSaver && conn.onCellular) });
    return r.cameras;
  };

  async function usualRoute(from, to, costing) {
    try {
      return await requestRoute(settings().routerUrl, buildRouteRequest({ from, to, costing, units: settings().units }), { fetchImpl });
    } catch (error) {
      // Our own router can still plan with a straight-line corridor.
      return { error };
    }
  }

  return {
    /**
     * @returns {Promise<{record: object, from: 'cache'|'network'}>}
     */
    async plan({ from, to, fromLabel = '', toLabel = '', force = false, onProgress = () => {} }) {
      const s = settings();
      const costing = s.costing;
      const avoid = s.avoidCameras;
      const conn = connection();
      const kept = await routes.find({ from, to, costing, avoid });
      if (!force && shouldReuse(kept, { now: now(), maxAgeMs: s.routeMaxAgeHours * 3600_000, cellularSaver: s.cellularSaver, onCellular: conn.onCellular, online: conn.online }))
        return { record: kept, from: 'cache' };
      if (!conn.online) throw new Error('Offline, and no kept route matches this trip. Save routes before you lose signal.');

      onProgress('Asking for the usual route');
      const usual = await usualRoute(from, to, costing);
      let route = usual.error ? null : usual;
      let baselineCams = [];
      let solved = null;
      if (route) {
        onProgress('Checking cameras on the usual route');
        baselineCams = camerasAlongLine(route.coords, await loadCameras(route.coords, 200), view());
      }
      if (avoid) {
        solved = await cameraAwareRoute({
          from,
          to,
          profile: profileFor(costing),
          guide: route?.coords,
          loadRoads: roads.load,
          loadCameras,
          solve,
          view: view(),
          units: s.units,
          onProgress,
        });
        if (solved?.ok) route = solved.route;
        else if (!route) throw new Error(usual.error?.message || 'No route found between those places.');
      }
      if (!route) throw usual.error;
      const passed = solved?.ok ? solved.passed : baselineCams;
      const baseline = solved?.ok && !usual.error ? usual : null;
      const message = solved?.ok
        ? cameraMessage(solved, { baselineCount: baselineCams.length })
        : avoid
          ? `Couldn't compute a camera-free route (${solved?.reason || 'no road data'}); showing the usual route, which passes ${baselineCams.length} mapped camera${baselineCams.length === 1 ? '' : 's'}.`
          : baselineCams.length
            ? `Passes ${baselineCams.length} mapped camera${baselineCams.length === 1 ? '' : 's'}. Turn on Avoid cameras to route around them.`
            : 'No mapped camera reads your plate on this route.';

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
        route,
        baseline,
        cameras: passed,
        baselineCameraCount: baselineCams.length,
        message,
        deadEnd: solved?.ok ? solved.atEnd.length + solved.atStart.length : 0,
        engine: solved?.ok ? 'omni' : 'valhalla',
        stats: solved?.stats || null,
        extraTime: baseline ? route.time - baseline.time : 0,
        extraLength: baseline ? route.length - baseline.length : 0,
        saved: Boolean(kept?.saved),
        at: now(),
      });
      return { record, from: 'network' };
    },
  };
}
