import { tilesForBounds, tileToBBox } from '../../data/tomtomTiles.js';
import {
  OVERPASS_URL,
  QUERY_LIMIT,
  MAX_VIEWPORT_DEGREES,
  QUERY_SNAP_DEGREES,
  DETAIL_MIN_ZOOM,
  DETAIL_MAX_ZOOM,
  DETAIL_MAX_TILES,
  SOURCE_RECORD_LIMIT,
  PRECISION_CACHE_LIMIT,
  OVERVIEW_MIN_ZOOM,
  OVERVIEW_MAX_ZOOM,
  OVERVIEW_MAX_TILES,
  OVERVIEW_POINT_LIMIT,
} from './policy.js';
import {
  createVectorTileSource,
  validTileBounds,
} from '../../sources/vectorTiles.js';
import { buildOverpassQuery, normalizeAlprNode } from './records.js';
import { decodeAlprTile, decodeAlprOverviewTile } from './tileRecords.js';

/**
 * Finest attributed extract zoom whose tiles for `box` fit the per-view cap,
 * or null when even z9 would not (the layer asks the user to zoom in).
 * @param {{south:number, west:number, north:number, east:number}} box View box.
 * @returns {number|null} Tile zoom.
 */
export function alprDetailZoom(box) {
  for (let zoom = DETAIL_MAX_ZOOM; zoom >= DETAIL_MIN_ZOOM; zoom--)
    if (
      tilesForBounds(box, zoom, { maxTiles: DETAIL_MAX_TILES + 1 }).length <=
      DETAIL_MAX_TILES
    )
      return zoom;
  return null;
}

/**
 * Tile coordinates are quantized per zoom (about 19 m at z9, 2 m at z12).
 * Remember each camera's finest position so zooming out never nudges a marker
 * that a closer view already placed precisely. Bounded, oldest first.
 * @param {number} [limit] Cameras remembered.
 * @returns {{apply: (record: object, zoom: number) => object, clear: () => void,
 *   size: () => number}} Cache.
 */
export function createAlprPrecisionCache(limit = PRECISION_CACHE_LIMIT) {
  const known = new Map();
  return {
    apply(record, zoom) {
      const finer = known.get(record.id);
      if (finer && finer.zoom > zoom)
        return finer.latitude === record.latitude &&
          finer.longitude === record.longitude
          ? record
          : { ...record, latitude: finer.latitude, longitude: finer.longitude };
      known.delete(record.id);
      known.set(record.id, {
        zoom,
        latitude: record.latitude,
        longitude: record.longitude,
      });
      while (known.size > limit) known.delete(known.keys().next().value);
      return record;
    },
    clear: () => known.clear(),
    size: () => known.size,
  };
}

/**
 * Finest overview zoom whose tiles for `box` fit OVERVIEW_MAX_TILES.
 * @param {{south:number, west:number, north:number, east:number}} box View box.
 * @returns {number} Tile zoom (OVERVIEW_MIN_ZOOM at worst).
 */
export function alprOverviewZoom(box) {
  for (let zoom = OVERVIEW_MAX_ZOOM; zoom > OVERVIEW_MIN_ZOOM; zoom--)
    if (
      tilesForBounds(box, zoom, { maxTiles: OVERVIEW_MAX_TILES + 1 }).length <=
      OVERVIEW_MAX_TILES
    )
      return zoom;
  return OVERVIEW_MIN_ZOOM;
}

export const ALPR_EXTRACT_ORIGIN = 'https://tiles.dontgetflocked.com';

/** Same-origin `/api/alpr` proxy when the page is served over http(s). */
function defaultProxyOrigin() {
  const origin = globalThis.location?.origin;
  return typeof origin === 'string' && /^https?:\/\//.test(origin)
    ? origin
    : null;
}

/**
 * One country's extract, read through the app server's caching proxy
 * (`server/providers/alprTiles.js`) and directly from the community host when
 * the proxy is missing (a static or panel build) or cannot reach it.
 */
function createCountryExtract(country, options) {
  const { proxyOrigin, decode, fetchImpl, maxTiles } = options;
  const make = (tileJsonUrl, allowedOrigin) =>
    createVectorTileSource({
      tileJsonUrl,
      allowedOrigin,
      decode,
      fetchImpl,
      maxTiles,
      ttlMs: 60 * 60 * 1000,
    });
  const direct = make(
    `${ALPR_EXTRACT_ORIGIN}/cameras-${country}-hourly.json`,
    ALPR_EXTRACT_ORIGIN,
  );
  const proxy = proxyOrigin
    ? make(`${proxyOrigin}/api/alpr/${country}.json`, proxyOrigin)
    : null;
  let active = proxy || direct;
  async function run(read, signal) {
    try {
      return await read(active);
    } catch (error) {
      if (active !== proxy || signal?.aborted || error?.name === 'AbortError')
        throw error;
      const cause = error?.cause ?? error;
      const status = error?.status ?? cause?.status;
      // No proxy route on this host (404/405, or an HTML fallback page):
      // read the extract directly from now on.
      if (status === 404 || status === 405 || cause instanceof SyntaxError) {
        active = direct;
        return read(direct);
      }
      // The proxy is there but its upstream failed: the browser may still
      // reach the host directly, so try once without switching.
      try {
        return await read(direct);
      } catch {
        throw error;
      }
    }
  }
  return {
    getMetadata: (signal) => run((s) => s.getMetadata(signal), signal),
    fetchBounds: (box, opts) =>
      run((s) => s.fetchBounds(box, opts), opts?.signal),
    clear() {
      proxy?.clear();
      direct.clear();
    },
  };
}

