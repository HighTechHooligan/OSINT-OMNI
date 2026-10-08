import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMemoryStore } from '../src/lib/store.js';
import { createTileCache, OfflineMissError } from '../src/lib/tileCache.js';
import { createRouteCache, shouldReuse } from '../src/lib/routeCache.js';
import { createCameraSource, decodeCameraTile, cameraTileTemplate } from '../src/lib/cameras.js';
import { createNetMeter } from '../src/lib/netMeter.js';
import { rewriteStyle, rewriteTileJson, planRegion, fontStacks } from '../src/lib/mapStyle.js';
import { parseLatLon, createGeocoder } from '../src/lib/geocode.js';
import { cleanUrl } from '../src/lib/settings.js';
import { createPlanner } from '../src/lib/planner.js';
import { encodePolyline } from '../src/lib/polyline.js';

const austinTile = readFileSync(new URL('../../src/data/fixtures/osm-alpr-austin-11-467-843.pbf', import.meta.url));
const bytes = (n) => new Uint8Array(n).buffer;
const okResponse = (n) => ({ ok: true, status: 200, arrayBuffer: async () => bytes(n) });

test('tile cache serves repeats from the phone and meters the network', async () => {
  const store = createMemoryStore();
  let fetches = 0;
  const meter = createNetMeter();
  const cache = createTileCache({ store, meter, fetchImpl: async () => (fetches++, okResponse(100)) });
  await cache.get('https://t/1');
  await cache.get('https://t/1');
  assert.equal(fetches, 1);
  const snap = meter.snapshot();
  assert.equal(snap.bytes['unknown:tiles'], 100);
  assert.equal(snap.saved.tiles, 100);
});

test('a glyph url spelled with spaces or %20 is one cache entry', async () => {
  let fetches = 0;
  const cache = createTileCache({ store: createMemoryStore(), fetchImpl: async () => (fetches++, okResponse(1)) });
  await cache.get('https://t/fonts/Noto Sans Regular,Noto Sans Bold/0-255.pbf');
  await cache.get('https://t/fonts/Noto%20Sans%20Regular,Noto%20Sans%20Bold/0-255.pbf');
  assert.equal(fetches, 1);
});

test('concurrent requests for one tile share a download', async () => {
  let fetches = 0;
  const cache = createTileCache({ store: createMemoryStore(), fetchImpl: async () => (fetches++, okResponse(1)) });
  await Promise.all([cache.get('https://t/a'), cache.get('https://t/a')]);
  assert.equal(fetches, 1);
});

test('browse budget evicts least recently used tiles but never region tiles', async () => {
  let t = 0;
  const store = createMemoryStore();
  const cache = createTileCache({ store, budgetBytes: 250, now: () => ++t, fetchImpl: async () => okResponse(100) });
  await cache.get('https://t/region', { region: 'home' });
  await cache.get('https://t/1');
  await cache.get('https://t/2');
  await cache.get('https://t/3');
  assert.equal(await cache.has('https://t/region'), true);
  assert.equal(await cache.has('https://t/1'), false);
  assert.equal(await cache.has('https://t/3'), true);
  const s = await cache.stats();
  assert.equal(s.pinned, 100);
  assert.ok(s.browse <= 250);
});

test('cache refuses a download it is not allowed to make', async () => {
  const cache = createTileCache({ store: createMemoryStore(), canFetch: () => false, fetchImpl: async () => okResponse(1) });
  await assert.rejects(cache.get('https://t/x'), OfflineMissError);
});

test('empty tiles are cached as empty, missing styles are errors', async () => {
  const cache = createTileCache({ store: createMemoryStore(), fetchImpl: async () => ({ ok: false, status: 404 }) });
  assert.equal((await cache.get('https://t/ocean')).byteLength, 0);
  await assert.rejects(cache.get('https://t/style.json', { category: 'style' }), /HTTP 404/);
});

test('unpinning a region returns its tiles to the browse budget', async () => {
  const store = createMemoryStore();
  const cache = createTileCache({ store, budgetBytes: 50, fetchImpl: async () => okResponse(100) });
  await cache.get('https://t/r', { region: 'r1' });
  await cache.unpinRegion('r1');
  assert.equal(await cache.has('https://t/r'), false);
});

