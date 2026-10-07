/**
 * Pure helpers for the OSM streets + building footprints layer.
 * Tiles are fixed 0.01° cells so a panned view reuses what it already has.
 */

export const OSM_TILE_DEG = 0.01;
export const OSM_MAX_TILES_PER_VIEW = 9;
export const OSM_MAX_VIEW_HEIGHT_M = 4000;

/** Road styling by OSM highway class: width in pixels and lightness rank. */
export const ROAD_CLASSES = Object.freeze({
  motorway: { width: 5, rank: 0 },
  trunk: { width: 4.5, rank: 0 },
  primary: { width: 4, rank: 0 },
  secondary: { width: 3.5, rank: 1 },
  tertiary: { width: 3, rank: 1 },
  residential: { width: 2.5, rank: 2 },
  unclassified: { width: 2.5, rank: 2 },
  service: { width: 1.5, rank: 2 },
  living_street: { width: 2, rank: 2 },
  track: { width: 1.5, rank: 3 },
  path: { width: 1, rank: 3 },
  footway: { width: 1, rank: 3 },
  cycleway: { width: 1, rank: 3 },
  bridleway: { width: 1, rank: 3 },
  steps: { width: 1, rank: 3 },
});

export function roadStyle(highway) {
  const key = String(highway || '').replace(/_link$/, '');
  return ROAD_CLASSES[key] ?? null;
}

/** Tile key for a lon/lat. */
export function tileKey(lon, lat) {
  return `${Math.floor(lon / OSM_TILE_DEG)}:${Math.floor(lat / OSM_TILE_DEG)}`;
}

/** Tile bbox from its key. */
export function tileBbox(key) {
  const [x, y] = key.split(':').map(Number);
  return {
    west: x * OSM_TILE_DEG,
    south: y * OSM_TILE_DEG,
    east: (x + 1) * OSM_TILE_DEG,
    north: (y + 1) * OSM_TILE_DEG,
  };
}

/** Tiles covering a view rectangle (degrees), nearest the centre first, capped. */
export function tilesForView(
  { west, south, east, north },
  max = OSM_MAX_TILES_PER_VIEW,
) {
  if (
    ![west, south, east, north].every(Number.isFinite) ||
    east <= west ||
    north <= south
  )
    return [];
  const x0 = Math.floor(west / OSM_TILE_DEG);
  const x1 = Math.floor(east / OSM_TILE_DEG);
  const y0 = Math.floor(south / OSM_TILE_DEG);
  const y1 = Math.floor(north / OSM_TILE_DEG);
  const cx = (west + east) / 2 / OSM_TILE_DEG;
  const cy = (south + north) / 2 / OSM_TILE_DEG;
  const keys = [];
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++)
      keys.push({
        key: `${x}:${y}`,
        d: (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2,
      });
  return keys
    .sort((a, b) => a.d - b.d)
    .slice(0, max)
    .map(({ key }) => key);
}

/** Overpass QL for one tile: highways and building outlines with geometry. */
export function overpassTileQuery(key) {
  const { west, south, east, north } = tileBbox(key);
  const b = [south, west, north, east].map((v) => v.toFixed(5)).join(',');
  return `[out:json][timeout:25];(way["highway"](${b});way["building"](${b}););out geom qt;`;
}

/** Parse Overpass JSON into roads and building rings ([lon, lat] pairs). */
export function parseOsmTile(json) {
  const roads = [];
  const buildings = [];
  for (const el of json?.elements ?? []) {
    if (el?.type !== 'way' || !Array.isArray(el.geometry)) continue;
    const coords = el.geometry
      .filter((p) => Number.isFinite(p?.lon) && Number.isFinite(p?.lat))
      .map((p) => [p.lon, p.lat]);
    const tags = el.tags ?? {};
    if (tags.building && coords.length >= 4) {
      buildings.push({
        id: el.id,
        ring: coords,
        levels: Number(tags['building:levels']) || null,
      });
    } else if (tags.highway && coords.length >= 2) {
      const style = roadStyle(tags.highway);
      if (style)
        roads.push({ id: el.id, highway: tags.highway, coords, ...style });
    }
  }
  return { roads, buildings };
}
