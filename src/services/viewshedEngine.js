/**
 * Runs a band viewshed on the fastest engine available:
 *  1. GPU (WebGL2 shader, viewshedGpu.js): exact, a million cells in well
 *     under a second.
 *  2. CPU worker pool (viewshed.worker.js): rows split across cores, off the
 *     main thread.
 *  3. Inline on the main thread (tests, or no Worker support).
 * All three return the same BAND codes.
 */
import { computeViewshedBand, computeViewshedMulti } from './viewshedMath.js';
import { createGpuViewshed, gpuClass } from './viewshedGpu.js';

/** Grid budgets: how many cells each engine handles comfortably in < 1 s. */
export const ENGINE_MAX_CELLS = Object.freeze({
  gpu: 1_000_000,
  cpu: 250_000,
  // Routes and areas: each observer only walks the cells within its reach,
  // so a long corridor can use a bigger grid.
  gpuWide: 4_000_000,
  cpuWide: 250_000,
});

/**
 * Sight-line steps (texel reads) each engine gets through in about a second
 * for a route or area. One observer with a reach of r cells costs about
 * π·r³/2 steps, so this sets how many observers a run can afford.
 */
export const ENGINE_WORK = Object.freeze({
  gpu: 1.5e10, // dedicated
  integrated: 4e9,
  cpu: 5e8, // worker pool, or a software GPU
});

/** Observers a run can afford with a reach of `reachCells` grid cells. */
export function affordableObservers(work, reachCells) {
  const per = (Math.PI * Math.max(1, reachCells) ** 3) / 2;
  return Math.max(8, Math.min(2000, Math.floor(work / per)));
}

/** GPU choices offered in the UI, mapped to WebGL power preferences. */
export const GPU_MODES = Object.freeze({
  dedicated: 'high-performance',
  integrated: 'low-power',
  cpu: null,
});

export function createViewshedEngine({
  mode = 'dedicated',
  workers = Math.max(
    1,
    Math.min(8, (globalThis.navigator?.hardwareConcurrency || 2) - 1),
  ),
  makeWorker = () =>
    new Worker(new URL('./viewshed.worker.js', import.meta.url), {
      type: 'module',
    }),
} = {}) {
  let gpu;
  let gpuMode = mode in GPU_MODES ? mode : 'dedicated';
  let gpuFailed = gpuMode === 'cpu';
  let pool = null;
  let nextId = 0;

  function getGpu() {
    if (gpuFailed) return null;
    if (gpu === undefined)
      gpu = createGpuViewshed({ powerPreference: GPU_MODES[gpuMode] });
    if (!gpu) gpuFailed = true;
    return gpu;
  }

  function getPool() {
    if (pool !== null) return pool;
    try {
      pool = Array.from({ length: workers }, makeWorker);
    } catch {
      pool = [];
    }
    return pool;
  }

  function runWorker(worker, input) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const onMessage = (event) => {
        if (event.data?.id !== id) return;
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        if (event.data.error) reject(new Error(event.data.error));
        else resolve(event.data);
      };
      const onError = (event) => {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        reject(new Error(event?.message || 'viewshed worker failed'));
      };
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      worker.postMessage({ id, input });
    });
  }

  async function onCpuMulti(input) {
    const list = getPool();
    if (!list.length) {
      const { codes, used } = computeViewshedMulti(input);
      return { codes, used, engine: 'CPU' };
    }
    const per = Math.ceil(input.observers.length / list.length);
    const parts = await Promise.all(
      list.map((worker, k) => {
        const share = input.observers.slice(k * per, (k + 1) * per);
        return share.length
          ? runWorker(worker, { ...input, observers: share })
          : null;
      }),
    );
    const codes = new Uint8Array(input.width * input.height);
    let used = 0;
    for (const part of parts) {
      if (!part) continue;
      used += part.used;
      const c = part.codes;
      for (let i = 0; i < codes.length; i++)
        if (c[i] > codes[i]) codes[i] = c[i];
    }
    return { codes, used, engine: `CPU ×${list.length}` };
  }

  async function onCpu(input) {
    if (input.observers) return onCpuMulti(input);
    const list = getPool();
    if (!list.length)
      return { codes: computeViewshedBand(input), engine: 'CPU' };
    const per = Math.ceil(input.height / list.length);
    const parts = await Promise.all(
      list.map((worker, k) => {
        const r0 = k * per;
        const r1 = Math.min(input.height, r0 + per);
        return r0 < r1 ? runWorker(worker, { ...input, rows: [r0, r1] }) : null;
      }),
    );
    const codes = new Uint8Array(input.width * input.height);
    for (const part of parts)
      if (part) codes.set(part.codes, part.rows[0] * input.width);
    return { codes, engine: `CPU ×${list.length}` };
  }

  /**
   * @param {object} input computeViewshedBand input (heights, width, height,
   *   cellXM, cellYM, observer, lowM, highM, targetM, mask)
   * @returns {Promise<{codes: Uint8Array, engine: string, ms: number}>}
   */
  async function compute(input) {
    const t0 = performance.now();
    const g = getGpu();
    if (g && input.width <= g.maxSide && input.height <= g.maxSide) {
      try {
        const codes = g.compute(input);
        return {
          codes,
          used: codes.used,
          engine: `GPU (${g.renderer})`,
          ms: performance.now() - t0,
        };
      } catch (error) {
        if (error instanceof RangeError && /observer/.test(error.message))
          throw error;
        gpuFailed = true; // context lost or driver trouble: use the CPU
      }
    }
    const out = await onCpu(input);
    return { ...out, ms: performance.now() - t0 };
  }

  return {
    compute,
    /** Cell budget for the engine compute() will use. */
    get maxCells() {
      return getGpu() ? ENGINE_MAX_CELLS.gpu : ENGINE_MAX_CELLS.cpu;
    },
    /** Sight-line steps per run for routes and areas (see ENGINE_WORK). */
    get work() {
      const g = getGpu();
      const kind = g ? gpuClass(g.renderer) : 'cpu';
      if (kind === 'integrated' || kind === 'unified')
        return ENGINE_WORK.integrated;
      return kind === 'software' || kind === 'cpu'
        ? ENGINE_WORK.cpu
        : ENGINE_WORK.gpu;
    },
    /** Cell budget for routes and areas (reach-limited observers). */
    get maxCellsWide() {
      return getGpu() ? ENGINE_MAX_CELLS.gpuWide : ENGINE_MAX_CELLS.cpuWide;
    },
    get kind() {
      return getGpu() ? 'GPU' : 'CPU';
    },
    get mode() {
      return gpuMode;
    },
    /** GPU name in use, or null on the CPU. */
    get renderer() {
      return getGpu()?.renderer ?? null;
    },
    /** gpuClass() of the GPU in use, or null on the CPU. */
    get gpuKind() {
      const g = getGpu();
      return g ? gpuClass(g.renderer) : null;
    },
    /** 'dedicated' | 'integrated' | 'cpu': drops the old context and retries. */
    setMode(next) {
      if (!(next in GPU_MODES)) throw new Error(`Unknown GPU mode: ${next}`);
      if (next === gpuMode && !gpuFailed) return;
      gpu?.destroy();
      gpu = undefined;
      gpuMode = next;
      gpuFailed = next === 'cpu';
    },
    destroy() {
      gpu?.destroy();
      gpu = null;
      for (const w of pool ?? []) w.terminate?.();
      pool = null;
    },
  };
}
