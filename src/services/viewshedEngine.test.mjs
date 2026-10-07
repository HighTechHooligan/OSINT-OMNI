import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewshedEngine } from './viewshedEngine.js';
import { computeViewshedBand } from './viewshedMath.js';

function terrain(n) {
  const heights = new Float32Array(n * n);
  for (let i = 0; i < heights.length; i++)
    heights[i] =
      50 + 8 * Math.sin((i % n) / 5) + 6 * Math.cos(Math.floor(i / n) / 7);
  return {
    heights,
    width: n,
    height: n,
    cellXM: 3,
    cellYM: 3,
    observer: { col: 10, row: 12 },
    lowM: 1,
    highM: 2.5,
    targetM: 0,
  };
}

/** A fake worker that answers like viewshed.worker.js, in-process. */
function fakeWorker(log) {
  const listeners = new Set();
  return {
    addEventListener: (type, fn) => type === 'message' && listeners.add(fn),
    removeEventListener: (type, fn) => listeners.delete(fn),
    postMessage({ id, input }) {
      log.push(input.rows);
      const codes = computeViewshedBand(input);
      const [r0, r1] = input.rows;
      const data = {
        id,
        rows: input.rows,
        codes: codes.slice(r0 * input.width, r1 * input.width),
      };
      queueMicrotask(() => listeners.forEach((fn) => fn({ data })));
    },
    terminate() {},
  };
}

test('CPU pool splits rows across workers and matches one pass', async () => {
  const input = terrain(37);
  const log = [];
  const engine = createViewshedEngine({
    mode: 'cpu',
    workers: 3,
    makeWorker: () => fakeWorker(log),
  });
  assert.equal(engine.kind, 'CPU');
  assert.equal(engine.maxCells, 250_000);
  const out = await engine.compute(input);
  assert.deepEqual(log, [
    [0, 13],
    [13, 26],
    [26, 37],
  ]);
  assert.equal(out.engine, 'CPU ×3');
  assert.deepEqual(out.codes, computeViewshedBand(input));
  engine.destroy();
});

test('no Worker support: runs inline; no WebGL2 in Node: falls back to CPU', async () => {
  const input = terrain(21);
  const engine = createViewshedEngine({
    mode: 'dedicated',
    makeWorker: () => {
      throw new Error('no workers');
    },
  });
  assert.equal(engine.kind, 'CPU'); // dedicated asked, but no GPU here
  const out = await engine.compute(input);
  assert.equal(out.engine, 'CPU');
  assert.deepEqual(out.codes, computeViewshedBand(input));
  assert.throws(() => engine.setMode('quantum'), /Unknown GPU mode/);
  engine.setMode('integrated');
  assert.equal(engine.mode, 'integrated');
});

test('GPU names are shortened for the status line', async () => {
  const { shortRendererName } = await import('./viewshedGpu.js');
  assert.equal(
    shortRendererName(
      'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    ),
    'NVIDIA GeForce RTX 3080',
  );
  assert.equal(
    shortRendererName(
      'ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    ),
    'Intel(R) UHD Graphics 620',
  );
  assert.equal(shortRendererName('Apple M2 Pro'), 'Apple M2 Pro');
  assert.equal(shortRendererName(''), 'WebGL2');
});

test('GPU names are classed so an integrated GPU can be flagged', async () => {
  const { gpuClass } = await import('./viewshedGpu.js');
  const cases = {
    'NVIDIA GeForce RTX 4070 Laptop GPU': 'dedicated',
    'AMD Radeon RX 7900 XTX': 'dedicated',
    'Intel(R) Arc(TM) A770 Graphics': 'dedicated',
    'Intel(R) Iris(R) Xe Graphics': 'integrated',
    'Intel(R) UHD Graphics 620': 'integrated',
    'AMD Radeon(TM) Graphics': 'integrated',
    'AMD Radeon 780M Graphics': 'integrated',
    'Apple M2 Pro': 'unified',
    'SwiftShader Device (Subzero)': 'software',
    'Microsoft Basic Render Driver': 'software',
    WebGL2: 'unknown',
  };
  for (const [name, kind] of Object.entries(cases))
    assert.equal(gpuClass(name), kind, name);
});

test('integrated or software GPUs get steps to reach the dedicated one', async () => {
  const { dedicatedGpuAdvice } = await import('./viewshedGpu.js');
  const win = dedicatedGpuAdvice('integrated', 'Intel(R) Iris(R) Xe', 'Win32');
  assert.match(win, /Iris/);
  assert.match(win, /Settings > System > Display > Graphics/);
  assert.match(win, /High performance/);
  assert.match(
    dedicatedGpuAdvice('integrated', 'x', 'Linux x86_64'),
    /DRI_PRIME/,
  );
  assert.match(
    dedicatedGpuAdvice('software', 'SwiftShader', 'Win32'),
    /acceleration/,
  );
  assert.equal(dedicatedGpuAdvice('dedicated', 'RTX 4070', 'Win32'), null);
  assert.equal(dedicatedGpuAdvice('unified', 'Apple M2', 'MacIntel'), null);
});

test('observer budget shrinks with the cube of the reach', async () => {
  const { affordableObservers, ENGINE_WORK } =
    await import('./viewshedEngine.js');
  assert.equal(affordableObservers(ENGINE_WORK.gpu, 40), 2000); // long drive, coarse cells
  const near = affordableObservers(ENGINE_WORK.gpu, 333); // 1 km at 3 m
  assert.ok(near > 200 && near < 400, String(near));
  assert.equal(affordableObservers(ENGINE_WORK.cpu, 5000), 8); // never below 8
});
