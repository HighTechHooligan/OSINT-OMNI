import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/lib/store.js';
import { createRouteCache } from '../src/lib/routeCache.js';
import { createTileCache } from '../src/lib/tileCache.js';
import { createSavedRoutes, routeRegion } from '../src/lib/savedRoutes.js';
import { createRoadSource } from '../src/lib/roads.js';
import { createHostLink } from '../src/lib/hostLink.js';

const style = { version: 8, sources: { omt: { type: 'vector', url: 'https://t/planet' } }, layers: [] };
const tileJson = { tiles: ['https://t/v1/{z}/{x}/{y}.pbf'], minzoom: 0, maxzoom: 14 };
const fetchImpl = async (url) => ({
  ok: true,
  status: 200,
  arrayBuffer: async () => new TextEncoder().encode(url.endsWith('/style') ? JSON.stringify(style) : url.endsWith('/planet') ? JSON.stringify(tileJson) : 'tile').buffer,
});

function setup() {
  const store = createMemoryStore();
  const routes = createRouteCache({ store });
  const tiles = createTileCache({ store, fetchImpl });
  const planner = { plan: async (o) => ({ record: await routes.put({ ...(await routes.find({ ...o, costing: 'auto', avoid: true })), from: o.from, to: o.to, fromLabel: o.fromLabel, toLabel: o.toLabel, costing: 'auto', avoid: true, route: { coords: [o.from, o.to], maneuvers: [], length: 1, time: 60, units: 'miles' } }) }) };
  const saved = createSavedRoutes({ routes, tiles, cameras: { forLine: async () => ({ cameras: [] }) }, planner, styleUrl: () => 'https://t/style' });
  return { routes, tiles, saved, planner };
}

test('saved routes are kept forever, renamed, reversed and deleted with their map', async () => {
  const { routes, tiles, saved, planner } = setup();
  const { record } = await planner.plan({ from: [-97.75, 30.27], to: [-97.6, 30.4], fromLabel: 'Home, Austin', toLabel: 'Work, Austin' });
  const s1 = await saved.save(record.id);
  assert.equal(s1.saved, true);
  assert.equal(s1.name, 'Home → Work');
  // The map along it gets pinned to the route's own region.
  const offline = await saved.keepMap(s1);
  assert.ok(offline.tiles > 20 && offline.failed === 0, JSON.stringify(offline));
  const pinned = (await tiles.stats()).pinned;
  assert.ok(pinned > 0);
  // Recent routes roll off; saved ones never do.
  for (let i = 0; i < 40; i++) await routes.put({ from: [i, 0], to: [i, 1], costing: 'auto', avoid: true, route: { coords: [] } });
  assert.ok(await routes.get(record.id));
  assert.equal((await saved.rename(record.id, '  Commute ')).name, 'Commute');
  await assert.rejects(saved.rename(record.id, ' '), /name/);
  const back = await saved.reverse(record.id);
  assert.deepEqual(back.from, [-97.6, 30.4]);
  assert.equal(back.fromLabel, 'Work, Austin');
  await saved.remove(record.id);
  assert.equal(await routes.get(record.id), undefined);
  assert.equal((await tiles.stats()).pinned, 0);
  assert.equal(routeRegion('x'), 'route:x');
});

test('road tiles are cached for 30 days and retried when Overpass is busy', async () => {
  const store = createMemoryStore();
  let calls = 0;
  let now = 0;
  const post = async (url, body) => {
    calls++;
    assert.match(decodeURIComponent(body), /way\["highway"/);
    if (calls === 1) return { status: 429, text: '' };
    return { status: 200, text: JSON.stringify({ elements: [{ type: 'way', id: 1, nodes: [1, 2], geometry: [{ lon: 0, lat: 0 }, { lon: 0, lat: 0.001 }], tags: { highway: 'residential' } }] }) };
  };
  const roads = createRoadSource({ store, post, endpoints: () => 'https://o', now: () => now, sleep: async () => {} });
  const profile = { id: 'car', highways: ['residential'], major: ['primary'] };
  const t = { z: 12, x: 1, y: 2 };
  let ticks = 0;
  const [ways] = await roads.load([t], 'full', profile, () => ticks++);
  assert.equal(ways.length, 1);
  assert.equal(ticks, 1);
  assert.equal(calls, 2);
  now = 29 * 24 * 3600_000;
  await roads.load([t], 'full', profile);
  assert.equal(calls, 2);
  now = 31 * 24 * 3600_000;
  await roads.load([t], 'full', profile);
  assert.equal(calls, 3);
});

test('roads skip a host whose Overpass proxy is not configured', async () => {
  const store = createMemoryStore();
  const seen = [];
  const post = async (url) => {
    seen.push(url);
    if (url.startsWith('http://host')) return { status: 503, text: '{"code":"OVERPASS_NOT_CONFIGURED"}' };
    return { status: 200, text: JSON.stringify({ elements: [] }) };
  };
  const roads = createRoadSource({ store, post, endpoints: () => ['http://host/api/overpass', 'https://o'], sleep: async () => {} });
  const profile = { id: 'car', highways: ['residential'], major: ['primary'] };
  await roads.load([{ z: 12, x: 1, y: 2 }, { z: 12, x: 1, y: 3 }], 'full', profile);
  // Each of the two parallel loaders asks the host at most once.
  const hostCalls = seen.filter((u) => u.startsWith('http://host')).length;
  assert.ok(hostCalls >= 1 && hostCalls <= 2);
  assert.equal(seen.length - hostCalls, 2);
});

test('desktop commands run through the host and come back with output', async () => {
  let polls = 0;
  const http = async ({ method, url, body }) => {
    const path = new URL(url).pathname;
    if (path === '/remote/api/commands' && method === 'POST') return { status: 202, data: { ok: true, desktopOnline: true, command: { id: 'c1', line: body.line } } };
    if (path === '/remote/api/commands/c1') return { status: 200, data: { command: { id: 'c1', status: ++polls > 1 ? 'done' : 'running', lines: [{ text: 'Route ready', tone: 'ok' }], image: null } } };
    if (path === '/remote/api/tools') return { status: 200, data: { tools: [{ name: 'weather_at' }] } };
    if (path === '/remote/api/tools/weather_at') return { status: 200, data: { ok: true, summary: 'Sunny' } };
    return { status: 401, data: { error: 'This phone is not paired.' } };
  };
  const link = createHostLink({ http });
  const p = { hostUrl: 'http://100.101.1.2:4173', token: 't' };
  const states = [];
  const c = await link.command(p, 'route Austin to Dallas', { onStatus: (s) => states.push(s), sleep: async () => {} });
  assert.equal(c.status, 'done');
  assert.equal(c.lines[0].text, 'Route ready');
  assert.deepEqual(states.slice(0, 1), ['running']);
  assert.equal((await link.tools(p))[0].name, 'weather_at');
  assert.equal((await link.runTool(p, 'weather_at', {})).summary, 'Sunny');
  await assert.rejects(createHostLink({ http: async () => ({ status: 401, data: {} }) }).tools(p), /not paired/);
});
