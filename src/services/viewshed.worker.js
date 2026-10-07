/**
 * CPU viewshed worker: computes a slice of rows with
 * viewshedMath.computeViewshedBand so the main thread stays responsive and
 * several cores share a big grid.
 */
import { computeViewshedBand } from './viewshedMath.js';

self.onmessage = (event) => {
  const { id, input } = event.data;
  try {
    const codes = computeViewshedBand(input);
    const [r0, r1] = input.rows;
    const slice = codes.slice(r0 * input.width, r1 * input.width);
    self.postMessage({ id, rows: input.rows, codes: slice }, [slice.buffer]);
  } catch (error) {
    self.postMessage({ id, error: error?.message || String(error) });
  }
};
