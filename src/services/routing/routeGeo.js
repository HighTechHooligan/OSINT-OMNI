/**
 * Geometry for the camera-aware router. Points are [lon, lat] in degrees,
 * distances in metres, bearings in degrees clockwise from north.
 */
export const EARTH_RADIUS_M = 6371008.8;
const RAD = Math.PI / 180;
const M_PER_DEG = RAD * EARTH_RADIUS_M;

export function haversineM(a, b) {
  const dLat = (b[1] - a[1]) * RAD;
  const dLon = (b[0] - a[0]) * RAD;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial bearing from a to b. */
export function bearingDeg(a, b) {
  const p1 = a[1] * RAD;
  const p2 = b[1] * RAD;
  const dl = (b[0] - a[0]) * RAD;
  const y = Math.sin(dl) * Math.cos(p2);
  const x =
    Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/** Smallest absolute difference between two bearings (0..180). */
export function angleDiff(a, b) {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
}

/** Signed turn from heading a to heading b (-180..180, right is positive). */
export function turnDeg(a, b) {
  return ((((b - a) % 360) + 540) % 360) - 180;
}

/** Metres east/north of an origin, on a flat local projection. */
export function toLocal(p, origin) {
  return [
    (p[0] - origin[0]) * M_PER_DEG * Math.cos(origin[1] * RAD),
    (p[1] - origin[1]) * M_PER_DEG,
  ];
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
  const padLat = padM / M_PER_DEG;
  const padLon = padLat / Math.max(0.01, Math.cos(((s + n) / 2) * RAD));
  return [w - padLon, s - padLat, e + padLon, n + padLat];
}

/**
 * Uniform grid over [lon, lat] points for "what is near here" lookups.
 * Cell size is in metres at the given latitude.
 */
export function createGrid(cellM, lat) {
  const dLat = cellM / M_PER_DEG;
  const dLon = dLat / Math.max(0.01, Math.cos(lat * RAD));
  const cells = new Map();
  // Numeric keys: string keys made lookups the router's hottest path.
  const key = (cx, cy) => (cx + 1048576) * 2097152 + (cy + 1048576);
  const cellOf = (lon, lat2) => [
    Math.floor(lon / dLon),
    Math.floor(lat2 / dLat),
  ];
  return {
    /** Numeric key of the cell holding a point. */
    keyOf(lon, lat2) {
      const [cx, cy] = cellOf(lon, lat2);
      return key(cx, cy);
    },
    /** Keys of the cell holding a point and its eight neighbours. */
    ringKeys(lon, lat2) {
      const [cx, cy] = cellOf(lon, lat2);
      const out = [];
      for (let x = cx - 1; x <= cx + 1; x++)
        for (let y = cy - 1; y <= cy + 1; y++) out.push(key(x, y));
      return out;
    },
    add(lon, lat2, item) {
      const [cx, cy] = cellOf(lon, lat2);
      const k = key(cx, cy);
      let list = cells.get(k);
      if (!list) cells.set(k, (list = []));
      list.push(item);
    },
    /** Items in cells within radiusM of a point (a superset; filter exactly). */
    near(lon, lat2, radiusM) {
      const [cx, cy] = cellOf(lon, lat2);
      const r = Math.ceil(radiusM / cellM);
      const out = [];
      for (let x = cx - r; x <= cx + r; x++)
        for (let y = cy - r; y <= cy + r; y++) {
          const list = cells.get(key(x, y));
          if (list) for (const item of list) out.push(item);
        }
      return out;
    },
  };
}

// ---- web-mercator tiles ----

export function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const c = Math.max(-85.05112878, Math.min(85.05112878, lat)) * RAD;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(
    ((1 - Math.log(Math.tan(c) + 1 / Math.cos(c)) / Math.PI) / 2) * n,
  );
  return {
    x: Math.min(n - 1, Math.max(0, x)),
    y: Math.min(n - 1, Math.max(0, y)),
  };
}

export function tileBbox({ z, x, y }) {
  const n = 2 ** z;
  const lon = (t) => (t / n) * 360 - 180;
  const lat = (t) =>
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * t) / n))) * 180) / Math.PI;
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
}

/** Tiles within padM of a polyline at one zoom. */
export function tilesNearLine(line, z, padM = 0) {
  const seen = new Map();
  const put = (lon, lat) => {
    const t = lonLatToTile(lon, lat, z);
    seen.set(`${t.x}/${t.y}`, { z, x: t.x, y: t.y });
  };
  const padLat = padM / M_PER_DEG;
  const tileDeg = 360 / 2 ** z;
  const step = Math.max(tileDeg / 4, 1e-6);
  const visit = (lon, lat) => {
    if (!padM) return put(lon, lat);
    const padLon = padLat / Math.max(0.01, Math.cos(lat * RAD));
    // Cover the pad square with samples no further apart than a quarter tile.
    const k = Math.max(1, Math.ceil(Math.max(padLon, padLat) / step));
    for (let i = -k; i <= k; i++)
      for (let j = -k; j <= k; j++)
        put(lon + (padLon * i) / k, lat + (padLat * j) / k);
  };
  for (let i = 0; i < line.length; i++) {
    visit(line[i][0], line[i][1]);
    if (!i) continue;
    const [x0, y0] = line[i - 1];
    const [x1, y1] = line[i];
    const parts = Math.ceil(
      Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) / step,
    );
    for (let k = 1; k < parts; k++)
      visit(x0 + ((x1 - x0) * k) / parts, y0 + ((y1 - y0) * k) / parts);
  }
  return [...seen.values()];
}
