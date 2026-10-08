/**
 * Pure helpers for building mode (no Cesium, no DOM): OSM feature parsing,
 * footprint measurements, height/volume estimates, and the fallback that
 * finds buildings in a height raster from rectangles and vertical walls.
 * Coordinates are [lon, lat] degrees unless stated otherwise.
 */

import { haversineMeters } from './siteGeometry.js';

const M_PER_DEG_LAT = 111_320;
export const METRES_PER_LEVEL = 3.2;
export const DEFAULT_BUILDING_HEIGHT_M = 8;
export const SQFT_PER_M2 = 10.763910417;
export const CUFT_PER_M3 = 35.314666721;
/** Largest building-mode area, so one Overpass request stays modest. */
export const BUILDING_MAX_SPAN_DEG = 0.025;

// ---------------------------------------------------------------------------
// Footprint geometry
// ---------------------------------------------------------------------------

/** Average of the ring's distinct vertices. */
export function ringCenter(ring) {
  const pts = openRing(ring);
  let lon = 0;
  let lat = 0;
  for (const [x, y] of pts) {
    lon += x;
    lat += y;
  }
  return [lon / pts.length, lat / pts.length];
}

/** Ring without the repeated closing vertex. */
export function openRing(ring) {
  if (ring.length > 1) {
    const [a, b] = [ring[0], ring.at(-1)];
    if (a[0] === b[0] && a[1] === b[1]) return ring.slice(0, -1);
  }
  return ring;
}

/** Project [lon, lat] to local metres (east, north) around an origin. */
export function toLocalMetres(points, [lon0, lat0]) {
  const kx = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  return points.map(([lon, lat]) => [
    (lon - lon0) * kx,
    (lat - lat0) * M_PER_DEG_LAT,
  ]);
}

/** Inverse of toLocalMetres. */
export function fromLocalMetres(points, [lon0, lat0]) {
  const kx = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  return points.map(([x, y]) => [lon0 + x / kx, lat0 + y / M_PER_DEG_LAT]);
}

/** Shoelace area of planar points (absolute). */
export function planarArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

/** Footprint area in m². */
export function footprintAreaM2(ring) {
  const pts = openRing(ring);
  return planarArea(toLocalMetres(pts, ringCenter(pts)));
}

/** Length of a line (or closed ring) in metres. */
export function lineLengthM(coords) {
  let total = 0;
  for (let i = 1; i < coords.length; i++)
    total += haversineMeters(coords[i - 1], coords[i]);
  return total;
}

/** Monotone-chain convex hull of planar points (counter-clockwise). */
export function convexHull(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), p) <= 0)
      lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), p) <= 0)
      upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/**
 * Minimum-area enclosing rectangle of planar points (rotating hull edges).
 * `pad` grows each side by that much (used for raster cells).
 * @returns {{ area:number, length:number, width:number, angleDeg:number,
 *   corners:number[][] }}
 */
export function minAreaRect(points, pad = 0) {
  const hull = convexHull(points);
  if (hull.length === 0)
    return { area: 0, length: 0, width: 0, angleDeg: 0, corners: [] };
  const edges =
    hull.length < 2
      ? [0]
      : hull.map((p, i) => {
          const q = hull[(i + 1) % hull.length];
          return Math.atan2(q[1] - p[1], q[0] - p[0]);
        });
  let best = null;
  for (const theta of edges) {
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const [x, y] of hull) {
      const u = x * c + y * s;
      const v = -x * s + y * c;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    minU -= pad;
    maxU += pad;
    minV -= pad;
    maxV += pad;
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area)
      best = { area, theta, minU, maxU, minV, maxV };
  }
  const { theta, minU, maxU, minV, maxV } = best;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const back = (u, v) => [u * c - v * s, u * s + v * c];
  const du = maxU - minU;
  const dv = maxV - minV;
  // Bearing of the long side, degrees clockwise from north, 0–180.
  const longTheta = du >= dv ? theta : theta + Math.PI / 2;
  const bearing = (((90 - (longTheta * 180) / Math.PI) % 180) + 180) % 180;
  return {
    area: best.area,
    length: Math.max(du, dv),
    width: Math.min(du, dv),
    angleDeg: Math.round(bearing),
    corners: [
      back(minU, minV),
      back(maxU, minV),
      back(maxU, maxV),
      back(minU, maxV),
    ],
  };
}

/**
 * Footprint measurements: area, perimeter, oriented dimensions, and how
 * rectangular it is (1 = a perfect rectangle).
 */
