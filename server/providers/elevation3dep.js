import path from 'node:path';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';

/**
 * USGS 3DEP bare-earth elevation proxy (keyless, public domain).
 *
 *   GET /api/elevation/3dep?bbox=minLon,minLat,maxLon,maxLat[&res=1]
 *
 * Responds with the raw grid as little-endian Float32 (row 0 = north edge),
 * metres above NAVD88, and describes it in headers:
 *   X-Grid-Width, X-Grid-Height, X-Grid-Bbox, X-Grid-NoData, X-Grid-Source,
 *   X-Grid-Datum.
 *
 * X-Grid-Bbox is the outer pixel-edge extent the GeoTIFF itself declares
 * (ArcGIS may snap the requested box), not the box we asked for, so the
 * client places every sample where USGS put it. Horizontal coordinates are
 * NAD83: the service republishes NAD83 source DEMs without a datum shift,
 * which the client corrects to WGS84 (see src/services/datum.js).
 *
 * Grids are cached to `.gev-cache/3dep/` so a surveyed site keeps working
 * offline once it has been loaded once. Requests are capped by area so a
 * stray call cannot pull a county at 1 m.
 */
export const DEP_UPSTREAM =
  'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage';
export const DEP_MAX_SIDE_PX = 2048;
export const DEP_MAX_AREA_KM2 = 25;
export const DEP_NODATA = -9999;
export const DEP_HORIZONTAL_DATUM = 'NAD83';
// Bump when the cached meta's meaning changes so stale grids are refetched.
const CACHE_VERSION = 'v2';
const M_PER_DEG_LAT = 111_320;

/** Parse and validate "minLon,minLat,maxLon,maxLat". */
export function parseBbox(raw) {
  const parts = String(raw ?? '')
    .split(',')
    .map((v) => Number(v));
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) return null;
  const [minLon, minLat, maxLon, maxLat] = parts;
  if (minLon >= maxLon || minLat >= maxLat) return null;
  if (Math.abs(minLat) > 90 || Math.abs(maxLat) > 90) return null;
  if (Math.abs(minLon) > 180 || Math.abs(maxLon) > 180) return null;
  return { minLon, minLat, maxLon, maxLat };
}

/** Grid size for a bbox at a target resolution, capped at DEP_MAX_SIDE_PX. */
export function planGrid(bbox, resM = 1) {
  const midLat = ((bbox.minLat + bbox.maxLat) / 2) * (Math.PI / 180);
  const widthM = (bbox.maxLon - bbox.minLon) * M_PER_DEG_LAT * Math.cos(midLat);
  const heightM = (bbox.maxLat - bbox.minLat) * M_PER_DEG_LAT;
  const areaKm2 = (widthM * heightM) / 1e6;
  const res = Math.max(0.5, Number(resM) || 1);
  let width = Math.ceil(widthM / res);
  let height = Math.ceil(heightM / res);
  const scale = Math.min(1, DEP_MAX_SIDE_PX / Math.max(width, height));
  width = Math.max(2, Math.round(width * scale));
  height = Math.max(2, Math.round(height * scale));
  return {
    width,
    height,
    areaKm2,
    resM: Math.max(widthM / width, heightM / height),
  };
}

/** Upstream exportImage URL returning a Float32 GeoTIFF in lon/lat. */
export function buildUpstreamUrl(bbox, { width, height }) {
  const params = new URLSearchParams({
    bbox: [bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat].join(','),
    bboxSR: '4326',
    imageSR: '4326',
    size: `${width},${height}`,
    format: 'tiff',
    pixelType: 'F32',
    noData: String(DEP_NODATA),
    noDataInterpretation: 'esriNoDataMatchAny',
    interpolation: 'RSP_BilinearInterpolation',
    f: 'image',
  });
  return `${DEP_UPSTREAM}?${params}`;
}

/**
 * Outer pixel-edge extent [minLon, minLat, maxLon, maxLat] declared by the
 * GeoTIFF, or null when it carries no usable georeferencing. PixelIsPoint
 * rasters tie the first pixel's centre, so step back half a pixel.
 */
export function tiffExtent(image) {
  try {
    const [ox, oy] = image.getOrigin();
    const [rx, ry] = image.getResolution();
    if (![ox, oy, rx, ry].every(Number.isFinite) || !rx || !ry) return null;
    // GTRasterTypeGeoKey: 1 = PixelIsArea (the default), 2 = PixelIsPoint.
    const half = image.geoKeys?.GTRasterTypeGeoKey === 2 ? 0.5 : 0;
    const x0 = ox - half * rx;
    const y0 = oy - half * ry;
    const x1 = x0 + rx * image.getWidth();
    const y1 = y0 + ry * image.getHeight();
    const extent = [
      Math.min(x0, x1),
      Math.min(y0, y1),
      Math.max(x0, x1),
      Math.max(y0, y1),
    ];
    // Only trust lon/lat-looking numbers (imageSR=4326).
    if (Math.abs(extent[0]) > 180 || Math.abs(extent[2]) > 180) return null;
    if (Math.abs(extent[1]) > 90 || Math.abs(extent[3]) > 90) return null;
    return extent;
  } catch {
    return null;
  }
}

/**
 * Decode a single-band GeoTIFF into a Float32Array of the requested size.
 * Non-finite and no-data samples become DEP_NODATA. `extent` is the raster's
 * own georeferenced extent (null if the file has none).
 */
