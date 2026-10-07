/**
 * Viewshed math (pure): which cells of a height grid an observer can see.
 *
 * For every target cell, walk the straight line from the observer and keep
 * the steepest elevation angle met so far; the target is visible when the
 * sight line to it (target height included) is at least that steep. Heights
 * drop with distance for earth curvature, less a standard refraction share
 * (k = 0.13), which matters past a few hundred metres.
 */

import { chainSegments, marchingSquares, simplifyLine } from './contourMath.js';

export const VIEWSHED_DEFAULTS = Object.freeze({
  eyeM: 1.7, // standing person
  targetM: 0, // the ground itself
  refraction: 0.13,
});

export const VIEWSHED = Object.freeze({ NONE: 0, HIDDEN: 1, VISIBLE: 2 });

const EARTH_R = 6_371_000;

/** Curvature-and-refraction drop per metre² of distance. */
export const curveFactor = (refraction = VIEWSHED_DEFAULTS.refraction) =>
  (1 - refraction) / (2 * EARTH_R);

/** Cell codes for a two-height (band) viewshed. */
export const BAND = Object.freeze({
  NONE: 0,
  HIDDEN: 1,
  HIGH_ONLY: 2,
  BOTH: 3,
});

/**
 * @param {{
 *   heights: ArrayLike<number>, width: number, height: number,
 *   cellXM: number, cellYM: number,        metres per column / row
 *   observer: { col: number, row: number },
 *   eyeM?: number, targetM?: number, maxDistM?: number, refraction?: number,
 *   mask?: ArrayLike<number>,              only cells with mask[i] are judged
 * }} input
 * @returns {{ grid: Uint8Array, observerGroundM: number, observerM: number,
 *   stats: { visible: number, hidden: number, visiblePct: number,
 *            farthestVisibleM: number } }}
 */
export function computeViewshed({
  heights,
  width,
  height,
  cellXM,
  cellYM,
  observer,
  eyeM = VIEWSHED_DEFAULTS.eyeM,
  targetM = VIEWSHED_DEFAULTS.targetM,
  maxDistM = Infinity,
  refraction = VIEWSHED_DEFAULTS.refraction,
  mask = null,
}) {
  const oc = Math.round(observer.col);
  const or = Math.round(observer.row);
  if (oc < 0 || or < 0 || oc >= width || or >= height)
    throw new RangeError('Observer is outside the height grid');
  const ground = heights[or * width + oc];
  if (!Number.isFinite(ground))
    throw new RangeError('No height under the observer');
  const eye = ground + eyeM;
  const curve = (1 - refraction) / (2 * EARTH_R);
  const grid = new Uint8Array(width * height);
  let visible = 0;
  let hidden = 0;
  let farthest = 0;
  for (let r = 0; r < height; r++)
    for (let c = 0; c < width; c++) {
      const i = r * width + c;
      if (mask && !mask[i]) continue;
      const h = heights[i];
      if (!Number.isFinite(h)) continue;
      const dx = (c - oc) * cellXM;
      const dy = (r - or) * cellYM;
      const dist = Math.hypot(dx, dy);
      if (dist > maxDistM) continue;
      if (dist === 0) {
        grid[i] = VIEWSHED.VISIBLE;
        visible++;
        continue;
      }
      // Step one cell at a time along the longer axis.
      const steps = Math.max(Math.abs(c - oc), Math.abs(r - or));
      let maxSlope = -Infinity;
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        const sc = Math.round(oc + (c - oc) * t);
        const sr = Math.round(or + (r - or) * t);
        const sh = heights[sr * width + sc];
        if (!Number.isFinite(sh)) continue;
        const d = dist * t;
        const slope = (sh - d * d * curve - eye) / d;
        if (slope > maxSlope) maxSlope = slope;
      }
      const targetSlope = (h + targetM - dist * dist * curve - eye) / dist;
      if (targetSlope >= maxSlope) {
        grid[i] = VIEWSHED.VISIBLE;
        visible++;
        if (dist > farthest) farthest = dist;
      } else {
        grid[i] = VIEWSHED.HIDDEN;
        hidden++;
      }
    }
  const judged = visible + hidden;
  return {
    grid,
    observerGroundM: ground,
    observerM: eye,
    stats: {
      visible,
      hidden,
      visiblePct: judged ? Math.round((visible / judged) * 1000) / 10 : 0,
      farthestVisibleM: Math.round(farthest),
    },
  };
}

/**
 * Merge runs of equal, non-NONE cells along each row: one rectangle per run
 * keeps the draped overlay to a few thousand pieces.
 * @returns {Array<{ row: number, col0: number, col1: number, value: number }>}
 */
