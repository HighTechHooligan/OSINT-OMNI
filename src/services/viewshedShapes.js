/**
 * Observer shapes for the viewshed (pure: no Cesium, no DOM). Coordinates
 * are [lon, lat] degrees.
 *
 *   { kind: 'point', at: [lon, lat] }           one observer
 *   { kind: 'line',  path: [[lon, lat], …] }    a walking path or a drive:
 *                                               observers every few metres
 *   { kind: 'area',  ring: [[lon, lat], …] }    a park or a radius circle:
 *                                               observers over the inside
 *
 * The analysed area is everything within `reachM` of the shape.
 */
import { boundaryAreaM2, pointInRing } from './siteGeometry.js';
import { parseCoordinateList } from './surveyGeometry.js';

const M_PER_DEG_LAT = 111_320;

export const SHAPE_LIMITS = Object.freeze({
  maxReachM: 5000,
  maxObservers: 2000,
  maxDemTileKm2: 24, // the 3DEP proxy refuses more than 25 km² per request
  maxDemTileSidePx: 2000, // and more than 2048 px per side
});

const mPerDegLon = (lat) => M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);

/** Validate a shape; rings are closed, paths need two distinct points. */
export function normalizeShape(shape) {
  const pt = (p) => {
    const lon = Number(p?.[0]);
    const lat = Number(p?.[1]);
    if (
      !Number.isFinite(lon) ||
      !Number.isFinite(lat) ||
      Math.abs(lon) > 180 ||
      Math.abs(lat) > 90
    )
      throw new Error(`Bad coordinate: ${p}`);
    return [lon, lat];
  };
  const kind = shape?.kind;
  if (kind === 'point') return { kind, at: pt(shape.at) };
  if (kind === 'line') {
    const path = (shape.path ?? []).map(pt);
    if (path.length < 2) throw new Error('A route needs at least 2 points');
    return { kind, path };
  }
  if (kind === 'area') {
    const ring = (shape.ring ?? []).map(pt);
    if (ring.length < 3) throw new Error('An area needs at least 3 corners');
    const [a, b] = [ring[0], ring.at(-1)];
    if (a[0] !== b[0] || a[1] !== b[1]) ring.push([...a]);
    return { kind, ring, ...(shape.circle ? { circle: shape.circle } : {}) };
  }
  throw new Error(`Unknown shape: ${kind}`);
}

export const shapePoints = (shape) =>
  shape.kind === 'point'
    ? [shape.at]
    : shape.kind === 'line'
      ? shape.path
      : shape.ring;

/** Length of a path in metres (local flat-earth steps, fine below ~100 km). */
export function pathLengthM(path) {
  let sum = 0;
  for (let k = 1; k < path.length; k++) sum += stepM(path[k - 1], path[k]);
  return sum;
}

function stepM(a, b) {
  const lat = (a[1] + b[1]) / 2;
  return Math.hypot(
    (b[0] - a[0]) * mPerDegLon(lat),
    (b[1] - a[1]) * M_PER_DEG_LAT,
  );
}

/** Route length, area and centre, for status lines and the orbit. */
export function describeShape(shape) {
  const pts = shapePoints(shape);
  const bbox = shapeBbox(shape);
  const center = [
    (bbox.minLon + bbox.maxLon) / 2,
    (bbox.minLat + bbox.maxLat) / 2,
  ];
  let radiusM = 0;
  for (const p of pts) radiusM = Math.max(radiusM, stepM(center, p));
  return {
    kind: shape.kind,
    center,
    radiusM,
    lengthM:
      shape.kind === 'line'
        ? pathLengthM(shape.path)
        : shape.kind === 'area'
          ? pathLengthM(shape.ring)
          : 0,
    areaM2: shape.kind === 'area' ? boundaryAreaM2(shape.ring) : 0,
  };
}

export function shapeBbox(shape) {
  const pts = shapePoints(shape);
  return {
    minLon: Math.min(...pts.map((p) => p[0])),
    minLat: Math.min(...pts.map((p) => p[1])),
    maxLon: Math.max(...pts.map((p) => p[0])),
    maxLat: Math.max(...pts.map((p) => p[1])),
  };
}

