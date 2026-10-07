import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContours,
  chainSegments,
  clampIntervalFt,
  contourLevels,
  marchingSquares,
  simplifyLine,
  smoothGrid,
} from './contourMath.js';
import { FEET_PER_METRE } from './siteGeometry.js';

/** A tilted plane rising 1 m per column. */
function plane(width, height) {
  const v = new Float32Array(width * height);
  for (let r = 0; r < height; r++)
    for (let c = 0; c < width; c++) v[r * width + c] = c;
  return v;
}

/** A cone peaking at the centre. */
function cone(n, peak = 20) {
  const v = new Float32Array(n * n);
  const mid = (n - 1) / 2;
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      v[r * n + c] = peak - Math.hypot(r - mid, c - mid);
  return v;
}

test('interval clamps to the 2–100 ft slider range', () => {
  assert.equal(clampIntervalFt(1), 2);
  assert.equal(clampIntervalFt(2), 2);
  assert.equal(clampIntervalFt(37.4), 37);
  assert.equal(clampIntervalFt(250), 100);
  assert.equal(clampIntervalFt('x', 10), 10);
});

test('levels land on whole feet and flag every 5th as index', () => {
  const levels = contourLevels(10 / FEET_PER_METRE, 62 / FEET_PER_METRE, 10);
  assert.deepEqual(
    levels.map((l) => l.ft),
    [10, 20, 30, 40, 50, 60],
  );
  assert.deepEqual(
    levels.map((l) => l.index),
    [false, false, false, false, true, false],
  );
  const two = contourLevels(0, 1, 2); // 0..3.28 ft
  assert.deepEqual(
    two.map((l) => l.ft),
    [0, 2],
  );
});

test('a plane produces straight vertical contour lines', () => {
  const w = 8;
  const h = 6;
  const segs = marchingSquares(plane(w, h), w, h, [2.5, 4.5]);
  assert.equal(segs.size, 2);
  const lines = chainSegments(segs.get(0));
  assert.equal(lines.length, 1);
  for (const [x] of lines[0]) assert.ok(Math.abs(x - 2.5) < 1e-9);
  const ys = lines[0].map(([, y]) => y).sort((a, b) => a - b);
  assert.equal(ys[0], 0);
  assert.equal(ys.at(-1), h - 1);
});

test('a cone produces closed rings', () => {
  const n = 21;
  const { lines, range } = buildContours(cone(n), n, n, 10, { smooth: false });
  assert.ok(range.max > 19);
  // Levels above ~36 ft stay inside the 21×21 grid, so they must close.
  const inner = lines.filter((line) => line.ft >= 40);
  assert.ok(inner.length >= 1);
  for (const line of inner) {
    const [a, b] = [line.points[0], line.points.at(-1)];
    assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6, 'ring closes');
  }
});

test('mask and missing samples suppress contours', () => {
  const w = 8;
  const h = 6;
  const values = plane(w, h);
  const none = marchingSquares(values, w, h, [2.5], new Uint8Array(w * h));
  assert.equal(none.size, 0);
  const holes = Float32Array.from(values);
  for (let r = 0; r < h; r++) holes[r * w + 2] = Number.NaN;
  assert.equal(marchingSquares(holes, w, h, [2.5]).size, 0);
});

test('smoothing keeps NaN holes and averages neighbours', () => {
  const v = Float32Array.from([0, 0, 0, 0, 9, 0, 0, 0, Number.NaN]);
  const s = smoothGrid(v, 3, 3);
  assert.ok(Number.isNaN(s[8]));
  assert.ok(Math.abs(s[4] - 9 / 8) < 1e-6);
});

test('simplification drops collinear points but keeps corners', () => {
  const straight = [
    [0, 0],
    [1, 0],
    [2, 0],
    [3, 0],
  ];
  assert.deepEqual(simplifyLine(straight), [
    [0, 0],
    [3, 0],
  ]);
  const corner = [
    [0, 0],
    [1, 0],
    [2, 0],
    [2, 1],
    [2, 2],
  ];
  assert.deepEqual(simplifyLine(corner), [
    [0, 0],
    [2, 0],
    [2, 2],
  ]);
});

test('2 ft interval on a 50 m rise yields one level per 2 ft', () => {
  const w = 60;
  const h = 4;
  const v = new Float32Array(w * h);
  for (let r = 0; r < h; r++)
    for (let c = 0; c < w; c++) v[r * w + c] = (c * 50) / (w - 1);
  const { levels } = buildContours(v, w, h, 2, { smooth: false });
  assert.equal(levels.length, Math.floor((50 * FEET_PER_METRE) / 2) + 1);
});
