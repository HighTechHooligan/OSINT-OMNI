import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VIEWSHED,
  computeViewshed,
  parseHeightM,
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
