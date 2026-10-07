import {
  AIRSPACE_MAX_SPAN_DEG,
  NORMALIZERS,
  bboxKey,
  bboxSpan,
  normalizeTfrs,
  parseBboxParam,
} from '../../src/layers/airspace/records.js';
import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// FAA open data (U.S. public domain, keyless). The ArcGIS services are the
// FAA's own "ADDS" publications; override any of them with an env var if the
// FAA renames a service, without touching code.
const ARCGIS =
  'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services';
export const AIRSPACE_UPSTREAMS = Object.freeze({
  class:
    process.env.AIRSPACE_CLASS_URL ||
    `${ARCGIS}/Class_Airspace/FeatureServer/0/query`,
  sua:
    process.env.AIRSPACE_SUA_URL ||
    `${ARCGIS}/Special_Use_Airspace/FeatureServer/0/query`,
  laanc:
    process.env.AIRSPACE_UASFM_URL ||
    `${ARCGIS}/FAA_UAS_FacilityMap_Data/FeatureServer/0/query`,
  tfrShapes:
    process.env.AIRSPACE_TFR_WFS_URL ||
    'https://tfr.faa.gov/geoserver/TFR/ows?service=WFS&version=1.1.0' +
      '&request=GetFeature&typeName=TFR:V_TFR_LOC&maxFeatures=1000' +
      '&outputFormat=application/json&srsname=EPSG:4326',
  tfrList:
    process.env.AIRSPACE_TFR_LIST_URL ||
    'https://tfr.faa.gov/tfrapi/exportTfrList',
});

const MIB = 1024 * 1024;
const MAX_PAGES = { class: 4, sua: 3, laanc: 8 };
// Airspace is published on a 28/56-day cycle; LAANC grids change rarely.
// TFRs are minutes-sensitive.
const TTL_MS = {
  class: 12 * 3600e3,
  sua: 12 * 3600e3,
  laanc: 12 * 3600e3,
  tfr: 5 * 60e3,
};
const MAX_ENTRIES = 160;

/** ArcGIS envelope query for one quantized box. */
export function arcgisQueryUrl(base, bbox, offset = 0) {
  const params = new URLSearchParams({
    where: '1=1',
    geometry: `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: '*',
    outSR: '4326',
    // ~50 m generalization keeps statewide class airspace well under a few MB.
    maxAllowableOffset: '0.0005',
    returnGeometry: 'true',
    f: 'geojson',
  });
  if (offset) params.set('resultOffset', String(offset));
  return `${base}?${params}`;
}

const exceeded = (payload) =>
  payload?.exceededTransferLimit === true ||
  payload?.properties?.exceededTransferLimit === true;

/** Bounded, cached, same-origin FAA airspace routes for dev and preview. */
export function airspaceProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  upstreams = AIRSPACE_UPSTREAMS,
} = {}) {
  const cache = new Map();
  const inFlight = new Map();
  const allow = makeRateLimiter({
    windowMs: 60_000,
    max: 120,
    globalMax: 1200,
  });

  async function upstream(url, cap, timeout) {
    const signal = AbortSignal.timeout(timeout);
    const response = await fetchImpl(url, {
      signal,
      redirect: 'error',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('upstream_unavailable');
    }
    return readResponseJsonCapped(response, cap, signal);
  }

  async function fetchArea(kind, bbox) {
    const features = [];
    let partial = false;
    for (let page = 0; page < MAX_PAGES[kind]; page++) {
      const payload = await upstream(
        arcgisQueryUrl(upstreams[kind], bbox, features.length),
        24 * MIB,
        45_000,
      );
      if (payload?.error) throw new Error('upstream_error');
      if (!Array.isArray(payload?.features)) throw new Error('invalid_payload');
      features.push(...payload.features);
      if (!exceeded(payload) || !payload.features.length) break;
      if (page === MAX_PAGES[kind] - 1) partial = true;
    }
    return { fetchedAt: now(), partial, rows: NORMALIZERS[kind]({ features }) };
  }

  async function fetchTfrs() {
    const shapes = await upstream(upstreams.tfrShapes, 16 * MIB, 30_000);
    if (!Array.isArray(shapes?.features)) throw new Error('invalid_payload');
    let list = [];
    try {
      const value = await upstream(upstreams.tfrList, 4 * MIB, 15_000);
      if (Array.isArray(value)) list = value;
    } catch {
      // Descriptions are a nicety; shapes alone still draw.
    }
    return {
      fetchedAt: now(),
      partial: false,
      rows: normalizeTfrs(shapes, list),
    };
  }

  async function acquire(key, ttl, load) {
    const previous = cache.get(key);
    if (previous && now() - previous.savedAt < ttl)
      return { value: previous.value, stale: false };
    if (!inFlight.has(key) && inFlight.size >= 32)
      throw Object.assign(new Error('busy'), { status: 429 });
    try {
      const { promise } = coalesceProxyRequest(inFlight, key, async () => {
        const value = await load();
        cache.delete(key);
        cache.set(key, { value, savedAt: now() });
        while (cache.size > MAX_ENTRIES)
          cache.delete(cache.keys().next().value);
        return value;
      });
      return { value: await promise, stale: false };
    } catch (error) {
      if (previous) return { value: previous.value, stale: true };
      throw error;
    }
  }

  async function handler(req, res) {
    const json = (status, value, stale = false) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(status === 429 ? { 'Retry-After': '60' } : {}),
        ...(stale ? { 'X-Data-Stale': 'true' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const [pathPart, queryPart = ''] = (req.url || '/').split('?');
    const kind = pathPart.replace(/^\/+|\/+$/g, '');
    let key;
    let load;
    if (kind === 'tfr') {
      key = 'tfr';
      load = fetchTfrs;
    } else if (Object.hasOwn(AIRSPACE_MAX_SPAN_DEG, kind)) {
      const bbox = parseBboxParam(new URLSearchParams(queryPart).get('bbox'));
      if (!bbox) return json(400, { error: 'invalid_bbox' });
      if (bboxSpan(bbox) > AIRSPACE_MAX_SPAN_DEG[kind])
        return json(400, { error: 'bbox_too_large' });
      key = `${kind}:${bboxKey(bbox)}`;
      load = () => fetchArea(kind, bbox);
    } else return json(404, { error: 'unknown_route' });
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    try {
      const { value, stale } = await acquire(key, TTL_MS[kind], load);
      json(200, stale ? { ...value, stale: true } : value, stale);
    } catch (error) {
      json(error.status === 429 ? 429 : 502, { error: 'airspace_unavailable' });
    }
  }

  return {
    name: 'airspace',
    configureServer({ middlewares }) {
      middlewares.use('/api/airspace', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/airspace', handler);
    },
  };
}
