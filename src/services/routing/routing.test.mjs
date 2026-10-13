import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cameraSees,
  parseDirections,
  createCameraIndex,
} from './cameraView.js';
import { PROFILES, parseMaxspeed } from './roadProfiles.js';
import { solveRoute } from './solveRoute.js';
import {
  cameraAwareRoute,
  cameraMessage,
  corridorPlan,
} from './cameraAwareRoute.js';
import { parseRoadResponse, roadQuery, mergeWays } from './overpassRoads.js';
import { tilesNearLine, haversineM } from './routeGeo.js';

// A grid town near Austin: avenues run east-west every ~220 m (lat step 0.002),
// streets north-south every ~190 m (lon step 0.002). Node ids are row*100+col.
const LON0 = -97.75;
const LAT0 = 30.27;
const at = (r, c) => [LON0 + c * 0.002, LAT0 + r * 0.002];
function gridWays(rows = 5, cols = 6, extra = {}) {
  const ways = [];
  let id = 1;
  for (let r = 0; r < rows; r++) {
    const nodes = [];
    const coords = [];
    for (let c = 0; c < cols; c++) {
      nodes.push(r * 100 + c);
      coords.push(...at(r, c));
    }
    ways.push({
      id: id++,
      nodes,
      coords,
      tags: {
        highway: r === 0 ? 'secondary' : 'residential',
        name: `Avenue ${r}`,
        ...(extra[`r${r}`] || {}),
      },
    });
  }
  for (let c = 0; c < cols; c++) {
    const nodes = [];
    const coords = [];
    for (let r = 0; r < rows; r++) {
      nodes.push(r * 100 + c);
      coords.push(...at(r, c));
    }
    ways.push({
      id: id++,
      nodes,
      coords,
      tags: {
        highway: 'residential',
        name: `Street ${c}`,
        ...(extra[`c${c}`] || {}),
      },
    });
  }
  return ways;
}
const from = at(0, 0);
const to = at(0, 5);
// Camera beside Avenue 0 between columns 2 and 3, a few metres north of the road.
const midAve0 = [(at(0, 2)[0] + at(0, 3)[0]) / 2, LAT0 + 0.00008];

test('direction parsing handles degrees, lists, ranges and compass points', () => {
  assert.deepEqual(parseDirections('90'), [90]);
  assert.deepEqual(parseDirections('90;270'), [90, 270]);
  assert.deepEqual(parseDirections('NE'), [45]);
  assert.deepEqual(parseDirections('30-60'), [45]);
  assert.deepEqual(parseDirections(-90), [270]);
  assert.deepEqual(parseDirections('garbage'), []);
});

test('a camera only reads plates inside its cone and range', () => {
  const cam = { lon: LON0, lat: LAT0, direction: 90 }; // faces east
  const east = [LON0 + 0.0003, LAT0]; // ~29 m east
  const west = [LON0 - 0.0003, LAT0];
  const far = [LON0 + 0.0006, LAT0]; // ~58 m
  assert.equal(cameraSees(cam, east, 90), true); // driving away: rear plate
  assert.equal(cameraSees(cam, east, 270), true); // driving toward: front plate
  assert.equal(cameraSees(cam, east, 270, { frontPlates: false }), false);
  assert.equal(cameraSees(cam, west, 90), false); // behind the camera
  assert.equal(cameraSees(cam, far, 90), false); // out of range
  assert.equal(cameraSees({ lon: LON0, lat: LAT0 }, west, 0), true); // no direction: all round
});

test('a camera facing along one road does not see the cross street', () => {
  // Camera at a junction facing east along Avenue 0.
  const cam = {
    id: 'j',
    lon: at(0, 2)[0] + 0.00005,
    lat: LAT0 + 0.00005,
    direction: 90,
  };
  const index = createCameraIndex([cam]);
  assert.deepEqual(index.segmentSeenBy(at(0, 2), at(0, 3)), ['j']);
  assert.equal(index.segmentSeenBy(at(0, 2), at(1, 2)), null); // Street 2 heading north
});

