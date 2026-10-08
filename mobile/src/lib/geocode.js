/**
 * Place search through Nominatim (OpenStreetMap). Results are cached, and a
 * typed "lat, lon" never touches the network.
 */
export const DEFAULT_GEOCODER_URL = 'https://nominatim.openstreetmap.org';

export function parseLatLon(text) {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(text || ''));
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lon, lat, label: `${lat.toFixed(5)}, ${lon.toFixed(5)}` };
}

export function createGeocoder({ store, fetchImpl = fetch, baseUrl = () => DEFAULT_GEOCODER_URL, canFetch = () => true, meter = null }) {
  return {
    async search(text, { near } = {}) {
      const direct = parseLatLon(text);
      if (direct) return [direct];
      const q = String(text || '').trim();
      if (!q) return [];
      const key = `geo:${q.toLowerCase()}`;
      const cached = await store.get('meta', key);
      if (cached) return cached.results;
      if (!canFetch('search')) return [];
      const params = new URLSearchParams({ q, format: 'jsonv2', limit: '6', addressdetails: '0' });
      if (near) {
        const [lon, lat] = near;
        params.set('viewbox', `${lon - 0.5},${lat + 0.5},${lon + 0.5},${lat - 0.5}`);
      }
      const res = await fetchImpl(`${baseUrl().replace(/\/+$/, '')}/search?${params}`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`Search HTTP ${res.status}`);
      const text2 = await res.text();
      meter?.add('search', text2.length);
      const results = JSON.parse(text2)
        .map((r) => ({ lon: Number(r.lon), lat: Number(r.lat), label: r.display_name }))
        .filter((r) => Number.isFinite(r.lon) && Number.isFinite(r.lat));
      await store.put('meta', key, { results, at: Date.now() });
      return results;
    },
  };
}
