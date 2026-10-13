import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pickModelIds,
  siteCard,
  turbineCard,
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

test('turbine and site cards say what it is', () => {
  const card = turbineCard({
    id: '3038257',
    lon: -100.36,
    lat: 32.47,
    manufacturer: 'Vestas',
    model: 'V110-2.0',
    kw: 2000,
    hubM: 80,
    rotorM: 110,
    tipM: 135,
    project: 'Roscoe',
    year: 2008,
    county: 'Nolan County',
    state: 'TX',
    faaOrs: '48-012345',
  });
  assert.equal(card.title, 'WIND TURBINE · Vestas V110-2.0');
  assert.ok(card.details.includes('Capacity 2,000 kW'));
  assert.ok(card.details.includes('Rotor 110 m · blade tip 135 m'));
  assert.ok(card.details.some((l) => /FAA ORS 48-012345/.test(l)));
  assert.match(
    turbineCard({ id: '1', lon: 0, lat: 0, hubM: null }, { estimatedHub: true })
      .details[1],
    /unknown \(model height estimated\)/,
  );
  const site = siteCard({
    name: 'Roscoe',
    turbines: 627,
    mw: 781.5,
    years: [2008, 2009],
    models: [{ name: 'Mitsubishi MWT-1000A', count: 209 }],
    state: 'TX',
  });
  assert.equal(site.title, 'WIND FARM · Roscoe');
  assert.match(site.details[0], /^627 turbines · 781.5 MW · online 2008–2009$/);
  assert.equal(site.details[1], 'Mitsubishi MWT-1000A × 209');
});

test('3D models go to the nearest turbines within range', () => {
  const turbines = [];
  for (let i = 0; i < 50; i++)
    turbines.push({ id: String(i), lon: -100 + i * 0.01, lat: 32 });
  const near = pickModelIds(turbines, -100, 32, { max: 5, rangeKm: 15 });
  assert.deepEqual([...near].sort(), ['0', '1', '2', '3', '4']);
  const ranged = pickModelIds(turbines, -100, 32, { max: 400, rangeKm: 2 });
  assert.equal(ranged.size, 3);
  assert.equal(pickModelIds(turbines, NaN, 32).size, 0);
});
