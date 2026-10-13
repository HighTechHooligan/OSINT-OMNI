/**
 * Pure survey helpers for the site boundary (no Cesium, no DOM): radius
 * circles, angle snapping while drawing, and parsing pasted coordinate
 * lists (CSV/TSV/plain "lat, lon" lines) into points. Coordinates are
 * [lon, lat] degrees.
 */

import { convexHull, fromLocalMetres, toLocalMetres } from './buildingMath.js';
import { FEET_PER_METRE } from './siteGeometry.js';

export const SNAP_STEPS_DEG = Object.freeze([0, 5, 15, 30, 45, 90]);
export const CIRCLE_SEGMENTS = 72;
export const CIRCLE_MAX_RADIUS_M = 5000;

/** "150", "150m", "500 ft", "0.5km", "0.25 mi" → metres, or null. */
export function parseLength(text, defaultUnit = 'm') {
  const m = String(text ?? '')
    .trim()
    .toLowerCase()
    .match(
      /^(\d+(?:\.\d+)?)\s*(m|meters?|metres?|ft|feet|foot|'|km|mi|miles?|yd|yards?)?$/,
    );
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] ?? defaultUnit;
  const factor = /^(ft|feet|foot|')$/.test(unit)
    ? 1 / FEET_PER_METRE
    : /^km$/.test(unit)
      ? 1000
      : /^mi/.test(unit)
        ? 1609.344
        : /^y/.test(unit)
          ? 0.9144
          : 1;
  const metres = n * factor;
  return metres > 0 ? metres : null;
}

/** Closed ring approximating a circle of `radiusM` around [lon, lat]. */
export function circleRing(center, radiusM, segments = CIRCLE_SEGMENTS) {
  const r = Math.min(CIRCLE_MAX_RADIUS_M, Math.max(0.5, radiusM));
  const pts = [];
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * 2 * Math.PI;
    pts.push([r * Math.sin(t), r * Math.cos(t)]); // clockwise from north
  }
  const ring = fromLocalMetres(pts, center);
  return [...ring, [...ring[0]]];
}

/** Distance in metres and bearing (° clockwise from north) from a to b. */
export function measureSegment(a, b) {
  const [[x, y]] = toLocalMetres([b], a);
  return {
    lengthM: Math.hypot(x, y),
    bearingDeg: ((((Math.atan2(x, y) * 180) / Math.PI) % 360) + 360) % 360,
  };
}

/**
 * Snap the next drawing vertex. With one previous vertex the segment's
 * bearing snaps to multiples of `stepDeg` (so 90 gives north/east/south/
 * west). With two, the turn angle relative to the previous segment snaps
 * instead, so a rotated rectangle stays square. Length is kept.
 * @returns {number[]} snapped [lon, lat]
 */
export function snapVertex(vertices, cursor, stepDeg) {
  const prev = vertices.at(-1);
  if (!prev || !stepDeg) return cursor;
  const { lengthM, bearingDeg } = measureSegment(prev, cursor);
  if (lengthM < 0.01) return cursor;
  const before = vertices.at(-2);
  let bearing;
  if (before) {
    const ref = measureSegment(before, prev).bearingDeg;
    const turn = bearingDeg - ref;
    bearing = ref + Math.round(turn / stepDeg) * stepDeg;
  } else bearing = Math.round(bearingDeg / stepDeg) * stepDeg;
  const t = (bearing * Math.PI) / 180;
  const [p] = fromLocalMetres(
    [[lengthM * Math.sin(t), lengthM * Math.cos(t)]],
    prev,
  );
  return p;
}

// ---------------------------------------------------------------------------
// Pasted coordinates
// ---------------------------------------------------------------------------

const LAT_HEAD = /^(lat|latitude|y|northing)$/i;
const LON_HEAD = /^(lon|lng|long|longitude|x|easting)$/i;
const NAME_HEAD = /^(name|id|label|point|title|gcp|description)$/i;

const isNum = (s) => /^[+-]?\d+(?:\.\d+)?$/.test(String(s).trim());

