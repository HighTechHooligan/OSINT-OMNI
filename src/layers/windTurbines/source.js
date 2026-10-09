import { bboxParam } from './records.js';

/** Viewport reads from the app server's cached USWTDB proxy. */
export function createWindTurbineSource({
  url = '/api/wind-turbines',
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  return {
    async getView(bbox, { limit, signal } = {}) {
      const params = new URLSearchParams({ bbox: bboxParam(bbox) });
      if (limit) params.set('limit', String(limit));
      const response = await fetchImpl(`${url}?${params}`, { signal });
      if (!response.ok)
        throw new Error(`Wind turbines HTTP ${response.status}`);
      const json = await response.json();
      if (!Array.isArray(json?.turbines))
        throw new Error('Malformed wind turbine response');
      return json;
    },
  };
}
