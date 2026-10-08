import path from 'node:path';
import { promises as fsp } from 'node:fs';

/**
 * Same-origin proxy for the U.S. Wind Turbine Database (USWTDB; USGS, LBNL
 * and ACP, public domain), the federal inventory of every utility-scale
 * land-based and offshore turbine in the US with location, hub height,
 * rotor diameter, capacity, make, model and project.
 *
 *   GET /api/wind-turbines?bbox=W,S,E,N[&limit=N]
 *     → { source, fetchedAt, total, inView, sampled, summary, turbines }
 *
 * The whole database (~75k rows) is downloaded once in pages, kept in memory
 * and on disk (`.gev-cache/wind-turbines/`) for a week (USGS updates it
 * quarterly), and served stale when USGS is down. Viewport queries are then
 * answered locally, so panning never hits USGS. `USWTDB_UPSTREAM` points the
 * proxy at another PostgREST host with the same `turbines` table (for example
 * a self-hosted copy on the private server).
 */
export const USWTDB_DEFAULT_UPSTREAM = 'https://energy.usgs.gov/api/uswtdb/v1';
export const TURBINE_DEFAULT_LIMIT = 3000;
export const TURBINE_MAX_LIMIT = 10_000;
const PAGE_SIZE = 10_000;
const MAX_PAGES = 30;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PAGE_BYTES = 32 * 1024 * 1024;

/** Resolve the upstream base; anything but a plain http(s) URL falls back. */
export function resolveUswtdbUpstream(raw = process.env.USWTDB_UPSTREAM) {
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
  return USWTDB_DEFAULT_UPSTREAM;
}

/** PostgREST URL for one page of the turbine table. */
export function uswtdbPageUrl(offset, upstream = resolveUswtdbUpstream()) {
  // No `select`: older and self-hosted copies differ in optional columns
  // (t_offshore, retrofit), and an unknown column fails the whole request.
  const params = new URLSearchParams({
    order: 'case_id',
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  return `${upstream}/turbines?${params}`;
}

const num = (v) => {
  const n = Number(v);
  return v !== null && v !== '' && Number.isFinite(n) && n >= 0 ? n : null;
};
const text = (v) => {
  const s = String(v ?? '').trim();
  return s && s !== '-9999' && s.toLowerCase() !== 'missing' ? s : null;
};

/**
 * One USWTDB row → compact turbine record, or null when it has no usable
 * position. USWTDB writes -9999 for unknown numbers; those become null.
 */
export function normalizeTurbine(row) {
  const lon = Number(row?.xlong);
  const lat = Number(row?.ylat);
  if (
    !Number.isFinite(lon) ||
    !Number.isFinite(lat) ||
    Math.abs(lon) > 180 ||
    Math.abs(lat) > 90
  )
    return null;
  return {
    id: String(row.case_id ?? `${lon},${lat}`),
    lon: Math.round(lon * 1e6) / 1e6,
    lat: Math.round(lat * 1e6) / 1e6,
    project: text(row.p_name),
    year: num(row.p_year),
    projectMw: num(row.p_cap),
    state: text(row.t_state),
    county: text(row.t_county),
    manufacturer: text(row.t_manu),
    model: text(row.t_model),
    kw: num(row.t_cap),
    hubM: num(row.t_hh),
    rotorM: num(row.t_rd),
    tipM: num(row.t_ttlh),
    offshore: Number(row.t_offshore) === 1,
    faaOrs: text(row.faa_ors),
  };
}

/** Parse "W,S,E,N" into a bbox, or null. Antimeridian-crossing boxes are rejected. */
export function parseBbox(raw) {
  const parts = String(raw ?? '')
    .split(',')
    .map((v) => Number(v));
  if (parts.length !== 4 || !parts.every(Number.isFinite)) return null;
  const [west, south, east, north] = parts;
  if (
    west < -180 ||
    east > 180 ||
    south < -90 ||
    north > 90 ||
    east <= west ||
    north <= south
  )
    return null;
  return { west, south, east, north };
}

/** Clamp a requested record limit. */
export function parseLimit(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return TURBINE_DEFAULT_LIMIT;
  return Math.min(TURBINE_MAX_LIMIT, n);
}

/**
 * Turbines inside a bbox, evenly thinned to `limit`, plus a summary of every
 * turbine in view (not just the returned sample).
 */
export function queryTurbines(turbines, bbox, limit = TURBINE_DEFAULT_LIMIT) {
  const inView = turbines.filter(
    (t) =>
      t.lon >= bbox.west &&
      t.lon <= bbox.east &&
      t.lat >= bbox.south &&
      t.lat <= bbox.north,
  );
  let mw = 0;
  let tallest = null;
  const projects = new Map();
  for (const t of inView) {
    mw += (t.kw ?? 0) / 1000;
    if (t.tipM !== null && (!tallest || t.tipM > tallest.tipM)) tallest = t;
    if (t.project) projects.set(t.project, (projects.get(t.project) ?? 0) + 1);
  }
  const topProjects = [...projects]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));
  let sample = inView;
  if (inView.length > limit) {
    const stride = inView.length / limit;
    sample = Array.from(
      { length: limit },
      (_, i) => inView[Math.floor(i * stride)],
    );
  }
  return {
    total: turbines.length,
    inView: inView.length,
    sampled: sample.length < inView.length,
    summary: {
      turbines: inView.length,
      mw: Math.round(mw * 10) / 10,
      projects: projects.size,
      topProjects,
      tallest: tallest
        ? {
            id: tallest.id,
            project: tallest.project,
            tipM: tallest.tipM,
            lon: tallest.lon,
            lat: tallest.lat,
          }
        : null,
    },
    turbines: sample,
  };
}

