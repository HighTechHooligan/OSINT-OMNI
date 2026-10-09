import { decodePolyline } from './polyline.js';

/**
 * Valhalla routing client. Valhalla is open source, runs on the public
 * OpenStreetMap instance today and can run on the OMNI host later, and unlike
 * OSRM it accepts `exclude_locations`, which is what camera avoidance needs.
 */
export const DEFAULT_ROUTER_URL = 'https://valhalla1.openstreetmap.de';
/** Valhalla's default service limit for exclude_locations. */
export const MAX_EXCLUDES = 50;
export const NO_PATH_CODES = new Set([442, 443]);

export class RoutingError extends Error {
  constructor(message, { code = null, status = null } = {}) {
    super(message);
    this.name = 'RoutingError';
    this.code = code;
    this.status = status;
  }
  get noPath() {
    return NO_PATH_CODES.has(this.code);
  }
}

const COSTINGS = new Set(['auto', 'bicycle', 'pedestrian']);

/** Build a /route request body. Points are [lon, lat]. */
export function buildRouteRequest({
  from,
  to,
  costing = 'auto',
  excludes = [],
  units = 'miles',
}) {
  if (!COSTINGS.has(costing)) throw new Error(`Unknown travel mode: ${costing}`);
  const body = {
    locations: [
      { lon: from[0], lat: from[1], type: 'break' },
      { lon: to[0], lat: to[1], type: 'break' },
    ],
    costing,
    directions_options: { units, language: 'en-US' },
  };
  if (excludes.length)
    body.exclude_locations = excludes
      .slice(0, MAX_EXCLUDES)
      .map(([lon, lat]) => ({ lon, lat }));
  return body;
}

/** Normalize a Valhalla /route response into one route object. */
export function parseRouteResponse(json) {
  const trip = json?.trip;
  if (!trip || !Array.isArray(trip.legs) || !trip.legs.length)
    throw new RoutingError('Router returned no trip');
  const coords = [];
  const maneuvers = [];
  for (const leg of trip.legs) {
    const offset = coords.length ? coords.length - 1 : 0;
    const shape = decodePolyline(leg.shape || '', 6);
    coords.push(...(coords.length ? shape.slice(1) : shape));
    for (const m of leg.maneuvers || [])
      maneuvers.push({
        type: m.type,
        instruction: m.instruction || '',
        verbalPre: m.verbal_pre_transition_instruction || m.instruction || '',
        street: (m.street_names || [])[0] || '',
        length: m.length || 0,
        time: m.time || 0,
        begin: offset + (m.begin_shape_index || 0),
        end: offset + (m.end_shape_index || 0),
      });
  }
  return {
    coords,
    maneuvers,
    length: trip.summary?.length ?? 0,
    time: trip.summary?.time ?? 0,
    units: trip.units || 'miles',
  };
}

/** POST a route request. Throws RoutingError (with Valhalla's error_code) on failure. */
export async function requestRoute(baseUrl, body, { fetchImpl = fetch, signal } = {}) {
  const url = `${String(baseUrl || DEFAULT_ROUTER_URL).replace(/\/+$/, '')}/route`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    /* handled below */
  }
  if (!response.ok || json?.error_code)
    throw new RoutingError(json?.error || `Router HTTP ${response.status}`, {
      code: json?.error_code ?? null,
      status: response.status,
    });
  return parseRouteResponse(json);
}