export function rowRuns(grid, width, height) {
  const runs = [];
  for (let r = 0; r < height; r++) {
    let start = -1;
    let value = 0;
    for (let c = 0; c <= width; c++) {
      const v = c < width ? grid[r * width + c] : 0;
      if (v === value) continue;
      if (value) runs.push({ row: r, col0: start, col1: c - 1, value });
      value = v;
      start = c;
    }
  }
  return runs;
}

/** Parse an eye/target height: "1.7", "6 ft", "30m"; null when invalid. */
export function parseHeightM(text) {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(m|ft|feet|')?\s*$/i.exec(
    String(text ?? ''),
  );
  if (!m) return null;
  const n = Number(m[1]);
  const metres = /^(ft|feet|')$/i.test(m[2] || '') ? n * 0.3048 : n;
  return metres >= 0 && metres <= 1000 ? metres : null;
}

/**
 * Viewshed for a low and a high eye height in one pass (the same sight-line
 * walk, two running horizons). A cell visible from the low eye is always
 * visible from the high one, so each cell gets one BAND code. `rows`
 * limits the work to [r0, r1) so a worker pool can split the grid; cells
 * outside it stay NONE.
 * @returns {Uint8Array} BAND codes
 */
export function computeViewshedBand({
  heights,
  width,
  height,
  cellXM,
  cellYM,
  observer,
  lowM = VIEWSHED_DEFAULTS.eyeM,
  highM = lowM,
  targetM = VIEWSHED_DEFAULTS.targetM,
  refraction = VIEWSHED_DEFAULTS.refraction,
  mask = null,
  rows = [0, height],
  out = new Uint8Array(width * height),
}) {
  const oc = Math.round(observer.col);
  const or = Math.round(observer.row);
  const ground = heights[or * width + oc];
  if (!Number.isFinite(ground))
    throw new RangeError('No height under the observer');
  const eyeLo = ground + lowM;
  const eyeHi = ground + highM;
  const curve = curveFactor(refraction);
  for (let r = rows[0]; r < rows[1]; r++)
    for (let c = 0; c < width; c++) {
      const i = r * width + c;
      if (mask && !mask[i]) continue;
      const h = heights[i];
      if (!Number.isFinite(h)) continue;
      const dist = Math.hypot((c - oc) * cellXM, (r - or) * cellYM);
      if (dist === 0) {
        out[i] = BAND.BOTH;
        continue;
      }
      const steps = Math.max(Math.abs(c - oc), Math.abs(r - or));
      let maxLo = -Infinity;
      let maxHi = -Infinity;
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        const sh =
          heights[
            Math.round(or + (r - or) * t) * width +
              Math.round(oc + (c - oc) * t)
          ];
        if (!Number.isFinite(sh)) continue;
        const d = dist * t;
        const z = sh - d * d * curve;
        const lo = (z - eyeLo) / d;
        const hi = (z - eyeHi) / d;
        if (lo > maxLo) maxLo = lo;
        if (hi > maxHi) maxHi = hi;
      }
      const tz = h + targetM - dist * dist * curve;
      out[i] =
        (tz - eyeLo) / dist >= maxLo
          ? BAND.BOTH
          : (tz - eyeHi) / dist >= maxHi
            ? BAND.HIGH_ONLY
            : BAND.HIDDEN;
    }
  return out;
}

/** Counts, shares and farthest visible distance for a BAND grid. */
export function bandStats(codes, width, cellXM, cellYM, observer) {
  let both = 0;
  let highOnly = 0;
  let hidden = 0;
  let farLo = 0;
  let farHi = 0;
  const oc = Math.round(observer.col);
  const or = Math.round(observer.row);
  for (let i = 0; i < codes.length; i++) {
    const v = codes[i];
    if (!v) continue;
    if (v === BAND.HIDDEN) {
      hidden++;
      continue;
    }
    const d = Math.hypot(
      ((i % width) - oc) * cellXM,
      (Math.floor(i / width) - or) * cellYM,
    );
    if (v === BAND.BOTH) {
      both++;
      if (d > farLo) farLo = d;
    } else highOnly++;
    if (d > farHi) farHi = d;
  }
  const judged = both + highOnly + hidden;
  const pct = (n) => (judged ? Math.round((n / judged) * 1000) / 10 : 0);
  return {
    both,
    highOnly,
    hidden,
    judged,
    lowPct: pct(both),
    highPct: pct(both + highOnly),
    farthestLowM: Math.round(farLo),
    farthestHighM: Math.round(farHi),
  };
}

/**
 * Outline (edge) of the area visible at the low (`level: 'low'`) or high
 * eye, as polylines in grid (col,row) coordinates.
 * @param {{ minLength?: number, tolerance?: number }} [options] cells
 */
