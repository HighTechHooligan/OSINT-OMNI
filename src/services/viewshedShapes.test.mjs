import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeShape,
  distanceToShapeM,
  expandBbox,
  normalizeShape,
  parseShapeText,
  pathLengthM,
  planDemTiles,
  pointsAlongPath,
  pointsInRing,
  shapeBbox,
  shapeObservers,
  workCellM,
} from './viewshedShapes.js';
import {
  BAND,
  computeViewshedBand,
  computeViewshedMulti,
} from './viewshedMath.js';

// About 1 km east-west at 45° N is 0.0127° of longitude.
const KM_LON = 1000 / (111_320 * Math.cos(Math.PI / 4));
const KM_LAT = 1000 / 111_320;

test('shapes are validated and closed', () => {
  assert.deepEqual(normalizeShape({ kind: 'point', at: [-93, 45] }), {
    kind: 'point',
    at: [-93, 45],
  });
  const area = normalizeShape({
    kind: 'area',
    ring: [
      [0, 0],
      [1, 0],
      [1, 1],
    ],
  });
  assert.deepEqual(area.ring.at(-1), [0, 0]);
  assert.throws(
    () => normalizeShape({ kind: 'line', path: [[0, 0]] }),
    /2 points/,
  );
  assert.throws(() => normalizeShape({ kind: 'point', at: [0, 99] }), /Bad/);
});

test('points along a route keep their spacing across corners', () => {
  const path = [
    [-93, 45],
    [-93 + KM_LON, 45],
    [-93 + KM_LON, 45 + KM_LAT],
  ];
  assert.ok(Math.abs(pathLengthM(path) - 2000) < 2);
  const pts = pointsAlongPath(path, 100);
  assert.equal(pts.length, 21); // 0, 100, …, 2000 m
  assert.deepEqual(pts[0], path[0]);
  assert.deepEqual(pts.at(-1), path.at(-1));
});

test('area observers cover the inside, and the count is capped', () => {
  const ring = [
    [-93, 45],
    [-93 + KM_LON, 45],
    [-93 + KM_LON, 45 + KM_LAT],
    [-93, 45 + KM_LAT],
    [-93, 45],
  ];
  const pts = pointsInRing(ring, 100);
  // 40 edge points + a 10 × 10 lattice inside
  assert.ok(pts.length >= 130 && pts.length <= 150, String(pts.length));
  const capped = shapeObservers({ kind: 'area', ring }, 1, 500);
  assert.ok(capped.points.length <= 500);
  assert.ok(capped.spacingM > 40);
  const route = shapeObservers({ kind: 'line', path: [ring[0], ring[2]] }, 5);
  assert.ok(route.points.length <= 2000 && route.spacingM === 5);
  assert.ok(Math.abs(describeShape({ kind: 'area', ring }).areaM2 - 1e6) < 2e4);
});

test('distance to a shape, bbox growth and a corridor of 3DEP tiles', () => {
  const line = {
    kind: 'line',
    path: [
      [-93, 45],
      [-93 + 40 * KM_LON, 45 + 40 * KM_LAT],
    ],
  };
  assert.ok(distanceToShapeM([-93 + 20 * KM_LON, 45 + 20 * KM_LAT], line) < 5);
  assert.ok(Math.abs(distanceToShapeM([-93 - KM_LON, 45], line) - 1000) < 5);
  const bbox = expandBbox(shapeBbox(line), 1000);
  const all = planDemTiles(bbox, 20);
  const corridor = planDemTiles(bbox, 20, line, 1000);
  assert.ok(all.length >= 64, String(all.length));
  assert.ok(
    corridor.length < all.length / 2,
    `${corridor.length}/${all.length}`,
  );
  // Small areas stay one request.
  assert.equal(
    planDemTiles(
      expandBbox(shapeBbox({ kind: 'point', at: [-93, 45] }), 1000),
      2,
    ).length,
    1,
  );
});

test('routes and areas from KML or coordinate lists', () => {
  const kml =
    '<kml><LineString><coordinates>-93.1,45.1,0 -93.2,45.2,0</coordinates></LineString></kml>';
  assert.deepEqual(parseShapeText(kml).path, [
    [-93.1, 45.1],
    [-93.2, 45.2],
  ]);
  const area = parseShapeText('45,-93; 45.01,-93; 45.01,-92.99', 'area');
  assert.equal(area.kind, 'area');
  assert.equal(area.ring.length, 4);
});

test('many observers: each looks only within its reach, best result wins', () => {
  const n = 61;
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
    lowM: 0,
    highM: 2.5,
  };
  const a = { col: 10, row: 30 };
  const b = { col: 50, row: 30 };
  const one = computeViewshedBand({ ...base, observer: a, maxDistM: 30 });
  const full = computeViewshedBand({ ...base, observer: a });
  for (let i = 0; i < one.length; i++) {
    const d = Math.hypot(((i % n) - 10) * 2, (Math.floor(i / n) - 30) * 2);
    assert.equal(one[i], d > 30 ? BAND.NONE : full[i], `cell ${i}`);
  }
  const { codes, used } = computeViewshedMulti({
    ...base,
    observers: [a, b],
    maxDistM: 30,
  });
  assert.equal(used, 2);
  const oneB = computeViewshedBand({ ...base, observer: b, maxDistM: 30 });
  for (let i = 0; i < codes.length; i++)
    assert.equal(codes[i], Math.max(one[i], oneB[i]));
});

test('cell size for a route or area fits the engine work budget', () => {
  const route = {
    kind: 'line',
    path: [
      [-93, 45],
      [-93 + 1.58 * KM_LON, 45],
    ],
  };
  const fast = workCellM(route, 1000, 1.5e10);
  const slow = workCellM(route, 1000, 1.5e9);
  assert.ok(fast > 1.5 && fast < 4, String(fast));
  assert.ok(slow > fast * 1.5, `${slow} vs ${fast}`);
  assert.equal(workCellM({ kind: 'point', at: [0, 0] }, 1000, 1e9), 0);
});
