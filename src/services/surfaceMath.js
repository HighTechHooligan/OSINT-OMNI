/**
 * Pure helpers for drone-inspection pricing (no Cesium, no DOM): a
 * building's roof and wall (facade) surface areas from its footprint,
 * height and OSM roof tags, and a price from per-area rates.
 *
 * Model: the roof is the footprint tilted by its pitch (flat = footprint);
 * walls are the perimeter times the eave height (total height less the roof
 * rise and any min_height), plus the two gable triangles on a gabled roof.
 * Whatever OSM does not say is assumed and flagged, so a quote can say so.
 */

import { SQFT_PER_M2, parseOsmLength } from './buildingMath.js';

/** Typical pitch when OSM names a pitched shape but no roof:angle (6:12). */
export const DEFAULT_PITCH_DEG = 26.6;

/**
 * Per roof:shape: pitch in degrees (planar roofs), or a fixed area factor
 * (curved roofs), and how the rise spans the footprint ('half' = ridge in
 * the middle, 'full' = one slope across).
 */
const ROOF_SHAPES = Object.freeze({
  flat: { pitchDeg: 0 },
  skillion: { pitchDeg: 10, span: 'full' },
  gabled: { pitchDeg: DEFAULT_PITCH_DEG, span: 'half', gables: true },
  hipped: { pitchDeg: DEFAULT_PITCH_DEG, span: 'half' },
  half_hipped: { pitchDeg: DEFAULT_PITCH_DEG, span: 'half', gables: true },
  side_hipped: { pitchDeg: DEFAULT_PITCH_DEG, span: 'half' },
  pyramidal: { pitchDeg: DEFAULT_PITCH_DEG, span: 'half' },
  gambrel: { pitchDeg: 40, span: 'half', gables: true },
  mansard: { pitchDeg: 45, span: 'half' },
  saltbox: { pitchDeg: DEFAULT_PITCH_DEG, span: 'half', gables: true },
  dome: { factor: 2, riseOfWidth: 0.5 },
  onion: { factor: 2.2, riseOfWidth: 0.7 },
  round: { factor: Math.PI / 2, riseOfWidth: 0.5 },
});

export const RATE_UNITS = Object.freeze(['ft2', 'm2']);
export const DEFAULT_RATES = Object.freeze({
  unit: 'ft2',
  roof: 0.15,
  wall: 0.15,
  minimum: 0,
  currency: 'USD',
});

const roofKey = (shape) =>
  String(shape || '')
    .trim()
    .toLowerCase()
    .replace(/[-\s]/g, '_');

/**
 * Roof and wall surface areas for a building record from siteBuildings
 * (`measure`, `height`, `tags`).
 * @returns {{ roofM2:number, wallM2:number, totalM2:number,
 *   footprintM2:number, roofShape:string, pitchDeg:number|null,
 *   eaveM:number, roofRiseM:number, assumed:string[] }}
 */
export function buildingSurfaces(record) {
  const tags = record?.tags ?? {};
  const m = record?.measure ?? {};
  const footprintM2 = Math.max(0, Number(m.areaM2) || 0);
  const perimeterM = Math.max(0, Number(m.perimeterM) || 0);
  const widthM = Math.max(0, Number(m.widthM) || 0);
  const heightM = Math.max(0, Number(record?.height?.heightM) || 0);
  const minM = parseOsmLength(tags.min_height) ?? 0;
  const assumed = [];
  if (!record?.height || record.height.source === 'default')
    assumed.push('height');

  const tagged = roofKey(tags['roof:shape']);
  const shapeKey = tagged in ROOF_SHAPES ? tagged : 'flat';
  if (!tagged) assumed.push('roof shape');
  else if (!(tagged in ROOF_SHAPES)) assumed.push(`roof shape (${tagged})`);
  const shape = ROOF_SHAPES[shapeKey];

  const angle = Number.parseFloat(tags['roof:angle']);
  let pitchDeg = null;
  let roofM2;
  let riseM;
  if (shape.factor) {
    roofM2 = footprintM2 * shape.factor;
    riseM = widthM * shape.riseOfWidth;
  } else {
    pitchDeg =
      Number.isFinite(angle) && angle >= 0 && angle < 80
        ? angle
        : shape.pitchDeg;
    if (pitchDeg && !(Number.isFinite(angle) && angle >= 0 && angle < 80))
      assumed.push('roof pitch');
    const rad = (pitchDeg * Math.PI) / 180;
    roofM2 = footprintM2 / Math.cos(rad);
    const run = shape.span === 'full' ? widthM : widthM / 2;
    riseM = Math.tan(rad) * run;
  }
  const taggedRise = parseOsmLength(tags['roof:height']);
  if (taggedRise != null && shapeKey !== 'flat') riseM = taggedRise;

  // Walls stop at the eaves. Keep at least 40% of the height as wall so a
  // wide building with a guessed pitch cannot lose its facade entirely.
  const standing = Math.max(0, heightM - minM);
  riseM = Math.min(riseM, standing * 0.6);
  const eaveM = Math.max(0, standing - riseM);
  let wallM2 = perimeterM * eaveM;
  if (shape.gables) wallM2 += widthM * riseM; // two triangles: 2 × ½·w·rise

  return {
    roofM2,
    wallM2,
    totalM2: roofM2 + wallM2,
    footprintM2,
    roofShape: shapeKey,
    pitchDeg,
    eaveM,
    roofRiseM: riseM,
    assumed,
  };
}

