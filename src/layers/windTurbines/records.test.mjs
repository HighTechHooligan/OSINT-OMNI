import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeSummary,
  describeTurbine,
  dotSize,
  nearestTurbine,
  snapBbox,
  tipClass,
} from './records.js';

test('view boxes snap outward so small pans reuse a load', () => {
  assert.deepEqual(
    snapBbox({ west: -100.03, south: 32.01, east: -99.96, north: 32.07 }),
    { west: -100.05, south: 32, east: -99.95, north: 32.1 },
  );
  assert.deepEqual(
    snapBbox({ west: -100.04, south: 32.02, east: -99.97, north: 32.06 }),
    snapBbox({ west: -100.03, south: 32.01, east: -99.96, north: 32.07 }),
  );
  assert.equal(snapBbox({ west: 1, south: 0, east: 0, north: 1 }), null);
});

test('styling and descriptions', () => {
  assert.equal(tipClass(null), 'unknown');
  assert.equal(tipClass(90), 'low');
  assert.equal(tipClass(160), 'tall');
  assert.equal(tipClass(210), 'xl');
  assert.ok(dotSize(5000) > dotSize(1500));
  assert.ok(dotSize(1e9) <= 11);
  const t = {
    id: '1',
    lon: -100,
    lat: 32,
    manufacturer: 'Vestas',
    model: 'V110',
    kw: 2000,
    hubM: 80,
    rotorM: 110,
    tipM: 135,
    year: 2015,
    project: 'Roscoe',
    state: 'TX',
  };
  assert.match(describeTurbine(t), /^Vestas V110 · 2000 kW · hub 80 m/);
  assert.match(
    describeSummary({
      sampled: false,
      turbines: [t],
      summary: {
        turbines: 1,
        mw: 2,
        projects: 1,
        topProjects: [{ name: 'Roscoe', count: 1 }],
        tallest: { tipM: 135, project: 'Roscoe' },
      },
    }),
    /1 turbines in view · 2 MW · 1 projects · largest: Roscoe/,
  );
  assert.match(describeSummary({ summary: { turbines: 0 } }), /US only/);
  const hit = nearestTurbine([t, { ...t, id: '2', lon: -99 }], -99.1, 32);
  assert.equal(hit.turbine.id, '2');
  assert.ok(hit.km > 9 && hit.km < 10);
});