test('camera tile decodes real Austin ALPR records', () => {
  const cams = decodeCameraTile(austinTile, 11, 467, 843);
  assert.equal(cams.length, 1);
  assert.equal(cams[0].id, 'n13854687801');
  assert.equal(cams[0].brand, 'Flock Safety');
  assert.ok(Math.abs(cams[0].lon - -97.84535) < 1e-4 && Math.abs(cams[0].lat - 30.27349) < 1e-4);
  assert.deepEqual(decodeCameraTile(new ArrayBuffer(0), 11, 467, 843), []);
});

test('camera tiles are kept a week and used offline', async () => {
  const store = createMemoryStore();
  let now = 0;
  let online = true;
  let fetches = 0;
  const src = createCameraSource({
    store,
    now: () => now,
    canFetch: () => online,
    fetchBytes: async () => (fetches++, { status: 200, body: austinTile.buffer.slice(austinTile.byteOffset, austinTile.byteOffset + austinTile.byteLength) }),
  });
  const t = { z: 11, x: 467, y: 843 };
  const first = await src.forTiles([t]);
  assert.equal(first.report.network, 1);
  now = 3 * 24 * 3600_000;
  assert.equal((await src.forTiles([t])).report.cache, 1);
  now = 30 * 24 * 3600_000;
  online = false;
  const offline = await src.forTiles([t]);
  assert.equal(offline.report.cache, 1);
  assert.equal(offline.cameras.length, first.cameras.length);
  assert.equal(fetches, 1);
  assert.equal(cameraTileTemplate('https://host.example/'), 'https://host.example/api/alpr/us/{z}/{x}/{y}.mvt');
});

test('route cache matches nearby trips and keeps saved ones', async () => {
  const routes = createRouteCache({ store: createMemoryStore(), recentLimit: 2 });
  const a = await routes.put({ from: [-97.75, 30.27], to: [-97.73, 30.27], costing: 'auto', avoid: true });
  assert.ok(a.id);
  await routes.setSaved(a.id, true, 'Home');
  for (let i = 0; i < 4; i++) await routes.put({ from: [i, 0], to: [i, 1], costing: 'auto', avoid: true });
  assert.equal((await routes.all()).length, 3);
  const hit = await routes.find({ from: [-97.7505, 30.2702], to: [-97.73, 30.27], costing: 'auto', avoid: true });
  assert.equal(hit?.name, 'Home');
  assert.equal(await routes.find({ from: [-97.75, 30.27], to: [-97.73, 30.27], costing: 'auto', avoid: false }), null);
});

test('reuse rules: offline and cellular saver use kept routes', () => {
  const rec = { at: 0, saved: false };
  const base = { now: 48 * 3600_000, maxAgeMs: 24 * 3600_000, cellularSaver: true };
  assert.equal(shouldReuse(rec, { ...base, onCellular: false, online: true }), false);
  assert.equal(shouldReuse(rec, { ...base, onCellular: true, online: true }), true);
  assert.equal(shouldReuse(rec, { ...base, onCellular: false, online: false }), true);
  assert.equal(shouldReuse(null, { ...base, online: false }), false);
});

test('planner reuses a kept route instead of calling the router', async () => {
  const store = createMemoryStore();
  let routerCalls = 0;
  const shape = encodePolyline([[-97.75, 30.27], [-97.73, 30.27]]);
  const fetchImpl = async () => (routerCalls++, {
    ok: true,
    status: 200,
    json: async () => ({ trip: { units: 'miles', summary: { length: 1.2, time: 120 }, legs: [{ shape, maneuvers: [] }] } }),
  });
  const conn = { online: true, onCellular: true };
  const planner = createPlanner({
    routes: createRouteCache({ store }),
    cameras: { forLine: async () => ({ cameras: [] }) },
    settings: () => ({ routerUrl: 'https://r', units: 'miles', costing: 'auto', avoidCameras: true, cameraBufferM: 40, cellularSaver: true, routeMaxAgeHours: 24 }),
    connection: () => conn,
    fetchImpl,
  });
  const first = await planner.plan({ from: [-97.75, 30.27], to: [-97.73, 30.27] });
  assert.equal(first.from, 'network');
  const again = await planner.plan({ from: [-97.7501, 30.27], to: [-97.73, 30.27] });
  assert.equal(again.from, 'cache');
  assert.equal(routerCalls, 1);
  await planner.plan({ from: [-97.75, 30.27], to: [-97.73, 30.27], force: true });
  assert.equal(routerCalls, 2);
  assert.equal((await createRouteCache({ store }).all()).length, 1);
  conn.online = false;
  await assert.rejects(planner.plan({ from: [0, 0], to: [1, 1] }), /Offline/);
});

