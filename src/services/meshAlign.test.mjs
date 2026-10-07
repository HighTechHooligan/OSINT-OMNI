import test from 'node:test';
import assert from 'node:assert/strict';
import { bilinear, estimateMeshOffset } from './meshAlign.js';

const W = 160;
const H = 160;
const PX = 1; // metres per pixel

/** Rolling terrain with features in both axes (metres at metre coords). */
const terrain = (eM, sM) =>
  250 +
  6 * Math.sin(eM / 23) +
  4 * Math.cos(sM / 17) +
  2 * Math.sin((eM + sM) / 9);

function demGrid() {
  const values = new Float32Array(W * H);
  for (let r = 0; r < H; r++)
    for (let c = 0; c < W; c++) values[r * W + c] = terrain(c * PX, r * PX);
  return { values, width: W, height: H, pxEastM: PX, pxSouthM: PX };
}

/** Deterministic PRNG. */
function rng(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

/**
 * Mesh = the true ground drawn `eastM`/`northM` away from where the DEM puts
 * it, plus a vertical bias, plus trees/roofs on some samples.
 */
function meshSamples({ eastM, northM, bias = 31.2, coverFrac = 0.3 }) {
  const rand = rng(7);
  const out = [];
  for (let k = 0; k < 1500; k++) {
    const x = 20 + rand() * (W - 40);
    const y = 20 + rand() * (H - 40);
    // Location x,y on screen shows terrain from (x - east, y + north).
    let h = terrain((x - eastM / PX) * PX, (y + northM / PX) * PX) + bias;
    if (rand() < coverFrac) h += 4 + rand() * 12;
    h += (rand() - 0.5) * 0.2; // mesh noise
    out.push({ x, y, h });
  }
  return out;
}

test('bilinear interpolates and rejects off-grid points', () => {
  const v = new Float32Array([0, 1, 2, 3]);
  assert.equal(bilinear(v, 2, 2, 0.5, 0.5), 1.5);
  assert.ok(Number.isNaN(bilinear(v, 2, 2, -0.1, 0)));
  assert.equal(bilinear(v, 2, 2, 1, 1), 3);
});

test('recovers a ~4 m (13 ft) offset through vegetation and vertical bias', () => {
  const r = estimateMeshOffset(
    demGrid(),
    meshSamples({ eastM: 3, northM: -2.5 }),
  );
  assert.equal(r.ok, true, r.reason);
  assert.ok(Math.abs(r.eastM - 3) <= 0.25, `east ${r.eastM}`);
  assert.ok(Math.abs(r.northM + 2.5) <= 0.25, `north ${r.northM}`);
  assert.ok(Math.abs(r.biasM - 31.2) < 0.3);
});

test('an already-aligned mesh gets no shift', () => {
  const r = estimateMeshOffset(demGrid(), meshSamples({ eastM: 0, northM: 0 }));
  assert.equal(r.eastM, 0);
  assert.equal(r.northM, 0);
});

test('flat ground yields no offset rather than a guess', () => {
  const g = demGrid();
  g.values.fill(250);
  const r = estimateMeshOffset(g, meshSamples({ eastM: 3, northM: 3 }));
  assert.equal(r.ok, false);
  assert.equal(r.eastM, 0);
  assert.equal(r.northM, 0);
});

test('too few samples or mostly canopy is refused', () => {
  assert.equal(estimateMeshOffset(demGrid(), []).ok, false);
  const r = estimateMeshOffset(
    demGrid(),
    meshSamples({ eastM: 2, northM: 2, coverFrac: 0.95 }),
  );
  assert.equal(r.ok, false);
});
