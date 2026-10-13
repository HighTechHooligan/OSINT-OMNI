import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createRoutePlanner,
  describeRoute,
  parseLatLon,
  parseRouteArgs,
} from './routePlanner.js';
import { createFeatureCommands } from '../ui/featuresCode.js';

const tile = readFileSync(
  new URL('../data/fixtures/osm-alpr-austin-11-467-843.pbf', import.meta.url),
);

// Real fixture camera n13854687801 at (-97.84535, 30.27349), facing 76°.
// The south road passes 7 m north of it, inside its view cone; the north
// road is 300 m away.
const S = 30.27355;
const N = 30.2763;
const way = (id, nodes, pts, tags) => ({
  type: 'way',
  id,
  nodes,
  geometry: pts.map(([lon, lat]) => ({ lon, lat })),
  tags,
});
const roads = {
  elements: [
    way(
      1,
      [1, 2, 3, 4],
      [
        [-97.86, S],
        [-97.85, S],
        [-97.84, S],
        [-97.83, S],
      ],
      {
        highway: 'primary',
        name: 'Bee Caves Rd',
      },
    ),
    way(
      2,
      [5, 6, 7, 8],
      [
        [-97.86, N],
        [-97.85, N],
        [-97.84, N],
        [-97.83, N],
      ],
      {
        highway: 'residential',
        name: 'Ridge Ln',
      },
    ),
    way(
      3,
      [1, 5],
      [
        [-97.86, S],
        [-97.86, N],
      ],
      { highway: 'residential', name: 'West Dr' },
    ),
    way(
      4,
      [4, 8],
      [
        [-97.83, S],
        [-97.83, N],
      ],
      { highway: 'residential', name: 'East Dr' },
    ),
  ],
};

function fakeFetch(calls) {
  return async (url, init = {}) => {
    const u = String(url);
    calls.push(u);
    const json = (body, status = 200) => ({
      status,
      ok: status < 400,
      headers: { get: () => 'application/json' },
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
    if (u === '/api/overpass')
      return json(
        { error: 'not configured', code: 'OVERPASS_NOT_CONFIGURED' },
        503,
      );
    if (u.startsWith('https://overpass')) {
      assert.equal(init.method, 'POST');
      return json(roads);
    }
    if (u.startsWith('/api/route'))
      return json({
        ok: true,
        geometry: [
          [-97.86, S],
          [-97.85, S],
          [-97.84, S],
          [-97.83, S],
        ],
        distanceM: 2880,
        durationS: 150,
      });
    if (u.startsWith('/api/alpr/us/11/467/843.mvt'))
      return {
        status: 200,
        ok: true,
        headers: { get: () => 'application/vnd.mapbox-vector-tile' },
        arrayBuffer: async () =>
          tile.buffer.slice(tile.byteOffset, tile.byteOffset + tile.byteLength),
      };
    return { status: 404, ok: false, headers: { get: () => '' } };
  };
}

test('route arguments: places, lat/lon, mode and direct', () => {
  assert.deepEqual(parseRouteArgs('here to Austin, TX bike'), {
    from: 'here',
    to: 'Austin, TX',
    mode: 'bike',
    avoid: true,
  });
  assert.deepEqual(parseRouteArgs('from 30.1, -97.2 to 30.3,-97.4 direct'), {
    from: '30.1, -97.2',
    to: '30.3,-97.4',
    mode: 'car',
    avoid: false,
  });
  assert.equal(parseRouteArgs('somewhere'), null);
  assert.deepEqual(parseLatLon('30.27, -97.74'), [-97.74, 30.27]);
  assert.equal(parseLatLon('Austin'), null);
  assert.equal(parseLatLon('95, 10'), null);
});

test('plans around a camera that faces the usual road', async () => {
  const calls = [];
  const planner = createRoutePlanner({ fetchImpl: fakeFetch(calls) });
  const r = await planner.plan({ from: `${S}, -97.86`, to: `${S}, -97.83` });
  assert.equal(r.baselineCount, 1, 'the usual road passes the camera');
  assert.equal(r.passed.length, 0, 'the new route passes none');
  assert.equal(r.deadEnd, false);
  assert.match(r.message, /No mapped camera reads your plate.*Avoids 1 camera/);
  assert.ok(Math.max(...r.route.coords.map((c) => c[1])) > 30.276);
  assert.match(describeRoute(r), /min · \d/);
  // The server's Overpass proxy was not configured, so roads came from the
  // public API; it is asked at most once per parallel loader.
  assert.ok(calls.filter((u) => u === '/api/overpass').length <= 2);
});

test('direct routes keep the usual road and count its camera', async () => {
  const planner = createRoutePlanner({ fetchImpl: fakeFetch([]) });
  const r = await planner.plan({
    from: [-97.86, S],
    to: [-97.83, S],
    avoid: false,
  });
  assert.equal(r.passed.length, 1);
  assert.equal(r.passed[0].id, 'n13854687801');
});

test('Features Code route command plans through the routes service', async () => {
  const lines = [];
  const print = (text, tone) => {
    const line = { textContent: text, className: `fc-${tone}` };
    lines.push(line);
    return line;
  };
  const planner = createRoutePlanner({ fetchImpl: fakeFetch([]) });
  let current = null;
  const routes = {
    plan: async (ask) => (current = await planner.plan(ask)),
    describe: () => ({ route: current }),
    clear: () => (current = null),
    steps: () => current?.route.maneuvers ?? [],
    zoom: async () => {},
  };
  const { run } = createFeatureCommands({
    site: { boundary: {}, orbit: {}, contours: {}, routes },
    print,
    clearOutput: () => {},
    pickFile: async () => null,
  });
  assert.equal(await run(`route ${S}, -97.86 to ${S}, -97.83 car`), true);
  assert.match(lines.at(-1).textContent, /No mapped camera reads your plate/);
  assert.equal(lines.at(-1).className, 'fc-ok');
  await run('route steps');
  assert.match(lines.at(-1).textContent, /arrived/i);
  await run('route clear');
  assert.equal(current, null);
});
