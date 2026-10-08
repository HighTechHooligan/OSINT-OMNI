/**
 * Cache-first byte cache for map resources (style, TileJSON, vector tiles,
 * glyphs, sprites). Everything the map ever loads is kept, so a place seen
 * once on Wi-Fi works later on cellular or with no signal. Tiles fetched for
 * a downloaded region are pinned to it; the rest share a browse budget and
 * the least recently used go first. Nothing is ever re-fetched while cached,
 * which also keeps a region's tiles on one consistent basemap version.
 */
export const DEFAULT_BUDGET_BYTES = 512 * 1024 * 1024;
const TOUCH_EVERY_MS = 6 * 60 * 60 * 1000;

/** One key per resource however it was spelled (the map asks for glyphs with raw spaces). */
export function cacheKey(url) {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

export class OfflineMissError extends Error {
  constructor(url) {
    super(`Not cached and offline: ${url}`);
    this.name = 'OfflineMissError';
  }
}

export function createTileCache({
  store,
  fetchImpl = fetch,
  meter = null,
  budgetBytes = DEFAULT_BUDGET_BYTES,
  canFetch = () => true,
  now = Date.now,
}) {
  let browseBytes = null;
  const inflight = new Map();

  async function browseTotal() {
    if (browseBytes == null) {
      browseBytes = 0;
      for (const [, meta] of await store.entries('tileIndex'))
        if (!meta.regions?.length) browseBytes += meta.size;
    }
    return browseBytes;
  }

  async function evict() {
    if ((await browseTotal()) <= budgetBytes) return 0;
    const browse = (await store.entries('tileIndex'))
      .filter(([, m]) => !m.regions?.length)
      .sort((a, b) => a[1].at - b[1].at);
    let freed = 0;
    for (const [url, meta] of browse) {
      if (browseBytes <= budgetBytes * 0.9) break;
      await store.delete('tiles', url);
      await store.delete('tileIndex', url);
      browseBytes -= meta.size;
      freed += meta.size;
    }
    return freed;
  }

  async function pin(url, meta, region) {
    if (!region || meta.regions?.includes(region)) return;
    const wasBrowse = !meta.regions?.length;
    meta.regions = [...(meta.regions || []), region];
    await store.put('tileIndex', url, meta);
    if (wasBrowse && browseBytes != null) browseBytes -= meta.size;
  }

  async function download(url, category, region) {
    if (!canFetch(category)) throw new OfflineMissError(url);
    const response = await fetchImpl(url);
    // An empty tile (ocean, nothing mapped) is a real answer: cache it too.
    const empty =
      category === 'tiles' && (response.status === 204 || response.status === 404);
    if (!response.ok && !empty) throw new Error(`HTTP ${response.status} for ${url}`);
    const body = empty ? new ArrayBuffer(0) : await response.arrayBuffer();
    meter?.add(category, body.byteLength);
    const meta = { size: body.byteLength, at: now(), regions: region ? [region] : [] };
    await store.put('tiles', url, body);
    await store.put('tileIndex', url, meta);
    if (!region) {
      await browseTotal();
      browseBytes += meta.size;
      await evict();
    }
    return body;
  }

  return {
    /** Bytes for a URL: cache first, then network (if allowed). */
    async get(rawUrl, { category = 'tiles', region = null } = {}) {
      const url = cacheKey(rawUrl);
      const meta = await store.get('tileIndex', url);
      if (meta) {
        const body = await store.get('tiles', url);
        if (body) {
          meter?.saved(category, meta.size);
          if (region) await pin(url, meta, region);
          else if (now() - meta.at > TOUCH_EVERY_MS)
            await store.put('tileIndex', url, { ...meta, at: now() });
          return body;
        }
      }
      if (!inflight.has(url))
        inflight.set(
          url,
          download(url, category, region).finally(() => inflight.delete(url)),
        );
      return inflight.get(url);
    },
    async has(url) {
      return Boolean(await store.get('tileIndex', cacheKey(url)));
    },
    /** Drop a region's pins; tiles no other region holds join the browse budget. */
    async unpinRegion(region) {
      for (const [url, meta] of await store.entries('tileIndex')) {
        if (!meta.regions?.includes(region)) continue;
        meta.regions = meta.regions.filter((r) => r !== region);
        await store.put('tileIndex', url, meta);
      }
      browseBytes = null;
      await evict();
    },
    async stats() {
      let pinned = 0;
      let browse = 0;
      let count = 0;
      for (const [, m] of await store.entries('tileIndex')) {
        count++;
        if (m.regions?.length) pinned += m.size;
        else browse += m.size;
      }
      return { count, pinned, browse, budget: budgetBytes };
    },
    async clearBrowse() {
      for (const [url, m] of await store.entries('tileIndex'))
        if (!m.regions?.length) {
          await store.delete('tiles', url);
          await store.delete('tileIndex', url);
        }
      browseBytes = 0;
    },
    setBudget(bytes) {
      budgetBytes = bytes;
      return evict();
    },
  };
}
