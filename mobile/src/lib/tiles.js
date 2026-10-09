/** Web-mercator tile math for region downloads and camera tile lookups. */
const RAD = Math.PI / 180;
export const MAX_MERCATOR_LAT = 85.05112878;

export function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const clamped = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
  const x = Math.floor(((lon + 180) / 360) * n);
  const r = clamped * RAD;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n,
  );
  return { x: Math.min(n - 1, Math.max(0, x)), y: Math.min(n - 1, Math.max(0, y)) };
}

export function tileRange([w, s, e, n], z) {
  const a = lonLatToTile(w, n, z);
  const b = lonLatToTile(e, s, z);
  return { z, minX: a.x, maxX: b.x, minY: a.y, maxY: b.y };
}

/** Number of tiles a bbox covers across zoom levels zMin..zMax. */
export function countTiles(bbox, zMin, zMax) {
  let total = 0;
  for (let z = zMin; z <= zMax; z++) {
    const r = tileRange(bbox, z);
    total += (r.maxX - r.minX + 1) * (r.maxY - r.minY + 1);
  }
  return total;
}

/** Every tile in a bbox across zoom levels, coarse zooms first. */
export function* tilesInBbox(bbox, zMin, zMax) {
  for (let z = zMin; z <= zMax; z++) {
    const r = tileRange(bbox, z);
    for (let x = r.minX; x <= r.maxX; x++)
      for (let y = r.minY; y <= r.maxY; y++) yield { z, x, y };
  }
}

/**
 * Tiles a polyline passes through at one zoom (samples every ~1/4 tile), plus
 * any tile within padDeg of the line so points just across a tile edge count.
 */
export function tilesAlongLine(line, z, padDeg = 0) {
  const seen = new Map();
  const put = (lon, lat) => {
    const t = lonLatToTile(lon, lat, z);
    seen.set(`${t.x}/${t.y}`, { z, x: t.x, y: t.y });
  };
  const add = (lon, lat) => {
    put(lon, lat);
    if (!padDeg) return;
    for (const dx of [-padDeg, padDeg])
      for (const dy of [-padDeg, padDeg]) put(lon + dx, lat + dy);
  };
  const step = 360 / 2 ** z / 4;
  for (let i = 0; i < line.length; i++) {
    add(line[i][0], line[i][1]);
    if (i === 0) continue;
    const [x0, y0] = line[i - 1];
    const [x1, y1] = line[i];
    const parts = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) / step);
    for (let k = 1; k < parts; k++)
      add(x0 + ((x1 - x0) * k) / parts, y0 + ((y1 - y0) * k) / parts);
  }
  return [...seen.values()];
}

export function fillTemplate(template, { z, x, y }) {
  return template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
}
