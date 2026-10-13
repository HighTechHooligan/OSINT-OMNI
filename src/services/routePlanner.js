/**
 * Camera-aware route planning for the desktop ROUTES panel and the Features
 * Code `route` command (the same shared engine the phone app runs). Pure: no
 * Cesium and no DOM, so it is testable and callable as an agent tool.
 *
 * Roads come from Overpass (this server's /api/overpass proxy when it has an
 * upstream configured, else the public Overpass API), cameras from the ALPR
 * extract tiles (/api/alpr, else the extract host), and the "usual route"
 * the detour is measured against from /api/route (OSRM). There is no
 * distance limit: a trip longer than /api/route serves is guided by the
 * straight line instead.
 */
import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { cameraAwareRoute, cameraMessage } from './routing/cameraAwareRoute.js';
import { camerasAlongLine, VIEW_DEFAULTS } from './routing/cameraView.js';
import { profileFor } from './routing/roadProfiles.js';
import {
  createMemoryRoadStore,
  createRoadSource,
  DEFAULT_OVERPASS_URL,
} from './routing/roadSource.js';
import { haversineM, tilesNearLine } from './routing/routeGeo.js';
import { solveRoute } from './routing/solveRoute.js';

export const ROUTE_MODES = Object.freeze({
  car: Object.freeze({ engine: 'auto', osrm: 'car', word: 'Car' }),
  bike: Object.freeze({ engine: 'bicycle', osrm: 'bike', word: 'Bike' }),
  walk: Object.freeze({ engine: 'pedestrian', osrm: 'foot', word: 'Walk' }),
});

const MODE_ALIASES = Object.freeze({
  car: 'car',
  drive: 'car',
  auto: 'car',
  bike: 'bike',
  bicycle: 'bike',
  cycle: 'bike',
  walk: 'walk',
  foot: 'walk',
  pedestrian: 'walk',
});

export const CAMERA_TILE_ZOOM = 11;
const CAMERA_DIRECT =
  'https://tiles.dontgetflocked.com/cameras-us-hourly/{z}/{x}/{y}.mvt';

export const normalizeRouteMode = (mode) =>
  MODE_ALIASES[String(mode ?? 'car').toLowerCase()] ?? null;

/** "30.27, -97.74" (lat, lon) as [lon, lat], or null. */
export function parseLatLon(text) {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(
    String(text ?? ''),
  );
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return [lon, lat];
}

/**
 * Split "route <from> to <to> [car|bike|walk] [direct]" arguments.
 * @returns {{from: string, to: string, mode: string, avoid: boolean}|null}
 */
export function parseRouteArgs(raw) {
  let words = String(raw ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let mode = 'car';
  let avoid = true;
  for (;;) {
    const last = words.at(-1)?.toLowerCase();
    if (last && normalizeRouteMode(last)) {
      mode = normalizeRouteMode(last);
      words = words.slice(0, -1);
    } else if (last === 'direct' || last === 'fastest') {
      avoid = false;
      words = words.slice(0, -1);
    } else break;
  }
  const text = words.join(' ');
  const parts = text.split(/\s+to\s+/i);
  if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) return null;
  const from = parts[0].replace(/^from\s+/i, '').trim();
  return { from, to: parts[1].trim(), mode, avoid };
}

/** Decode one extract tile to {id, lon, lat, direction, brand, operator}. */
export function decodeCameraPoints(bytes, z, x, y) {
  if (!bytes?.byteLength) return [];
  const layer = new VectorTile(new PbfReader(new Uint8Array(bytes))).layers
    .cameras;
  if (!layer) return [];
  if (layer.length > 40_000)
    throw new Error('Camera tile feature limit exceeded');
  const out = [];
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i).toGeoJSON(x, y, z);
    if (f.geometry?.type !== 'Point') continue;
    const p = f.properties || {};
    const [lon, lat] = f.geometry.coordinates;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    out.push({
      id:
        p.osmId != null ? `n${p.osmId}` : `${lon.toFixed(6)},${lat.toFixed(6)}`,
      lon,
      lat,
      operator: p.operator || '',
      brand: p.brand || '',
      direction: p.direction ?? null,
    });
  }
  return out;
}

