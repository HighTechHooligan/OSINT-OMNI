import { angleDiff, bearingDeg, createGrid, haversineM } from './routeGeo.js';

/**
 * Which stretches of road a mapped ALPR camera can read plates on.
 *
 * Assumptions (stated so they can be tuned, not because they are exact):
 * - Read range 30 m (about 100 ft), the top of the capture distance vendors
 *   quote for pole-mounted plate readers such as Flock's Falcon, plus 10 m
 *   because OpenStreetMap positions are hand-placed and often off by a lane
 *   or a sidewalk. Effective radius: 40 m.
 * - A camera with a mapped `direction` sees a cone 30 degrees either side of
 *   it (typical ALPR lenses are 30-45 degrees wide; the rest is aiming and
 *   mapping slack). Without a direction it is treated as seeing all round.
 * - A plate is readable when the camera faces it: the rear plate of a car
 *   driving away from the camera, and (when `frontPlates` is on, the
 *   default, since most states require them) the front plate of a car
 *   driving toward it. So a car moving through the cone is seen either way
 *   by default, and only the cone (which road, which side of a junction)
 *   decides; turning front plates off makes the direction of travel count.
 */
export const VIEW_DEFAULTS = Object.freeze({
  rangeM: 40,
  halfAngleDeg: 30,
  frontPlates: true,
  sampleM: 6,
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

/** Whether one camera reads the plate of a car at point p heading `heading`. */
export function cameraSees(camera, p, heading, opts = VIEW_DEFAULTS) {
  const o = { ...VIEW_DEFAULTS, ...opts };
  const at = [camera.lon, camera.lat];
  const d = haversineM(at, p);
  if (d > o.rangeM) return false;
  if (d < 1) return true;
  const toCar = bearingDeg(at, p);
  const dirs = camera.directions ?? parseDirections(camera.direction);
  if (
    dirs.length &&
    !dirs.some((dir) => angleDiff(dir, toCar) <= o.halfAngleDeg)
  )
    return false;
  // Moving away from the camera shows the rear plate; toward it, the front.
  const away = angleDiff(heading, toCar) < 90;
  return away || o.frontPlates;
}

/**
 * Index cameras for repeated "who sees this road segment" questions.
 * @param {Array<{id:any, lon:number, lat:number, direction?:any}>} cameras
 */
export function createCameraIndex(cameras, opts = {}) {
  const o = { ...VIEW_DEFAULTS, ...opts };
  const list = cameras
    .filter((c) => Number.isFinite(c.lon) && Number.isFinite(c.lat))
    .map((c) => ({ ...c, directions: parseDirections(c.direction) }));
  const lat = list.length ? list[0].lat : 0;
  const cellM = Math.max(50, o.rangeM * 2);
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
    /** Ids of cameras that read a car driving from a to b. */
    segmentSeenBy(a, b) {
      if (!list.length) return null;
      const len = haversineM(a, b);
      if (!touchesHot(a, b, len)) return null;
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const near = grid.near(mid[0], mid[1], len / 2 + o.rangeM);
      if (!near.length) return null;
      const heading = bearingDeg(a, b);
      const steps = Math.max(1, Math.ceil(len / o.sampleM));
      let seen = null;
      for (const cam of near) {
        if (haversineM([cam.lon, cam.lat], mid) > len / 2 + o.rangeM) continue;
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
          if (cameraSees(cam, p, heading, o)) {
            (seen ??= []).push(cam.id);
            break;
          }
        }
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