const style = {
  version: 8,
  glyphs: 'https://tiles.example/fonts/{fontstack}/{range}.pbf',
  sprite: 'https://tiles.example/sprites/ofm',
  sources: { openmaptiles: { type: 'vector', url: 'https://tiles.example/planet' } },
  layers: [
    { id: 'a', type: 'symbol', layout: { 'text-font': ['Noto Sans Regular'] } },
    { id: 'b', type: 'symbol', layout: { 'text-font': ['step', ['zoom'], ['literal', ['Noto Sans Bold']], 10, ['literal', ['Noto Sans Italic']]] } },
  ],
};

test('style and TileJSON urls are routed through the phone cache', () => {
  const s = rewriteStyle(style, 'https://tiles.example/styles/liberty');
  assert.equal(s.sources.openmaptiles.url, 'omni://https://tiles.example/planet');
  assert.equal(s.glyphs, 'omni://https://tiles.example/fonts/{fontstack}/{range}.pbf');
  assert.equal(s.sprite, 'omni://https://tiles.example/sprites/ofm');
  const tj = rewriteTileJson({ tiles: ['https://tiles.example/v1/{z}/{x}/{y}.pbf'] }, 'https://tiles.example/planet');
  assert.equal(tj.tiles[0], 'omni://https://tiles.example/v1/{z}/{x}/{y}.pbf');
  assert.deepEqual(fontStacks(style).sort(), ['Noto Sans Bold', 'Noto Sans Italic', 'Noto Sans Regular']);
});

test('region plan lists tiles, glyphs and sprites', () => {
  const plan = planRegion({
    style,
    styleUrl: 'https://tiles.example/styles/liberty',
    tileJsons: { openmaptiles: { tiles: ['https://tiles.example/v1/{z}/{x}/{y}.pbf'], minzoom: 0, maxzoom: 14 } },
    bbox: [-97.8, 30.2, -97.6, 30.4],
    maxZoom: 12,
  });
  const urls = [...plan.urls()];
  assert.equal(urls.length, plan.tileCount + plan.extras.length);
  assert.ok(urls.includes('https://tiles.example/fonts/Noto Sans Regular/0-255.pbf'));
  assert.ok(urls.includes('https://tiles.example/sprites/ofm@2x.png'));
  assert.ok(urls.includes('https://tiles.example/v1/0/0/0.pbf'));
});

test('lat, lon input skips the geocoder', async () => {
  assert.deepEqual(parseLatLon('30.27, -97.74').lon, -97.74);
  assert.equal(parseLatLon('Austin'), null);
  let calls = 0;
  const g = createGeocoder({
    store: createMemoryStore(),
    fetchImpl: async () => (calls++, { ok: true, text: async () => JSON.stringify([{ lat: '30.2', lon: '-97.7', display_name: 'Austin' }]) }),
  });
  assert.equal((await g.search('30.27,-97.74'))[0].lat, 30.27);
  assert.equal((await g.search('Austin'))[0].label, 'Austin');
  await g.search('austin');
  assert.equal(calls, 1);
});

test('host urls must be plain http(s)', () => {
  assert.equal(cleanUrl('omni.example.net:8443/'), 'https://omni.example.net:8443');
  assert.equal(cleanUrl('http://192.168.1.20:4173'), 'http://192.168.1.20:4173');
  assert.equal(cleanUrl('ftp://x'), null);
  assert.equal(cleanUrl('https://u:p@x'), null);
  assert.equal(cleanUrl(''), '');
});
