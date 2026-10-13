/**
 * Tiny key-value store over IndexedDB, with an in-memory twin for tests.
 * Object stores: tiles (bytes), tileIndex (size/age/pin, small enough to scan
 * for eviction), cameraTiles, roadTiles (router road data), routes, regions,
 * meta. Version 2 added roadTiles.
 */
export const STORES = Object.freeze([
  'roadTiles',
  'tiles',
  'tileIndex',
  'cameraTiles',
  'routes',
  'regions',
  'meta',
]);

export function createMemoryStore() {
  const maps = new Map(STORES.map((name) => [name, new Map()]));
  const of = (name) => {
    const map = maps.get(name);
    if (!map) throw new Error(`Unknown store ${name}`);
    return map;
  };
  return {
    async get(name, key) {
      return of(name).get(key);
    },
    async put(name, key, value) {
      of(name).set(key, value);
    },
    async delete(name, key) {
      of(name).delete(key);
    },
    async entries(name) {
      return [...of(name).entries()];
    },
    async clear(name) {
      of(name).clear();
    },
  };
}

export function createIdbStore(dbName = 'omni-portal', idb = globalThis.indexedDB) {
  const ready = new Promise((resolve, reject) => {
    const open = idb.open(dbName, 2);
    open.onupgradeneeded = () => {
      for (const name of STORES)
        if (!open.result.objectStoreNames.contains(name))
          open.result.createObjectStore(name);
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  const run = async (name, mode, fn) => {
    const db = await ready;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(name, mode);
      const req = fn(tx.objectStore(name));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  };
  return {
    get: (name, key) => run(name, 'readonly', (s) => s.get(key)),
    put: (name, key, value) => run(name, 'readwrite', (s) => s.put(value, key)),
    delete: (name, key) => run(name, 'readwrite', (s) => s.delete(key)),
    clear: (name) => run(name, 'readwrite', (s) => s.clear()),
    async entries(name) {
      const db = await ready;
      return new Promise((resolve, reject) => {
        const out = [];
        const tx = db.transaction(name, 'readonly');
        const cursor = tx.objectStore(name).openCursor();
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (!c) return;
          out.push([c.key, c.value]);
          c.continue();
        };
        tx.oncomplete = () => resolve(out);
        tx.onerror = () => reject(tx.error);
      });
    },
  };
}
