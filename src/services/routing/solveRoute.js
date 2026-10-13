import { createCameraIndex } from './cameraView.js';
import { buildGraph } from './roadGraph.js';
import { findPath } from './pathSearch.js';
import { buildManeuvers } from './maneuvers.js';
import { haversineM } from './routeGeo.js';
import { PROFILES } from './roadProfiles.js';

/**
 * Pure, synchronous route solve: roads + cameras in, camera-minimising route
 * out. Runs in a worker on the phone and on the desktop.
 *
 * @param {object} o
 * @param {Array} o.ways from parseRoadResponse / mergeWays
 * @param {Array} o.cameras {id, lon, lat, direction?, brand?, operator?}
 * @param {[number,number]} o.from
 * @param {[number,number]} o.to
 * @param {object} [o.profile] from roadProfiles.js, or pass `profileId` (worker-safe)
 * @param {object} [o.view] camera view overrides (rangeM, halfAngleDeg, frontPlates)
 * @param {boolean} [o.avoid=true] false routes for time only and just reports cameras
 * @param {'miles'|'kilometers'} [o.units]
 */
export function solveRoute({
  ways,
  cameras = [],
  from,
  to,
  profile,
  profileId = 'car',
  view = {},
  avoid = true,
  units = 'miles',
}) {
  profile ??= PROFILES[profileId] ?? PROFILES.car;
  const index = createCameraIndex(cameras, view);
  const graph = buildGraph(ways, profile, index);
  const start = graph.nearestNode(from, { leaving: true });
  const goal = graph.nearestNode(to, { leaving: false });
  const stats = {
    nodes: graph.nodeCount,
    edges: graph.edgeCount,
    cameraEdges: graph.seenEdges,
    cameras: index.size,
  };
  if (!start || !goal)
    return {
      ok: false,
      reason: !start ? 'no-road-near-start' : 'no-road-near-destination',
      stats,
    };
  const path = findPath(graph, start.node, goal.node, {
    cameraPenaltyS: avoid ? undefined : 0,
    maxKmh: profile.maxKmh,
  });
  if (!path) return { ok: false, reason: 'no-path', stats };
  const built = buildManeuvers(graph, path.edges, units);

  // Distinct cameras that read the plate somewhere on the route, in order.
  const seen = new Map();
  path.edges.forEach((e, i) => {
    for (const id of graph.cams[e] || []) if (!seen.has(id)) seen.set(id, i);
  });
  const passed = [...seen.entries()].map(([id, i]) => ({
    ...index.get(id),
    index: i,
  }));
  return {
    ok: true,
    route: {
      coords: built.coords,
      maneuvers: built.maneuvers,
      length: built.lengthM / (units === 'kilometers' ? 1000 : 1609.344),
      time: built.timeS,
      units,
    },
    passed,
    snap: { start: start.distance, goal: goal.distance },
    stats: { ...stats, settled: path.settled },
    endpoints: { from, to },
  };
}

/**
 * Sort cameras still on a route into "the only way in or out" (within
 * `nearM` of the start or destination: a dead end, a gated street, a single
 * driveway) and the rest.
 */
export function classifyPassed(passed, from, to, nearM = 1200) {
  const atStart = [];
  const atEnd = [];
  const elsewhere = [];
  // On short trips "near the end" shrinks so a camera midway isn't called a dead end.
  const near = Math.min(nearM, haversineM(from, to) / 3);
  for (const c of passed) {
    const p = [c.lon, c.lat];
    const dEnd = haversineM(p, to);
    const dStart = haversineM(p, from);
    if (dEnd <= near && dEnd <= dStart) atEnd.push(c);
    else if (dStart <= near) atStart.push(c);
    else elsewhere.push(c);
  }
  return { atStart, atEnd, elsewhere };
}