export function bandOutlines(
  codes,
  width,
  height,
  level,
  {
    minLength = Math.max(8, 0.03 * Math.max(width, height)),
    tolerance = 0.9,
  } = {},
) {
  const min = level === 'low' ? BAND.BOTH : BAND.HIGH_ONLY;
  const field = new Float32Array(codes.length);
  for (let i = 0; i < codes.length; i++)
    field[i] = codes[i] ? (codes[i] >= min ? 1 : 0) : Number.NaN;
  const segs = marchingSquares(field, width, height, [0.5]);
  // Speckle (single bumps, a few cells across) makes hundreds of tiny loops
  // that cost redraw time and say nothing; keep edges at least `minLength`
  // cells long.
  const length = (pts) => {
    let sum = 0;
    for (let k = 1; k < pts.length; k++)
      sum += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    return sum;
  };
  return chainSegments(segs.get(0) ?? [])
    .filter((pts) => length(pts) >= minLength)
    .map((pts) => simplifyLine(pts, tolerance))
    .filter((pts) => pts.length >= 2);
}

/**
 * Eye height or range: "1.7", "6 ft", "1-2.5 m", "1 to 2.5m" → { lowM, highM };
 * null when invalid.
 */
export function parseHeightRange(text) {
  const raw = String(text ?? '').trim();
  const unit = /(m|ft|feet|')\s*$/i.exec(raw)?.[1] ?? '';
  const parts = raw
    .replace(/(m|ft|feet|')\s*$/i, '')
    .split(/\s*(?:-|–|to)\s*/i)
    .filter(Boolean);
  if (parts.length < 1 || parts.length > 2) return null;
  const [a, b] = parts.map((p) => parseHeightM(`${p}${unit}`));
  if (a == null || (parts.length === 2 && b == null)) return null;
  const lowM = Math.min(a, b ?? a);
  const highM = Math.max(a, b ?? a);
  return { lowM, highM };
}

/**
 * Average `factor`×`factor` blocks (NaN ignored) to shrink a grid; trailing
 * partial blocks are dropped so every output cell covers a full block.
 */
export function downsampleHeights(values, width, height, factor) {
  const f = Math.max(1, Math.floor(factor));
  const w = Math.floor(width / f);
  const h = Math.floor(height / f);
  const out = new Float32Array(w * h);
  for (let r = 0; r < h; r++)
    for (let c = 0; c < w; c++) {
      let sum = 0;
      let n = 0;
      for (let y = r * f; y < r * f + f; y++)
        for (let x = c * f; x < c * f + f; x++) {
          const v = values[y * width + x];
          if (Number.isFinite(v)) {
            sum += v;
            n++;
          }
        }
      out[r * w + c] = n ? sum / n : Number.NaN;
    }
  return { values: out, width: w, height: h, factor: f };
}

/**
 * Surface heights from scattered points: the highest point in each cell of
 * a north-up lon/lat grid (roofs and canopy win over the ground beside
 * them). Cells no point hit are filled from their neighbours, up to
 * `fillPasses` cells in from the nearest hit; farther gaps stay NaN.
 * @param {ArrayLike<number>} points flat [lon, lat, height, lon, lat, …]
 * @returns {{ values: Float64Array, hits: number }}
 */
export function surfaceGrid(
  points,
  bbox,
  width,
  height,
  { fillPasses = 3 } = {},
) {
  const values = new Float64Array(width * height).fill(Number.NaN);
  const sx = width / (bbox.maxLon - bbox.minLon);
  const sy = height / (bbox.maxLat - bbox.minLat);
  for (let k = 0; k + 2 < points.length; k += 3) {
    const c = Math.floor((points[k] - bbox.minLon) * sx);
    const r = Math.floor((bbox.maxLat - points[k + 1]) * sy);
    const h = points[k + 2];
    if (c < 0 || r < 0 || c >= width || r >= height || !Number.isFinite(h))
      continue;
    const i = r * width + c;
    if (!(values[i] >= h)) values[i] = h;
  }
  let hits = 0;
  for (const v of values) if (Number.isFinite(v)) hits++;
  for (let pass = 0; pass < fillPasses; pass++) {
    const next = values.slice();
    let filled = 0;
    for (let r = 0; r < height; r++)
      for (let c = 0; c < width; c++) {
        const i = r * width + c;
        if (Number.isFinite(values[i])) continue;
        let sum = 0;
        let n = 0;
        for (let y = Math.max(0, r - 1); y <= Math.min(height - 1, r + 1); y++)
          for (
            let x = Math.max(0, c - 1);
            x <= Math.min(width - 1, c + 1);
            x++
          ) {
            const v = values[y * width + x];
            if (Number.isFinite(v)) {
              sum += v;
              n++;
            }
          }
        if (n) {
          next[i] = sum / n;
          filled++;
        }
      }
    values.set(next);
    if (!filled) break;
  }
  return { values, hits };
}
