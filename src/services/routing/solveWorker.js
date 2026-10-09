import { solveRoute } from './solveRoute.js';

// Route solving runs here so building the road graph never freezes the map.
self.onmessage = (event) => {
  const { id, input } = event.data;
  try {
    self.postMessage({ id, result: solveRoute(input) });
  } catch (error) {
    self.postMessage({ id, error: error?.message || String(error) });
  }
};