/** Vite plugin. `fetchImpl`, `cacheDir` and `now` are injectable for tests. */
export function windTurbinesProxy({
  fetchImpl = (...args) => fetch(...args),
  cacheDir = path.join(process.cwd(), '.gev-cache', 'wind-turbines'),
  upstream,
  now = Date.now,
  timeoutMs = 60_000,
} = {}) {
  /** @type {{at:number, turbines:object[]}|null} */
  let snapshot = null;
  /** @type {Promise<{at:number, turbines:object[]}>|null} */
  let inflight = null;
  const diskFile = path.join(cacheDir, 'uswtdb.json');

  async function readDisk() {
    try {
      const parsed = JSON.parse(await fsp.readFile(diskFile, 'utf8'));
      return Array.isArray(parsed?.turbines) && Number.isFinite(parsed.at)
        ? parsed
        : null;
    } catch {
      return null;
    }
  }

  async function writeDisk(entry) {
    try {
      await fsp.mkdir(cacheDir, { recursive: true });
      const tmp = `${diskFile}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(entry));
      await fsp.rename(tmp, diskFile);
    } catch {
      // Cache is best-effort; the response still goes out.
    }
  }

  async function fetchAll() {
    const base = upstream ?? resolveUswtdbUpstream();
    const turbines = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await fetchImpl(uswtdbPageUrl(page * PAGE_SIZE, base), {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: 'application/json' },
      });
      if (!response.ok)
        throw new Error(`USWTDB upstream HTTP ${response.status}`);
      const body = await response.text();
      if (body.length > MAX_PAGE_BYTES)
        throw new Error('USWTDB upstream page too large');
      const rows = JSON.parse(body);
      if (!Array.isArray(rows)) throw new Error('USWTDB returned non-array');
      for (const row of rows) {
        const t = normalizeTurbine(row);
        if (t) turbines.push(t);
      }
      if (rows.length < PAGE_SIZE) break;
    }
    if (!turbines.length) throw new Error('USWTDB returned no turbines');
    return { at: now(), turbines };
  }

  /** Fresh snapshot, else refetch, else stale snapshot. */
  async function resolve() {
    snapshot ||= await readDisk();
    if (snapshot && now() - snapshot.at < TTL_MS)
      return { entry: snapshot, cache: 'HIT' };
    inflight ||= fetchAll()
      .then(async (entry) => {
        snapshot = entry;
        await writeDisk(entry);
        return entry;
      })
      .finally(() => {
        inflight = null;
      });
    try {
      return { entry: await inflight, cache: 'MISS' };
    } catch (error) {
      if (snapshot) {
        console.warn('[wind-turbines] serving stale', error?.message);
        return { entry: snapshot, cache: 'STALE' };
      }
      throw error;
    }
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/wind-turbines', async (req, res) => {
      const send = (status, payload, headers = {}) => {
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': status === 200 ? 'public, max-age=600' : 'no-store',
          ...headers,
        });
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify(payload));
      };
      if (req.method !== 'GET' && req.method !== 'HEAD')
        return send(405, { error: 'method not allowed' });
      const url = new URL(req.url || '', 'http://internal');
      const bbox = parseBbox(url.searchParams.get('bbox'));
      if (!bbox) return send(400, { error: 'bbox=W,S,E,N required' });
      try {
        const { entry, cache } = await resolve();
        send(
          200,
          {
            source: 'USWTDB',
            fetchedAt: new Date(entry.at).toISOString(),
            ...queryTurbines(
              entry.turbines,
              bbox,
              parseLimit(url.searchParams.get('limit')),
            ),
          },
          { 'X-Uswtdb-Cache': cache },
        );
      } catch (error) {
        console.warn('[wind-turbines]', error?.message || error);
        send(502, { error: 'U.S. Wind Turbine Database unavailable' });
      }
    });
  };

  return {
    name: 'wind-turbines-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
