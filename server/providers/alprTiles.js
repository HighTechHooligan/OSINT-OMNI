import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { promises as fsp } from 'node:fs';

/**
 * Same-origin proxy for the community-hosted OpenStreetMap ALPR extract
 * (the hourly tiles DeFlock's map draws, built from OSM
 * `surveillance:type=ALPR` nodes; © OpenStreetMap contributors, ODbL).
 *
 *   GET /api/alpr/{us|ca}.json             TileJSON, `tiles` rewritten to this proxy
 *   GET /api/alpr/{us|ca}/{z}/{x}/{y}.mvt  Mapbox Vector Tile, never gzip-wrapped
 *
 * The browser never talks to the third-party host, so CORS, privacy filters and
 * host outages stop breaking the layer. Responses are cached in memory and on
 * disk (`.gev-cache/alpr/`) for an hour and served stale when the upstream
 * fails, so once a city has been viewed it keeps working offline.
 * `ALPR_TILES_UPSTREAM` points the proxy at another host serving the same
 * `cameras-{country}-hourly` layout (for example a self-hosted copy).
 */
export const ALPR_DEFAULT_UPSTREAM = 'https://tiles.dontgetflocked.com';
export const ALPR_COUNTRIES = Object.freeze(['us', 'ca']);
export const ALPR_MAX_ZOOM = 14;
const TTL_MS = 60 * 60 * 1000;
const MAX_TILE_BYTES = 4 * 1024 * 1024;
const MAX_TILEJSON_BYTES = 256 * 1024;
const MEM_MAX_ENTRIES = 512;

/** Resolve the upstream origin; anything but a plain http(s) origin falls back. */
export function resolveAlprUpstream(raw = process.env.ALPR_TILES_UPSTREAM) {
  try {
    const url = new URL(String(raw || '').trim());
    if (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password
    )
      return url.origin + url.pathname.replace(/\/+$/, '');
  } catch {
    /* fall through */
  }
  return ALPR_DEFAULT_UPSTREAM;
}

/**
 * Parse a proxy path (relative to /api/alpr) into a request, or null.
 * @param {string} pathname e.g. "/us.json" or "/us/11/467/843.mvt".
 */
export function parseAlprPath(pathname) {
  const meta = /^\/(us|ca)\.json$/.exec(pathname);
  if (meta) return { kind: 'tilejson', country: meta[1] };
  const tile = /^\/(us|ca)\/(\d{1,2})\/(\d{1,5})\/(\d{1,5})\.(?:mvt|pbf)$/.exec(
    pathname,
  );
  if (!tile) return null;
  const [z, x, y] = tile.slice(2).map(Number);
  if (z > ALPR_MAX_ZOOM || x >= 2 ** z || y >= 2 ** z) return null;
  return { kind: 'tile', country: tile[1], z, x, y };
}

/** Upstream URL for a parsed request. */
export function alprUpstreamUrl(request, upstream = resolveAlprUpstream()) {
  const layer = `cameras-${request.country}-hourly`;
  return request.kind === 'tilejson'
    ? `${upstream}/${layer}.json`
    : `${upstream}/${layer}/${request.z}/${request.x}/${request.y}.mvt`;
}

/** Point a TileJSON's tiles at this proxy, keeping every other field. */
export function rewriteAlprTileJson(json, country, mount = '/api/alpr') {
  if (!json || typeof json !== 'object' || !Array.isArray(json.tiles))
    throw new Error('ALPR upstream returned invalid TileJSON');
  return { ...json, tiles: [`${mount}/${country}/{z}/{x}/{y}.mvt`] };
}

/** Undo a gzip wrapper some static tile hosts serve without Content-Encoding. */
export function unwrapTileBytes(buf) {
  return buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b
    ? gunzipSync(buf, { maxOutputLength: MAX_TILE_BYTES * 4 })
    : buf;
}

