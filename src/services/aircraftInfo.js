/**
 * Pure helpers for the aircraft pop-out: which aircraft a globe pick hit, and
 * the rows, facts and source links the panel shows. No DOM, no Cesium.
 */
import { lookupAircraftType } from './aircraftTypes.js';

export const AIRCRAFT_LAYERS = Object.freeze(['flights', 'military']);
const LAYER_LABEL = Object.freeze({
  flights: 'Civil ADS-B (OpenSky / adsb.lol)',
  military: 'Military ADS-B (adsb.lol)',
});

/** Parse an entity's "flights:abc123" tracking id. */
export function parseTrackedId(value) {
  const [layerId, ...rest] = String(value ?? '').split(':');
  const id = rest.join(':').trim();
  return AIRCRAFT_LAYERS.includes(layerId) && id ? { layerId, id } : null;
}

/**
 * Which aircraft a `scene.pick()` result names, or null.
 * @param {object|null} picked
 * @param {(layerId:string, id:string) => boolean} has  layer membership test
 */
export function aircraftFromPick(picked, has) {
  if (!picked) return null;
  const fromEntity = parseTrackedId(picked.id?.gevTrackedId);
  if (fromEntity) return fromEntity;
  const candidates = [picked.id, picked.primitive?.id].filter(
    (v) => typeof v === 'string' && v,
  );
  for (const id of candidates)
    for (const layerId of AIRCRAFT_LAYERS)
      if (has(layerId, id)) return { layerId, id };
  return null;
}

const FT = 3.28084;
const KT = 1.943844;
const num = (v) => (Number.isFinite(v) ? v : null);

/** Display label for an aircraft: callsign, then tail, then hex. */
export const aircraftLabel = (info, fallback = '') =>
  info?.callsign || info?.registration || info?.icao24 || fallback;

function routeText(info) {
  const r = info?.route;
  if (r?.origin?.code || r?.destination?.code) {
    const end = (a) =>
      [a?.code, a?.name].filter(Boolean).join(' ') || 'unknown';
    return `${end(r.origin)} → ${end(r.destination)}`;
  }
  if (info?.origin || info?.destination)
    return `${info.origin || '?'} → ${info.destination || '?'}`;
  return null;
}

/** Live flight rows: [label, value] pairs, unknowns left out. */
export function flightRows(info, layerId) {
  if (!info) return [];
  const rows = [];
  const add = (k, v) => v != null && v !== '' && rows.push([k, String(v)]);
  add('Callsign', info.callsign);
  add('ICAO hex', info.icao24?.toUpperCase());
  add('Registration', info.registration);
  add('Airline / operator', info.airline || info.operator);
  add('Route', routeText(info));
  const alt = num(info.altitudeM);
  if (info.onGround) add('Altitude', 'On the ground');
  else if (alt != null)
    add(
      'Altitude',
      `${Math.round(alt * FT).toLocaleString('en-US')} ft (${Math.round(alt).toLocaleString('en-US')} m)`,
    );
  const speed = num(info.velocityMps);
  if (speed != null) add('Ground speed', `${Math.round(speed * KT)} kt`);
  const track = num(info.track);
  if (track != null)
    add(
      'Heading',
      `${String(((Math.round(track) % 360) + 360) % 360).padStart(3, '0')}°`,
    );
  if (num(info.latitude) != null && num(info.longitude) != null)
    add(
      'Position',
      `${info.latitude.toFixed(4)}, ${info.longitude.toFixed(4)}`,
    );
  if (info.stale) add('Status', 'Signal stale (last known position)');
  add('Source', LAYER_LABEL[layerId]);
  return rows;
}

/** Airframe rows from the live record plus the adsbdb lookup. */
export function airframeRows(info, adsbdb) {
  const rows = [];
  const add = (k, v) => v != null && v !== '' && rows.push([k, String(v)]);
  add('Type', adsbdb?.typeName || info?.typeName);
  add('ICAO type code', adsbdb?.typeCode || info?.typeCode);
  if (!info?.registration) add('Registration', adsbdb?.registration);
  add('Registered owner', adsbdb?.owner);
  add('Owner country', adsbdb?.ownerCountry);
  return rows;
}

const FACT_LABELS = Object.freeze([
  ['firstFlight', 'First flight'],
  ['introduced', 'Entered service'],
  ['retired', 'Retired'],
  ['numberBuilt', 'Number built'],
]);

/** Model facts (from Wikidata) as rows. */
export function modelFactRows(facts) {
  return FACT_LABELS.filter(([key]) => facts?.[key] != null).map(
    ([key, label]) => [
      label,
      typeof facts[key] === 'number'
        ? facts[key].toLocaleString('en-US')
        : String(facts[key]),
    ],
  );
}

/** The type the panel should look up, preferring the airframe lookup. */
export function resolveModel(info, adsbdb) {
  return lookupAircraftType(
    adsbdb?.typeCode || info?.typeCode || null,
    adsbdb?.typeName || info?.typeName || null,
  );
}

/** Query string for /api/aircraft/trivia, or null when there is nothing to ask. */
export function triviaQuery(model, registration) {
  const params = new URLSearchParams();
  if (model?.article) params.set('article', model.article);
  else if (model?.name) params.set('name', model.name);
  const reg = String(registration ?? '').trim();
  if (reg) params.set('reg', reg);
  const text = params.toString();
  return text ? text : null;
}

/** Outside lookups a journalist would check next. */
export function sourceLinks(info) {
  const links = [];
  const hex = String(info?.icao24 ?? '').toLowerCase();
  const reg = String(info?.registration ?? '').trim();
  const cs = String(info?.callsign ?? '').trim();
  if (/^[0-9a-f]{6}$/.test(hex))
    links.push({
      label: 'ADS-B Exchange track',
      href: `https://globe.adsbexchange.com/?icao=${hex}`,
    });
  if (cs)
    links.push({
      label: `FlightAware: ${cs}`,
      href: `https://www.flightaware.com/live/flight/${encodeURIComponent(cs)}`,
    });
  if (reg) {
    links.push({
      label: `Planespotters airframe history: ${reg}`,
      href: `https://www.planespotters.net/search?q=${encodeURIComponent(reg)}`,
    });
    if (/^N[0-9][0-9A-Z]{0,4}$/i.test(reg))
      links.push({
        label: `FAA registry: ${reg.toUpperCase()}`,
        href: `https://registry.faa.gov/AircraftInquiry/Search/NNumberResult?nNumberTxt=${encodeURIComponent(reg.toUpperCase())}`,
      });
  }
  return links;
}
