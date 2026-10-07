import test from 'node:test';
import assert from 'node:assert/strict';
import {
  airspaceProxy,
  arcgisQueryUrl,
} from '../../server/providers/airspace.js';

const square = {
  type: 'Polygon',
  coordinates: [
    [
      [-93.3, 44.9],
      [-93.2, 44.9],
      [-93.2, 45],
      [-93.3, 45],
      [-93.3, 44.9],
    ],
  ],
};

function install(options = {}) {
  let handler;
  const plugin = airspaceProxy({
    upstreams: {
      class: 'https://class.test/query',
      sua: 'https://sua.test/query',
      laanc: 'https://laanc.test/query',
      tfrShapes: 'https://tfr.test/wfs',
      tfrList: 'https://tfr.test/list',
    },
    ...options,
  });
  plugin.configureServer({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/airspace');
        handler = callback;
      },
    },
  });
  return async (url, method = 'GET') => {
    const res = {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.body = JSON.parse(body);
      },
    };
    await handler({ url, method, socket: { remoteAddress: 'local' } }, res);
    return res;
  };
}

test('arcgis query is an envelope intersect in WGS84 GeoJSON', () => {
  const url = new URL(
    arcgisQueryUrl(
      'https://x.test/q',
      { west: -94, south: 44, east: -93, north: 45 },
      2000,
    ),
  );
  assert.equal(url.searchParams.get('geometry'), '-94,44,-93,45');
  assert.equal(url.searchParams.get('f'), 'geojson');
  assert.equal(url.searchParams.get('resultOffset'), '2000');
});

test('class route quantizes, pages, normalizes and caches', async () => {
  const calls = [];
  const request = install({
    fetchImpl: async (url) => {
      calls.push(new URL(url));
      return Response.json({
        features: [
          {
            properties: {
              OBJECTID: calls.length,
              CLASS: 'D',
              LOWER_VAL: 0,
              LOWER_CODE: 'SFC',
            },
            geometry: square,
          },
        ],
        exceededTransferLimit: calls.length === 1,
      });
    },
  });
  const res = await request('/class?bbox=-93.3,44.9,-93.1,45.05');
  assert.equal(res.status, 200);
  assert.equal(res.body.rows.length, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].origin, 'https://class.test');
  assert.equal(calls[0].searchParams.get('geometry'), '-93.5,44.75,-93,45.25');
  // Same quantized tile → served from cache.
  await request('/class?bbox=-93.4,44.8,-93.2,45.1');
  assert.equal(calls.length, 2);
});

test('rejects bad routes, boxes and methods', async () => {
  const request = install({
    fetchImpl: async () => {
      throw new Error('no network in tests');
    },
  });
  assert.equal((await request('/class?bbox=1,2,3')).status, 400);
  assert.equal(
    (await request('/laanc?bbox=-95,44,-93,45')).body.error,
    'bbox_too_large',
  );
  assert.equal((await request('/nope')).status, 404);
  assert.equal((await request('/tfr', 'POST')).status, 405);
  assert.equal((await request('/sua?bbox=-94,44,-93,45')).status, 502);
});

test('tfr route survives a failed list and merges when it works', async () => {
  let listFails = true;
  const request = install({
    now: (() => {
      let t = 0;
      return () => (t += 10 * 60e3);
    })(),
    fetchImpl: async (url) => {
      if (url.endsWith('/list')) {
        if (listFails) return new Response('down', { status: 503 });
        return Response.json([{ notam_id: '6/4045', description: 'VIP' }]);
      }
      return Response.json({
        features: [
          { properties: { NOTAM_KEY: '6/4045-1-FDC-F' }, geometry: square },
        ],
      });
    },
  });
  const first = await request('/tfr');
  assert.equal(first.status, 200);
  assert.equal(first.body.rows[0].notamId, '6/4045');
  assert.equal(first.body.rows[0].description, null);
  listFails = false;
  const second = await request('/tfr');
  assert.equal(second.body.rows[0].description, 'VIP');
});