/** True when the text looks like KML (or a KML fragment). */
export function looksLikeKml(text) {
  return /<(kml|Placemark|Polygon|LineString|Point|coordinates)\b/i.test(
    String(text),
  );
}

/** Wrap a KML fragment (e.g. one Placemark) so the KML loader accepts it. */
export function wrapKml(text) {
  const t = String(text).trim();
  if (/<kml\b/i.test(t)) return t;
  return `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>${
    /<Placemark\b/i.test(t) ? t : `<Placemark>${t}</Placemark>`
  }</Document></kml>`;
}

function splitRow(line) {
  if (line.includes('\t')) return line.split('\t');
  if (line.includes(';')) return line.split(';');
  if (line.includes(',')) return line.split(',');
  return line.trim().split(/\s+/);
}

/**
 * Parse a pasted list of coordinates.
 *
 * Accepts CSV/TSV/semicolon rows with or without a header (lat/latitude,
 * lon/lng/longitude, name/id), plain "lat, lon" or "lat lon" lines, and an
 * optional name in the first or last column. Without a header the order is
 * `order` ('auto' reads lat,lon unless the first value cannot be a latitude).
 *
 * @param {string} text
 * @param {{ order?: 'auto'|'latlon'|'lonlat' }} [options]
 * @returns {{ points: {name:string, lon:number, lat:number}[],
 *   skipped: number, order: 'latlon'|'lonlat', header: boolean }}
 */
export function parseCoordinateList(text, { order = 'auto' } = {}) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  let latCol = -1;
  let lonCol = -1;
  let nameCol = -1;
  let header = false;
  if (lines.length) {
    const cells = splitRow(lines[0]).map((c) => c.trim().replace(/^"|"$/g, ''));
    const lat = cells.findIndex((c) => LAT_HEAD.test(c));
    const lon = cells.findIndex((c) => LON_HEAD.test(c));
    if (lat !== -1 && lon !== -1) {
      header = true;
      latCol = lat;
      lonCol = lon;
      nameCol = cells.findIndex((c) => NAME_HEAD.test(c));
      lines.shift();
    }
  }
  let resolved = order === 'lonlat' ? 'lonlat' : 'latlon';
  const rows = lines.map((l) =>
    splitRow(l).map((c) => c.trim().replace(/^"|"$/g, '')),
  );
  if (!header && order === 'auto') {
    // Any first numeric value outside ±90 means the list is lon,lat.
    const firstNums = rows
      .map((r) => r.filter(isNum).map(Number))
      .filter((n) => n.length >= 2);
    if (firstNums.some(([a, b]) => Math.abs(a) > 90 && Math.abs(b) <= 90))
      resolved = 'lonlat';
  }
  const points = [];
  let skipped = 0;
  for (const r of rows) {
    let lat;
    let lon;
    let name = '';
    if (header) {
      lat = Number(r[latCol]);
      lon = Number(r[lonCol]);
      name = nameCol >= 0 ? (r[nameCol] ?? '') : '';
    } else {
      const numIdx = r.map((c, i) => (isNum(c) ? i : -1)).filter((i) => i >= 0);
      if (numIdx.length < 2) {
        skipped++;
        continue;
      }
      // Name = first non-numeric cell; coordinates = first two numbers.
      name = r.find((c) => c && !isNum(c)) ?? '';
      const [a, b] = [Number(r[numIdx[0]]), Number(r[numIdx[1]])];
      [lat, lon] = resolved === 'lonlat' ? [b, a] : [a, b];
    }
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    ) {
      skipped++;
      continue;
    }
    points.push({ name: name || `P${points.length + 1}`, lon, lat });
  }
  return { points, skipped, order: resolved, header };
}

/** Outline (convex hull) ring around points, closed; null if < 3 points. */
export function outlineRing(lonLats) {
  if (lonLats.length < 3) return null;
  const c = [
    lonLats.reduce((s, p) => s + p[0], 0) / lonLats.length,
    lonLats.reduce((s, p) => s + p[1], 0) / lonLats.length,
  ];
  const hull = convexHull(toLocalMetres(lonLats, c));
  if (hull.length < 3) return null;
  const ring = fromLocalMetres(hull, c);
  return [...ring, [...ring[0]]];
}