test('maxspeed parsing', () => {
  assert.ok(Math.abs(parseMaxspeed('45 mph') - 72.42) < 0.01);
  assert.equal(parseMaxspeed('50'), 50);
  assert.equal(parseMaxspeed('signals'), null);
});

test('without cameras the solver takes the fast avenue', () => {
  const r = solveRoute({ ways: gridWays(), from, to, profile: PROFILES.car });
  assert.equal(r.ok, true);
  assert.ok(r.route.coords.every(([, lat]) => Math.abs(lat - LAT0) < 1e-9));
  assert.equal(r.passed.length, 0);
  assert.match(r.route.maneuvers[0].instruction, /Head east on Avenue 0/);
  assert.match(r.route.maneuvers.at(-1).instruction, /arrived/);
});

test('the solver detours around a camera and reports none passed', () => {
  const cams = [
    {
      id: 'A',
      lon: midAve0[0],
      lat: midAve0[1],
      direction: null,
      brand: 'Flock Safety',
    },
  ];
  const direct = solveRoute({
    ways: gridWays(),
    cameras: cams,
    from,
    to,
    profile: PROFILES.car,
    avoid: false,
  });
  assert.deepEqual(
    direct.passed.map((c) => c.id),
    ['A'],
  );
  const r = solveRoute({
    ways: gridWays(),
    cameras: cams,
    from,
    to,
    profile: PROFILES.car,
  });
  assert.equal(r.passed.length, 0);
  assert.ok(r.route.coords.some(([, lat]) => lat > LAT0 + 0.001));
  assert.ok(
    r.route.maneuvers.some((m) => /Turn (left|right)/.test(m.instruction)),
  );
  assert.ok(r.route.time > direct.route.time);
});

test('a camera facing away from the road is ignored', () => {
  // Same spot, but it faces north, up Street 2... nothing: it looks at an empty block.
  const cams = [
    { id: 'N', lon: midAve0[0], lat: midAve0[1] + 0.0001, direction: 0 },
  ];
  const r = solveRoute({
    ways: gridWays(),
    cameras: cams,
    from,
    to,
    profile: PROFILES.car,
  });
  assert.ok(r.route.coords.every(([, lat]) => Math.abs(lat - LAT0) < 1e-9));
  assert.equal(r.passed.length, 0);
});

test('rear-plate-only cameras let you drive toward them', () => {
  // Faces west: a car driving east comes toward it (front plate only).
  const cams = [{ id: 'W', lon: midAve0[0], lat: midAve0[1], direction: 270 }];
  const strict = solveRoute({
    ways: gridWays(),
    cameras: cams,
    from,
    to,
    profile: PROFILES.car,
    view: { frontPlates: false },
  });
  assert.equal(strict.passed.length, 0);
  assert.ok(
    strict.route.coords.every(([, lat]) => Math.abs(lat - LAT0) < 1e-9),
    'stays on the avenue',
  );
});

test('one-way streets are respected', () => {
  // Make every street one-way southbound except the destination column.
  const extra = {};
  for (let c = 1; c < 5; c++) extra[`c${c}`] = { oneway: '-1' };
  const cams = [{ id: 'A', lon: midAve0[0], lat: midAve0[1] }];
  const r = solveRoute({
    ways: gridWays(5, 6, extra),
    cameras: cams,
    from,
    to,
    profile: PROFILES.car,
  });
  assert.equal(r.ok, true);
  assert.equal(r.passed.length, 0);
  // It must go north on Street 0 (two-way), so the first step heads north.
  assert.match(r.route.maneuvers[0].instruction, /Head north/);
});

