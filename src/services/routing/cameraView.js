import {
  angleDiff,
  bearingDeg,
  createGrid,
  fromLocal,
  haversineM,
  toLocal,
} from './routeGeo.js';

/**
 * Which stretches of road a mapped ALPR camera can read plates on.
 *
 * Each camera's coverage is a 2D triangle (see coverage polygons below).
 * Assumptions (stated so they can be tuned, not because they are exact):
 * - Read range 30 m (about 100 ft), the top of the capture distance vendors
 *   quote for pole-mounted plate readers such as Flock's Falcon, plus 10 m
 *   because OpenStreetMap positions are hand-placed and often off by a lane
 *   or a sidewalk. Effective radius: 40 m.
 * - A camera with a mapped `direction` sees a triangle 30 degrees either side
 *   of it, ending 40 m out (typical ALPR lenses are 30-45 degrees wide; the
 *   rest is aiming and mapping slack). Without a direction it is treated as
 *   seeing all round (a hexagon).
 * - A plate is readable when the camera faces it: the rear plate of a car
 *   driving away from the camera, and (when `frontPlates` is on, the
 *   default, since most states require them) the front plate of a car
 *   driving toward it. So a car moving through the triangle is seen either way
 *   by default, and only the triangle (which road, which side of a junction)
 *   decides; turning front plates off makes the direction of travel count.
 */
export const VIEW_DEFAULTS = Object.freeze({
  rangeM: 40,
  halfAngleDeg: 30,
  frontPlates: true,
});

const CARDINAL = {
  N: 0,
  NNE: 22.5,
  NE: 45,
  ENE: 67.5,
  E: 90,
  ESE: 112.5,
  SE: 135,
  SSE: 157.5,
  S: 180,
  SSW: 202.5,
  SW: 225,
  WSW: 247.5,
  W: 270,
  WNW: 292.5,
  NW: 315,
  NNW: 337.5,
};

/** Parse an OSM `direction` / `camera:direction` value to bearings. */
export function parseDirections(raw) {
  if (raw == null || raw === '') return [];
  if (typeof raw === 'number')
    return Number.isFinite(raw) ? [((raw % 360) + 360) % 360] : [];
  const out = [];
  for (const part of String(raw).split(/[;,]/)) {
    const t = part.trim().toUpperCase();
    if (t in CARDINAL) out.push(CARDINAL[t]);
    else {
      // "45", "45.5", or a range "30-60" (take its middle).
      const range = /^(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)$/.exec(t);
      const value = range
        ? (Number(range[1]) + Number(range[2])) / 2
        : Number(t);
      if (Number.isFinite(value)) out.push(((value % 360) + 360) % 360);
    }
  }
  return out;
}

// ---- coverage polygons ----
//
// Each camera's coverage is a plain 2D polygon on a flat local frame (metres
// east and north of the camera), with no line-of-sight or viewshed work:
// - a triangle for every mapped direction: apex at the camera, opening
//   halfAngleDeg either side, ending in a straight edge rangeM out;
// - a hexagon of the same reach when no direction is mapped.
// A road edge that enters a polygon gets the router's heavy camera cost
// (pathSearch.js), so routes stay clear of the triangles unless there is no
// other way. A camera can also carry its own `coverage` ring of [lon, lat]
// points (a hand-surveyed field of view), used instead.

const RAD = Math.PI / 180;

/** Vertices of a regular polygon whose edges sit rangeM from the centre. */
function aroundPoints(rangeM, sides) {
  const r = rangeM / Math.cos(Math.PI / sides);
  const out = [];
  for (let i = 0; i < sides; i++) {
    const b = (i * 360) / sides + 180 / sides;
    out.push([r * Math.sin(b * RAD), r * Math.cos(b * RAD)]);
  }
  return out;
}

/** Triangle facing `dir`: apex at the camera, far edge rangeM out. */
function trianglePoints(rangeM, dir, half) {
  const side = rangeM / Math.cos(half * RAD);
  const corner = (b) => [side * Math.sin(b * RAD), side * Math.cos(b * RAD)];
  return [[0, 0], corner(dir - half), corner(dir + half)];
}

/**
 * Coverage polygons of one camera in local metres around it: arrays of
 * [east, north] rings (open, no repeated first point).
 */
export function coverageRingsLocal(camera, opts = VIEW_DEFAULTS) {
  const o = { ...VIEW_DEFAULTS, ...opts };
  if (Array.isArray(camera.coverage) && camera.coverage.length >= 3) {
    const at = [camera.lon, camera.lat];
    return [camera.coverage.map((p) => toLocal(p, at))];
  }
  const dirs = camera.directions ?? parseDirections(camera.direction);
  const half = Math.max(1, o.halfAngleDeg);
  // A triangle cannot open 90 degrees or more either side; treat that as all round.
  if (!dirs.length || half >= 80) return [aroundPoints(o.rangeM, 6)];
  return dirs.map((dir) => trianglePoints(o.rangeM, dir, half));
}

/** Coverage polygons of one camera as closed [lon, lat] rings (GeoJSON order). */
export function coveragePolygons(camera, opts = VIEW_DEFAULTS) {
  const at = [camera.lon, camera.lat];
  return coverageRingsLocal(camera, opts).map((ring) => {
    const out = ring.map((p) => fromLocal(p, at));
    out.push(out[0]);
    return out;
  });
}

