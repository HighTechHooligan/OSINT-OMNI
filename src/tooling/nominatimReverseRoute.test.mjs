// THE DOSSIER ADDRESS ROUTE — reverse geocoding for buildings, roads and parks.
//
// It shares the forward search's one-request-per-second queue, keeps only
// plain-text address fields, and validates coordinates before going upstream.
//
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNominatimReverseProvider,
  geocodeProxy,
} from '../../server/providers/regional/place.js';

function mountReverse(reverse) {
  const routes = new Map();
  geocodeProxy({ reverse }).configureServer({
    middlewares: { use: (route, handler) => routes.set(route, handler) },
  });
  const handler = routes.get('/api/reverse-geocode');
  assert.ok(handler, 'reverse route is mounted');
  return (query) =>
    new Promise((resolve, reject) => {
      let status = 200;
      const res = {
        writableEnded: false,
        on() {},
        writeHead(code) {
          status = code;
        },
        end(body) {
          res.writableEnded = true;
          resolve({ status, body: JSON.parse(body) });
        },
      };
      Promise.resolve(
        handler(
          {
            method: 'GET',
            url: `/${query}`,
            headers: {},
            socket: { remoteAddress: '10.9.9.9' },
            on() {},
          },
          res,
        ),
      ).catch(reject);
    });
}

test('bad coordinates never reach the upstream', async () => {
  let calls = 0;
  const request = mountReverse(async () => {
    calls++;
    return { status: 'OK', result: {} };
  });
  for (const q of ['', '?lat=91&lon=0', '?lat=abc&lon=1', '?lat=&lon=1'])
    assert.equal((await request(q)).status, 400, q);
  assert.equal(calls, 0);
});

test('a lookup returns compact address fields and is cached', async () => {
  const urls = [];
  const provider = createNominatimReverseProvider({
    requestJson: async (url) => {
      urls.push(url);
      return {
        display_name: '7600, Normandale Boulevard, Bloomington, MN 55435',
        name: '',
        category: 'building',
        type: 'office',
        osm_type: 'way',
        osm_id: '123',
        address: { house_number: '7600', road: 'Normandale\u0007 Boulevard' },
      };
    },
  });
  const request = mountReverse(provider);
  const first = await request('?lat=44.85&lon=-93.35');
  assert.equal(first.status, 200);
  assert.equal(first.body.result.osmId, 123);
  assert.equal(first.body.result.address.road, 'Normandale  Boulevard');
  assert.match(urls[0], /zoom=18/);
  await request('?lat=44.85&lon=-93.35');
  assert.equal(urls.length, 1, 'second lookup served from cache');
});

test('an upstream failure is a service answer, not a crash', async () => {
  const request = mountReverse(async () => {
    throw new Error('down');
  });
  const out = await request('?lat=1&lon=1');
  assert.equal(out.status, 503);
});