/** Vite plugin. `fetchImpl`, `cacheDir` and `now` are injectable for tests. */
export function alprTilesProxy({
  fetchImpl = (...args) => fetch(...args),
  cacheDir = path.join(process.cwd(), '.gev-cache', 'alpr'),
  upstream,
  now = Date.now,
  timeoutMs = 15_000,
} = {}) {
  /** @type {Map<string, {at:number, body:Buffer}>} */
  const mem = new Map();
  /** @type {Map<string, Promise<{at:number, body:Buffer}>>} */
  const inflight = new Map();

  const diskPath = (key) =>
    path.join(cacheDir, ...key.split('/').filter(Boolean));

  function remember(key, entry) {
    mem.delete(key);
    mem.set(key, entry);
    while (mem.size > MEM_MAX_ENTRIES) mem.delete(mem.keys().next().value);
  }

  async function readDisk(key) {
    try {
      const file = diskPath(key);
      const [body, stat] = await Promise.all([
        fsp.readFile(file),
        fsp.stat(file),
      ]);
      return { at: stat.mtimeMs, body };
    } catch {
      return null;
    }
  }

  async function writeDisk(key, body) {
    try {
      const file = diskPath(key);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, body);
      await fsp.rename(tmp, file);
    } catch {
      // Cache is best-effort; the response still goes out.
    }
  }

  async function fetchUpstream(request) {
    const response = await fetchImpl(
      alprUpstreamUrl(request, upstream ?? resolveAlprUpstream()),
      { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' },
    );
    // An empty extract tile is a valid, cacheable answer.
    if (
      request.kind === 'tile' &&
      (response.status === 204 || response.status === 404)
    )
      return Buffer.alloc(0);
    if (!response.ok)
      throw Object.assign(new Error(`ALPR upstream HTTP ${response.status}`), {
        status: response.status,
      });
    const limit =
      request.kind === 'tilejson' ? MAX_TILEJSON_BYTES : MAX_TILE_BYTES;
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > limit)
      throw new Error('ALPR upstream response too large');
    const raw = Buffer.from(await response.arrayBuffer());
    if (raw.length > limit) throw new Error('ALPR upstream response too large');
    if (request.kind === 'tile') return unwrapTileBytes(raw);
    const json = JSON.parse(unwrapTileBytes(raw).toString('utf8'));
    return Buffer.from(
      JSON.stringify(rewriteAlprTileJson(json, request.country)),
    );
  }

  /** Fresh cache, else upstream, else stale cache. */
  async function resolve(request, key) {
    let cached = mem.get(key) || (await readDisk(key));
    if (cached && now() - cached.at < TTL_MS) {
      remember(key, cached);
      return { entry: cached, cache: 'HIT' };
    }
    if (!inflight.has(key)) {
      inflight.set(
        key,
        fetchUpstream(request)
          .then(async (body) => {
            const entry = { at: now(), body };
            remember(key, entry);
            await writeDisk(key, body);
            return entry;
          })
          .finally(() => inflight.delete(key)),
      );
    }
    try {
      return { entry: await inflight.get(key), cache: 'MISS' };
    } catch (error) {
      cached ||= mem.get(key);
      if (cached) {
        console.warn('[alpr-proxy] serving stale', key, error?.message);
        return { entry: cached, cache: 'STALE' };
      }
      throw error;
    }
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/alpr', async (req, res) => {
      const fail = (status, error) => {
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({ error }));
      };
      if (req.method !== 'GET' && req.method !== 'HEAD')
        return fail(405, 'method not allowed');
      const url = new URL(req.url || '', 'http://internal');
      const request = parseAlprPath(url.pathname);
      if (!request) return fail(404, 'unknown ALPR tile path');
      const key =
        request.kind === 'tilejson'
          ? `${request.country}.json`
          : `${request.country}/${request.z}/${request.x}/${request.y}.mvt`;
      try {
        const { entry, cache } = await resolve(request, key);
        res.writeHead(200, {
          'Content-Type':
            request.kind === 'tilejson'
              ? 'application/json'
              : 'application/vnd.mapbox-vector-tile',
          'Cache-Control': 'public, max-age=900',
          'X-Alpr-Cache': cache,
          'X-Alpr-Fetched-At': new Date(entry.at).toISOString(),
        });
        res.end(req.method === 'HEAD' ? undefined : entry.body);
      } catch (error) {
        console.warn('[alpr-proxy]', key, error?.message || error);
        fail(502, 'ALPR camera extract unavailable');
      }
    });
  };

  return {
    name: 'alpr-tiles-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