/** Area in the rate's unit (ft² or m²). */
export const inUnit = (m2, unit) => (unit === 'm2' ? m2 : m2 * SQFT_PER_M2);

/** Clean up user-entered rates; anything invalid keeps the default. */
export function normalizeRates(rates = {}, base = DEFAULT_RATES) {
  const num = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    unit: RATE_UNITS.includes(rates.unit) ? rates.unit : base.unit,
    roof: num(rates.roof, base.roof),
    wall: num(rates.wall, base.wall),
    minimum: num(rates.minimum, base.minimum),
    currency:
      typeof rates.currency === 'string' && /^[A-Z]{3}$/.test(rates.currency)
        ? rates.currency
        : base.currency,
  };
}

/**
 * Price one building's surfaces at the given rates. The minimum is a
 * per-building floor (a call-out fee), applied after roof + walls.
 */
export function priceSurfaces(surfaces, rates) {
  const r = normalizeRates(rates);
  const roof = inUnit(surfaces.roofM2, r.unit) * r.roof;
  const wall = inUnit(surfaces.wallM2, r.unit) * r.wall;
  const subtotal = roof + wall;
  return {
    roof,
    wall,
    subtotal,
    price: Math.max(subtotal, r.minimum),
    minimumApplied: r.minimum > subtotal,
  };
}

/**
 * Surfaces and prices for a selection of building records, plus totals.
 * Non-building records (roads, parks) are skipped.
 */
export function quoteBuildings(records = [], rates = DEFAULT_RATES) {
  const r = normalizeRates(rates);
  const rows = records
    .filter((rec) => rec?.kind === 'building')
    .map((rec) => {
      const surfaces = buildingSurfaces(rec);
      return {
        id: rec.id,
        record: rec,
        surfaces,
        price: priceSurfaces(surfaces, r),
      };
    });
  const sum = (fn) => rows.reduce((s, row) => s + fn(row), 0);
  return {
    rates: r,
    rows,
    totals: {
      count: rows.length,
      footprintM2: sum((x) => x.surfaces.footprintM2),
      roofM2: sum((x) => x.surfaces.roofM2),
      wallM2: sum((x) => x.surfaces.wallM2),
      totalM2: sum((x) => x.surfaces.totalM2),
      price: sum((x) => x.price.price),
      assumed: rows.filter((x) => x.surfaces.assumed.length).length,
    },
  };
}

/** Money in the quote's currency, e.g. "$1,234.50". */
export function fmtMoney(amount, currency = 'USD') {
  if (!Number.isFinite(amount)) return '—';
  try {
    return amount.toLocaleString('en-US', { style: 'currency', currency });
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** Area in the rate's unit, rounded, e.g. "12,345 ft²". */
export const fmtUnitArea = (m2, unit) =>
  `${Math.round(inUnit(m2, unit)).toLocaleString('en-US')} ${unit === 'm2' ? 'm²' : 'ft²'}`;

/** A quote as CSV (one row per building plus a total row). */
export function quoteCsv(quote, nameOf = (rec) => rec.tags?.name || rec.id) {
  const { unit, currency } = quote.rates;
  const u = unit === 'm2' ? 'm2' : 'ft2';
  const head = [
    'building',
    'lat',
    'lon',
    `footprint_${u}`,
    `roof_${u}`,
    `walls_${u}`,
    `total_${u}`,
    'roof_shape',
    'height_m',
    'assumed',
    `price_${currency}`,
  ];
  const cell = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const a = (m2) => Math.round(inUnit(m2, unit));
  const lines = quote.rows.map(({ record, surfaces: s, price }) =>
    [
      nameOf(record),
      record.center?.[1]?.toFixed(6),
      record.center?.[0]?.toFixed(6),
      a(s.footprintM2),
      a(s.roofM2),
      a(s.wallM2),
      a(s.totalM2),
      s.roofShape,
      record.height?.heightM?.toFixed(1),
      s.assumed.join('; '),
      price.price.toFixed(2),
    ]
      .map(cell)
      .join(','),
  );
  const t = quote.totals;
  lines.push(
    [
      `TOTAL (${t.count})`,
      '',
      '',
      a(t.footprintM2),
      a(t.roofM2),
      a(t.wallM2),
      a(t.totalM2),
      '',
      '',
      '',
      t.price.toFixed(2),
    ]
      .map(cell)
      .join(','),
  );
  return [head.join(','), ...lines].join('\n');
}
