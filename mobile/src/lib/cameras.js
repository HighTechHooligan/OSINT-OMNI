import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { fillTemplate, tileRange } from './tiles.js';
import { tilesNearLine } from '../../../src/services/routing/routeGeo.js';

/**
 * Mapped ALPR cameras (Flock and others) from the community OpenStreetMap
 * extract (`surveillance:type=ALPR`, © OpenStreetMap contributors, ODbL), the
 * same hourly vector tiles the desktop ALPR layer reads. With an OMNI host
 * set, tiles come through its cached /api/alpr proxy; otherwise straight from
 * the extract host. Tiles are kept on the phone for a week, so a route checked
 * once needs no camera download the next time.
 */
export const DIRECT_CAMERA_TILES =
  'https://tiles.dontgetflocked.com/cameras-us-hourly/{z}/{x}/{y}.mvt';
/** z9+ tiles carry full attributes; z11 is ~15-20 km across in the US. */
export const CAMERA_ZOOM = 11;
export const CAMERA_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function cameraTileTemplate(hostUrl) {
  const host = String(hostUrl || '').trim().replace(/\/+$/, '');
  return host ? `${host}/api/alpr/us/{z}/{x}/{y}.mvt` : DIRECT_CAMERA_TILES;
}

/** Decode one camera tile to {id, lon, lat, operator, brand, direction}. */
export function decodeCameraTile(bytes, z, x, y) {
  if (!bytes || !bytes.byteLength) return [];
  const layer = new VectorTile(new PbfReader(new Uint8Array(bytes))).layers.cameras;
  if (!layer) return [];
  if (layer.length > 40_000) throw new Error('Camera tile feature limit exceeded');
  const out = [];
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i).toGeoJSON(x, y, z);
    if (f.geometry?.type !== 'Point') continue;
    const p = f.properties || {};
    const [lon, lat] = f.geometry.coordinates;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    out.push({
      id: p.osmId != null ? `n${p.osmId}` : `${lon.toFixed(6)},${lat.toFixed(6)}`,
      lon,
      lat,
      operator: p.operator || '',
      brand: p.brand || '',
      direction: p.direction ?? null,
    });
  }
  return out;
}

async function gunzipIfWrapped(bytes) {
  const u8 = new Uint8Array(bytes);
  if (u8.length < 2 || u8[0] !== 0x1f || u8[1] !== 0x8b) return bytes;
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

/**
 * @param {object} o
 * @param {ReturnType<import('./store.js').createMemoryStore>} o.store
 * @param {(url:string) => Promise<{status:number, body:ArrayBuffer}>} o.fetchBytes
 */
export function createCameraSource({
  store,
  fetchBytes,
  template = () => DIRECT_CAMERA_TILES,
  canFetch = () => true,
  meter = null,
  now = Date.now,
}) {
  async function tile(t, { preferCache = false } = {}) {
    const key = `${t.z}/${t.x}/${t.y}`;
    const cached = await store.get('cameraTiles', key);
    const fresh = cached && now() - cached.at < CAMERA_TTL_MS;
    if (cached && (fresh || preferCache || !canFetch('cameras'))) {
      meter?.saved('cameras', cached.bytes || 0);
      return { cameras: cached.cameras, from: 'cache', at: cached.at };
    }
    if (!canFetch('cameras')) return { cameras: [], from: 'missing', at: null };
    try {
      const res = await fetchBytes(fillTemplate(template(), t));
      const empty = res.status === 204 || res.status === 404;
      if (!empty && (res.status < 200 || res.status >= 300))
        throw new Error(`Camera tile HTTP ${res.status}`);
      const bytes = empty ? new ArrayBuffer(0) : await gunzipIfWrapped(res.body);
      meter?.add('cameras', bytes.byteLength);
      const cameras = decodeCameraTile(bytes, t.z, t.x, t.y);
      await store.put('cameraTiles', key, { cameras, at: now(), bytes: bytes.byteLength });
      return { cameras, from: 'network', at: now() };
    } catch (error) {
      if (cached) return { cameras: cached.cameras, from: 'stale', at: cached.at };
      throw error;
    }
  }

  async function forTiles(tiles, options) {
    const byId = new Map();
    const report = { network: 0, cache: 0, stale: 0, missing: 0, failed: 0, oldest: null };
    const queue = [...tiles];
    const total = tiles.length;
    const worker = async () => {
      while (queue.length) {
        const t = queue.shift();
        try {
          const r = await tile(t, options);
          report[r.from]++;
          if (r.at && (report.oldest == null || r.at < report.oldest)) report.oldest = r.at;
          for (const c of r.cameras) byId.set(c.id, c);
        } catch {
          report.failed++;
        }
        options?.onTile?.(total - queue.length, total);
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    return { cameras: [...byId.values()], report };
  }

  return {
    tile,
    forTiles,
    /** Cameras within padM of a line (no length limit; tiles stay cached a week). */
    forLine(line, { padM = 200, ...options } = {}) {
      return forTiles(tilesNearLine(line, CAMERA_ZOOM, padM), options);
    },
    forBbox(bbox, options) {
      const r = tileRange(bbox, CAMERA_ZOOM);
      const tiles = [];
      for (let x = r.minX; x <= r.maxX; x++)
        for (let y = r.minY; y <= r.maxY; y++) tiles.push({ z: CAMERA_ZOOM, x, y });
      return forTiles(tiles, options);
    },
  };
}