export async function decodeElevationTiff(buffer, { width, height }) {
  const { fromArrayBuffer } = await import('geotiff');
  const arrayBuffer =
    buffer instanceof ArrayBuffer
      ? buffer
      : buffer.buffer.slice(
          buffer.byteOffset,
          buffer.byteOffset + buffer.byteLength,
        );
  const tiff = await fromArrayBuffer(arrayBuffer);
  const image = await tiff.getImage();
  if (image.getWidth() !== width || image.getHeight() !== height) {
    throw new Error(
      `3DEP returned ${image.getWidth()}x${image.getHeight()}, expected ${width}x${height}`,
    );
  }
  const [band] = await image.readRasters();
  const fileNoData = image.getGDALNoData();
  const out = new Float32Array(width * height);
  let valid = 0;
  for (let i = 0; i < out.length; i++) {
    const v = band[i];
    const missing =
      !Number.isFinite(v) ||
      v <= DEP_NODATA ||
      (fileNoData !== null && v === fileNoData) ||
      v < -500 ||
      v > 9000;
    out[i] = missing ? DEP_NODATA : v;
    if (!missing) valid++;
  }
  return {
    values: out,
    validFraction: valid / out.length,
    extent: tiffExtent(image),
  };
}

/** Stable cache key for a planned request. */
export function gridCacheKey(bbox, grid) {
  return createHash('sha1')
    .update(
      `${CACHE_VERSION}:${bbox.minLon.toFixed(6)},${bbox.minLat.toFixed(6)},${bbox.maxLon.toFixed(6)},${bbox.maxLat.toFixed(6)}:${grid.width}x${grid.height}`,
    )
    .digest('hex');
}

/**
 * Vite plugin. `fetchImpl` and `cacheDir` are injectable for tests.
 */
export function elevation3depProxy({
  fetchImpl = (...args) => fetch(...args),
  cacheDir = path.join(process.cwd(), '.gev-cache', '3dep'),
  timeoutMs = 60_000,
} = {}) {
  const inflight = new Map();

  async function readCache(key) {
    try {
      const [meta, data] = await Promise.all([
        fsp.readFile(path.join(cacheDir, `${key}.json`), 'utf8'),
        fsp.readFile(path.join(cacheDir, `${key}.f32`)),
      ]);
      return { meta: JSON.parse(meta), body: data };
    } catch {
      return null;
    }
  }

  async function writeCache(key, meta, body) {
    try {
      await fsp.mkdir(cacheDir, { recursive: true });
      await fsp.writeFile(path.join(cacheDir, `${key}.f32`), body);
      await fsp.writeFile(
        path.join(cacheDir, `${key}.json`),
        JSON.stringify(meta),
      );
    } catch {
      // Cache is best-effort; the response still goes out.
    }
  }

  async function fetchGrid(bbox, grid) {
    const response = await fetchImpl(buildUpstreamUrl(bbox, grid), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`3DEP upstream HTTP ${response.status}`);
    const type = response.headers.get('content-type') || '';
    if (/json|html|text/i.test(type))
      throw new Error('3DEP upstream returned an error page');
    const { values, validFraction, extent } = await decodeElevationTiff(
      await response.arrayBuffer(),
      grid,
    );
    const requested = [bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat];
    if (extent && extent.some((v, i) => Math.abs(v - requested[i]) > 1e-7))
      console.info('[3dep-proxy] upstream extent differs from request', {
        requested,
        extent,
      });
    const meta = {
      width: grid.width,
      height: grid.height,
      bbox: extent || requested,
      datum: DEP_HORIZONTAL_DATUM,
      resM: grid.resM,
      validFraction,
      fetchedAt: new Date().toISOString(),
    };
    return { meta, body: Buffer.from(values.buffer) };
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/elevation/3dep', async (req, res) => {
      const fail = (status, error) => {
        if (res.headersSent) return;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error }));
      };
      try {
        const url = new URL(req.url || '', 'http://internal');
        const bbox = parseBbox(url.searchParams.get('bbox'));
        if (!bbox)
          return fail(400, 'bbox must be "minLon,minLat,maxLon,maxLat"');
        const grid = planGrid(bbox, url.searchParams.get('res'));
        if (grid.areaKm2 > DEP_MAX_AREA_KM2) {
          return fail(
            413,
            `area ${grid.areaKm2.toFixed(1)} km² exceeds the ${DEP_MAX_AREA_KM2} km² limit`,
          );
        }
        const key = gridCacheKey(bbox, grid);
        let entry = await readCache(key);
        let cacheState = 'HIT';
        if (!entry) {
          cacheState = 'MISS';
          if (!inflight.has(key)) {
            inflight.set(
              key,
              fetchGrid(bbox, grid).finally(() => inflight.delete(key)),
            );
          }
          entry = await inflight.get(key);
          await writeCache(key, entry.meta, entry.body);
        }
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Cache-Control': 'private, max-age=86400',
          'X-Grid-Width': String(entry.meta.width),
          'X-Grid-Height': String(entry.meta.height),
          'X-Grid-Bbox': entry.meta.bbox.join(','),
          'X-Grid-NoData': String(DEP_NODATA),
          'X-Grid-Res-M': String(entry.meta.resM),
          'X-Grid-Valid': String(entry.meta.validFraction),
          'X-Grid-Source': 'USGS 3DEP (bare earth, NAVD88 m)',
          'X-Grid-Datum': entry.meta.datum || DEP_HORIZONTAL_DATUM,
          'X-Cache': cacheState,
        });
        res.end(entry.body);
      } catch (error) {
        console.warn('[3dep-proxy]', error?.message || error);
        fail(502, 'USGS 3DEP elevation unavailable');
      }
    });
  };

  return {
    name: 'elevation-3dep-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
