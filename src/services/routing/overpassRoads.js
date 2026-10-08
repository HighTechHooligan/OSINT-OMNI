/**
 * Road data for the router: OpenStreetMap ways from Overpass, one map tile at
 * a time so tiles cache and reuse. "full" tiles carry every road a profile
 * may use; "major" tiles only the through roads, for the wide margins of
 * long trips.
 */
import { tileBbox } from './routeGeo.js';

const KEEP_TAGS = [
  'highway',
  'name',
  'ref',
  'oneway',
  'oneway:bicycle',
  'junction',
  'maxspeed',
  'access',
  'motor_vehicle',
  'motorcar',
  'vehicle',
  'bicycle',
  'foot',
  'service',
  'area',
];

export function roadQuery(tile, highways) {
  const [w, s, e, n] = tileBbox(tile);
  const f = (v) => v.toFixed(6);
  const pattern = highways.map((h) => h.replace(/[^a-z_]/g, '')).join('|');
  return `[out:json][timeout:60];way["highway"~"^(${pattern})$"](${f(s)},${f(w)},${f(n)},${f(e)});out body geom qt;`;
}

/**
 * Overpass JSON -> compact ways: {id, nodes: number[], coords: number[] (lon,lat
 * interleaved), tags}. Nodes outside the response (null geometry) are dropped.
 */
export function parseRoadResponse(json) {
  const ways = [];
  for (const el of json?.elements || []) {
    if (
      el.type !== 'way' ||
      !Array.isArray(el.nodes) ||
      !Array.isArray(el.geometry)
    )
      continue;
    const nodes = [];
    const coords = [];
    for (let i = 0; i < el.nodes.length; i++) {
      const g = el.geometry[i];
      if (!g || !Number.isFinite(g.lon) || !Number.isFinite(g.lat)) continue;
      nodes.push(el.nodes[i]);
      coords.push(g.lon, g.lat);
    }
    if (nodes.length < 2) continue;
    const tags = {};
    for (const k of KEEP_TAGS) if (el.tags?.[k] != null) tags[k] = el.tags[k];
    ways.push({ id: el.id, nodes, coords, tags });
  }
  return ways;
}

/** Merge way lists from several tiles, keeping one copy of each way. */
export function mergeWays(lists) {
  const byId = new Map();
  for (const list of lists)
    for (const way of list) {
      const have = byId.get(way.id);
      // A way cut by tile edges keeps its longest copy.
      if (!have || have.nodes.length < way.nodes.length) byId.set(way.id, way);
    }
  return [...byId.values()];
}