/** Grow a bbox by `m` metres on every side. */
export function expandBbox(bbox, m) {
  const lat = (bbox.minLat + bbox.maxLat) / 2;
  const dLon = m / mPerDegLon(lat);
  const dLat = m / M_PER_DEG_LAT;
  return {
    minLon: bbox.minLon - dLon,
    minLat: Math.max(-90, bbox.minLat - dLat),
    maxLon: bbox.maxLon + dLon,
    maxLat: Math.min(90, bbox.maxLat + dLat),
  };
}

export function bboxSizeM(bbox) {
  const lat = (bbox.minLat + bbox.maxLat) / 2;
  return {
    widthM: (bbox.maxLon - bbox.minLon) * mPerDegLon(lat),
    heightM: (bbox.maxLat - bbox.minLat) * M_PER_DEG_LAT,
  };
}

/** Points every `spacingM` along a path, both ends included. */
export function pointsAlongPath(path, spacingM) {
  const out = [[...path[0]]];
  let carry = 0; // metres walked since the last point
  for (let k = 1; k < path.length; k++) {
    const a = path[k - 1];
    const b = path[k];
    const len = stepM(a, b);
    let d = spacingM - carry;
    while (d <= len) {
      const t = d / len;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      d += spacingM;
    }
    carry = len - (d - spacingM);
  }
  const last = path.at(-1);
  // A point a hair short of the end (rounding) becomes the end itself.
  if (out.length > 1 && stepM(out.at(-1), last) < spacingM * 0.05) out.pop();
  const prev = out.at(-1);
  if (prev[0] !== last[0] || prev[1] !== last[1]) out.push([...last]);
  return out;
}

/** A square lattice of points `spacingM` apart inside a ring, plus its edge. */
export function pointsInRing(ring, spacingM) {
  const bbox = shapeBbox({ kind: 'area', ring });
  const lat = (bbox.minLat + bbox.maxLat) / 2;
  const dLon = spacingM / mPerDegLon(lat);
  const dLat = spacingM / M_PER_DEG_LAT;
  const out = pointsAlongPath(ring, spacingM);
  for (let y = bbox.minLat + dLat / 2; y < bbox.maxLat; y += dLat)
    for (let x = bbox.minLon + dLon / 2; x < bbox.maxLon; x += dLon)
      if (pointInRing([x, y], ring)) out.push([x, y]);
  return out;
}

/**
 * Observer positions for a shape: no closer than `minSpacingM` (about two
 * grid cells; closer observers see the same thing) and no more than
 * `maxObservers`, widening the spacing to fit.
 * @returns {{ points: number[][], spacingM: number }}
 */
export function shapeObservers(
  shape,
  minSpacingM,
  maxObservers = SHAPE_LIMITS.maxObservers,
) {
  if (shape.kind === 'point') return { points: [shape.at], spacingM: 0 };
  let spacingM = Math.max(1, minSpacingM);
  const info = describeShape(shape);
  if (shape.kind === 'line')
    spacingM = Math.max(spacingM, info.lengthM / (maxObservers - 1));
  else
    spacingM = Math.max(
      spacingM,
      Math.sqrt(info.areaM2 / (maxObservers * 0.8)),
      info.lengthM / (maxObservers * 0.2),
    );
  const make = (s) =>
    shape.kind === 'line'
      ? pointsAlongPath(shape.path, s)
      : pointsInRing(shape.ring, s);
  let points = make(spacingM);
  while (points.length > maxObservers) {
    spacingM *= 1.25;
    points = make(spacingM);
  }
  return { points, spacingM };
}

