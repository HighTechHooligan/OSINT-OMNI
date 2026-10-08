import { makeRateLimiter, clientKey } from '../common/rate-limit.js';
import { coalesceProxyRequest } from '../common/http.js';
import { fetchRegionalJson } from './http.js';
import { naturalRegionAtPoint } from '../../../src/data/naturalEarthRegions.js';
import {
  nominatimToGeocodeResult,
  nominatimViewboxFromBounds,
} from '../../../src/nominatimGeocode.js';

/**
 * The usage policy for the public Nominatim instance asks for a User-Agent or
 * Referer that identifies the application, and states that stock library
 * agents will not do. Both are sent.
 */
const NOMINATIM_HEADERS = Object.freeze({
  'User-Agent':
    'gods-eye-view/0.1 (+https://github.com/bilawalsidhu/gods-eye-view)',
  Referer: 'https://github.com/bilawalsidhu/gods-eye-view',
});

/**
 * Minimum spacing between upstream calls. The policy states an absolute
 * maximum of one request per second; 1.1 s keeps clock jitter from crossing it.
 */
const NOMINATIM_MIN_SPACING_MS = 1100;

/**
 * How many searches may be waiting for their turn.
 *
 * One request per second and an unbounded queue are incompatible: a burst of
 * searches would keep the upstream busy long after everyone who asked has given
 * up, which is exactly the load the policy asks callers not to create. Past
 * this depth a search is refused at once instead of being promised a slot
 * minutes away.
 */
const NOMINATIM_MAX_PENDING = 4;

/**
 * How long a queued search may wait before it is not worth sending. The
 * browser gives up well before this, so anything reaching the front later than
 * this is answering nobody.
 */
const NOMINATIM_MAX_WAIT_MS = 10_000;

const NOMINATIM_SEARCH_CACHE_MS = 5 * 60_000;

const NOMINATIM_SEARCH_MAX_CACHE = 80;

const NOMINATIM_SEARCH_MAX_QUERY = 200;

// The pacer is deliberately module state while everything else here is
// per-instance. One request per second is a budget for the whole application,
// not for each provider object: two instances each pacing themselves would
// send two requests a second between them. Last-resort forward searches and
// dossier reverse lookups share this queue.
let _nominatimQueue = Promise.resolve();

let _nominatimLastRequestAt = 0;

let _nominatimPending = 0;

/** Raised when the queue is already as deep as it is allowed to get. */
function queueFullError() {
  return Object.assign(new Error('Place search queue is full'), {
    code: 'NOMINATIM_QUEUE_FULL',
  });
}

/** Raised when a queued search waited so long that nobody is left to answer. */
function abandonedError() {
  return Object.assign(new Error('Place search was abandoned'), {
    code: 'NOMINATIM_ABANDONED',
  });
}

/**
 * Run one piece of upstream work, never closer than the policy spacing to the
 * last one.
 *
 * `bounded` applies queue-depth and staleness limits to interactive forward searches.
 *
 * @param {() => Promise<unknown>} work
 * @param {{bounded?: boolean, signal?: AbortSignal}} [options]
 */
function enqueueNominatim(work, { bounded = false, signal } = {}) {
  if (bounded && _nominatimPending >= NOMINATIM_MAX_PENDING)
    return Promise.reject(queueFullError());
  if (bounded) _nominatimPending += 1;
  const queuedAt = Date.now();
  const task = _nominatimQueue.then(async () => {
    try {
      const waitMs = Math.max(
        0,
        NOMINATIM_MIN_SPACING_MS - (Date.now() - _nominatimLastRequestAt),
      );
      if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
      // Nobody is waiting for this any more: sending it would spend the one
      // request per second the policy allows on an answer with no reader.
      if (bounded && Date.now() - queuedAt > NOMINATIM_MAX_WAIT_MS)
        throw abandonedError();
      if (signal?.aborted) throw abandonedError();
      _nominatimLastRequestAt = Date.now();
      return await work();
    } finally {
      if (bounded) _nominatimPending -= 1;
    }
  });
  _nominatimQueue = task.catch(() => null);
  return task;
}

/** Construct the offline regional context provider from bundled Natural Earth polygons. */
export function createRegionalPlaceProvider() {
  return (point) => naturalRegionAtPoint(point.latitude, point.longitude);
}

