import { parseRoadResponse, roadQuery } from './overpassRoads.js';

/**
 * Road tiles for the router, from Overpass: the OMNI host's cached
 * /api/overpass proxy first when there is one, else (or when that proxy has
 * no upstream configured) the public Overpass API. Tiles are cached for 30
 * days in whatever store the caller hands in (IndexedDB on the phone, memory
 * on the desktop).
 */
export const DEFAULT_OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
export const ROAD_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** In-memory store with the phone store's get/put shape. */
export function createMemoryRoadStore(maxTiles = 600) {
  const map = new Map();
  return {
    async get(_name, key) {
      return map.get(key) ?? null;
    },
    async put(_name, key, value) {
      map.delete(key);
      map.set(key, value);
      while (map.size > maxTiles) map.delete(map.keys().next().value);
    },
  };
}

/**
 * @param {object} o
 * @param {{get: Function, put: Function}} o.store
 * @param {(url: string, body: string) => Promise<{status: number, text: string}>} o.post
 * @param {() => string[]|string} o.endpoints Overpass URLs, best first
 */
export function createRoadSource({
  store,
  post,
  endpoints,
  canFetch = () => true,
  meter = null,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  // An endpoint that answers "not configured" (or refuses the query) is
  // skipped for the rest of the session; the next one in the list is used.
  const skipped = new Set();
  const live = () =>
    [endpoints()]
      .flat()
      .filter(Boolean)
      .filter((u) => !skipped.has(u));

  async function fetchTile(tile, tier, profile) {
    const highways = tier === 'major' ? profile.major : profile.highways;
    const body = `data=${encodeURIComponent(roadQuery(tile, highways))}`;
    for (let attempt = 0; ; attempt++) {
      const list = live();
      if (!list.length) throw new Error('No road data source answered');
      const url = list[0];
      const res = await post(url, body);
      if (res.status === 200) {
        meter?.add('roads', res.text.length);
        return parseRoadResponse(JSON.parse(res.text));
      }
      const notConfigured =
        res.status === 400 ||
        res.status === 404 ||
        res.status === 405 ||
        /OVERPASS_NOT_CONFIGURED/.test(res.text || '');
      if (notConfigured && list.length > 1) {
        skipped.add(url);
        continue;
      }
      // Overpass sheds load with 429/503/504; wait and try again a few times.
      if (
        (res.status === 429 || res.status === 504 || res.status === 503) &&
        !notConfigured &&
        attempt < 4
      ) {
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      throw new Error(`Road data HTTP ${res.status}`);
    }
  }

  async function tile(t, tier, profile, { preferCache = false } = {}) {
    const key = `${profile.id}:${tier}/${t.z}/${t.x}/${t.y}`;
    const cached = await store.get('roadTiles', key);
    if (
      cached &&
      (now() - cached.at < ROAD_TTL_MS || preferCache || !canFetch('roads'))
    ) {
      meter?.saved('roads', cached.bytes || 0);
      return cached.ways;
    }
    if (!canFetch('roads'))
      throw new Error('Offline, and this area has no road data on the phone.');
    try {
      const ways = await fetchTile(t, tier, profile);
      await store.put('roadTiles', key, {
        ways,
        at: now(),
        bytes: JSON.stringify(ways).length,
      });
      return ways;
    } catch (error) {
      if (cached) return cached.ways;
      throw error;
    }
  }

  return {
    tile,
    /** Matches cameraAwareRoute's loadRoads(tiles, tier, profile, tick). */
    async load(tiles, tier, profile, tick = () => {}, options = {}) {
      const out = [];
      const queue = [...tiles];
      let failed = 0;
      // Two at a time: public Overpass gives each client two slots.
      const worker = async () => {
        while (queue.length) {
          const t = queue.shift();
          try {
            out.push(await tile(t, tier, profile, options));
          } catch (error) {
            failed++;
            if (failed > Math.max(3, tiles.length / 4)) throw error;
          }
          tick();
        }
      };
      await Promise.all([worker(), worker()]);
      return out;
    },
  };
}
