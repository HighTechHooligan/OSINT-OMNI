/**
 * Horizontal datum shift: NAD83(2011) → WGS84 (realised as ITRF2014, which
 * current WGS84 (G2139) and Google's 3D tiles agree with at the cm level).
 *
 * USGS 3DEP DEMs are surveyed in NAD83, and the 3DEP image service hands them
 * out in "EPSG:4326" without a datum transformation, so a 3DEP lon/lat is
 * really a NAD83 lon/lat. NAD83 is pinned to the North American plate while
 * WGS84 is global, so the two drift apart: ~1–2 m across the US today, and
 * growing by a couple of cm per year. The shift is computed per point from
 * the published 14-parameter Helmert transform (Pearson & Snay 2013,
 * "Introducing HTDP 3.1", ITRF2008 → NAD83(2011), t0 = 1997.0), not from a
 * hand-tuned offset, so it is right anywhere NAD83 data comes from.
 *
 * Pure math, no Cesium. Heights pass through unchanged (contours only need
 * horizontal positions; vertical datums are handled in data/geoid.js).
 */

const MAS = Math.PI / (180 * 3600 * 1000); // milliarcseconds → radians
const T0 = 1997.0;
// ITRF2008(≈ITRF2014) → NAD83(2011), coordinate-frame rotation convention.
const P = {
  t: [0.99343, -1.90331, -0.52655], // m
  dt: [0.00079, -0.0006, -0.00134], // m/yr
  r: [25.91467, 9.42645, 11.59935], // mas
  dr: [0.06667, -0.75744, -0.05133], // mas/yr
  s: 1.71504, // ppb
  ds: -0.10201, // ppb/yr
};

// GRS80 (NAD83). WGS84 differs by 0.1 mm in the semi-minor axis; ignored.
const A = 6378137;
const F = 1 / 298.257222101;
const E2 = F * (2 - F);

/** Decimal year for a Date (defaults to now). */
export function decimalYear(date = new Date()) {
  const y = date.getUTCFullYear();
  const start = Date.UTC(y, 0, 1);
  const end = Date.UTC(y + 1, 0, 1);
  return y + (date.getTime() - start) / (end - start);
}

function toEcef(lon, lat, h = 0) {
  const lam = (lon * Math.PI) / 180;
  const phi = (lat * Math.PI) / 180;
  const sinPhi = Math.sin(phi);
  const n = A / Math.sqrt(1 - E2 * sinPhi * sinPhi);
  return [
    (n + h) * Math.cos(phi) * Math.cos(lam),
    (n + h) * Math.cos(phi) * Math.sin(lam),
    (n * (1 - E2) + h) * sinPhi,
  ];
}

function fromEcef([x, y, z]) {
  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - E2));
  let h = 0;
  for (let i = 0; i < 5; i++) {
    const sinLat = Math.sin(lat);
    const n = A / Math.sqrt(1 - E2 * sinLat * sinLat);
    h = p / Math.cos(lat) - n;
    lat = Math.atan2(z, p * (1 - (E2 * n) / (n + h)));
  }
  return [(lon * 180) / Math.PI, (lat * 180) / Math.PI, h];
}

/** ITRF → NAD83 ECEF at `epoch` (decimal year). */
function itrfToNad83([x, y, z], epoch) {
  const dt = epoch - T0;
  const [tx, ty, tz] = P.t.map((v, i) => v + P.dt[i] * dt);
  const [ex, ey, ez] = P.r.map((v, i) => (v + P.dr[i] * dt) * MAS);
  const s = (P.s + P.ds * dt) * 1e-9;
  return [
    tx + (1 + s) * x + ez * y - ey * z,
    ty - ez * x + (1 + s) * y + ex * z,
    tz + ey * x - ex * y + (1 + s) * z,
  ];
}

/**
 * NAD83(2011) lon/lat → WGS84 lon/lat at `epoch` (default: now).
 * @returns {[number, number]}
 */
export function nad83ToWgs84(lon, lat, epoch = decimalYear()) {
  const target = toEcef(lon, lat);
  // Invert the (near-identity) transform by fixed-point iteration.
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const back = itrfToNad83(guess, epoch);
    guess = guess.map((v, k) => v + (target[k] - back[k]));
  }
  const [outLon, outLat] = fromEcef(guess);
  return [outLon, outLat];
}

/**
 * Shift (in degrees) that moves a NAD83 point near (lon, lat) onto WGS84.
 * Over a site a few km across it varies by well under a millimetre, so one
 * shift per grid is enough.
 * @returns {{ dLon: number, dLat: number, eastM: number, northM: number }}
 */
export function nad83ShiftAt(lon, lat, epoch = decimalYear()) {
  const [wLon, wLat] = nad83ToWgs84(lon, lat, epoch);
  const dLon = wLon - lon;
  const dLat = wLat - lat;
  const mPerDegLat = 111_320;
  return {
    dLon,
    dLat,
    eastM: dLon * mPerDegLat * Math.cos((lat * Math.PI) / 180),
    northM: dLat * mPerDegLat,
  };
}
