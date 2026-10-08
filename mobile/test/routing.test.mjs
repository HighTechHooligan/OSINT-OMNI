import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePolyline } from '../src/lib/polyline.js';
import { buildRouteRequest, parseRouteResponse, requestRoute, RoutingError, MAX_EXCLUDES } from '../src/lib/valhalla.js';
import { createNavigator, formatDistance } from '../src/lib/nav.js';

const trip = (coords, extra = {}) => ({
  trip: {
    units: 'miles',
    summary: { length: extra.length ?? 1, time: extra.time ?? 100 },
    legs: [
      {
        shape: encodePolyline(coords),
        maneuvers: [
          { type: 1, instruction: 'Drive east.', begin_shape_index: 0, end_shape_index: 1, length: 0.5, time: 50, street_names: ['Main St'] },
          { type: 10, instruction: 'Turn right.', begin_shape_index: 1, end_shape_index: coords.length - 1, length: 0.5, time: 50 },
          { type: 4, instruction: 'You have arrived.', begin_shape_index: coords.length - 1, end_shape_index: coords.length - 1 },
        ],
      },
    ],
  },
});

test('route request carries excludes, capped at the service limit', () => {
  const ex = Array.from({ length: 70 }, (_, i) => [i / 1000, 0]);
  const body = buildRouteRequest({ from: [1, 2], to: [3, 4], excludes: ex });
  assert.deepEqual(body.locations[0], { lon: 1, lat: 2, type: 'break' });
  assert.equal(body.exclude_locations.length, MAX_EXCLUDES);
  assert.equal(buildRouteRequest({ from: [1, 2], to: [3, 4] }).exclude_locations, undefined);
  assert.throws(() => buildRouteRequest({ from: [1, 2], to: [3, 4], costing: 'boat' }));
});

test('route response parses shape and maneuvers', () => {
  const coords = [[-97.74, 30.27], [-97.73, 30.27], [-97.73, 30.26]];
  const r = parseRouteResponse(trip(coords));
  assert.equal(r.coords.length, 3);
  assert.equal(r.maneuvers[0].street, 'Main St');
  assert.equal(r.maneuvers[1].begin, 1);
});

test('router errors keep the Valhalla error code', async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ error_code: 442, error: 'No path could be found for input' }) });
  await assert.rejects(requestRoute('https://r.example', {}, { fetchImpl }), (e) => e instanceof RoutingError && e.noPath);
});

// A grid town: the direct road east passes camera A; the detour north is clear.
const from = [-97.75, 30.27];
const to = [-97.73, 30.27];
const direct = [from, [-97.74, 30.27], to];
const detour = [from, [-97.75, 30.275], [-97.73, 30.275], to];
const camA = { id: 'A', lon: -97.74, lat: 30.2702 };
const camFar = { id: 'F', lon: -97.6, lat: 30.4 };

test('navigator tracks the next maneuver and camera ahead', () => {
  const r = parseRouteResponse(trip(direct));
  const nav = createNavigator(r, [camA]);
  const s = nav.update([-97.748, 30.27]);
  assert.equal(s.offRoute, false);
  assert.equal(s.next.instruction, 'Turn right.');
  assert.ok(s.toCamera > 700 && s.toCamera < 800, String(s.toCamera));
  assert.equal(nav.update([-97.748, 30.28]).offRoute, true);
  assert.equal(formatDistance(1609.344 * 2.5), '2.5 mi');
});
