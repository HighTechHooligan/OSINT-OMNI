/**
 * Runs a band viewshed on the fastest engine available:
 *  1. GPU (WebGL2 shader, viewshedGpu.js): exact, a million cells in well
 *     under a second.
 *  2. CPU worker pool (viewshed.worker.js): rows split across cores, off the
 *     main thread.
 *  3. Inline on the main thread (tests, or no Worker support).
 * All three return the same BAND codes.
 */
import { computeViewshedBand } from './viewshedMath.js';
import { createGpuViewshed } from './viewshedGpu.js';

/** Grid budgets: how many cells each engine handles comfortably in < 1 s. */
export const ENGINE_MAX_CELLS = Object.freeze({
  gpu: 1_000_000,
  cpu: 250_000,
});

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

  async function onCpu(input) {
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
