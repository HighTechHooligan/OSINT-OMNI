/**
 * Pure site geometry helpers (no Cesium, no DOM) shared by the boundary,
 * orbit and contour services. Coordinates are [lon, lat] degrees.
 */

const EARTH_RADIUS_M = 6_371_008.8;
export const FEET_PER_METRE = 3.280839895;

/** Great-circle distance in metres between two [lon, lat] degree pairs. */
export function haversineMeters([lon1, lat1], [lon2, lat2]) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Close a ring, drop invalid vertices, and require at least three corners. */
export function normalizeBoundary(boundary) {
  if (!Array.isArray(boundary))
    throw new TypeError('Boundary must be an array');
  const ring = boundary
    .map((p) => [Number(p?.[0]), Number(p?.[1])])
    .filter(
      ([lon, lat]) =>
        Number.isFinite(lon) &&
        Number.isFinite(lat) &&
        Math.abs(lon) <= 180 &&
        Math.abs(lat) <= 90,
    );
  if (ring.length < 3)
    throw new Error('Boundary needs at least 3 valid points');
  const [first, last] = [ring[0], ring.at(-1)];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([...first]);
  return ring;
}

/** Bounding box of a ring. */
export function boundaryBbox(boundary) {
  const lons = boundary.map((p) => p[0]);
  const lats = boundary.map((p) => p[1]);
  return {
    minLon: Math.min(...lons),
    minLat: Math.min(...lats),
    maxLon: Math.max(...lons),
    maxLat: Math.max(...lats),
  };
}

/** Bounding-box centre and the furthest vertex distance from it. */
export function summarizeBoundary(boundary) {
  const b = boundaryBbox(boundary);
  const center = {
    lon: (b.minLon + b.maxLon) / 2,
    lat: (b.minLat + b.maxLat) / 2,
  };
  let radiusM = 0;
  for (const p of boundary) {
    radiusM = Math.max(radiusM, haversineMeters([center.lon, center.lat], p));
  }
  return { center, radiusM: Math.max(radiusM, 50) };
}

/** Planar (local equirectangular) ring area in square metres. */
export function boundaryAreaM2(boundary) {
  const lat0 =
    ((boundary.reduce((s, p) => s + p[1], 0) / boundary.length) * Math.PI) /
    180;
  const kx = 111_320 * Math.cos(lat0);
  const ky = 110_574;
  let sum = 0;
  for (let i = 0; i < boundary.length - 1; i++) {
    const [x1, y1] = boundary[i];
    const [x2, y2] = boundary[i + 1];
    sum += x1 * kx * (y2 * ky) - x2 * kx * (y1 * ky);
  }
  return Math.abs(sum) / 2;
}

/** Even-odd point-in-polygon test. */
export function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

/** Build a GIF file name from a site name. */
export function orbitFileName(siteName) {
  return `${slug(siteName)}_orbit.gif`;
}

/** Filesystem-friendly stem from a display name. */
export function slug(name) {
  const stem = String(name || 'site')
    .split(/[·—]/)[0]
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return stem || 'site';
}

const escapeXml = (s) =>
  String(s).replace(
    /[<>&'"]/g,
    (c) =>
      ({
        '<': '&lt;',
        '>': '&gt;',
        '&': '&amp;',
        "'": '&apos;',
        '"': '&quot;',
      })[c],
  );

/** Serialize a site (boundary + points) to KML text. */
export function siteToKml({ name = 'Site', boundary, points = [] }) {
  const ring = normalizeBoundary(boundary)
    .map(([lon, lat]) => `${lon},${lat},0`)
    .join(' ');
  const pins = points
    .map(
      ([id, lon, lat]) =>
        `<Placemark><name>${escapeXml(id)}</name><Point><coordinates>${lon},${lat},0</coordinates></Point></Placemark>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${escapeXml(name)}</name>
<Placemark><name>${escapeXml(name)} boundary</name><Polygon><tessellate>1</tessellate><outerBoundaryIs><LinearRing><coordinates>${ring}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
${pins}</Document></kml>
`;
}