/** Construct the viewport-bounded OpenStreetMap hourly extract adapter. */
export function createAlprTileSource({
  tileFetchImpl = (...args) => globalThis.fetch(...args),
  proxyOrigin = defaultProxyOrigin(),
} = {}) {
  const countries = ['us', 'ca'];
  const sources = countries.map((country) =>
    createCountryExtract(country, {
      proxyOrigin,
      decode: decodeAlprTile,
      fetchImpl: tileFetchImpl,
      maxTiles: DETAIL_MAX_TILES,
    }),
  );
  const overviewSources = countries.map((country) =>
    createCountryExtract(country, {
      proxyOrigin,
      decode: decodeAlprOverviewTile,
      fetchImpl: tileFetchImpl,
      maxTiles: OVERVIEW_MAX_TILES,
    }),
  );
  const precision = createAlprPrecisionCache();
  const precise = precision.apply;
  return {
    /**
     * Read the camera records for every extract tile covering `box`.
     * @param {{south:number, west:number, north:number, east:number}} box View box.
     * @param {AbortSignal} [signal] Cancellation.
     * @returns {Promise<{records: Array<object>, stale: boolean, saturated: boolean,
     *   noCoverage?: boolean, zoomIn?: boolean, coverage?: object, zoom?: number}>}
     *   Records inside the fetched tiles; `coverage` is those tiles' bounds.
     */
    async fetch(box, signal) {
      if (
        !validTileBounds(box) ||
        box.north - box.south >
          MAX_VIEWPORT_DEGREES + 2 * QUERY_SNAP_DEGREES + 1e-9 ||
        box.east - box.west >
          MAX_VIEWPORT_DEGREES + 2 * QUERY_SNAP_DEGREES + 1e-9
      )
        throw new TypeError('ALPR requires a bounded city viewport');
      signal?.throwIfAborted();
      // Fast geographic rejection; the exact extract extents below refine coverage.
      if (box.east < -180 || box.west > -50 || box.north < 17 || box.south > 84)
        return {
          records: [],
          stale: false,
          saturated: false,
          noCoverage: true,
        };
      const zoom = alprDetailZoom(box);
      if (zoom === null)
        return { records: [], stale: false, saturated: false, zoomIn: true };
      const tiles = tilesForBounds(box, zoom, {
        maxTiles: DETAIL_MAX_TILES + 1,
      });
      const tileBounds = tiles.map((tile) => tileToBBox(zoom, tile.x, tile.y));
      const coverage = {
        south: Math.min(...tileBounds.map((b) => b.south)),
        west: Math.min(...tileBounds.map((b) => b.west)),
        north: Math.max(...tileBounds.map((b) => b.north)),
        east: Math.max(...tileBounds.map((b) => b.east)),
      };
      const records = new Map();
      let covered = false,
        partial = false;
      for (const [index, source] of sources.entries()) {
        if (
          index === 1 &&
          (box.north < 41 ||
            box.south > 84 ||
            box.east < -142 ||
            box.west > -52)
        )
          continue;
        const metadata = await source.getMetadata(signal);
        const [west, south, east, north] = metadata.bounds || [];
        if (![west, south, east, north].every(Number.isFinite))
          throw new Error('Camera coverage unavailable');
        if (
          box.east < west ||
          box.west > east ||
          box.north < south ||
          box.south > north
        )
          continue;
        covered = true;
        const result = await source.fetchBounds(box, { zoom, signal });
        partial ||= result.partial;
        for (const record of result.tiles.flat())
          records.set(record.id, precise(record, zoom));
      }
      signal?.throwIfAborted();
      let list = [...records.values()];
      const truncated = list.length > SOURCE_RECORD_LIMIT;
      if (truncated) {
        // Keep the cameras nearest the view centre when a dense metro overflows.
        const lat = (box.south + box.north) / 2;
        const lon = (box.west + box.east) / 2;
        const scale = Math.cos((lat * Math.PI) / 180);
        list = list
          .map((record) => ({
            record,
            d:
              (record.latitude - lat) ** 2 +
              ((record.longitude - lon) * scale) ** 2,
          }))
          .sort((a, b) => a.d - b.d)
          .slice(0, SOURCE_RECORD_LIMIT)
          .map((item) => item.record);
      }
      return {
        records: list,
        stale: false,
        saturated: partial || truncated,
        noCoverage: !covered,
        // A partial or truncated read does not cover its tiles; reuse only the box.
        coverage: partial || truncated ? { ...box } : coverage,
        zoom,
      };
    },
    detailZoom: alprDetailZoom,
    /**
     * Every mapped camera position in a wide view, from geometry-only tiles.
     * @param {{south:number, west:number, north:number, east:number}} box View box.
     * @param {AbortSignal} [signal] Cancellation.
     * @returns {Promise<{positions: Float64Array[], count: number, key: string,
     *   partial: boolean, noCoverage: boolean}>} lon/lat pairs per tile;
     *   `key` names the tile set so an unchanged view need not redraw.
     */
    async fetchOverview(box, signal) {
      if (!validTileBounds(box))
        throw new TypeError('ALPR overview requires a geographic box');
      signal?.throwIfAborted();
      const positions = [];
      const keys = [];
      let count = 0,
        points = 0,
        partial = false,
        covered = false;
      for (const source of overviewSources) {
        const metadata = await source.getMetadata(signal);
        const [west, south, east, north] = metadata.bounds || [];
        if (![west, south, east, north].every(Number.isFinite))
          throw new Error('Camera coverage unavailable');
        const clip = {
          south: Math.max(box.south, south),
          west: Math.max(box.west, west),
          north: Math.min(box.north, north),
          east: Math.min(box.east, east),
        };
        if (clip.north <= clip.south || clip.east <= clip.west) continue;
        covered = true;
        const zoom = alprOverviewZoom(clip);
        const result = await source.fetchBounds(clip, { zoom, signal });
        partial ||= result.partial;
        for (const [i, tile] of result.tiles.entries()) {
          const t = result.loadedTiles[i];
          keys.push(`${t.z}/${t.x}/${t.y}`);
          if (points + tile.positions.length / 2 > OVERVIEW_POINT_LIMIT) {
            partial = true;
            continue;
          }
          positions.push(tile.positions);
          points += tile.positions.length / 2;
          count += tile.count;
        }
      }
      signal?.throwIfAborted();
      return {
        positions,
        count,
        key: keys.sort().join(','),
        partial,
        noCoverage: !covered,
      };
    },
    destroy() {
      for (const source of [...sources, ...overviewSources]) source.clear();
      precision.clear();
    },
    label: 'OpenStreetMap · community mapped',
    attribution: {
      name: 'OpenStreetMap',
      description: '© OpenStreetMap contributors, ODbL',
      text: '© OpenStreetMap contributors, ODbL',
      href: 'https://www.openstreetmap.org/copyright',
    },
  };
}