/** Distance and time words for a solved route. */
export function describeRoute(r) {
  if (!r) return 'No route';
  const miles =
    r.route.units === 'kilometers' ? r.route.length * 0.621371 : r.route.length;
  const min = Math.round(r.route.time / 60);
  const time =
    min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
  const extra =
    r.extraTimeS != null && r.extraTimeS > 60
      ? ` · +${Math.round(r.extraTimeS / 60)} min vs usual`
      : '';
  return `${time} · ${miles.toFixed(miles < 10 ? 1 : 0)} mi${extra}`;
}

const fill = (template, t) =>
  template.replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y);

/**
 * @param {object} [o]
 * @param {Function} [o.fetchImpl]
 * @param {(query: string) => Promise<{lat:number, lng:number, label?:string, name?:string}|null>} [o.geocode]
 * @param {(input: object) => Promise<object>|object} [o.solve] solveRoute or a worker proxy
 * @param {string} [o.origin] base for /api/* requests ('' = same origin)
 */
export function createRoutePlanner({
  fetchImpl = (...args) => globalThis.fetch(...args),
  geocode = null,
  solve = solveRoute,
  origin = '',
  overpassUrl = DEFAULT_OVERPASS_URL,
  view = {},
} = {}) {
  const roads = createRoadSource({
    store: createMemoryRoadStore(),
    endpoints: () => [`${origin}/api/overpass`, overpassUrl],
    post: async (url, body) => {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      return { status: res.status, text: await res.text() };
    },
  });

  // Camera tiles change hourly upstream; an hour in memory is plenty.
  const cameraTiles = new Map();
  let cameraTemplate = `${origin}/api/alpr/us/{z}/{x}/{y}.mvt`;
  async function cameraTile(t) {
    const key = `${t.z}/${t.x}/${t.y}`;
    const hit = cameraTiles.get(key);
    if (hit && Date.now() - hit.at < 3600_000) return hit.cameras;
    let res = await fetchImpl(fill(cameraTemplate, t));
    const type = res.headers?.get?.('content-type') || '';
    if (
      cameraTemplate !== CAMERA_DIRECT &&
      (res.status === 404 || res.status === 405 || /text\/html/.test(type))
    ) {
      // No ALPR proxy on this server (static build): read the extract directly.
      cameraTemplate = CAMERA_DIRECT;
      res = await fetchImpl(fill(cameraTemplate, t));
    }
    if (res.status === 204 || res.status === 404) return [];
    if (!res.ok) throw new Error(`Camera tile HTTP ${res.status}`);
    const cameras = decodeCameraPoints(await res.arrayBuffer(), t.z, t.x, t.y);
    cameraTiles.set(key, { cameras, at: Date.now() });
    return cameras;
  }
  async function camerasNear(line, padM) {
    const seen = new Map();
    for (const t of tilesNearLine(line, CAMERA_TILE_ZOOM, padM))
      for (const c of await cameraTile(t)) seen.set(c.id, c);
    return [...seen.values()];
  }

  async function usualRoute(from, to, mode) {
    try {
      const coords = `${from[0].toFixed(6)},${from[1].toFixed(6)};${to[0].toFixed(6)},${to[1].toFixed(6)}`;
      const res = await fetchImpl(
        `${origin}/api/route?profile=${ROUTE_MODES[mode].osrm}&coords=${encodeURIComponent(coords)}`,
      );
      const data = await res.json();
      if (
        !data?.ok ||
        !Array.isArray(data.geometry) ||
        data.geometry.length < 2
      )
        return null;
      return {
        coords: data.geometry.map(([lon, lat]) => [Number(lon), Number(lat)]),
        lengthM: Number(data.distanceM) || 0,
        timeS: Number(data.durationS) || 0,
      };
    } catch {
      return null;
    }
  }

  /** A place: [lon, lat], "lat, lon", or a name to geocode. */
  async function resolvePlace(place, { here = null } = {}) {
    if (Array.isArray(place) && place.length === 2)
      return { at: [Number(place[0]), Number(place[1])], label: null };
    const text = String(place ?? '').trim();
    if (/^(here|view|center|centre)$/i.test(text)) {
      if (!here) throw new Error('No map view to start from');
      return { at: here, label: 'Map view' };
    }
    const ll = parseLatLon(text);
    if (ll) return { at: ll, label: text };
    if (!geocode)
      throw new Error(`Can't look up "${text}" here; give lat, lon`);
    const hit = await geocode(text);
    if (
      !hit ||
      !Number.isFinite(hit.lat) ||
      !Number.isFinite(hit.lng ?? hit.lon)
    )
      throw new Error(`No place found for "${text}"`);
    return {
      at: [hit.lng ?? hit.lon, hit.lat],
      label: hit.label || hit.name || text,
    };
  }

  /**
   * @param {object} o
   * @param {[number,number]|string} o.from
   * @param {[number,number]|string} o.to
   * @param {string} [o.mode] car | bike | walk
   * @param {boolean} [o.avoid=true]
   * @param {[number,number]} [o.here] what "here" means (the map view)
   * @param {(stage: string, done?: number, total?: number) => void} [o.onProgress]
   */
  async function plan({
    from,
    to,
    mode = 'car',
    avoid = true,
    here = null,
    units = 'miles',
    onProgress = () => {},
  }) {
    const m = normalizeRouteMode(mode);
    if (!m) throw new Error('Mode is car, bike or walk');
    onProgress('Finding the places');
    const a = await resolvePlace(from, { here });
    const b = await resolvePlace(to, { here });
    if (haversineM(a.at, b.at) < 20)
      throw new Error('Start and destination are the same place');
    const profile = profileFor(ROUTE_MODES[m].engine);
    const viewOpts = { ...VIEW_DEFAULTS, ...view };

    onProgress('Getting the usual route');
    const usual = await usualRoute(a.at, b.at, m);
    let baselineCameras = [];
    if (usual) {
      const near = await camerasNear(usual.coords, 200);
      baselineCameras = camerasAlongLine(usual.coords, near, viewOpts);
    }
    const solved = await cameraAwareRoute({
      from: a.at,
      to: b.at,
      profile,
      guide: usual?.coords ?? null,
      loadRoads: (tiles, tier, p, tick) => roads.load(tiles, tier, p, tick),
      loadCameras: camerasNear,
      solve,
      avoid,
      view: viewOpts,
      units,
      onProgress,
    });
    if (!solved?.ok) {
      const why = {
        'no-road-near-start': 'No mapped road near the start',
        'no-road-near-destination': 'No mapped road near the destination',
        'no-path': 'No road connects these places in the loaded area',
      };
      throw new Error(why[solved?.reason] || 'No route found');
    }
    const baselineCount = usual ? baselineCameras.length : null;
    return {
      from: a.at,
      to: b.at,
      fromLabel: a.label,
      toLabel: b.label,
      mode: m,
      avoid,
      route: solved.route,
      passed: solved.passed,
      deadEnd: solved.atEnd.length > 0 || solved.atStart.length > 0,
      baseline: usual,
      baselineCameras,
      baselineCount,
      message: cameraMessage(solved, { baselineCount }),
      extraTimeS: usual ? solved.route.time - usual.timeS : null,
      stats: {
        ...solved.stats,
        widened: solved.widened,
        cameras: solved.cameraCount,
      },
      at: Date.now(),
    };
  }

  return { plan, resolvePlace, camerasNear };
}
