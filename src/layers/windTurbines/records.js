/**
 * Pure helpers for the wind turbine layer (U.S. Wind Turbine Database via the
 * app server's /api/wind-turbines proxy).
 */

/** Above this camera height the layer still loads, as a thinned overview. */
export const TURBINE_DETAIL_HEIGHT_M = 25_000;
/** Towers are drawn only when this few turbines are in view. */
/** Close in, the nearest turbines (at most this many) get 3D models. */
export const TURBINE_MODEL_MAX = 400;
export const TURBINE_MODEL_RANGE_KM = 15;
export const SITE_OUTLINE_COLOR = '#7FDBFF';
export const TURBINE_VIEW_LIMIT = 3000;
const SNAP_DEG = 0.05;

/** Snap a view rectangle outward to a coarse grid so small pans reuse a load. */
export function snapBbox({ west, south, east, north }, step = SNAP_DEG) {
  if (
    ![west, south, east, north].every(Number.isFinite) ||
    east <= west ||
    north <= south
  )
    return null;
  const down = (v) => Math.floor(v / step) * step;
  const up = (v) => Math.ceil(v / step) * step;
  const r = (v) => Math.round(v * 1e4) / 1e4;
  return {
    west: r(Math.max(-180, down(west))),
    south: r(Math.max(-90, down(south))),
    east: r(Math.min(180, up(east))),
    north: r(Math.min(90, up(north))),
  };
}

export const bboxParam = (b) => [b.west, b.south, b.east, b.north].join(',');

/** Height class used for color: blade-tip height in metres. */
export function tipClass(tipM) {
  if (!Number.isFinite(tipM)) return 'unknown';
  if (tipM >= 200) return 'xl';
  if (tipM >= 150) return 'tall';
  if (tipM >= 100) return 'mid';
  return 'low';
}

export const TIP_COLORS = Object.freeze({
  xl: '#FF6B6B',
  tall: '#FFD166',
  mid: '#7FDBFF',
  low: '#C8E6F5',
  unknown: '#B0B0B0',
});

/** Dot size in pixels from nameplate capacity (kW). */
export function dotSize(kw) {
  if (!Number.isFinite(kw) || kw <= 0) return 5;
  return Math.min(11, Math.max(4, 3 + Math.sqrt(kw / 1000) * 3));
}

const fmt = (v, unit) => (Number.isFinite(v) ? `${v} ${unit}` : '?');

/** One-line description of a turbine for consoles and agent output. */
export function describeTurbine(t) {
  const name = [t.manufacturer, t.model].filter(Boolean).join(' ') || 'Turbine';
  const where = [t.project, t.county, t.state].filter(Boolean).join(', ');
  return `${name} · ${fmt(t.kw, 'kW')} · hub ${fmt(t.hubM, 'm')} · rotor ${fmt(t.rotorM, 'm')} · tip ${fmt(t.tipM, 'm')}${t.year ? ` · ${t.year}` : ''}${where ? ` · ${where}` : ''} (${t.lat.toFixed(5)}, ${t.lon.toFixed(5)})`;
}

/** Summary line for a /api/wind-turbines response. */
export function describeSummary(response) {
  const s = response?.summary;
  if (!s) return 'No wind turbine data loaded';
  if (!s.turbines) return 'No USWTDB turbines in view (US only)';
  const top = s.topProjects?.[0];
  return `${s.turbines.toLocaleString('en-US')} turbines in view · ${s.mw.toLocaleString('en-US')} MW · ${s.projects} projects${top ? ` · largest: ${top.name} (${top.count})` : ''}${s.tallest ? ` · tallest tip ${s.tallest.tipM} m (${s.tallest.project ?? 'unnamed'})` : ''}${response.sampled ? ` · showing ${response.turbines.length.toLocaleString('en-US')}` : ''}`;
}

/** Nearest turbine to a lon/lat (equirectangular distance is fine at this scale). */
export function nearestTurbine(turbines, lon, lat) {
  let best = null;
  let bestD = Infinity;
  const k = Math.cos((lat * Math.PI) / 180);
  for (const t of turbines ?? []) {
    const d = ((t.lon - lon) * k) ** 2 + (t.lat - lat) ** 2;
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best ? { turbine: best, km: Math.sqrt(bestD) * 111.32 } : null;
}

const val = (v, unit) =>
  Number.isFinite(v) ? `${v.toLocaleString('en-US')} ${unit}` : 'unknown';

/** Pop-up card for one turbine: title + detail lines. */
export function turbineCard(t, { estimatedHub = false } = {}) {
  const make = [t.manufacturer, t.model].filter(Boolean).join(' ');
  const place = [t.county, t.state].filter(Boolean).join(', ');
  return {
    title: `WIND TURBINE · ${make || 'make/model not recorded'}`,
    details: [
      `Capacity ${val(t.kw, 'kW')}${t.offshore ? ' · offshore' : ''}`,
      `Hub height ${val(t.hubM, 'm')}${estimatedHub ? ' (model height estimated)' : ''}`,
      `Rotor ${val(t.rotorM, 'm')} · blade tip ${val(t.tipM, 'm')}`,
      `${t.project || 'Unnamed project'}${t.year ? ` · online ${t.year}` : ''}`,
      ...(place ? [place] : []),
      `${t.lat.toFixed(5)}, ${t.lon.toFixed(5)}`,
      `USWTDB ${t.id}${t.faaOrs ? ` · FAA ORS ${t.faaOrs}` : ''}`,
    ],
  };
}

/** Pop-up card for one wind farm site outline. */
export function siteCard(s) {
  const place = [s.county, s.state].filter(Boolean).join(', ');
  const years = s.years
    ? s.years[0] === s.years[1]
      ? `${s.years[0]}`
      : `${s.years[0]}–${s.years[1]}`
    : null;
  return {
    title: `WIND FARM · ${s.name}`,
    details: [
      `${s.turbines.toLocaleString('en-US')} turbines · ${val(s.mw, 'MW')}${years ? ` · online ${years}` : ''}`,
      ...s.models.map((m) => `${m.name} × ${m.count}`),
      ...(place ? [place] : []),
      'Outline drawn around the turbines (approximate)',
    ],
  };
}

/**
 * Ids of the turbines that get 3D models: the nearest `max` within
 * `rangeKm` of the camera's ground point. The rest stay dots.
 */
export function pickModelIds(
  turbines,
  lon,
  lat,
  { max = TURBINE_MODEL_MAX, rangeKm = TURBINE_MODEL_RANGE_KM } = {},
) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return new Set();
  const k = Math.cos((lat * Math.PI) / 180);
  const r2 = (rangeKm / 111.32) ** 2;
  const near = [];
  for (const t of turbines ?? []) {
    const d = ((t.lon - lon) * k) ** 2 + (t.lat - lat) ** 2;
    if (d <= r2) near.push([d, t.id]);
  }
  near.sort((a, b) => a[0] - b[0]);
  return new Set(near.slice(0, max).map(([, id]) => id));
}