/** Construct the bounded OSM request adapter without starting a request. */
export function createOverpassAlprSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  async function fetchAlprNodes(box, signal) {
    signal?.throwIfAborted();
    if (
      !box ||
      ![box.south, box.west, box.north, box.east].every(Number.isFinite) ||
      box.south < -90 ||
      box.north > 90 ||
      box.west < -180 ||
      box.east > 180 ||
      box.north <= box.south ||
      box.east <= box.west ||
      box.north - box.south >
        MAX_VIEWPORT_DEGREES + 2 * QUERY_SNAP_DEGREES + 1e-9 ||
      box.east - box.west > MAX_VIEWPORT_DEGREES + 2 * QUERY_SNAP_DEGREES + 1e-9
    ) {
      throw new TypeError('ALPR requires a bounded city viewport');
    }
    const query = buildOverpassQuery(box.south, box.west, box.north, box.east);
    const response = await fetchImpl(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
      signal,
    });
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        /* already closed */
      }
      const message =
        response.status === 429
          ? 'Overpass rate-limited'
          : response.status === 504
            ? 'Overpass timed out'
            : 'Overpass temporarily unavailable';
      throw new Error(message);
    }
    const stale = response.headers.get('x-overpass-cache') === 'STALE';
    const payload = await response.json();
    signal?.throwIfAborted();
    // The shared proxy already rejects query errors. Validate here too so a
    // malformed or partial response never becomes an authoritative empty map.
    if (!Array.isArray(payload?.elements) || payload.remark) {
      throw new Error('Overpass returned an incomplete camera response');
    }
    return {
      records: [
        ...new Map(
          payload.elements
            .slice(0, QUERY_LIMIT)
            .map(normalizeAlprNode)
            .filter(Boolean)
            .map((record) => [record.id, record]),
        ).values(),
      ],
      stale,
      saturated: payload.elements.length >= QUERY_LIMIT,
    };
  }
  return {
    fetch: fetchAlprNodes,
    label: 'OpenStreetMap · community mapped',
    attribution: {
      name: 'OpenStreetMap',
      description: 'OpenStreetMap contributors (ODbL 1.0; community mapped)',
      text: '© OpenStreetMap contributors',
      href: 'https://www.openstreetmap.org/copyright',
    },
  };
}

export { buildOverpassQuery } from './records.js';
