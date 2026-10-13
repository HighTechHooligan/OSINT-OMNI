/**
 * FAA airspace records: TFRs, Class B/C/D/E, Special Use Airspace and the
 * UAS Facility Map (LAANC grid). Pure — no Cesium, no fetch — so the server
 * proxy and the browser layer share one normalizer and it is unit-testable.
 *
 * Field names are read case-insensitively from a list of known aliases: the
 * FAA's ArcGIS services have renamed fields between releases, and one bad
 * feature must never blank the layer (skip it, keep the rest).
 */

export const AIRSPACE_KINDS = Object.freeze(['tfr', 'class', 'sua', 'laanc']);

/** Grid the client snaps view boxes to, so the server can cache by tile. */
export const AIRSPACE_QUANTUM_DEG = 0.25;

/** Widest box (degrees, either axis) each viewport kind will fetch. TFRs are national. */
export const AIRSPACE_MAX_SPAN_DEG = Object.freeze({
  class: 6,
  sua: 10,
  laanc: 1,
});

const FT_TO_M = 0.3048;

// ---------- small field helpers ----------

/** Case-insensitive property read across aliases; first non-empty wins. */
export function prop(properties, ...keys) {
  if (!properties || typeof properties !== 'object') return null;
  for (const key of keys) {
    if (Object.hasOwn(properties, key)) {
      const v = properties[key];
      if (v !== null && v !== undefined && v !== '') return v;
    }
  }
  const lower = new Map(
    Object.keys(properties).map((k) => [k.toLowerCase(), k]),
  );
  for (const key of keys) {
    const actual = lower.get(String(key).toLowerCase());
    if (actual === undefined) continue;
    const v = properties[actual];
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return null;
}

const text = (v) =>
  typeof v === 'string'
    ? v.trim() || null
    : Number.isFinite(v)
      ? String(v)
      : null;
const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

// ---------- geometry ----------

function validRing(ring) {
  if (!Array.isArray(ring) || ring.length < 4) return false;
  for (const p of ring) {
    if (!Array.isArray(p) || p.length < 2) return false;
    if (!Number.isFinite(p[0]) || Math.abs(p[0]) > 180) return false;
    if (!Number.isFinite(p[1]) || Math.abs(p[1]) > 90) return false;
  }
  return true;
}

/** Polygon/MultiPolygon → array of polygons (arrays of 2D rings), or null. */
export function normalizePolygons(geometry) {
  if (!geometry || typeof geometry !== 'object') return null;
  let polygons;
  if (geometry.type === 'Polygon') polygons = [geometry.coordinates];
  else if (geometry.type === 'MultiPolygon') polygons = geometry.coordinates;
  else return null;
  if (!Array.isArray(polygons)) return null;
  const out = [];
  for (const rings of polygons) {
    if (!Array.isArray(rings) || !rings.length) continue;
    if (!rings.every(validRing)) return null;
    out.push(rings.map((ring) => ring.map(([lon, lat]) => [lon, lat])));
  }
  return out.length ? out : null;
}

function ringContains(ring, lon, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
}

/** Even-odd point-in-polygon over normalized polygons (holes excluded). */
export function polygonsContain(polygons, lon, lat) {
  for (const [outer, ...holes] of polygons || []) {
    if (!ringContains(outer, lon, lat)) continue;
    if (holes.some((hole) => ringContains(hole, lon, lat))) continue;
    return true;
  }
  return false;
}

/** Degree bounding box of normalized polygons. */
export function polygonsBbox(polygons) {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [outer] of polygons) {
    for (const [lon, lat] of outer) {
      if (lon < west) west = lon;
      if (lon > east) east = lon;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
  }
  return { west, south, east, north };
}

/** Vertex-mean anchor of the largest outer ring (card placement). */
export function polygonsAnchor(polygons) {
  let best = polygons[0][0];
  let bestArea = -1;
  for (const [outer] of polygons) {
    let a = 0;
    for (let i = 0; i < outer.length - 1; i++)
      a += outer[i][0] * outer[i + 1][1] - outer[i + 1][0] * outer[i][1];
    if (Math.abs(a) > bestArea) {
      bestArea = Math.abs(a);
      best = outer;
    }
  }
  let lon = 0;
  let lat = 0;
  const n = best.length - 1;
  for (let i = 0; i < n; i++) {
    lon += best[i][0];
    lat += best[i][1];
  }
  return { lon: lon / n, lat: lat / n };
}

// ---------- bbox quantization ----------

/**
 * Snap a view rectangle outward to the quantum grid. Returns null for an
 * invalid or antimeridian-crossing box.
 */
export function quantizeBbox(rect, quantum = AIRSPACE_QUANTUM_DEG) {
  if (!rect) return null;
  const { west, south, east, north } = rect;
  if (![west, south, east, north].every(Number.isFinite)) return null;
  if (west >= east || south >= north) return null;
  const snap = (v, f) => Math.round(f(v / quantum) * quantum * 1e6) / 1e6;
  return {
    west: Math.max(-180, snap(west, Math.floor)),
    south: Math.max(-90, snap(south, Math.floor)),
    east: Math.min(180, snap(east, Math.ceil)),
    north: Math.min(90, snap(north, Math.ceil)),
  };
}

export const bboxSpan = (b) => Math.max(b.east - b.west, b.north - b.south);
export const bboxKey = (b) => `${b.west},${b.south},${b.east},${b.north}`;

/** Parse "w,s,e,n" from a query string; null when malformed. */
export function parseBboxParam(value) {
  const parts = String(value ?? '').split(',');
  if (parts.length !== 4) return null;
  const [west, south, east, north] = parts.map(Number);
  if (![west, south, east, north].every(Number.isFinite)) return null;
  if (Math.abs(west) > 180 || Math.abs(east) > 180) return null;
  if (Math.abs(south) > 90 || Math.abs(north) > 90) return null;
  return quantizeBbox({ west, south, east, north });
}

/** The quantum tile that holds one point (used by "check here"). */
export function tileAround(lon, lat, quantum = AIRSPACE_QUANTUM_DEG) {
  const eps = quantum / 1000;
  return quantizeBbox({
    west: lon - eps,
    south: lat - eps,
    east: lon + eps,
    north: lat + eps,
  });
}

// ---------- vertical limits ----------

/**
 * One vertical limit from the FAA's value/unit/reference triple.
 * Sentinel or missing values give `known: false` ("see chart"), never a guess.
 * @returns {{known: boolean, ft: ?number, ref: ?('MSL'|'AGL'), label: string}}
 */
export function verticalLimit(value, uom, code) {
  const v = num(value);
  const unit = String(uom ?? '').toUpperCase();
  const ref = String(code ?? '').toUpperCase();
  if (ref === 'SFC' || ref === 'GND' || (v === 0 && ref !== 'MSL'))
    return { known: true, ft: 0, ref: 'AGL', label: 'SFC' };
  if (v === null || v < 0)
    return { known: false, ft: null, ref: null, label: 'see chart' };
  if (unit === 'FL')
    return { known: true, ft: v * 100, ref: 'MSL', label: `FL${v}` };
  const feet = unit === 'M' ? Math.round(v / FT_TO_M) : v;
  const r = ref === 'AGL' || ref === 'SFC' ? 'AGL' : 'MSL';
  return {
    known: true,
    ft: feet,
    ref: r,
    label: `${feet.toLocaleString('en-US')} ${r}`,
  };
}

function limitsFrom(p, side) {
  const S = side.toUpperCase();
  return verticalLimit(
    prop(p, `${S}_VAL`, `${S}_VALUE`, `${side}_val`),
    prop(p, `${S}_UOM`, `${S}_UNIT`),
    prop(p, `${S}_CODE`, `${S}_REF`, `${S}_DESC`),
  );
}

export const isSurface = (limit) => limit?.known && limit.ft === 0;

// ---------- normalizers ----------

function stableId(p, feature, ...keys) {
  const raw = prop(p, ...keys) ?? feature?.id;
  return raw === null || raw === undefined || raw === '' ? null : String(raw);
}

function collect(features, build) {
  if (!Array.isArray(features)) return null;
  const rows = [];
  const ids = new Set();
  for (const feature of features) {
    const p = feature?.properties;
    if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
    const polygons = normalizePolygons(feature.geometry);
    if (!polygons) continue;
    let row;
    try {
      row = build(p, feature, polygons);
    } catch {
      row = null;
    }
    if (!row?.id || ids.has(row.id)) continue;
    ids.add(row.id);
    rows.push(row);
  }
  return rows;
}

/** Class B/C/D/E (and Mode C veil) from the FAA Class_Airspace service. */
export function normalizeClassAirspace(geojson) {
  return collect(geojson?.features, (p, feature, polygons) => {
    const localType = text(prop(p, 'LOCAL_TYPE', 'TYPE_CODE'))?.toUpperCase();
    let cls = text(prop(p, 'CLASS', 'AIRSPACE_CLASS'))?.toUpperCase() ?? null;
    if (!cls && localType) {
      const m = localType.match(/CLASS[_\s]?([A-G])/);
      if (m) cls = m[1];
      else if (/MODE\s*C/.test(localType)) cls = 'MODE C';
    }
    if (!cls) return null;
    const id = stableId(p, feature, 'GLOBAL_ID', 'GLOBALID', 'OBJECTID');
    return {
      id: id && `class:${id}`,
      kind: 'class',
      cls,
      type: localType,
      name: text(prop(p, 'NAME')),
      ident: text(prop(p, 'IDENT', 'ICAO_ID')),
      lower: limitsFrom(p, 'lower'),
      upper: limitsFrom(p, 'upper'),
      polygons,
    };
  });
}

const SUA_NAME_TYPES = [
  [/^P-/i, 'P'],
  [/^R-/i, 'R'],
  [/^W-/i, 'W'],
  [/^A-/i, 'A'],
  [/\bMOA\b/i, 'MOA'],
  [/\bNSA\b/i, 'NSA'],
];

/** Special Use Airspace (P, R, W, A, MOA, NSA) from the FAA SUA service. */
export function normalizeSpecialUse(geojson) {
  return collect(geojson?.features, (p, feature, polygons) => {
    const name = text(prop(p, 'NAME'));
    let suaType = text(
      prop(p, 'TYPE_CODE', 'SUA_TYPE', 'LOCAL_TYPE', 'TYPE'),
    )?.toUpperCase();
    if (!suaType || suaType.length > 6) {
      suaType = SUA_NAME_TYPES.find(([re]) => re.test(name ?? ''))?.[1] ?? null;
    }
    const id = stableId(p, feature, 'GLOBAL_ID', 'GLOBALID', 'OBJECTID');
    return {
      id: id && `sua:${id}`,
      kind: 'sua',
      suaType: suaType ?? 'SUA',
      name,
      times: text(prop(p, 'TIMESOFUSE', 'TIMES_OF_USE', 'WKHR_RMK')),
      agency: text(prop(p, 'CONT_AGENT', 'CONTROLLING_AGENCY', 'CONT_AGENCY')),
      lower: limitsFrom(p, 'lower'),
      upper: limitsFrom(p, 'upper'),
      polygons,
    };
  });
}

/** UAS Facility Map grid cells: max LAANC-authorizable ceiling (ft AGL). */
export function normalizeFacilityMap(geojson) {
  return collect(geojson?.features, (p, feature, polygons) => {
    const ceilingFt = num(prop(p, 'CEILING', 'CEILING_FT', 'MAX_ALT'));
    if (ceilingFt === null || ceilingFt < 0) return null;
    const id = stableId(p, feature, 'GLOBALID', 'GLOBAL_ID', 'OBJECTID');
    return {
      id: id && `laanc:${id}`,
      kind: 'laanc',
      ceilingFt,
      airport: text(prop(p, 'APT1_FAAID', 'APT1_ICAO', 'AIRPORT')),
      airportName: text(prop(p, 'APT1_NAME', 'AIRPORT_NAME')),
      polygons,
    };
  });
}

/** "6/4045-1-FDC-F" or "6/4045" → "6/4045". */
export function tfrNotamId(value) {
  const m = String(value ?? '').match(/(\d{1,2})\s*\/\s*(\d{1,5})/);
  return m ? `${m[1]}/${m[2]}` : null;
}

export const tfrDetailUrl = (notamId) =>
  `https://tfr.faa.gov/tfr3/?page=detail_${notamId.replace('/', '_')}`;

/**
 * TFR shapes (FAA TFR WFS) merged with the TFR list (descriptions). The list
 * is optional: shapes still draw if it fails. Altitudes are NOT in either
 * feed, so TFRs are never drawn as volumes — read the NOTAM.
 */
export function normalizeTfrs(geojson, list = []) {
  const byId = new Map();
  for (const item of Array.isArray(list) ? list : []) {
    const id = tfrNotamId(prop(item, 'notam_id', 'NOTAM_ID', 'notamId'));
    if (id) byId.set(id, item);
  }
  const rows = [];
  const merged = new Map();
  for (const feature of Array.isArray(geojson?.features)
    ? geojson.features
    : []) {
    const p = feature?.properties;
    if (!p || typeof p !== 'object') continue;
    const polygons = normalizePolygons(feature.geometry);
    if (!polygons) continue;
    const notamId = tfrNotamId(prop(p, 'NOTAM_KEY', 'NOTAM_ID', 'notam_id'));
    if (!notamId) continue;
    // One TFR can arrive as several area features; fold them together.
    const existing = merged.get(notamId);
    if (existing) {
      existing.polygons.push(...polygons);
      continue;
    }
    const item = byId.get(notamId);
    const row = {
      id: `tfr:${notamId}`,
      kind: 'tfr',
      notamId,
      name: text(prop(p, 'TITLE', 'NAME')) ?? text(prop(item, 'description')),
      type:
        text(prop(p, 'LEGAL', 'TYPE'))?.toUpperCase() ??
        text(prop(item, 'type'))?.toUpperCase() ??
        null,
      facility:
        text(prop(p, 'CNS_LOCATION_ID', 'FACILITY')) ??
        text(prop(item, 'facility')),
      state: text(prop(p, 'STATE')) ?? text(prop(item, 'state')),
      description: text(prop(item, 'description')),
      modified: text(
        prop(p, 'LAST_MODIFICATION_DATETIME', 'MOD_DATE') ??
          prop(item, 'mod_abs_time', 'creation_date'),
      ),
      url: tfrDetailUrl(notamId),
      polygons,
    };
    merged.set(notamId, row);
    rows.push(row);
  }
  return rows;
}

export const NORMALIZERS = Object.freeze({
  class: normalizeClassAirspace,
  sua: normalizeSpecialUse,
  laanc: normalizeFacilityMap,
});

// ---------- presentation (pure) ----------

const CLASS_COLORS = {
  B: '#3b82f6',
  C: '#d946ef',
  D: '#60a5fa',
  E: '#c084fc',
  'MODE C': '#94a3b8',
};
const SUA_COLORS = {
  P: '#dc2626',
  R: '#ef4444',
  W: '#fb923c',
  A: '#eab308',
  MOA: '#f59e0b',
  NSA: '#f97316',
};
export const TFR_COLOR = '#ff3b30';

/** LAANC grid color by ceiling: 0 ft red → 400 ft green. */
export function laancColor(ceilingFt) {
  if (ceilingFt <= 0) return '#ef4444';
  if (ceilingFt <= 100) return '#f97316';
  if (ceilingFt <= 200) return '#eab308';
  if (ceilingFt < 400) return '#a3e635';
  return '#22c55e';
}

/** CSS color for any normalized row. */
export function airspaceColor(row) {
  if (row.kind === 'tfr') return TFR_COLOR;
  if (row.kind === 'laanc') return laancColor(row.ceilingFt);
  if (row.kind === 'sua') return SUA_COLORS[row.suaType] ?? '#f59e0b';
  return CLASS_COLORS[row.cls] ?? '#c084fc';
}

/** Class E5/E6 (700/1200 ft floors) cover most of the map: outline only. */
export const isBackgroundClassE = (row) =>
  row.kind === 'class' && row.cls === 'E' && !isSurface(row.lower);

const SUA_LABELS = {
  P: 'Prohibited',
  R: 'Restricted',
  W: 'Warning',
  A: 'Alert',
  MOA: 'MOA',
  NSA: 'National Security Area',
};

/** One-line description of a row for cards and the console. */
export function describeRow(row) {
  const band = (r) =>
    r.lower && r.upper ? `${r.lower.label} – ${r.upper.label}` : '';
  switch (row.kind) {
    case 'tfr':
      return `TFR ${row.notamId}${row.type ? ` · ${row.type}` : ''}${row.name ? ` · ${row.name}` : ''} · altitudes: see NOTAM`;
    case 'laanc':
      return `LAANC grid · max ${row.ceilingFt} ft AGL${row.airport ? ` (${row.airport})` : ''}`;
    case 'sua':
      return `${SUA_LABELS[row.suaType] ?? row.suaType}${row.name ? ` ${row.name}` : ''} · ${band(row)}${row.times ? ` · ${row.times}` : ''}`;
    default: {
      const label = row.cls === 'MODE C' ? 'Mode C veil' : `Class ${row.cls}`;
      const sub = row.type?.match(/CLASS_E(\d)/)?.[1];
      return `${label}${sub ? ` (E${sub})` : ''}${row.name ? ` · ${row.name}` : ''} · ${band(row)}`;
    }
  }
}

const SORT = { tfr: 0, sua: 1, class: 2, laanc: 3 };
const CLASS_SORT = { B: 0, C: 1, D: 2, E: 3, 'MODE C': 4 };
const SUA_SORT = { P: 0, R: 1, NSA: 2, W: 3, A: 4, MOA: 5 };

/**
 * Everything over one point, most restrictive first, plus a Part 107
 * advisory. The advisory is a lead, not a clearance: it says so.
 */
export function airspaceAt(rows, lon, lat) {
  const hits = rows
    .filter((row) => polygonsContain(row.polygons, lon, lat))
    .sort(
      (a, b) =>
        SORT[a.kind] - SORT[b.kind] ||
        (CLASS_SORT[a.cls] ?? 9) - (CLASS_SORT[b.cls] ?? 9) ||
        (SUA_SORT[a.suaType] ?? 9) - (SUA_SORT[b.suaType] ?? 9) ||
        (a.lower?.ft ?? 0) - (b.lower?.ft ?? 0),
    );
  const notes = [];
  const tfrs = hits.filter((r) => r.kind === 'tfr');
  const prohibited = hits.some((r) => r.kind === 'sua' && r.suaType === 'P');
  const restricted = hits.some((r) => r.kind === 'sua' && r.suaType === 'R');
  const surfaceClass = hits.find(
    (r) =>
      r.kind === 'class' &&
      ['B', 'C', 'D', 'E'].includes(r.cls) &&
      isSurface(r.lower),
  );
  const grid = hits
    .filter((r) => r.kind === 'laanc')
    .reduce((min, r) => (min && min.ceilingFt <= r.ceilingFt ? min : r), null);
  if (tfrs.length)
    notes.push(
      `TFR over this point (${tfrs.map((r) => r.notamId).join(', ')}) — read the NOTAM for times and altitudes before flying.`,
    );
  if (prohibited) notes.push('Prohibited area — no flight.');
  if (restricted)
    notes.push('Restricted area — check status with the controlling agency.');
  let level = tfrs.length || prohibited || restricted ? 'stop' : 'ok';
  if (surfaceClass) {
    if (level === 'ok') level = 'auth';
    notes.push(
      `Class ${surfaceClass.cls} at the surface — Part 107 needs LAANC or DroneZone authorization${
        grid ? `; LAANC grid max ${grid.ceilingFt} ft AGL` : ''
      }.`,
    );
  } else if (grid) {
    notes.push(`LAANC grid here: max ${grid.ceilingFt} ft AGL.`);
  } else {
    notes.push('Class G at the surface — Part 107 up to 400 ft AGL.');
  }
  notes.push(
    'Advisory from FAA open data, not a clearance — confirm in B4UFLY / your LAANC app.',
  );
  return { hits, notes, level, grid, surfaceClass: surfaceClass ?? null };
}

/** Feet → meters, for Cesium heights. */
export const ftToM = (ft) => ft * FT_TO_M;
