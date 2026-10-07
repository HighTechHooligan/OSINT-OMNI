import { overpassTileQuery, parseOsmTile } from './records.js';

/**
 * OSM streets + building footprints source, one 0.01° tile per request,
 * through the app's bounded, cached /api/overpass proxy (no Google calls).
 */
export function createOsmStreetsSource({
  url = '/api/overpass',
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  return {
    async getTile(key, { signal } = {}) {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data: overpassTileQuery(key) }).toString(),
        signal,
      });
      if (!response.ok) throw new Error(`OSM tile HTTP ${response.status}`);
      return parseOsmTile(await response.json());
    },
  };
}
