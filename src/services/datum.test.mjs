import test from 'node:test';
import assert from 'node:assert/strict';
import { decimalYear, nad83ShiftAt, nad83ToWgs84 } from './datum.js';

test('NAD83 → WGS84 shift in Minneapolis is ~1.4 m, mostly west', () => {
  const s = nad83ShiftAt(-93.265, 44.977, 2026.75);
  const m = Math.hypot(s.eastM, s.northM);
  assert.ok(m > 1.0 && m < 2.0, `shift ${m.toFixed(3)} m`);
  assert.ok(s.eastM < 0, 'WGS84 lies west of NAD83 here');
});

test('shift is computed per location and grows with epoch (plate motion)', () => {
  const mn = nad83ShiftAt(-93.265, 44.977, 2026.75);
  const fl = nad83ShiftAt(-80.19, 25.76, 2026.75);
  assert.ok(Math.hypot(mn.eastM - fl.eastM, mn.northM - fl.northM) > 0.3);
  const early = nad83ShiftAt(-93.265, 44.977, 2010);
  const late = nad83ShiftAt(-93.265, 44.977, 2030);
  const growth =
    Math.hypot(late.eastM, late.northM) - Math.hypot(early.eastM, early.northM);
  assert.ok(growth > 0.1 && growth < 0.6, `growth ${growth}`);
});

test('nad83ToWgs84 is a small, smooth shift', () => {
  const [lon, lat] = nad83ToWgs84(-93.265, 44.977, 2026.75);
  assert.ok(Math.abs(lon + 93.265) < 1e-4);
  assert.ok(Math.abs(lat - 44.977) < 1e-4);
  const a = nad83ShiftAt(-93.27, 44.97, 2026.75);
  const b = nad83ShiftAt(-93.26, 44.98, 2026.75);
  assert.ok(Math.abs(a.eastM - b.eastM) < 1e-3, 'constant across a site');
});

test('decimalYear', () => {
  assert.equal(decimalYear(new Date(Date.UTC(2026, 0, 1))), 2026);
  const mid = decimalYear(new Date(Date.UTC(2026, 6, 2, 12)));
  assert.ok(Math.abs(mid - 2026.5) < 0.01);
});