/** GeoJSON FeatureCollection of camera coverage, one feature per camera. */
export function coverageGeoJSON(cameras, opts = {}, properties = () => ({})) {
  return {
    type: 'FeatureCollection',
    features: cameras
      .filter((c) => Number.isFinite(c.lon) && Number.isFinite(c.lat))
      .map((c) => ({
        type: 'Feature',
        geometry: {
          type: 'MultiPolygon',
          coordinates: coveragePolygons(c, opts).map((ring) => [ring]),
        },
        properties: { id: c.id, ...properties(c) },
      })),
  };
}

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

/**
 * Parameter intervals [t0, t1] of the segment p→q (0..1) that lie inside a
 * ring. Works for any simple polygon, convex or not.
 */
export function segmentInsideRing(p, q, ring) {
  const ts = [0, 1];
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ex = ring[i][0] - ring[j][0];
    const ey = ring[i][1] - ring[j][1];
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue; // parallel
    const wx = ring[j][0] - p[0];
    const wy = ring[j][1] - p[1];
    const t = (wx * ey - wy * ex) / den;
    const u = (wx * dy - wy * dx) / den;
    if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
  }
  ts.sort((a, b) => a - b);
  const out = [];
  for (let i = 1; i < ts.length; i++) {
    const t0 = ts[i - 1];
    const t1 = ts[i];
    if (t1 - t0 < 1e-9) continue;
    const m = (t0 + t1) / 2;
    if (!pointInRing(p[0] + dx * m, p[1] + dy * m, ring)) continue;
    const last = out.at(-1);
    if (last && t0 - last[1] < 1e-9) last[1] = t1;
    else out.push([t0, t1]);
  }
  return out;
}

/**
 * Whether a camera, given its local coverage rings, reads the plate of a car
 * driving the local segment p→q (metres around the camera).
 */
function ringsSeeSegment(rings, p, q, frontPlates) {
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  for (const ring of rings)
    for (const [t0, t1] of segmentInsideRing(p, q, ring)) {
      if (frontPlates) return true;
      // Rear plate only: the car must be moving away from the camera, which
      // on a straight segment is every point past its closest approach.
      const len2 = dx * dx + dy * dy;
      const tAway = len2 ? -(p[0] * dx + p[1] * dy) / len2 : 0;
      if (t1 > tAway) return true;
    }
  return false;
}

/** Whether one camera reads the plate of a car at point p heading `heading`. */
export function cameraSees(camera, p, heading, opts = VIEW_DEFAULTS) {
  const o = { ...VIEW_DEFAULTS, ...opts };
  const at = [camera.lon, camera.lat];
  const d = haversineM(at, p);
  if (d < 1) return true;
  const [x, y] = toLocal(p, at);
  if (!coverageRingsLocal(camera, o).some((ring) => pointInRing(x, y, ring)))
    return false;
  // Moving away from the camera shows the rear plate; toward it, the front.
  const away = angleDiff(heading, bearingDeg(at, p)) < 90;
  return away || o.frontPlates;
}

/**
 * Index cameras for repeated "who sees this road segment" questions.
 * @param {Array<{id:any, lon:number, lat:number, direction?:any, coverage?:Array}>} cameras
 */
export function createCameraIndex(cameras, opts = {}) {
  const o = { ...VIEW_DEFAULTS, ...opts };
  const list = cameras
    .filter((c) => Number.isFinite(c.lon) && Number.isFinite(c.lat))
    .map((c) => {
      const cam = { ...c, directions: parseDirections(c.direction) };
      cam.rings = coverageRingsLocal(cam, o);
      cam.reachM = Math.max(
        1,
        ...cam.rings.flat().map(([x, y]) => Math.hypot(x, y)),
      );
      return cam;
    });
  const lat = list.length ? list[0].lat : 0;
  const maxReach = list.reduce((m, c) => Math.max(m, c.reachM), o.rangeM);
  const cellM = Math.max(50, maxReach * 2);
  const grid = createGrid(cellM, lat);
  // Cells within reach of some camera; most road segments touch none of them.
  const hot = new Set();
  for (const c of list) {
    grid.add(c.lon, c.lat, c);
    for (const k of grid.ringKeys(c.lon, c.lat)) hot.add(k);
  }
  const touchesHot = (a, b, len) => {
    const steps = Math.max(1, Math.ceil(len / (cellM / 2)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (
        hot.has(grid.keyOf(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
      )
        return true;
    }
    return false;
  };
  return {
    size: list.length,
    options: o,
    /** Ids of cameras whose coverage polygon a car driving a to b crosses. */
    segmentSeenBy(a, b) {
      if (!list.length) return null;
      const len = haversineM(a, b);
      if (!touchesHot(a, b, len)) return null;
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const near = grid.near(mid[0], mid[1], len / 2 + maxReach);
      if (!near.length) return null;
      let seen = null;
      for (const cam of near) {
        const at = [cam.lon, cam.lat];
        if (haversineM(at, mid) > len / 2 + cam.reachM) continue;
        if (
          ringsSeeSegment(
            cam.rings,
            toLocal(a, at),
            toLocal(b, at),
            o.frontPlates,
          )
        )
          (seen ??= []).push(cam.id);
      }
      return seen;
    },
    get(id) {
      return list.find((c) => c.id === id) || null;
    },
  };
}

/** Distinct cameras that read the plate along a driven line, in order met. */
export function camerasAlongLine(line, cameras, opts = {}) {
  const index = createCameraIndex(cameras, opts);
  const seen = new Map();
  for (let i = 1; i < line.length; i++)
    for (const id of index.segmentSeenBy(line[i - 1], line[i]) || [])
      if (!seen.has(id)) seen.set(id, { ...index.get(id), index: i - 1 });
  return [...seen.values()];
}
