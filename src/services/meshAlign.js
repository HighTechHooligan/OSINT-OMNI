/**
 * Measure the horizontal offset between a bare-earth elevation grid and the
 * 3D mesh the user is looking at (Google photorealistic tiles), so contours
 * traced on the grid can be drawn where the mesh actually shows that ground.
 *
 * Why measure instead of hard-coding a translation: the residual between a
 * national DEM and a photogrammetry mesh comes from the mesh's own absolute
 * georeferencing, which varies city to city. Matching the two surfaces at
 * the site itself gives the right answer anywhere on Earth.
 *
 * Method: sample mesh heights at a few thousand points inside the site, then
 * grid-search a 2D shift that best explains the mesh with the shifted DEM.
 * A constant vertical bias (geoid model, NAVD88 vs ellipsoid, mesh offset)
 * is removed per candidate, and residuals are truncated so trees, buildings
 * and cars (mesh well above bare earth) cannot drag the fit. Flat sites
 * carry no horizontal signal; the result says so and no shift is applied.
 *
 * Pure math, no Cesium.
 */

export const ALIGN_DEFAULTS = Object.freeze({
  maxShiftM: 12, // search radius
  coarseStepM: 1,
  fineStepM: 0.25,
  truncM: 0.75, // residuals beyond this count as "not ground"
  minInlierFraction: 0.25,
  minImprovement: 0.15, // best cost must beat no-shift by 15 %
  minSamples: 200,
});

/** Bilinear sample at fractional (x = col, y = row); NaN off-grid or missing. */
export function bilinear(values, width, height, x, y) {
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return Number.NaN;
  const x0 = Math.min(Math.floor(x), width - 2);
  const y0 = Math.min(Math.floor(y), height - 2);
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * width + x0;
  const a = values[i];
  const b = values[i + 1];
  const c = values[i + width];
  const d = values[i + width + 1];
  return (
    a * (1 - fx) * (1 - fy) +
    b * fx * (1 - fy) +
    c * (1 - fx) * fy +
    d * fx * fy
  );
}

function median(arr, n) {
  const a = Array.from(arr.subarray(0, n)).sort((p, q) => p - q);
  return n % 2 ? a[(n - 1) >> 1] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

/**
 * @param {{ values: Float32Array, width: number, height: number,
 *           pxEastM: number, pxSouthM: number }} grid
 *   Grid with metres per column (east) and per row (south).
 * @param {Array<{ x: number, y: number, h: number }>} samples
 *   Mesh heights h (any vertical datum) at grid coordinates (x, y), i.e.
 *   where the UNshifted grid sample (x, y) is drawn.
 * @returns {{ ok: boolean, eastM: number, northM: number, reason?: string,
 *             inliers: number, samples: number, biasM?: number,
 *             improvement?: number }}
 *   eastM/northM: move the grid's drawn positions by this much to sit on
 *   the mesh.
 */
export function estimateMeshOffset(grid, samples, options = {}) {
  const o = { ...ALIGN_DEFAULTS, ...options };
  const { values, width, height, pxEastM, pxSouthM } = grid;
  const pts = samples.filter((s) => Number.isFinite(s.h));
  const fail = (reason) => ({
    ok: false,
    eastM: 0,
    northM: 0,
    reason,
    inliers: 0,
    samples: pts.length,
  });
  if (pts.length < o.minSamples) return fail('too few mesh samples');

  const resid = new Float64Array(pts.length);
  const trunc2 = o.truncM * o.truncM;

  /** Cost of drawing grid point p at p + (e, n) metres. */
  function cost(eM, nM) {
    // Mesh at drawn location L shows the DEM at L - shift.
    const dx = eM / pxEastM;
    const dy = -nM / pxSouthM;
    let n = 0;
    for (const p of pts) {
      const dem = bilinear(values, width, height, p.x - dx, p.y - dy);
      if (Number.isFinite(dem)) resid[n++] = p.h - dem;
    }
    if (n < o.minSamples) return { cost: Infinity, inliers: 0, bias: 0 };
    let bias = median(resid, n);
    // Re-centre on the ground cluster (vegetation skews the plain median up).
    let near = 0;
    let sum = 0;
    for (let i = 0; i < n; i++)
      if (Math.abs(resid[i] - bias) < 3 * o.truncM) {
        sum += resid[i];
        near++;
      }
    if (near) bias = sum / near;
    let c = 0;
    let inliers = 0;
    for (let i = 0; i < n; i++) {
      const r = resid[i] - bias;
      const r2 = r * r;
      if (r2 < trunc2) inliers++;
      c += Math.min(r2, trunc2);
    }
    return { cost: c / n, inliers, bias };
  }

  const zero = cost(0, 0);
  let best = { ...zero, eM: 0, nM: 0 };
  // Coarse search over the whole radius, then refine around the winner.
  const search = (cE, cN, radius, step) => {
    const k = Math.round(radius / step);
    for (let i = -k; i <= k; i++)
      for (let j = -k; j <= k; j++) {
        const eM = cE + i * step;
        const nM = cN + j * step;
        if (Math.hypot(eM, nM) > o.maxShiftM) continue;
        const c = cost(eM, nM);
        if (c.cost < best.cost) best = { ...c, eM, nM };
      }
  };
  search(0, 0, o.maxShiftM, o.coarseStepM);
  search(best.eM, best.nM, o.coarseStepM, o.fineStepM);

  const base = {
    inliers: best.inliers,
    samples: pts.length,
    biasM: best.bias,
    improvement: zero.cost > 0 ? 1 - best.cost / zero.cost : 0,
  };
  if (!Number.isFinite(best.cost)) return { ...fail('no overlap'), ...base };
  if (best.inliers / pts.length < o.minInlierFraction)
    return { ...fail('too little bare ground visible'), ...base };
  if (Math.hypot(best.eM, best.nM) >= o.maxShiftM - o.coarseStepM)
    return { ...fail('offset larger than search radius'), ...base };
  if (base.improvement < o.minImprovement)
    return {
      ...fail('no clear offset (flat ground or already aligned)'),
      ...base,
    };
  return { ok: true, eastM: best.eM, northM: best.nM, ...base };
}