test('a dead-end destination behind a camera is reported as such', async () => {
  // Destination at the end of a cul-de-sac off Avenue 0 with a camera at its mouth.
  const ways = gridWays();
  ways.push({
    id: 99,
    nodes: [3, 9001],
    coords: [...at(0, 3), at(0, 3)[0], LAT0 - 0.002],
    tags: { highway: 'residential', name: 'Dead End Ct' },
  });
  const dest = [at(0, 3)[0], LAT0 - 0.002];
  const cams = [
    { id: 'D', lon: at(0, 3)[0] + 0.0001, lat: LAT0 - 0.0004, direction: null },
  ];
  const solve = (input) => solveRoute(input);
  const r = await cameraAwareRoute({
    from,
    to: dest,
    profile: PROFILES.car,
    loadRoads: async (tiles) => tiles.map(() => ways),
    loadCameras: async () => cams,
    solve,
  });
  assert.equal(r.ok, true);
  assert.equal(r.atEnd.length, 1);
  assert.equal(r.elsewhere.length, 0);
  assert.equal(r.widened, true); // it looked wider before settling on the dead end
  assert.match(
    cameraMessage(r),
    /destination can only be reached past 1 camera \(dead end\)/,
  );
});

test('the corridor widens when a camera sits on the only nearby road', async () => {
  const calls = [];
  const cams = [{ id: 'A', lon: midAve0[0], lat: midAve0[1] }];
  // Narrow corridor: only Avenue 0 exists. Wide corridor: the whole grid.
  const narrow = gridWays().filter((w) => w.tags.name === 'Avenue 0');
  const r = await cameraAwareRoute({
    from,
    to,
    profile: PROFILES.car,
    loadRoads: async (tiles, tier) => {
      calls.push(tier);
      return [calls.length > 2 ? gridWays() : narrow];
    },
    loadCameras: async () => cams,
    solve: (input) => solveRoute(input),
  });
  assert.equal(r.widened, true);
  assert.equal(r.passed.length, 0);
  assert.match(
    cameraMessage(r, { baselineCount: 1 }),
    /No mapped camera reads your plate.*Avoids 1 camera/,
  );
});

test('long trips plan a bounded corridor, with no distance limit', () => {
  // Austin to Dallas, ~300 km straight.
  const line = [
    [-97.74, 30.27],
    [-96.8, 32.78],
  ];
  const plan = corridorPlan(line, line[0], line[1]);
  assert.ok(plan.lengthM > 280_000);
  assert.ok(
    plan.full.length > 30 && plan.full.length < 400,
    String(plan.full.length),
  );
  assert.ok(plan.major.length < 200, String(plan.major.length));
});

test('Overpass road responses become compact ways', () => {
  const ways = parseRoadResponse({
    elements: [
      {
        type: 'way',
        id: 5,
        nodes: [1, 2, 3],
        geometry: [{ lat: 30, lon: -97 }, null, { lat: 30.001, lon: -97 }],
        tags: { highway: 'residential', name: 'A', surface: 'asphalt' },
      },
      { type: 'node', id: 9 },
    ],
  });
  assert.deepEqual(ways, [
    {
      id: 5,
      nodes: [1, 3],
      coords: [-97, 30, -97, 30.001],
      tags: { highway: 'residential', name: 'A' },
    },
  ]);
  assert.match(
    roadQuery({ z: 12, x: 947, y: 1689 }, ['residential', 'service']),
    /way\["highway"~"\^\(residential\|service\)\$"\]\(\d/,
  );
  const merged = mergeWays([
    [{ id: 1, nodes: [1, 2] }],
    [
      { id: 1, nodes: [1, 2, 3] },
      { id: 2, nodes: [4, 5] },
    ],
  ]);
  assert.deepEqual(merged.map((w) => w.nodes.length).sort(), [2, 3]);
});

test('tiles near a line cover the padding', () => {
  assert.equal(tilesNearLine([[-97.74, 30.27]], 12).length, 1);
  const tiles = tilesNearLine([[-97.74, 30.27]], 12, 10000);
  assert.ok(tiles.length >= 4, String(tiles.length));
  assert.ok(haversineM([0, 0], [0, 1]) > 111_000);
});
