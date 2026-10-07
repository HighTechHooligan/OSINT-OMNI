import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BAND,
  VIEWSHED,
  bandOutlines,
  bandStats,
  computeViewshed,
  computeViewshedBand,
  downsampleHeights,
  parseHeightM,
  parseHeightRange,
  rowRuns,
} from './viewshedMath.js';

const flat = (w, h, z = 100) => new Float64Array(w * h).fill(z);

test('flat ground: everything is visible', () => {
  const out = computeViewshed({
    heights: flat(21, 21),
    width: 21,
    height: 21,
    cellXM: 5,
    cellYM: 5,
    observer: { col: 10, row: 10 },
  });
  assert.equal(out.stats.hidden, 0);
  assert.equal(out.stats.visiblePct, 100);
  assert.equal(out.observerM, 101.7);
  assert.ok(out.stats.farthestVisibleM > 70);
});

test('a wall hides the ground behind it, but not a tall target', () => {
  const w = 41;
  const heights = flat(w, 1);
  heights[20] = 110; // 10 m wall halfway
  const base = {
    heights,
    width: w,
    height: 1,
    cellXM: 2,
    cellYM: 2,
    observer: { col: 0, row: 0 },
  };
  const out = computeViewshed(base);
  assert.equal(out.grid[10], VIEWSHED.VISIBLE);
  assert.equal(out.grid[20], VIEWSHED.VISIBLE); // the wall face itself
  assert.equal(out.grid[30], VIEWSHED.HIDDEN);
  assert.equal(out.grid[40], VIEWSHED.HIDDEN);
  // A 30 m mast at the far end clears the wall.
  const mast = computeViewshed({ ...base, targetM: 30 });
  assert.equal(mast.grid[40], VIEWSHED.VISIBLE);
  // Raising the observer to 25 m sees over it too.
  const high = computeViewshed({ ...base, eyeM: 25 });
  assert.equal(high.grid[40], VIEWSHED.VISIBLE);
});

test('a hill: the far slope is hidden, the near slope visible', () => {
  const w = 61;
  const heights = new Float64Array(w);
  for (let c = 0; c < w; c++)
    heights[c] = 100 + 20 * Math.exp(-((c - 30) ** 2) / 40);
  const out = computeViewshed({
    heights,
    width: w,
    height: 1,
    cellXM: 3,
    cellYM: 3,
    observer: { col: 0, row: 0 },
  });
  assert.equal(out.grid[25], VIEWSHED.VISIBLE);
  assert.equal(out.grid[40], VIEWSHED.HIDDEN);
});

test('mask, max distance and missing heights are skipped', () => {
  const heights = flat(11, 11);
  heights[5] = Number.NaN;
  const mask = new Uint8Array(121).fill(1);
  mask[0] = 0;
  const out = computeViewshed({
    heights,
    width: 11,
    height: 11,
    cellXM: 10,
    cellYM: 10,
    observer: { col: 5, row: 5 },
    maxDistM: 30,
    mask,
  });
  assert.equal(out.grid[0], VIEWSHED.NONE);
  assert.equal(out.grid[5], VIEWSHED.NONE);
  assert.equal(out.grid[5 * 11 + 10], VIEWSHED.NONE); // 50 m away
  assert.equal(out.grid[5 * 11 + 8], VIEWSHED.VISIBLE);
  assert.throws(
    () =>
      computeViewshed({
        heights,
        width: 11,
        height: 11,
        cellXM: 1,
        cellYM: 1,
        observer: { col: 20, row: 0 },
      }),
    RangeError,
  );
});

test('row runs and height parsing', () => {
  const grid = Uint8Array.from([2, 2, 1, 0, 1, 1]);
  assert.deepEqual(rowRuns(grid, 3, 2), [
    { row: 0, col0: 0, col1: 1, value: 2 },
    { row: 0, col0: 2, col1: 2, value: 1 },
    { row: 1, col0: 1, col1: 2, value: 1 },
  ]);
  assert.equal(parseHeightM('1.7'), 1.7);
  assert.ok(Math.abs(parseHeightM('6 ft') - 1.8288) < 1e-9);
  assert.equal(parseHeightM('30m'), 30);
  assert.equal(parseHeightM('tall'), null);
  assert.equal(parseHeightM('-3'), null);
});

test('band viewshed: matches the single-height result at each end', () => {
  const n = 41;
  const heights = new Float64Array(n * n);
  for (let i = 0; i < heights.length; i++) {
    const r = Math.floor(i / n);
    const c = i % n;
    heights[i] = 100 + 6 * Math.sin(c / 4) + 5 * Math.cos(r / 5);
  }
  const base = {
    heights,
    width: n,
    height: n,
    cellXM: 2,
    cellYM: 2,
    observer: { col: 20, row: 20 },
  };
  const band = computeViewshedBand({ ...base, lowM: 1, highM: 2.5 });
  const lo = computeViewshed({ ...base, eyeM: 1 }).grid;
  const hi = computeViewshed({ ...base, eyeM: 2.5 }).grid;
  let highOnly = 0;
  for (let i = 0; i < band.length; i++) {
    assert.equal(band[i] === BAND.BOTH, lo[i] === VIEWSHED.VISIBLE, `low ${i}`);
    assert.equal(
      band[i] >= BAND.HIGH_ONLY,
      hi[i] === VIEWSHED.VISIBLE,
      `high ${i}`,
    );
    if (band[i] === BAND.HIGH_ONLY) highOnly++;
  }
  assert.ok(highOnly > 0, 'raising the eye reveals more ground');
  const stats = bandStats(band, n, 2, 2, base.observer);
  assert.ok(stats.highPct > stats.lowPct);
  assert.equal(stats.judged, n * n);
  // Outlines: the edge of the high-eye area exists and is in grid coords.
  const lines = bandOutlines(band, n, n, 'high');
  assert.ok(lines.length > 0);
  for (const [x, y] of lines.flat())
    assert.ok(x >= 0 && x <= n - 1 && y >= 0 && y <= n - 1);
  // Row slices fill only their rows and agree with the whole.
  const top = computeViewshedBand({
    ...base,
    lowM: 1,
    highM: 2.5,
    rows: [0, 10],
  });
  assert.deepEqual(top.slice(0, 10 * n), band.slice(0, 10 * n));
  assert.ok(top.slice(10 * n).every((v) => v === 0));
});

test('height ranges and downsampling', () => {
  assert.deepEqual(parseHeightRange('1-2.5 m'), { lowM: 1, highM: 2.5 });
  assert.deepEqual(parseHeightRange('2.5 to 1'), { lowM: 1, highM: 2.5 });
  assert.deepEqual(parseHeightRange('1.7'), { lowM: 1.7, highM: 1.7 });
  const ft = parseHeightRange('3–8 ft');
  assert.ok(
    Math.abs(ft.lowM - 0.9144) < 1e-9 && Math.abs(ft.highM - 2.4384) < 1e-9,
  );
  assert.equal(parseHeightRange('a-b'), null);
  assert.equal(parseHeightRange('1-2-3'), null);
  const d = downsampleHeights(
    Float32Array.from([1, 3, 5, 7, 2, 4, NaN, 8, 9]),
    3,
    3,
    2,
  );
  assert.equal(d.width, 1);
  assert.equal(d.height, 1);
  assert.equal(d.values[0], 3.25); // the 2×2 block 1, 3, 7, 2
  const gap = downsampleHeights(Float32Array.from([NaN, 2, 4, 6]), 2, 2, 2);
  assert.equal(gap.values[0], 4); // NaN ignored
});
