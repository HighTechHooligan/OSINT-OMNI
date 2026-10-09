/**
 * Runs a band viewshed on the fastest engine available:
 *  1. GPU (WebGL2 shader, viewshedGpu.js): exact, a million cells in well
 *     under a second.
 *  2. CPU worker pool (viewshed.worker.js): rows split across cores, off the
 *     main thread.
 *  3. Inline on the main thread (tests, or no Worker support).
 * All three return the same BAND codes. With the `hybrid` budget on, a
 * route or area runs on both: the CPU workers take a share of the observers
 * (sized to their speed relative to the GPU) while the GPU draws the rest,
 * and the two results merge with MAX.
 *
 * How much of the machine a run may use (workers, GPU work, grid sizes,
 * draw batch size) comes from resourceBudgets.js and is read per run.
 */
import { computeViewshedBand, computeViewshedMulti } from './viewshedMath.js';
import { createGpuViewshed, gpuClass } from './viewshedGpu.js';
import { resourceBudgets } from './resourceBudgets.js';

/**
 * Base grid budgets (the `balanced` profile): how many cells each engine
 * handles comfortably in < 1 s. The budgets in force come from
 * resourceBudgets (pointCellsGpu, wideCellsGpu, cpuCells).
 */
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
 * for a route or area, before the `gpuWorkScale` budget multiplies them
 * (×4 on the `high` profile: a run of a few seconds with a finer grid and
 * more observers). One observer with a reach of r cells costs about
 * π·r³/2 steps, so this sets how many observers a run can afford.
 */
export const ENGINE_WORK = Object.freeze({
  gpu: 1.5e10, // dedicated
  integrated: 4e9,
  cpu: 5e8, // worker pool, or a software GPU
});

/** CPU workers the ENGINE_WORK.cpu figure was measured with. */
const CPU_WORK_WORKERS = 7;

/**
 * Observers a run can afford with a reach of `reachCells` grid cells, up to
 * `cap` (the maxObservers budget).
 */
export function affordableObservers(work, reachCells, cap = 2000) {
  const per = (Math.PI * Math.max(1, reachCells) ** 3) / 2;
  return Math.max(8, Math.min(cap, Math.floor(work / per)));
}

/**
 * Share of a route's observers to give the CPU workers when they run
 * alongside the GPU: their speed over the sum of both, never above half.
 */
export function cpuShare(gpuWork, workers) {
  const cpu = ENGINE_WORK.cpu * (Math.max(0, workers) / CPU_WORK_WORKERS);
  if (!(gpuWork > 0) || cpu <= 0) return 0;
  return Math.min(0.5, cpu / (cpu + gpuWork));
}

/** GPU choices offered in the UI, mapped to WebGL power preferences. */
export const GPU_MODES = Object.freeze({
  dedicated: 'high-performance',
  integrated: 'low-power',
  cpu: null,
});

export function createViewshedEngine({
  mode = 'dedicated',
  budgets = () => resourceBudgets.get(),
  workers = null, // fixed worker count; null = the cpuWorkers budget
  createGpu = createGpuViewshed,
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
      gpu = createGpu({ powerPreference: GPU_MODES[gpuMode] });
    if (!gpu) gpuFailed = true;
    return gpu;
  }

  const workerCount = () =>
    Math.max(1, Math.floor(workers ?? budgets().cpuWorkers ?? 1));

  /** The worker pool, rebuilt when the cpuWorkers budget changes. */
  function getPool() {
    const want = workerCount();
    if (pool !== null && (pool.length === want || pool.failed)) return pool;
    for (const w of pool ?? []) w.terminate?.();
    try {
      pool = Array.from({ length: want }, makeWorker);
    } catch {
      pool = [];
      pool.failed = true;
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

  async function onCpuMulti(input, list = getPool()) {
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
  function gpuWorkOf(g) {
    const kind = g ? gpuClass(g.renderer) : 'cpu';
    if (kind === 'integrated' || kind === 'unified')
      return ENGINE_WORK.integrated;
    return kind === 'software' || kind === 'cpu'
      ? ENGINE_WORK.cpu
      : ENGINE_WORK.gpu;
  }

  /**
   * GPU and CPU workers together on a route or area: the workers get their
   * share of the observers first (they run in parallel threads), the GPU
   * draws the rest on this thread, then both merge.
   */
  async function computeHybrid(g, input, b, t0) {
    const list = getPool();
    const share = cpuShare(gpuWorkOf(g), list.length);
    const n = input.observers.length;
    const cpuN = Math.floor(n * share);
    // Each worker gets its own copy of the heights; keep the copies under
    // about a gigabyte.
    const bytes = input.width * input.height * 8;
    const fit = Math.max(1, Math.floor(1024 ** 3 / Math.max(1, bytes)));
    // At least four observers per worker, so a thread is worth its copy.
    const use = list.slice(0, Math.min(list.length, fit, Math.floor(cpuN / 4)));
    if (!use.length) return null;
    // Spread the CPU's observers along the shape so both halves stay even.
    const step = n / cpuN;
    const cpuObs = [];
    const gpuObs = [];
    let nextPick = 0;
    for (let i = 0; i < n; i++) {
      if (i >= Math.round(nextPick) && cpuObs.length < cpuN) {
        cpuObs.push(input.observers[i]);
        nextPick += step;
      } else gpuObs.push(input.observers[i]);
    }
    const cpuRun = onCpuMulti({ ...input, observers: cpuObs }, use);
    const codes = g.compute({
      ...input,
      observers: gpuObs,
      batchCells: b.gpuBatchCells,
    });
    const cpu = await cpuRun;
    const c = cpu.codes;
    for (let i = 0; i < codes.length; i++) if (c[i] > codes[i]) codes[i] = c[i];
    return {
      codes,
      used: (codes.used ?? 0) + cpu.used,
      engine: `GPU (${g.renderer}) + CPU ×${use.length}`,
      split: { gpu: gpuObs.length, cpu: cpuObs.length },
      ms: performance.now() - t0,
    };
  }

  async function compute(input) {
    const t0 = performance.now();
    const g = getGpu();
    const b = budgets();
    if (g && input.width <= g.maxSide && input.height <= g.maxSide) {
      try {
        if (b.hybrid && input.observers?.length >= 32) {
          const out = await computeHybrid(g, input, b, t0);
          if (out) return out;
        }
        const codes = g.compute({ ...input, batchCells: b.gpuBatchCells });
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
      const g = getGpu();
      const b = budgets();
      return g ? Math.min(b.pointCellsGpu, g.maxSide * g.maxSide) : b.cpuCells;
    },
    /**
     * Sight-line steps per run for routes and areas (see ENGINE_WORK),
     * times the gpuWorkScale budget; on the CPU, scaled by the worker count.
     */
    get work() {
      const g = getGpu();
      const b = budgets();
      const base = g
        ? gpuWorkOf(g)
        : ENGINE_WORK.cpu * (workerCount() / CPU_WORK_WORKERS);
      return base * b.gpuWorkScale;
    },
    /** Observer cap for routes and areas (maxObservers budget). */
    get maxObservers() {
      return budgets().maxObservers;
    },
    /** Cell budget for routes and areas (reach-limited observers). */
    get maxCellsWide() {
      const g = getGpu();
      const b = budgets();
      return g ? Math.min(b.wideCellsGpu, g.maxSide * g.maxSide) : b.cpuCells;
    },
    /** CPU workers a CPU or hybrid run uses. */
    get workers() {
      return workerCount();
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
