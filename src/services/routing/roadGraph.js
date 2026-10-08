import { bearingDeg, createGrid, haversineM } from './routeGeo.js';

/**
 * Directed road graph from OSM ways. Every pair of consecutive way nodes is
 * an edge (both directions unless one-way). Edges carry length, travel time,
 * the way they came from, and which cameras read plates along them.
 */
export function buildGraph(ways, profile, cameraIndex = null) {
  const nodeIndex = new Map();
  const lon = [];
  const lat = [];
  const node = (id, x, y) => {
    let i = nodeIndex.get(id);
    if (i === undefined) {
      i = lon.length;
      nodeIndex.set(id, i);
      lon.push(x);
      lat.push(y);
    }
    return i;
  };
  const from = [];
  const to = [];
  const length = [];
  const time = [];
  const wayOf = [];
  const cams = [];
  const wayInfo = [];
  let seenEdges = 0;

  for (const way of ways) {
    const tags = way.tags || {};
    if (!profile.allowed(tags)) continue;
    const speed = (profile.speedKmh(tags) * 1000) / 3600;
    const oneway = profile.oneway(tags);
    const w = wayInfo.length;
    wayInfo.push({
      id: way.id,
      name: tags.name || '',
      ref: tags.ref || '',
      highway: tags.highway,
    });
    for (let k = 0; k < way.nodes.length - 1; k++) {
      const a = [way.coords[2 * k], way.coords[2 * k + 1]];
      const b = [way.coords[2 * k + 2], way.coords[2 * k + 3]];
      const ia = node(way.nodes[k], a[0], a[1]);
      const ib = node(way.nodes[k + 1], b[0], b[1]);
      if (ia === ib) continue;
      const len = haversineM(a, b);
      const add = (u, v, p, q) => {
        from.push(u);
        to.push(v);
        length.push(len);
        time.push(len / speed);
        wayOf.push(w);
        const seen = cameraIndex?.size ? cameraIndex.segmentSeenBy(p, q) : null;
        if (seen) seenEdges++;
        cams.push(seen);
      };
      if (oneway >= 0) add(ia, ib, a, b);
      if (oneway <= 0) add(ib, ia, b, a);
    }
  }

  // Compressed adjacency: edges leaving node n are out[offset[n] .. offset[n+1]).
  const n = lon.length;
  const offset = new Int32Array(n + 1);
  for (const u of from) offset[u + 1]++;
  for (let i = 0; i < n; i++) offset[i + 1] += offset[i];
  const out = new Int32Array(from.length);
  const fill = offset.slice(0, n);
  for (let e = 0; e < from.length; e++) out[fill[from[e]]++] = e;
  const hasIn = new Uint8Array(n);
  for (const v of to) hasIn[v] = 1;

  const grid = createGrid(150, lat[0] ?? 0);
  for (let i = 0; i < n; i++)
    if (offset[i + 1] > offset[i] || hasIn[i]) grid.add(lon[i], lat[i], i);

  return {
    nodeCount: n,
    edgeCount: from.length,
    seenEdges,
    lon,
    lat,
    from,
    to,
    length,
    time,
    wayOf,
    cams,
    wayInfo,
    offset,
    out,
    point: (i) => [lon[i], lat[i]],
    bearing: (e) =>
      bearingDeg([lon[from[e]], lat[from[e]]], [lon[to[e]], lat[to[e]]]),
    /** Nearest node that can start (outgoing edge) or end (incoming edge) a trip. */
    nearestNode(p, { leaving = true, maxM = 3000 } = {}) {
      for (let r = 150; r <= maxM * 2; r *= 2) {
        let best = -1;
        let bestD = Infinity;
        for (const i of grid.near(p[0], p[1], r)) {
          if (leaving ? offset[i + 1] === offset[i] : !hasIn[i]) continue;
          const d = haversineM(p, [lon[i], lat[i]]);
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
        if (best >= 0 && bestD <= r)
          return bestD <= maxM ? { node: best, distance: bestD } : null;
      }
      return null;
    },
  };
}
