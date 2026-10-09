/**
 * Small geodesy helpers. Points are [lon, lat] in degrees, distances in metres.
 */
export const EARTH_RADIUS_M = 6371008.8;
const RAD = Math.PI / 180;

export function haversineM(a, b) {
  const dLat = (b[1] - a[1]) * RAD;
  const dLon = (b[0] - a[0]) * RAD;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Distance from p to segment ab on a local flat projection (fine below ~50 km). */
export function pointSegmentM(p, a, b) {
  const kx = Math.cos(p[1] * RAD) * RAD * EARTH_RADIUS_M;
  const ky = RAD * EARTH_RADIUS_M;
  const ax = (a[0] - p[0]) * kx;
  const ay = (a[1] - p[1]) * ky;
  const bx = (b[0] - p[0]) * kx;
  const by = (b[1] - p[1]) * ky;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/** Nearest distance from p to a polyline, with the segment index it fell on. */
export function distanceToLineM(p, line) {
  let best = Infinity;
  let index = -1;
  if (line.length === 1) return { distance: haversineM(p, line[0]), index: 0 };
  for (let i = 0; i < line.length - 1; i++) {
    const d = pointSegmentM(p, line[i], line[i + 1]);
    if (d < best) {
      best = d;
      index = i;
    }
  }
  return { distance: best, index };
}

/** [west, south, east, north] around points, padded by padM metres. */
export function bboxOf(points, padM = 0) {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const [lon, lat] of points) {
    if (lon < w) w = lon;
    if (lon > e) e = lon;
    if (lat < s) s = lat;
    if (lat > n) n = lat;
  }
  const padLat = padM / (RAD * EARTH_RADIUS_M);
  const midLat = ((s + n) / 2) * RAD;
  const padLon = padLat / Math.max(0.01, Math.cos(midLat));
  return [w - padLon, s - padLat, e + padLon, n + padLat];
}

export function inBbox(p, [w, s, e, n]) {
  return p[0] >= w && p[0] <= e && p[1] >= s && p[1] <= n;
}

/** Cumulative distance along a line, metres, one entry per vertex. */
export function cumulativeM(line) {
  const out = new Float64Array(line.length);
  for (let i = 1; i < line.length; i++)
    out[i] = out[i - 1] + haversineM(line[i - 1], line[i]);
  return out;
}
