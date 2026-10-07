import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContours,
  chainSegments,
  clampIntervalFt,
  contourLevels,
  formatElevationFt,
  gridRange,
  marchingSquares,
  normalizeDatum,
  pickLabelAnchors,
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

test('normalizeDatum reads what people type', () => {
  for (const v of ['asl', 'MSL', 'sea', 'navd88', ' abs '])
    assert.equal(normalizeDatum(v), 'asl');
  for (const v of ['relative', 'Rel', 'zero', 'local', 'site'])
    assert.equal(normalizeDatum(v), 'relative');
  assert.equal(normalizeDatum('banana'), 'asl');
  assert.equal(normalizeDatum('banana', null), null);
});

test('gridRange honours the mask', () => {
  const values = Float32Array.from([1, 5, 9, Number.NaN]);
  assert.deepEqual(gridRange(values), { min: 1, max: 9 });
  assert.deepEqual(gridRange(values, Uint8Array.from([0, 1, 1, 1])), {
    min: 5,
    max: 9,
  });
  assert.equal(gridRange(values, new Uint8Array(4)), null);
});

test('relative levels start at 0 ft from the base', () => {
  const baseM = 250.3;
  const levels = contourLevels(baseM, baseM + 10, 10, baseM);
  assert.deepEqual(
    levels.map((l) => l.ft),
    [0, 10, 20, 30],
  );
  assert.ok(Math.abs(levels[1].m - (baseM + 10 / FEET_PER_METRE)) < 1e-9);
  assert.equal(levels[0].index, true);
});

test('buildContours relative datum counts from the lowest point inside the mask', () => {
  const width = 40;
  const height = 6;
  const values = plane(width, height).map((v) => v + 300);
  const mask = new Uint8Array(width * height);
  for (let r = 0; r < height; r++)
    for (let c = 10; c < width; c++) mask[r * width + c] = 1;
  const rel = buildContours(values, width, height, 10, {
    mask,
    smooth: false,
    datum: 'rel',
  });
  assert.equal(rel.datum, 'relative');
  assert.equal(rel.baseM, 310);
  assert.equal(rel.levels[0].ft, 0);
  const top = Math.floor((29 * FEET_PER_METRE) / 10) * 10;
  assert.equal(rel.levels.at(-1).ft, top);
  assert.ok(rel.lines.every((l) => l.ft >= 0 && l.ft <= top));
  const asl = buildContours(values, width, height, 10, { mask, smooth: false });
  assert.equal(asl.datum, 'asl');
  assert.equal(asl.baseM, 0);
  assert.ok(asl.levels[0].ft >= 310 * FEET_PER_METRE);
  // Same metres either way, only the labels change.
  assert.ok(Math.abs(rel.levels[1].m - (310 + 10 / FEET_PER_METRE)) < 1e-9);
});

test('labels: text per datum and anchors on the longest index lines', () => {
  assert.equal(formatElevationFt(905, 'asl'), '905 ft');
  assert.equal(formatElevationFt(40, 'relative'), '+40 ft');
  assert.equal(formatElevationFt(0, 'relative'), '0 ft');
  const lines = [
    {
      ft: 0,
      m: 1,
      index: true,
      points: [
        [0, 0],
        [1, 1],
      ],
    },
    {
      ft: 10,
      m: 2,
      index: false,
      points: [
        [0, 0],
        [1, 1],
        [2, 2],
      ],
    },
    {
      ft: 50,
      m: 3,
      index: true,
      points: [
        [0, 0],
        [1, 1],
        [2, 2],
        [3, 3],
      ],
    },
  ];
  const anchors = pickLabelAnchors(lines, 1);
  assert.deepEqual(anchors, [{ ft: 50, m: 3, point: [2, 2] }]);
  // Few index lines: minor lines are labelled after them.
  assert.deepEqual(
    pickLabelAnchors(lines).map((a) => a.ft),
    [50, 0, 10],
  );
  // Plenty of index lines: only those.
  const many = Array.from({ length: 5 }, (_, i) => ({
    ft: i * 50,
    m: i,
    index: true,
    points: [
      [0, 0],
      [1, 1],
    ],
  }));
  assert.equal(pickLabelAnchors([...many, lines[1]]).length, 5);
});