export const fetchRegionalPlace = createRegionalPlaceProvider();

/**
 * Construct the forward search adapter with a trusted endpoint.
 *
 * The policy asks that results be cached, and warns that a client repeating the
 * same query may be treated as faulty, so an answer is remembered and identical
 * searches already in flight share one upstream call rather than queueing
 * behind each other.
 */
export function createNominatimSearchProvider({
  endpoint = 'https://nominatim.openstreetmap.org/search',
  requestJson = fetchRegionalJson,
} = {}) {
  const cache = new Map();
  const inFlight = new Map();

  const trimCache = () => {
    while (cache.size > NOMINATIM_SEARCH_MAX_CACHE) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  return async function fetchNominatimSearch(query, bounds, { signal } = {}) {
    const cacheKey = `${query.toLowerCase()}|${bounds || ''}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt <= NOMINATIM_SEARCH_CACHE_MS) {
      return { ...cached.payload, cached: true };
    }
    const { promise } = coalesceProxyRequest(inFlight, cacheKey, async () => {
      const params = new URLSearchParams({
        format: 'jsonv2',
        q: query,
        addressdetails: '1',
        limit: '1',
        'accept-language': 'en',
      });
      const viewbox = nominatimViewboxFromBounds(bounds);
      if (viewbox) params.set('viewbox', viewbox);
      const rows = await enqueueNominatim(
        () =>
          requestJson(`${endpoint}?${params}`, {
            headers: NOMINATIM_HEADERS,
            redirect: 'error',
          }),
        { bounded: true, signal },
      );
      const result = nominatimToGeocodeResult(
        Array.isArray(rows) ? rows[0] : null,
      );
      const payload = result
        ? { status: 'OK', results: [result] }
        : { status: 'ZERO_RESULTS', results: [] };
      cache.set(cacheKey, { payload, cachedAt: Date.now() });
      trimCache();
      return payload;
    });
    return await promise;
  };
}

export const fetchNominatimSearch = createNominatimSearchProvider();

const NOMINATIM_REVERSE_CACHE_MS = 30 * 60_000;
const NOMINATIM_REVERSE_MAX_CACHE = 200;

/** Keep only the plain-text address fields a dossier shows. */
function compactReverse(hit) {
  if (!hit || typeof hit !== 'object' || hit.error) return null;
  const text = (value) =>
    typeof value === 'string'
      ? value
          .replace(/[\x00-\x1f\x7f]/g, ' ')
          .trim()
          .slice(0, 200)
      : undefined;
  const address = {};
  for (const [key, value] of Object.entries(hit.address ?? {})) {
    const clean = text(value);
    if (clean && Object.keys(address).length < 24) address[key] = clean;
  }
  return {
    displayName: text(hit.display_name) ?? null,
    name: text(hit.name) || null,
    category: text(hit.category || hit.class) ?? null,
    type: text(hit.type) ?? null,
    osmType: text(hit.osm_type) ?? null,
    osmId: Number.isFinite(Number(hit.osm_id)) ? Number(hit.osm_id) : null,
    address,
  };
}

/**
 * Reverse geocoding for building/road/park dossiers. Shares the one
 * request-per-second queue with forward search, caches by ~1 m cell, and
 * coalesces identical lookups.
 */
export function createNominatimReverseProvider({
  endpoint = 'https://nominatim.openstreetmap.org/reverse',
  requestJson = fetchRegionalJson,
} = {}) {
  const cache = new Map();
  const inFlight = new Map();
  return async function fetchNominatimReverse(lat, lon, { signal } = {}) {
    const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.cachedAt <= NOMINATIM_REVERSE_CACHE_MS)
      return { ...cached.payload, cached: true };
    const { promise } = coalesceProxyRequest(inFlight, key, async () => {
      const params = new URLSearchParams({
        format: 'jsonv2',
        lat: lat.toFixed(6),
        lon: lon.toFixed(6),
        zoom: '18',
        addressdetails: '1',
        'accept-language': 'en',
      });
      const hit = await enqueueNominatim(
        () =>
          requestJson(`${endpoint}?${params}`, {
            headers: NOMINATIM_HEADERS,
            redirect: 'error',
          }),
        { bounded: true, signal },
      );
      const result = compactReverse(hit);
      const payload = result
        ? { status: 'OK', result }
        : { status: 'ZERO_RESULTS', result: null };
      cache.set(key, { payload, cachedAt: Date.now() });
      while (cache.size > NOMINATIM_REVERSE_MAX_CACHE)
        cache.delete(cache.keys().next().value);
      return payload;
    });
    return await promise;
  };
}

export const fetchNominatimReverse = createNominatimReverseProvider();

/** Vite plugin: last-resort place search over the public Nominatim instance. */
export function geocodeProxy({
  search = fetchNominatimSearch,
  reverse = fetchNominatimReverse,
} = {}) {
  const limiter = makeRateLimiter({
    windowMs: 60_000,
    max: 30,
    globalMax: 90,
  });

  function install(middlewares) {
    middlewares.use('/api/geocode', async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return;
      }
      if (!limiter(clientKey(req))) {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Retry-After': '10',
        });
        res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
        return;
      }
      const url = new URL(req.url || '', 'http://localhost');
      const query = String(url.searchParams.get('q') || '').trim();
      if (!query || query.length > NOMINATIM_SEARCH_MAX_QUERY) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'A place query of 1-200 characters is required',
          }),
        );
        return;
      }
      // A browser that gave up is no longer waiting; the queue reads this
      // before spending its slot.
      const abandoned = new AbortController();
      req.on?.('aborted', () => abandoned.abort());
      res.on?.('close', () => abandoned.abort());
      try {
        const payload = await search(query, url.searchParams.get('bounds'), {
          signal: abandoned.signal,
        });
        if (res.writableEnded) return;
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': payload.cached ? 'public, max-age=60' : 'no-store',
        });
        res.end(
          JSON.stringify({ status: payload.status, results: payload.results }),
        );
      } catch (error) {
        if (res.writableEnded) return;
        const busy =
          error?.code === 'NOMINATIM_QUEUE_FULL' ||
          error?.code === 'NOMINATIM_ABANDONED';
        res.writeHead(busy ? 429 : 503, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          ...(busy ? { 'Retry-After': '5' } : {}),
        });
        res.end(
          JSON.stringify({
            error: busy
              ? 'Place search is busy'
              : 'Place search is temporarily unavailable',
          }),
        );
      }
    });
  }

  // GET /api/reverse-geocode?lat=&lon= → { status, result } (dossier addresses).
  function installReverse(middlewares) {
    middlewares.use('/api/reverse-geocode', async (req, res) => {
      const send = (code, body, extra = {}) => {
        if (res.writableEnded) return;
        res.writeHead(code, { 'Content-Type': 'application/json', ...extra });
        res.end(JSON.stringify(body));
      };
      if (req.method !== 'GET')
        return send(405, { error: 'Method Not Allowed' });
      if (!limiter(clientKey(req)))
        return send(
          429,
          { error: 'Rate limit exceeded' },
          { 'Retry-After': '10' },
        );
      const url = new URL(req.url || '', 'http://localhost');
      const num = (name) => {
        const raw = url.searchParams.get(name);
        return raw != null && raw.trim() !== '' ? Number(raw) : Number.NaN;
      };
      const lat = num('lat');
      const lon = num('lon');
      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        Math.abs(lat) > 90 ||
        Math.abs(lon) > 180
      )
        return send(400, { error: 'lat and lon are required' });
      const abandoned = new AbortController();
      req.on?.('aborted', () => abandoned.abort());
      res.on?.('close', () => abandoned.abort());
      try {
        const payload = await reverse(lat, lon, { signal: abandoned.signal });
        send(
          200,
          { status: payload.status, result: payload.result },
          {
            'Cache-Control': payload.cached
              ? 'public, max-age=300'
              : 'no-store',
          },
        );
      } catch (error) {
        const busy =
          error?.code === 'NOMINATIM_QUEUE_FULL' ||
          error?.code === 'NOMINATIM_ABANDONED';
        send(
          busy ? 429 : 503,
          {
            error: busy
              ? 'Address lookup is busy'
              : 'Address lookup is temporarily unavailable',
          },
          {
            'Cache-Control': 'no-store',
            ...(busy ? { 'Retry-After': '5' } : {}),
          },
        );
      }
    });
  }

  return {
    name: 'geocode-proxy',
    configureServer(server) {
      install(server.middlewares);
      installReverse(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
      installReverse(server.middlewares);
    },
  };
}

export { NOMINATIM_MAX_PENDING };