/** Distance in metres from a point to the shape (0 inside an area). */
export function distanceToShapeM(p, shape) {
  if (shape.kind === 'point') return stepM(p, shape.at);
  if (shape.kind === 'area' && pointInRing(p, shape.ring)) return 0;
  const pts = shape.kind === 'line' ? shape.path : shape.ring;
  const kx = mPerDegLon(p[1]);
  let best = Infinity;
  for (let k = 1; k < pts.length; k++) {
    const ax = (pts[k - 1][0] - p[0]) * kx;
    const ay = (pts[k - 1][1] - p[1]) * M_PER_DEG_LAT;
    const bx = (pts[k][0] - p[0]) * kx;
    const by = (pts[k][1] - p[1]) * M_PER_DEG_LAT;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(ax + dx * t, ay + dy * t));
  }
  return best;
}

/**
 * Split a bbox into elevation-request tiles small enough for the 3DEP proxy
 * at `resM`, keeping only tiles within `reachM` of the shape (a long,
 * diagonal drive needs a corridor of tiles, not the whole square).
 * @returns {Array<{minLon:number,minLat:number,maxLon:number,maxLat:number}>}
 */
export function planDemTiles(bbox, resM, shape = null, reachM = 0) {
  const { widthM, heightM } = bboxSizeM(bbox);
  const side = Math.min(
    Math.sqrt(SHAPE_LIMITS.maxDemTileKm2) * 1000,
    SHAPE_LIMITS.maxDemTileSidePx * resM,
  );
  const nx = Math.max(1, Math.ceil(widthM / side));
  const ny = Math.max(1, Math.ceil(heightM / side));
  const dLon = (bbox.maxLon - bbox.minLon) / nx;
  const dLat = (bbox.maxLat - bbox.minLat) / ny;
  const tiles = [];
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const t = {
        minLon: bbox.minLon + i * dLon,
        maxLon: bbox.minLon + (i + 1) * dLon,
        minLat: bbox.minLat + j * dLat,
        maxLat: bbox.minLat + (j + 1) * dLat,
      };
      if (shape) {
        const c = [(t.minLon + t.maxLon) / 2, (t.minLat + t.maxLat) / 2];
        const s = bboxSizeM(t);
        if (
          distanceToShapeM(c, shape) >
          reachM + Math.hypot(s.widthM, s.heightM) / 2
        )
          continue;
      }
      tiles.push(t);
    }
  return tiles;
}

/**
 * A route ('line') or area from text: KML (the first <coordinates>, which
 * holds lon,lat[,alt] tuples) or a coordinate list (CSV, `lat, lon` lines,
 * or pairs separated by `;`).
 */
export function parseShapeText(text, kind = 'line') {
  const raw = String(text ?? '');
  const kml = /<coordinates>([\s\S]*?)<\/coordinates>/i.exec(raw);
  const pts = kml
    ? kml[1]
        .trim()
        .split(/\s+/)
        .map((t) => t.split(',').map(Number))
        .filter(
          (a) =>
            a.length >= 2 && Number.isFinite(a[0]) && Number.isFinite(a[1]),
        )
        .map(([lon, lat]) => [lon, lat])
    : parseCoordinateList(raw.replace(/;/g, '\n')).points.map((p) => [
        p.lon,
        p.lat,
      ]);
  return normalizeShape(
    kind === 'area' ? { kind, ring: pts } : { kind: 'line', path: pts },
  );
}

/**
 * Grid cell size (m) that lets a route or area run within `work`
 * sight-line steps with observers `k` cells apart. Each observer walks
 * about π·(reach/cell)³/2 steps, so finer cells cost the cube; coarser
 * cells with denser observers usually show more than fine cells with few.
 */
export function workCellM(shape, reachM, work, k = 4) {
  if (shape.kind === 'point' || !Number.isFinite(work)) return 0;
  const info = describeShape(shape);
  const observers = (c) => {
    const s = k * c;
    return shape.kind === 'line'
      ? info.lengthM / s + 1
      : info.areaM2 / (s * s) + info.lengthM / s + 1;
  };
  const cost = (c) => (observers(c) * Math.PI * (reachM / c) ** 3) / 2;
  let lo = 0.5;
  let hi = 500;
  if (cost(lo) <= work) return lo;
  for (let i = 0; i < 40; i++) {
    const mid = Math.sqrt(lo * hi);
    if (cost(mid) > work) lo = mid;
    else hi = mid;
  }
  return hi;
}
