/**
 * Pure contour math on a regular elevation grid (no Cesium, no DOM).
 *
 * Grid convention: `values[row * width + col]`, row 0 at the NORTH edge,
 * column 0 at the WEST edge, cell centres spanning the bbox. Missing samples
 * are NaN (or any value <= noData). Output lines are in grid coordinates
 * (x = column, y = row, fractional) and converted to lon/lat by the caller.
 */

import { FEET_PER_METRE } from './siteGeometry.js';

export const CONTOUR_MIN_FT = 2;
export const CONTOUR_MAX_FT = 100;
export const INDEX_EVERY = 5;

/** Clamp an interval to the 2–100 ft range the UI offers. */
export function clampIntervalFt(value, fallback = 10) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(CONTOUR_MAX_FT, Math.max(CONTOUR_MIN_FT, Math.round(n)));
}

export const DATUMS = Object.freeze(['asl', 'relative']);

/**
 * Elevation reference for contour labels.
 * - 'asl': feet above sea level (NAVD88, as served by USGS 3DEP)
 * - 'relative': 0 ft at the lowest point inside the boundary
 */
export function normalizeDatum(value, fallback = 'asl') {
  const v = String(value ?? '')
    .trim()
    .toLowerCase();
  if (
    ['asl', 'msl', 'sea', 'sealevel', 'navd88', 'absolute', 'abs'].includes(v)
  )
    return 'asl';
  if (['relative', 'rel', 'zero', 'local', 'agl', 'site'].includes(v))
    return 'relative';
  return fallback;
}

/**
 * Contour levels covering [minM, maxM] at an interval in feet, counted from
 * `baseM` (0 for sea level, the zone minimum for relative). `ft` is the
 * label value relative to the base; `m` is the absolute level in metres.
 */
export function contourLevels(minM, maxM, intervalFt, baseM = 0) {
  const stepFt = clampIntervalFt(intervalFt);
  const lo =
    Math.ceil(((minM - baseM) * FEET_PER_METRE) / stepFt - 1e-9) * stepFt;
  const hi =
    Math.floor(((maxM - baseM) * FEET_PER_METRE) / stepFt + 1e-9) * stepFt;
  const levels = [];
  for (let ft = lo; ft <= hi + 1e-9; ft += stepFt) {
    levels.push({
      ft: Math.round(ft * 100) / 100 + 0, // + 0 turns -0 into 0
      m: baseM + ft / FEET_PER_METRE,
      index: Math.round(ft / stepFt) % INDEX_EVERY === 0,
    });
  }
  return levels;
}

/** Copy of the grid with a 3×3 mean filter over valid samples (tames 1 m noise). */
export function smoothGrid(values, width, height) {
  const out = new Float32Array(values.length);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const i = r * width + c;
      if (!Number.isFinite(values[i])) {
        out[i] = Number.NaN;
        continue;
      }
      let sum = 0;
      let n = 0;
      for (let dr = -1; dr <= 1; dr++) {
        const rr = r + dr;
        if (rr < 0 || rr >= height) continue;
        for (let dc = -1; dc <= 1; dc++) {
          const cc = c + dc;
          if (cc < 0 || cc >= width) continue;
          const v = values[rr * width + cc];
          if (Number.isFinite(v)) {
            sum += v;
            n++;
          }
        }
      }
      out[i] = sum / n;
    }
  }
  return out;
}

/** Min/max of finite samples (only where mask is set, when given). */
export function gridRange(values, mask = null) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v) || (mask && !mask[i])) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return Number.isFinite(min) ? { min, max } : null;
}

/**
 * Marching squares. Returns Map(levelIndex → Array<[x1,y1,x2,y2]>).
 * Cells with any missing corner, or whose centre is outside `mask`
 * (Uint8Array per sample, optional), are skipped.
 */
export function marchingSquares(values, width, height, levels, mask = null) {
  const out = new Map();
  const lvls = levels.map((l) => (typeof l === 'number' ? l : l.m));
  const push = (k, seg) => {
    let list = out.get(k);
    if (!list) out.set(k, (list = []));
    list.push(seg);
  };
  for (let r = 0; r < height - 1; r++) {
    for (let c = 0; c < width - 1; c++) {
      const i = r * width + c;
      const tl = values[i];
      const tr = values[i + 1];
      const bl = values[i + width];
      const br = values[i + width + 1];
      if (
        !Number.isFinite(tl) ||
        !Number.isFinite(tr) ||
        !Number.isFinite(bl) ||
        !Number.isFinite(br)
      )
        continue;
      if (
        mask &&
        !(mask[i] && mask[i + 1] && mask[i + width] && mask[i + width + 1])
      )
        continue;
      const lo = Math.min(tl, tr, bl, br);
      const hi = Math.max(tl, tr, bl, br);
      for (let k = 0; k < lvls.length; k++) {
        const z = lvls[k];
        if (z < lo || z > hi || lo === hi) continue;
        // Bit order: tl=8, tr=4, br=2, bl=1 (1 = above level)
        const code =
          (tl > z ? 8 : 0) |
          (tr > z ? 4 : 0) |
          (br > z ? 2 : 0) |
          (bl > z ? 1 : 0);
        if (code === 0 || code === 15) continue;
        const t = (a, b) => (z - a) / (b - a);
        const top = [c + t(tl, tr), r];
        const right = [c + 1, r + t(tr, br)];
        const bottom = [c + t(bl, br), r + 1];
        const left = [c, r + t(tl, bl)];
        const seg = (a, b) => push(k, [a[0], a[1], b[0], b[1]]);
        switch (code) {
          case 1:
          case 14:
            seg(left, bottom);
            break;
          case 2:
          case 13:
            seg(bottom, right);
            break;
          case 3:
          case 12:
            seg(left, right);
            break;
          case 4:
          case 11:
            seg(top, right);
            break;
          case 6:
          case 9:
            seg(top, bottom);
            break;
          case 7:
          case 8:
            seg(left, top);
            break;
          case 5: {
            const centre = (tl + tr + bl + br) / 4;
            if (centre > z) {
              seg(left, top);
              seg(bottom, right);
            } else {
              seg(left, bottom);
              seg(top, right);
            }
            break;
          }
          case 10: {
            const centre = (tl + tr + bl + br) / 4;
            if (centre > z) {
              seg(top, right);
              seg(left, bottom);
            } else {
              seg(left, top);
              seg(bottom, right);
            }
            break;
          }
          default:
            break;
        }
      }
    }
  }
  return out;
}