export function measureFootprint(ring) {
  const pts = openRing(ring);
  const center = ringCenter(pts);
  const local = toLocalMetres(pts, center);
  const areaM2 = planarArea(local);
  const rect = minAreaRect(local);
  return {
    center,
    areaM2,
    perimeterM: lineLengthM([...pts, pts[0]]),
    lengthM: rect.length,
    widthM: rect.width,
    bearingDeg: rect.angleDeg,
    rectangularity: rect.area > 0 ? Math.min(1, areaM2 / rect.area) : 0,
  };
}

// ---------------------------------------------------------------------------
// OSM tags → address, height, volume
// ---------------------------------------------------------------------------

/** A postal address from OSM addr:* tags, or null. */
export function osmAddress(tags = {}) {
  if (tags['addr:full']) return String(tags['addr:full']);
  const number = tags['addr:housenumber'];
  const street = tags['addr:street'] || tags['addr:place'];
  if (!street) return null;
  const line1 = [number, street].filter(Boolean).join(' ');
  const city = tags['addr:city'] || tags['addr:suburb'];
  const tail = [tags['addr:state'], tags['addr:postcode']]
    .filter(Boolean)
    .join(' ');
  return [line1, city, tail].filter(Boolean).join(', ');
}

/** Parse an OSM length ("12", "12 m", "40'", "40 ft", "12'6\"") into metres. */
export function parseOsmLength(value) {
  if (value == null) return null;
  const text = String(value).trim().toLowerCase();
  const feet = text.match(
    /^(\d+(?:\.\d+)?)\s*(?:'|ft|feet)\s*(?:(\d+(?:\.\d+)?)\s*(?:"|in))?$/,
  );
  if (feet) {
    const m = Number(feet[1]) * 0.3048 + Number(feet[2] || 0) * 0.0254;
    return m > 0 ? m : null;
  }
  const metres = text.match(/^(\d+(?:\.\d+)?)\s*(?:m|metres|meters)?$/);
  if (metres) {
    const m = Number(metres[1]);
    return m > 0 ? m : null;
  }
  return null;
}

/**
 * Best height for a building and where it came from. Priority: an OSM
 * height tag, a height measured from the 3D mesh, OSM levels × 3.2 m,
 * then a default.
 * @returns {{ heightM:number, source:'osm-height'|'mesh'|'osm-levels'|'default' }}
 */
export function resolveBuildingHeight(tags = {}, meshHeightM = null) {
  const tagged = parseOsmLength(tags.height ?? tags['building:height']);
  if (tagged) return { heightM: tagged, source: 'osm-height' };
  if (Number.isFinite(meshHeightM) && meshHeightM >= 2 && meshHeightM <= 600)
    return { heightM: meshHeightM, source: 'mesh' };
  const levels = Number(tags['building:levels']);
  if (Number.isFinite(levels) && levels > 0) {
    const roof = Number(tags['roof:levels']) || 0;
    return {
      heightM: (levels + roof * 0.5) * METRES_PER_LEVEL,
      source: 'osm-levels',
    };
  }
  return { heightM: DEFAULT_BUILDING_HEIGHT_M, source: 'default' };
}

/** Footprint × height, less any OSM min_height (a raised structure). */
export function buildingVolumeM3(areaM2, heightM, minHeightM = 0) {
  const h = Math.max(0, heightM - (Number(minHeightM) || 0));
  return areaM2 * h;
}

// ---------------------------------------------------------------------------
// OSM query + parsing
// ---------------------------------------------------------------------------

const PARK_LEISURE =
  'park|garden|playground|pitch|nature_reserve|recreation_ground|dog_park|common';
const PARK_LANDUSE = 'recreation_ground|village_green|cemetery|grass|forest';

/** Overpass QL: buildings, roads and parks/green space inside a bbox. */
export function buildingFeatureQuery({ minLon, minLat, maxLon, maxLat }) {
  const b = [minLat, minLon, maxLat, maxLon].map((v) => v.toFixed(6)).join(',');
  return [
    '[out:json][timeout:25];(',
    `way["building"](${b});`,
    `relation["building"](${b});`,
    `way["highway"](${b});`,
    `way["leisure"~"^(${PARK_LEISURE})$"](${b});`,
    `relation["leisure"~"^(${PARK_LEISURE})$"](${b});`,
    `way["landuse"~"^(${PARK_LANDUSE})$"](${b});`,
    ');out geom qt;',
  ].join('');
}

const geomCoords = (geometry) =>
  (Array.isArray(geometry) ? geometry : [])
    .filter((p) => Number.isFinite(p?.lon) && Number.isFinite(p?.lat))
    .map((p) => [p.lon, p.lat]);

const samePoint = (a, b) => a && b && a[0] === b[0] && a[1] === b[1];

/** Join relation member ways (role outer) into closed rings. */
export function assembleRings(members = []) {
  const pieces = members
    .filter((m) => m?.type === 'way' && (m.role || 'outer') === 'outer')
    .map((m) => geomCoords(m.geometry))
    .filter((c) => c.length >= 2);
  const rings = [];
  while (pieces.length) {
    let ring = pieces.shift();
    let grew = true;
    while (!samePoint(ring[0], ring.at(-1)) && grew) {
      grew = false;
      for (let i = 0; i < pieces.length; i++) {
        const p = pieces[i];
        if (samePoint(ring.at(-1), p[0])) ring = ring.concat(p.slice(1));
        else if (samePoint(ring.at(-1), p.at(-1)))
          ring = ring.concat([...p].reverse().slice(1));
        else continue;
        pieces.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (samePoint(ring[0], ring.at(-1)) && ring.length >= 4) rings.push(ring);
  }
  return rings;
}

const isPark = (tags) =>
  new RegExp(`^(${PARK_LEISURE})$`).test(tags.leisure || '') ||
  new RegExp(`^(${PARK_LANDUSE})$`).test(tags.landuse || '');

/**
 * Overpass JSON → { buildings, roads, parks }. Each feature keeps its OSM
 * type/id and tags; buildings and parks carry closed rings, roads a line.
 */
export function parseBuildingFeatures(json) {
  const buildings = [];
  const roads = [];
  const parks = [];
  for (const el of json?.elements ?? []) {
    const tags = el?.tags ?? {};
    const base = { osmType: el?.type, osmId: el?.id, tags };
    let rings = [];
    if (el?.type === 'way') {
      const coords = geomCoords(el.geometry);
      if (tags.highway) {
        if (coords.length >= 2) roads.push({ ...base, kind: 'road', coords });
        continue;
      }
      if (coords.length >= 4 && samePoint(coords[0], coords.at(-1)))
        rings = [coords];
    } else if (el?.type === 'relation') {
      rings = assembleRings(el.members);
    } else continue;
    if (!rings.length) continue;
    if (tags.building && tags.building !== 'no') {
      // The largest outer ring is the footprint; others are extra parts.
      rings.sort((a, b) => footprintAreaM2(b) - footprintAreaM2(a));
      buildings.push({
        ...base,
        kind: 'building',
        ring: rings[0],
        parts: rings,
      });
    } else if (isPark(tags)) {
      parks.push({ ...base, kind: 'park', rings });
    }
  }
  return { buildings, roads, parks };
}

// ---------------------------------------------------------------------------
// Fallback: buildings from a height raster (rectangles + vertical walls)
// ---------------------------------------------------------------------------

export const MESH_DETECT_DEFAULTS = Object.freeze({
  minHeightM: 3,
  minAreaM2: 40,
  maxAreaM2: 60_000,
  minRectangularity: 0.8,
  minVerticality: 0.5,
  wallDropM: 2,
  blockM: 40,
  groundQuantile: 0.05,
});

function quantile(values, q) {
  if (!values.length) return Number.NaN;
  const sorted = Float64Array.from(values).sort();
  const pos = Math.min(sorted.length - 1, Math.max(0, q * (sorted.length - 1)));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Estimate bare ground under a surface raster: a low quantile per block,
 * bilinearly blended between block centres. Good enough on gentle slopes;
 * pass a real DEM when one is available.
 */
export function estimateGround(surface, width, height, blockCells, q = 0.05) {
  const B = Math.max(2, Math.round(blockCells));
  const bw = Math.ceil(width / B);
  const bh = Math.ceil(height / B);
  const blocks = new Float64Array(bw * bh).fill(Number.NaN);
  for (let by = 0; by < bh; by++)
    for (let bx = 0; bx < bw; bx++) {
      const vals = [];
      for (let r = by * B; r < Math.min(height, (by + 1) * B); r++)
        for (let c = bx * B; c < Math.min(width, (bx + 1) * B); c++) {
          const v = surface[r * width + c];
          if (Number.isFinite(v)) vals.push(v);
        }
      blocks[by * bw + bx] = quantile(vals, q);
    }
  // Fill empty blocks from their neighbours.
  for (let pass = 0; pass < bw + bh; pass++) {
    let missing = 0;
    for (let i = 0; i < blocks.length; i++) {
      if (Number.isFinite(blocks[i])) continue;
      const x = i % bw;
      const y = Math.floor(i / bw);
      const near = [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ]
        .filter(([a, b]) => a >= 0 && b >= 0 && a < bw && b < bh)
        .map(([a, b]) => blocks[b * bw + a])
        .filter(Number.isFinite);
      if (near.length)
        blocks[i] = near.reduce((s, v) => s + v, 0) / near.length;
      else missing++;
    }
    if (!missing) break;
  }
  const at = (x, y) =>
    blocks[
      Math.min(bh - 1, Math.max(0, y)) * bw + Math.min(bw - 1, Math.max(0, x))
    ];
  const ground = new Float64Array(width * height);
  for (let r = 0; r < height; r++) {
    const fy = Math.min(bh - 1, Math.max(0, (r + 0.5) / B - 0.5));
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    for (let c = 0; c < width; c++) {
      const fx = Math.min(bw - 1, Math.max(0, (c + 0.5) / B - 0.5));
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
      const bottom = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
      ground[r * width + c] = top * (1 - ty) + bottom * ty;
    }
  }
  return ground;
}

/**
 * Find building-like blobs in a surface-height raster (e.g. the Google 3D
 * mesh sampled on a grid). A blob counts as a building when it is
 * rectangular in plan and its edges are walls (the roof stays high right to
 * the edge), which separates buildings from rounded, tapering tree crowns.
 *
 * Raster rows run north → south; corners come back in cell units
 * ([col, row], fractional) so the caller maps them to lon/lat.
 *
 * @param {{ surface: ArrayLike<number>, width:number, height:number,
 *   cellM:number, ground?: ArrayLike<number>, options?: object }} input
 */
export function detectBuildingsFromHeights({
  surface,
  width,
  height,
  cellM,
  ground = null,
  options = {},
}) {
  const o = { ...MESH_DETECT_DEFAULTS, ...options };
  const g =
    ground ??
    estimateGround(surface, width, height, o.blockM / cellM, o.groundQuantile);
  const n = width * height;
  const above = new Float64Array(n);
  for (let i = 0; i < n; i++) above[i] = surface[i] - g[i];
  const isUp = (i) => Number.isFinite(above[i]) && above[i] >= o.minHeightM;
  const label = new Int32Array(n).fill(-1);
  const found = [];
  const cellArea = cellM * cellM;
  let next = 0;
  for (let start = 0; start < n; start++) {
    if (label[start] !== -1 || !isUp(start)) continue;
    const id = next++;
    const cells = [start];
    label[start] = id;
    for (let k = 0; k < cells.length; k++) {
      const i = cells[k];
      const x = i % width;
      const y = (i - x) / width;
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ]) {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        if (label[j] === -1 && isUp(j)) {
          label[j] = id;
          cells.push(j);
        }
      }
    }
    const areaM2 = cells.length * cellArea;
    if (areaM2 < o.minAreaM2 || areaM2 > o.maxAreaM2) continue;
    const heights = cells.map((i) => above[i]);
    const roofM = quantile(heights, 0.9);
    // Rectangularity on cell centres, padded by half a cell per side.
    const pts = cells.map((i) => [i % width, Math.floor(i / width)]);
    const rect = minAreaRect(pts, 0.5);
    const rectangularity =
      rect.area > 0 ? Math.min(1, cells.length / rect.area) : 0;
    // Verticality: share of edge cells that stand near roof height and
    // drop sharply to a neighbour outside the blob.
    let edges = 0;
    let walls = 0;
    for (const i of cells) {
      const x = i % width;
      const y = (i - x) / width;
      let edge = false;
      let drop = 0;
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ]) {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        if (label[j] === id) continue;
        edge = true;
        if (Number.isFinite(above[j]))
          drop = Math.max(drop, above[i] - above[j]);
      }
      if (!edge) continue;
      edges++;
      if (above[i] >= 0.6 * roofM && drop >= o.wallDropM) walls++;
    }
    const verticality = edges ? walls / edges : 0;
    if (rectangularity < o.minRectangularity || verticality < o.minVerticality)
      continue;
    const groundM = quantile(
      cells.map((i) => g[i]),
      0.5,
    );
    found.push({
      id: `mesh-${found.length + 1}`,
      cells: cells.length,
      areaM2,
      heightM: roofM,
      groundM,
      rectangularity,
      verticality,
      confidence: Math.min(
        1,
        (rectangularity - 0.5) * 1.2 + (verticality - 0.4),
      ),
      lengthM: rect.length * cellM,
      widthM: rect.width * cellM,
      // Rows grow south, so mirror the bearing to read clockwise from north.
      bearingDeg: (180 - rect.angleDeg) % 180,
      corners: rect.corners,
    });
  }
  return found;
}
