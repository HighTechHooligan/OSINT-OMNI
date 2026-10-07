import path from 'node:path';
import { promises as fsp } from 'node:fs';

/**
 * Same-origin proxy for the OSM street basemap.
 *
 *   GET /api/tiles/osm/{z}/{x}/{y}.png   raster tile (PNG/JPEG as served)
 *
 * The browser used to load tile.openstreetmap.org directly, which shows a
 * blank map whenever that host refuses the request (its tile policy blocks
 * missing or unrecognised referrers and heavy users) or is unreachable.
 * This proxy sends an identifying User-Agent, caches tiles in memory and on
 * disk (`.gev-cache/osm-tiles/`, 7 days, served stale on failure), and fails
 * over across several OSM-style raster hosts. An upstream that errors is
 * skipped for a minute so one outage doesn't slow every tile.
 * `OSM_TILE_UPSTREAMS` (comma-separated `{z}/{x}/{y}` URL templates)
 * replaces the default list, for example with a self-hosted tile server.
 */
export const OSM_TILE_DEFAULT_UPSTREAMS = Object.freeze([
  'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  'https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
  'https://a.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
]);
export const OSM_TILE_MAX_ZOOM = 19;
export const OSM_TILE_USER_AGENT =
  'osint-omni/0.2 (+https://github.com/HighTechHooligan/OSINT-OMNI)';
const TTL_MS = 7 * 86_400_000;
const COOLDOWN_MS = 60_000;
const MAX_TILE_BYTES = 2 * 1024 * 1024;
const MEM_MAX_ENTRIES = 1024;
const MAX_CONCURRENT = 6;

/** Parse operator templates; only plain http(s) URLs with {z},{x},{y}. */
export function parseOsmTileUpstreams(raw) {
  const out = [];
  for (const token of String(raw || '').split(',')) {
    const template = token.trim();
    if (!/\{z\}/.test(template) || !/\{x\}/.test(template)) continue;
    if (!/\{y\}/.test(template)) continue;
    try {
      const url = new URL(template.replace(/\{[zxy]\}/g, '0'));
      if (
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !out.includes(template)
      )
        out.push(template);
    } catch {
      // invalid entries are ignored
    }
  }
  return out.slice(0, 8);
}

export function resolveOsmTileUpstreams(raw = process.env.OSM_TILE_UPSTREAMS) {
  const parsed = parseOsmTileUpstreams(raw);
  return parsed.length ? parsed : [...OSM_TILE_DEFAULT_UPSTREAMS];
}

/** "/{z}/{x}/{y}.png" (relative to /api/tiles/osm) → {z,x,y} or null. */
export function parseOsmTilePath(pathname) {
  const m = /^\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.(?:png|jpg|jpeg)$/.exec(
    pathname,
  );
  if (!m) return null;
  const [z, x, y] = m.slice(1).map(Number);
  if (z > OSM_TILE_MAX_ZOOM || x >= 2 ** z || y >= 2 ** z) return null;
  return { z, x, y };
}

export const osmTileUrl = (template, { z, x, y }) =>
  template.replace('{z}', z).replace('{x}', x).replace('{y}', y);

/** Image type from the first bytes (PNG/JPEG/WebP), else null. */
export function sniffImageType(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (
    buf.length > 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'image/webp';
  return null;
}

/** Vite plugin. `fetchImpl`, `cacheDir`, `upstreams` and `now` are injectable for tests. */
export function osmTilesProxy({
  fetchImpl = (...args) => fetch(...args),
  cacheDir = path.join(process.cwd(), '.gev-cache', 'osm-tiles'),
  upstreams,
  now = Date.now,
  timeoutMs = 10_000,
} = {}) {
  /** @type {Map<string, {at:number, body:Buffer, type:string}>} */
  const mem = new Map();
  const inflight = new Map();
  const downUntil = new Map(); // template → time it may be retried
  let active = 0;
  const queue = [];

  const slot = () =>
    active < MAX_CONCURRENT
      ? (active++, Promise.resolve())
      : new Promise((resolve) => queue.push(resolve)).then(() => active++);
  const release = () => {
    active--;
    queue.shift()?.();
  };

  const diskPath = (key) => path.join(cacheDir, ...key.split('/'));

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
      const type = sniffImageType(body);
      return type ? { at: stat.mtimeMs, body, type } : null;
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
      // best-effort cache
    }
  }

  async function fetchOne(template, tile) {
    const response = await fetchImpl(osmTileUrl(template, tile), {
      headers: { 'User-Agent': OSM_TILE_USER_AGENT, Accept: 'image/*' },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > MAX_TILE_BYTES) throw new Error('tile too large');
    const type = sniffImageType(body);
    if (!type) throw new Error('not an image');
    return { body, type };
  }

  /** Try each upstream in order, skipping ones that failed recently. */
  async function fetchUpstream(tile) {
    const list = upstreams ?? resolveOsmTileUpstreams();
    const t = now();
    const ready = list.filter((u) => (downUntil.get(u) ?? 0) <= t);
    const order = ready.length ? ready : list; // all down: try them anyway
    const errors = [];
    await slot();
    try {
      for (const template of order) {
        try {
          const out = await fetchOne(template, tile);
          downUntil.delete(template);
          return out;
        } catch (error) {
          downUntil.set(template, now() + COOLDOWN_MS);
          errors.push(
            `${new URL(osmTileUrl(template, tile)).host}: ${error?.message}`,
          );
        }
      }
    } finally {
      release();
    }
    throw new Error(`all OSM tile upstreams failed (${errors.join('; ')})`);
  }

  async function resolve(tile, key) {
    const cached = mem.get(key) || (await readDisk(key));
    if (cached && now() - cached.at < TTL_MS) {
      remember(key, cached);
      return { entry: cached, cache: 'HIT' };
    }
    if (!inflight.has(key))
      inflight.set(
        key,
        fetchUpstream(tile)
          .then(async ({ body, type }) => {
            const entry = { at: now(), body, type };
            remember(key, entry);
            await writeDisk(key, body);
            return entry;
          })
          .finally(() => inflight.delete(key)),
      );
    try {
      return { entry: await inflight.get(key), cache: 'MISS' };
    } catch (error) {
      if (cached) return { entry: cached, cache: 'STALE' };
      throw error;
    }
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/tiles/osm', async (req, res) => {
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
      const tile = parseOsmTilePath(url.pathname);
      if (!tile) return fail(404, 'unknown OSM tile path');
      const key = `${tile.z}/${tile.x}/${tile.y}`;
      try {
        const { entry, cache } = await resolve(tile, key);
        res.writeHead(200, {
          'Content-Type': entry.type,
          'Cache-Control': 'public, max-age=86400',
          'X-Osm-Tile-Cache': cache,
        });
        res.end(req.method === 'HEAD' ? undefined : entry.body);
      } catch (error) {
        console.warn('[osm-tiles]', key, error?.message || error);
        fail(502, 'OSM basemap tile unavailable');
      }
    });
  };

  return {
    name: 'osm-tiles-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