const keyOf = (x, y) => `${Math.round(x * 1e4)},${Math.round(y * 1e4)}`;

/** Join segments that share endpoints into polylines ([[x,y], ...]). */
export function chainSegments(segments) {
  const ends = new Map();
  const used = new Uint8Array(segments.length);
  const add = (k, i) => {
    let list = ends.get(k);
    if (!list) ends.set(k, (list = []));
    list.push(i);
  };
  segments.forEach(([x1, y1, x2, y2], i) => {
    add(keyOf(x1, y1), i);
    add(keyOf(x2, y2), i);
  });
  const next = (x, y) => {
    for (const j of ends.get(keyOf(x, y)) ?? []) if (!used[j]) return j;
    return -1;
  };
  const lines = [];
  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const [x1, y1, x2, y2] = segments[i];
    const line = [
      [x1, y1],
      [x2, y2],
    ];
    for (const forward of [true, false]) {
      for (;;) {
        const [x, y] = forward ? line.at(-1) : line[0];
        const j = next(x, y);
        if (j < 0) break;
        used[j] = 1;
        const [a1, b1, a2, b2] = segments[j];
        const far = keyOf(a1, b1) === keyOf(x, y) ? [a2, b2] : [a1, b1];
        if (forward) line.push(far);
        else line.unshift(far);
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Ramer–Douglas–Peucker simplification in grid units. */
export function simplifyLine(points, tolerance = 0.25) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const tol2 = tolerance * tolerance;
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = points[a];
    const [bx, by] = points[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-12;
    let worst = -1;
    let worstD = tol2;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i];
      const t = Math.max(
        0,
        Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2),
      );
      const ex = ax + t * dx - px;
      const ey = ay + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * Full pipeline: levels → segments → polylines, in grid coordinates.
 * `datum` 'relative' counts levels from the lowest point inside the mask.
 * @returns {{ levels: Array, lines: Array<{ft:number, m:number, index:boolean, points:number[][]}>,
 *   range: {min:number,max:number}|null, baseM: number, datum: 'asl'|'relative' }}
 */
export function buildContours(
  values,
  width,
  height,
  intervalFt,
  { mask = null, smooth = true, datum = 'asl' } = {},
) {
  const mode = normalizeDatum(datum);
  const grid = smooth ? smoothGrid(values, width, height) : values;
  const range = gridRange(grid, mask) ?? gridRange(grid);
  if (!range)
    return { levels: [], lines: [], range: null, baseM: 0, datum: mode };
  const baseM = mode === 'relative' ? range.min : 0;
  const levels = contourLevels(range.min, range.max, intervalFt, baseM);
  const segs = marchingSquares(grid, width, height, levels, mask);
  const lines = [];
  for (const [k, list] of segs) {
    for (const pts of chainSegments(list)) {
      const simple = simplifyLine(pts);
      if (simple.length >= 2)
        lines.push({
          ft: levels[k].ft,
          m: levels[k].m,
          index: levels[k].index,
          points: simple,
        });
    }
  }
  return { levels, lines, range, baseM, datum: mode };
}

/** Label text for a contour level: "905 ft" (sea level) or "+40 ft" (relative). */
export function formatElevationFt(ft, datum = 'asl') {
  const n = Math.round(Number(ft) * 10) / 10;
  if (normalizeDatum(datum) === 'relative')
    return n > 0 ? `+${n} ft` : `${n} ft`;
  return `${n} ft`;
}

/**
 * Pick label anchors: one per line at its middle vertex, index contours
 * first (longest first). When a site has fewer than 4 index lines, minor
 * lines are labelled too so short relief still gets numbers. At most `max`.
 * Returns {ft, m, point:[x,y]} in grid coordinates.
 */
export function pickLabelAnchors(lines, max = 60) {
  const usable = lines.filter((line) => line.points.length >= 2);
  const byLength = (a, b) => b.points.length - a.points.length;
  const index = usable.filter((line) => line.index).sort(byLength);
  const picked =
    index.length >= 4
      ? index
      : [...index, ...usable.filter((line) => !line.index).sort(byLength)];
  return picked.slice(0, Math.max(0, max)).map((line) => ({
    ft: line.ft,
    m: line.m,
    point: line.points[Math.floor(line.points.length / 2)],
  }));
}
