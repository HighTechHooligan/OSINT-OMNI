import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ORBIT_DEFAULTS,
  SITE_PRESETS,
  haversineMeters,
  normalizeBoundary,
  orbitFileName,
  summarizeBoundary,
} from './siteOrbit.js';

test('haversine measures known distances', () => {
  // One degree of latitude is ~111.2 km anywhere.
  const d = haversineMeters([-93, 44], [-93, 45]);
  assert.ok(Math.abs(d - 111_195) < 100, `got ${d}`);
  assert.equal(haversineMeters([10, 10], [10, 10]), 0);
});

test('normalizeBoundary closes open rings and drops bad vertices', () => {
  const ring = normalizeBoundary([
    [0, 0],
    [1, 0],
    ['x', 5],
    [1, 1],
    [999, 0],
  ]);
  assert.deepEqual(ring, [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 0],
  ]);
});

test('normalizeBoundary keeps an already-closed ring unchanged', () => {
  const closed = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 0],
  ];
  assert.deepEqual(normalizeBoundary(closed), closed);
});

test('normalizeBoundary rejects rings with fewer than three valid points', () => {
  assert.throws(
    () =>
      normalizeBoundary([
        [0, 0],
        [1, 1],
      ]),
    /at least 3/,
  );
  assert.throws(() => normalizeBoundary('nope'), TypeError);
});

test('Hyland preset summarizes to the surveyed site', () => {
  const { center, radiusM } = summarizeBoundary(SITE_PRESETS.hyland.boundary);
  assert.ok(Math.abs(center.lat - 44.8434) < 0.001);
  assert.ok(Math.abs(center.lon - -93.3651) < 0.001);
  // Site is ~2,500 ft (~760 m) north-south; half-diagonal sits near 400 m.
  assert.ok(radiusM > 300 && radiusM < 500, `radius ${radiusM}`);
  assert.equal(SITE_PRESETS.hyland.points.length, 6);
});

test('summarizeBoundary enforces a minimum radius for tiny sites', () => {
  const { radiusM } = summarizeBoundary([
    [0, 0],
    [0.00001, 0],
    [0.00001, 0.00001],
    [0, 0],
  ]);
  assert.equal(radiusM, 50);
});

test('orbitFileName builds a safe GIF name', () => {
  assert.equal(
    orbitFileName(SITE_PRESETS.hyland.name),
    'hyland_hills_lidar_orbit.gif',
  );
  assert.equal(orbitFileName('  '), 'site_orbit.gif');
  assert.equal(orbitFileName('Lot 7 / Phase 2'), 'lot_7_phase_2_orbit.gif');
});

test('GIF defaults give a smooth ~6 second loop', () => {
  assert.equal(ORBIT_DEFAULTS.frames, 144);
  const seconds = (ORBIT_DEFAULTS.frames * ORBIT_DEFAULTS.delayMs) / 1000;
  assert.ok(seconds > 5 && seconds < 7, `${seconds}s`);
  // Browsers slow GIF frames shorter than 20 ms to ~100 ms.
  assert.ok(ORBIT_DEFAULTS.delayMs >= 20);
});
