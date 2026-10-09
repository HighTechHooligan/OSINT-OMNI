/**
 * CPU viewshed worker: computes a slice of rows with
 * viewshedMath.computeViewshedBand, or a share of the observers of a route
 * or area with computeViewshedMulti, so the main thread stays responsive
 * and several cores share the work.
 */
import { computeViewshedBand, computeViewshedMulti } from './viewshedMath.js';

self.onmessage = (event) => {
  const { id, input } = event.data;
  try {
    if (input.observers) {
      const { codes, used } = computeViewshedMulti(input);
      self.postMessage({ id, codes, used }, [codes.buffer]);
      return;
    }
    const codes = computeViewshedBand(input);
    const [r0, r1] = input.rows;
    const slice = codes.slice(r0 * input.width, r1 * input.width);
    self.postMessage({ id, rows: input.rows, codes: slice }, [slice.buffer]);
  } catch (error) {
    self.postMessage({ id, error: error?.message || String(error) });
  }
};
