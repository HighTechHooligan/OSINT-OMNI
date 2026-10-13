import { haversineM } from './routeGeo.js';

/**
 * A* over the road graph. Cost is travel time plus `cameraPenaltyS` for every
 * camera that can read the plate along an edge, so the search first minimises
 * how many cameras see the car and only then the time.
 */
export const CAMERA_PENALTY_S = 100_000;

export function findPath(
  graph,
  start,
  goal,
  { cameraPenaltyS = CAMERA_PENALTY_S, maxKmh = 110 } = {},
) {
  const n = graph.nodeCount;
  const g = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const goalP = graph.point(goal);
  const vmax = (maxKmh * 1000) / 3600;
  const h = (i) => haversineM([graph.lon[i], graph.lat[i]], goalP) / vmax;
  const heap = createHeap();
  g[start] = 0;
  heap.push(h(start), start);
  let settled = 0;
  while (heap.size) {
    const u = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    settled++;
    if (u === goal) break;
    for (let k = graph.offset[u]; k < graph.offset[u + 1]; k++) {
      const e = graph.out[k];
      const v = graph.to[e];
      if (done[v]) continue;
      const seen = graph.cams[e];
      const cost =
        g[u] + graph.time[e] + (seen ? seen.length * cameraPenaltyS : 0);
      if (cost < g[v]) {
        g[v] = cost;
        prev[v] = e;
        heap.push(cost + h(v), v);
      }
    }
  }
  if (!done[goal]) return null;
  const edges = [];
  for (let v = goal; v !== start; v = graph.from[prev[v]]) edges.push(prev[v]);
  edges.reverse();
  return { edges, settled };
}

/** Minimal binary min-heap of (priority, value). */
function createHeap() {
  const pri = [];
  const val = [];
  return {
    get size() {
      return val.length;
    },
    push(p, v) {
      let i = val.length;
      pri.push(p);
      val.push(v);
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (pri[parent] <= p) break;
        pri[i] = pri[parent];
        val[i] = val[parent];
        i = parent;
      }
      pri[i] = p;
      val[i] = v;
    },
    pop() {
      const top = val[0];
      const lastP = pri.pop();
      const lastV = val.pop();
      const size = val.length;
      if (size) {
        let i = 0;
        for (;;) {
          let c = 2 * i + 1;
          if (c >= size) break;
          if (c + 1 < size && pri[c + 1] < pri[c]) c++;
          if (pri[c] >= lastP) break;
          pri[i] = pri[c];
          val[i] = val[c];
          i = c;
        }
        pri[i] = lastP;
        val[i] = lastV;
      }
      return top;
    },
  };
}
