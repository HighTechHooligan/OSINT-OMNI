/**
 * Viewshed math (pure): which cells of a height grid an observer can see.
 *
 * For every target cell, walk the straight line from the observer and keep
 * the steepest elevation angle met so far; the target is visible when the
 * sight line to it (target height included) is at least that steep. Heights
 * drop with distance for earth curvature, less a standard refraction share
 * (k = 0.13), which matters past a few hundred metres.
 */

export const VIEWSHED_DEFAULTS = Object.freeze({
  eyeM: 1.7, // standing person
  targetM: 0, // the ground itself
  refraction: 0.13,
});

export const VIEWSHED = Object.freeze({ NONE: 0, HIDDEN: 1, VISIBLE: 2 });

const EARTH_R = 6_371_000;

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
