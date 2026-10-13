import { cumulativeM, distanceToLineM, haversineM } from './geo.js';

/**
 * Turn-by-turn progress along a route from a position fix: which maneuver is
 * next, how far to it, how far off the line the phone is, and the next
 * mapped camera still ahead.
 */
export const OFF_ROUTE_M = 60;

export function createNavigator(route, cameras = []) {
  const along = cumulativeM(route.coords);
  const camAhead = cameras
    .map((c) => {
      const { index } = distanceToLineM([c.lon, c.lat], route.coords);
      return { ...c, at: along[index] + haversineM(route.coords[index], [c.lon, c.lat]) };
    })
    .sort((a, b) => a.at - b.at);

  return {
    total: along[along.length - 1] || 0,
    update(lonLat) {
      const { distance, index } = distanceToLineM(lonLat, route.coords);
      const i = Math.max(0, index);
      const progressed = along[i] + haversineM(route.coords[i], lonLat);
      const nextIdx = route.maneuvers.findIndex((m) => along[m.begin] > progressed + 5);
      const next = nextIdx >= 0 ? route.maneuvers[nextIdx] : route.maneuvers[route.maneuvers.length - 1];
      const camera = camAhead.find((c) => c.at > progressed - 10) || null;
      return {
        offRoute: distance > OFF_ROUTE_M,
        offBy: distance,
        progressed,
        remaining: Math.max(0, (along[along.length - 1] || 0) - progressed),
        next,
        nextIndex: nextIdx,
        toNext: next ? Math.max(0, along[next.begin] - progressed) : 0,
        camera,
        toCamera: camera ? Math.max(0, camera.at - progressed) : null,
      };
    },
  };
}

export function formatDistance(m, units = 'miles') {
  if (units === 'miles') {
    const ft = m * 3.28084;
    if (ft < 1000) return `${Math.round(ft / 50) * 50 || Math.round(ft)} ft`;
    const mi = m / 1609.344;
    return `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;
  }
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  const km = m / 1000;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

export function formatDuration(seconds) {
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  return `${h} h ${mins % 60} min`;
}

/** Route length (in its own units) to metres. */
export const routeLengthM = (route) => route.length * (route.units === 'kilometers' ? 1000 : 1609.344);
