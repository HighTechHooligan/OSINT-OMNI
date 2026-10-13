import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildingSurfaces,
  normalizeRates,
  priceSurfaces,
  quoteBuildings,
  quoteCsv,
} from './surfaceMath.js';
import { SQFT_PER_M2 } from './buildingMath.js';

// A 20 × 10 m box: footprint 200 m², perimeter 60 m.
const box = (tags = {}, heightM = 6, source = 'osm-height') => ({
  id: 'osm-way-1',
  kind: 'building',
  tags,
  center: [-93.3, 44.8],
  measure: { areaM2: 200, perimeterM: 60, lengthM: 20, widthM: 10 },
  height: { heightM, source },
});

const near = (a, b, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('flat roof: roof = footprint, walls = perimeter × height', () => {
  const s = buildingSurfaces(box({ 'roof:shape': 'flat' }));
  near(s.roofM2, 200);
  near(s.wallM2, 360);
  near(s.totalM2, 560);
  assert.deepEqual(s.assumed, []);
});

test('unknown roof shape is assumed flat and flagged', () => {
  const s = buildingSurfaces(box({}, 6, 'default'));
  near(s.roofM2, 200);
  assert.deepEqual(s.assumed, ['height', 'roof shape']);
});

test('gabled roof tilts the footprint and adds the gable triangles', () => {
  const s = buildingSurfaces(
    box({ 'roof:shape': 'gabled', 'roof:angle': '45' }, 10),
  );
  near(s.roofM2, 200 / Math.cos(Math.PI / 4));
  near(s.roofRiseM, 5); // tan 45° × half width
  near(s.eaveM, 5);
  near(s.wallM2, 60 * 5 + 10 * 5);
});

test('roof rise is capped so walls keep 40% of the height', () => {
  const s = buildingSurfaces(
    box({ 'roof:shape': 'hipped', 'roof:angle': '60' }, 5),
  );
  near(s.eaveM, 2);
});

test('min_height (a raised structure) shortens the walls', () => {
  const s = buildingSurfaces(box({ 'roof:shape': 'flat', min_height: '2' }, 6));
  near(s.wallM2, 60 * 4);
});

test('prices per ft² with a per-building minimum', () => {
  const s = buildingSurfaces(box({ 'roof:shape': 'flat' }));
  const p = priceSurfaces(s, {
    unit: 'ft2',
    roof: 0.1,
    wall: 0.05,
    minimum: 0,
  });
  near(p.roof, 200 * SQFT_PER_M2 * 0.1);
  near(p.wall, 360 * SQFT_PER_M2 * 0.05);
  const floor = priceSurfaces(s, {
    unit: 'm2',
    roof: 0.1,
    wall: 0.1,
    minimum: 500,
  });
  assert.equal(floor.price, 500);
  assert.ok(floor.minimumApplied);
});

test('quote sums buildings and skips roads and parks', () => {
  const q = quoteBuildings(
    [
      box({ 'roof:shape': 'flat' }),
      { id: 'r', kind: 'road' },
      box({ 'roof:shape': 'flat' }),
    ],
    { unit: 'm2', roof: 1, wall: 2 },
  );
  assert.equal(q.totals.count, 2);
  near(q.totals.totalM2, 1120);
  near(q.totals.price, 2 * (200 + 720));
  const csv = quoteCsv(q).split('\n');
  assert.equal(csv.length, 4);
  assert.match(csv[0], /roof_m2/);
  assert.match(csv[3], /^TOTAL \(2\),/);
});

test('bad rates fall back to the previous values', () => {
  const r = normalizeRates({ unit: 'acres', roof: -1, wall: 'x', minimum: 50 });
  assert.equal(r.unit, 'ft2');
  assert.equal(r.roof, 0.15);
  assert.equal(r.minimum, 50);
});
