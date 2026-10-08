import { solveRoute } from './solveRoute.js';

/**
 * Run solveRoute in a module worker (phone and desktop), so building a large
 * road graph never freezes the map. Falls back to solving in place where
 * workers are missing (tests, old browsers).
 */
export function createWorkerSolver() {
  if (typeof globalThis.Worker !== 'function')
    return async (input) => solveRoute(input);
  let worker = null;
  let seq = 0;
  const pending = new Map();
  const start = () => {
    // Written out literally so Vite bundles the worker and its imports.
    worker = new Worker(new URL('./solveWorker.js', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = ({ data }) => {
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      if (data.error) p.reject(new Error(data.error));
      else p.resolve(data.result);
    };
    worker.onerror = (event) => {
      for (const p of pending.values())
        p.reject(new Error(event.message || 'Route worker failed'));
      pending.clear();
      worker = null;
    };
  };
  const solve = (input) =>
    new Promise((resolve, reject) => {
      if (!worker) start();
      const id = ++seq;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, input });
    });
  solve.terminate = () => {
    worker?.terminate();
    worker = null;
  };
  return solve;
}
