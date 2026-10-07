import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  alprDetailZoom,
  alprOverviewZoom,
  createAlprPrecisionCache,
  createAlprTileSource,
  createOverpassAlprSource,
  buildOverpassQuery,
} from './source.js';
import { validateAlprSnapshot, alprCreditMarkup } from './model.js';
import { decodeAlprOverviewTile } from './tileRecords.js';
const box = { south: 30, west: -98, north: 30.1, east: -97.9 };
test('the source rejects invalid and unbounded queries before fetching', async () => {
  let calls = 0;
  const source = createAlprTileSource({
    tileFetchImpl() {
      calls++;
    },
  });
  for (const bad of [
    null,
    { ...box, west: '0);out;' },
    { ...box, north: 90 },
    { ...box, east: -99 },
    { ...box, south: NaN },
  ]) {
    await assert.rejects(source.fetch(bad), /bounded city viewport/);
  }
  assert.equal(calls, 0);
});
const fixture = readFileSync(
  new URL(
    '../../data/fixtures/osm-alpr-austin-11-467-843.pbf',
    import.meta.url,
  ),
);
const metadata = (country) => ({
  tiles: [
    `https://tiles.dontgetflocked.com/cameras-${country}-hourly/{z}/{x}/{y}.mvt`,
  ],
  bounds: country === 'ca' ? [-124, 42, -63, 54] : [-160, 17, -64, 59],
});
const austin = { south: 30.2, north: 30.35, west: -97.85, east: -97.65 };

test('cancellation while reading TileJSON is preserved even if fetch ignores it', async () => {
  const abort = new AbortController();
  const source = createAlprTileSource({
    tileFetchImpl: async () => ({
      ok: true,
      headers: new Headers(),
      async text() {
        abort.abort();
        return JSON.stringify(metadata('us'));
      },
    }),
  });
  await assert.rejects(source.fetch(austin, abort.signal), {
    name: 'AbortError',
  });
});

test('extract detail tiles map OSM records and repeated pans reuse decoded tiles', async () => {
  const calls = [];
  const source = createAlprTileSource({
    tileFetchImpl: async (url) => {
      calls.push(url);
      return url.endsWith('.json')
        ? Response.json(metadata(url.includes('-ca-') ? 'ca' : 'us'))
        : new Response(fixture);
    },
  });
  const snapshot = await source.fetch(austin);
  assert.ok(snapshot.records.length > 0);
  const record = snapshot.records[0];
  assert.match(record.id, /^alpr:/);
  assert.equal(record.manufacturer, 'Flock Safety');
  assert.equal(record.lastVerified, null);
  assert.ok(record.osmTimestamp);
  assert.equal(snapshot.stale, false);
  assert.equal('elements' in snapshot, false);
  const fetched = calls.length;
  await source.fetch(austin);
  assert.equal(calls.length, fetched);
  assert.ok(calls.every((url) => !url.includes('overpass')));
  assert.doesNotMatch(JSON.stringify(source.attribution), /flock/i);
});

test('outside extract coverage is an explicit no-data state without Overpass', async () => {
  const source = createAlprTileSource({
    tileFetchImpl: () => assert.fail('no network expected in Europe'),
  });
  assert.deepEqual(
    await source.fetch({ south: 51, north: 51.1, west: 0, east: 0.1 }),
    { records: [], stale: false, saturated: false, noCoverage: true },
  );
});

test('an unsuccessful source response releases its body before reporting an error', async () => {
  let cancelled = 0;
  const source = createAlprTileSource({
    tileFetchImpl: async () => ({
      ok: false,
      status: 429,
      body: {
        async cancel() {
          cancelled++;
        },
      },
    }),
  });
  await assert.rejects(source.fetch(box), /unavailable/);
  assert.equal(cancelled, 1);
});

test('source snapshots reject malformed coordinates and duplicate identities', () => {
  const record = { id: 'camera:1', latitude: 30, longitude: -98 };
  for (const records of [
    [{ ...record, latitude: NaN }],
    [record, record],
    [{ ...record, id: '' }],
  ]) {
    assert.throws(
      () => validateAlprSnapshot({ records, stale: false, saturated: false }),
      /invalid record/,
    );
  }
  assert.throws(
    () => validateAlprSnapshot({ elements: [] }),
    /invalid snapshot/,
  );
});

test('provider attribution escapes markup and rejects executable links', () => {
  assert.equal(alprCreditMarkup(null), null);
  assert.throws(
    () => alprCreditMarkup({ text: 'test', href: 'javascript:alert(1)' }),
    /HTTPS/,
  );
  const html = alprCreditMarkup({
    text: '<img onerror=alert(1)>',
    href: 'https://example.org/?a=1&b=2',
  });
  assert.ok(html.includes('&lt;img onerror=alert(1)&gt;'));
  assert.ok(html.includes('?a=1&amp;b=2'));
  assert.ok(!html.includes('<img'));
});

test('wide detail view returns zoom guidance before any fetch and can retry a smaller view', async () => {
  let calls = 0;
  const source = createAlprTileSource({
    tileFetchImpl: async () => {
      calls++;
      return Response.json({
        tiles: ['https://tiles.dontgetflocked.com/{z}/{x}/{y}.pbf'],
        bounds: [-180, 17, -50, 84],
      });
    },
  });
  const wide = await source.fetch({
    south: 29,
    north: 32,
    west: -99,
    east: -96,
  });
  assert.equal(wide.zoomIn, true);
  assert.equal(calls, 0);
  await source
    .fetch({ south: 30.267, north: 30.268, west: -97.744, east: -97.743 })
    .catch(() => {});
  assert.ok(calls > 0);
});

test('each view reads the finest attributed extract zoom that fits 16 tiles', () => {
  // Field report: a z11-only read refused whole-city views. Attributed detail
  // exists from z9, so a city reads a few z9/z10 tiles and a street z12.
  assert.equal(
    alprDetailZoom({ south: 30.29, north: 30.31, west: -97.78, east: -97.75 }),
    12,
  );
  assert.equal(
    alprDetailZoom({ south: 30.17, north: 30.36, west: -97.85, east: -97.63 }),
    12,
  );
  assert.equal(
    alprDetailZoom({ south: 29.7, north: 30.7, west: -98.25, east: -97.25 }),
    10,
  );
  assert.equal(
    alprDetailZoom({ south: 29.2, north: 31.2, west: -98.75, east: -96.75 }),
    9,
  );
  assert.equal(
    alprDetailZoom({ south: 29, north: 32, west: -99, east: -96 }),
    null,
  );
});

test('a whole-city view loads cameras and reports the tiles it covers', async () => {
  const urls = [];
  const source = createAlprTileSource({
    tileFetchImpl: async (url) => {
      urls.push(url);
      return url.endsWith('.json')
        ? Response.json(metadata(url.includes('-ca-') ? 'ca' : 'us'))
        : new Response(fixture);
    },
  });
  const city = { south: 29.95, north: 30.55, west: -98.05, east: -97.45 };
  const snapshot = await source.fetch(city);
  assert.equal(snapshot.zoomIn, undefined);
  assert.equal(snapshot.zoom, 10);
  assert.ok(snapshot.records.length > 0);
  assert.ok(urls.some((url) => url.includes('/10/')));
  for (const key of ['south', 'west'])
    assert.ok(snapshot.coverage[key] <= city[key]);
  for (const key of ['north', 'east'])
    assert.ok(snapshot.coverage[key] >= city[key]);
});

test('coarser tiles never move a camera a finer tile already placed', () => {
  const cache = createAlprPrecisionCache(2);
  const fine = {
    id: 'alpr:1',
    latitude: 30.30001,
    longitude: -97.76001,
    operator: 'A',
  };
  assert.equal(cache.apply(fine, 12), fine);
  const coarse = {
    ...fine,
    latitude: 30.3001,
    longitude: -97.7602,
    operator: 'B',
  };
  const kept = cache.apply(coarse, 9);
  assert.equal(kept.latitude, fine.latitude);
  assert.equal(kept.longitude, fine.longitude);
  assert.equal(kept.operator, 'B', 'attributes still refresh');
  const finer = { ...fine, latitude: 30.300012 };
  assert.equal(cache.apply(finer, 13), finer);
  cache.apply({ id: 'alpr:2', latitude: 1, longitude: 1 }, 12);
  cache.apply({ id: 'alpr:3', latitude: 1, longitude: 1 }, 12);
  assert.equal(cache.size(), 2, 'bounded');
});

test('the explicit Overpass factory posts the unchanged query to its API transport', async () => {
  const calls = [];
  const source = createOverpassAlprSource({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return Response.json({
        elements: [
          {
            type: 'node',
            id: 42,
            lat: 30.05,
            lon: -97.95,
            tags: { 'surveillance:type': 'ALPR', operator: 'Test' },
          },
        ],
      });
    },
  });
  const result = await source.fetch(box);
  assert.equal(result.records.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/overpass');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(
    new URLSearchParams(calls[0].options.body).get('data'),
    buildOverpassQuery(box.south, box.west, box.north, box.east),
  );
});

test('the tile adapter never passes public URLs through an injected API transport', async (t) => {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(url);
    return url.endsWith('.json')
      ? Response.json(metadata('us'))
      : new Response(fixture);
  });
  const source = createAlprTileSource({
    fetchImpl: () => assert.fail('API transport must not receive tile URLs'),
  });
  const result = await source.fetch(austin);
  assert.ok(result.records.length);
  assert.ok(urls.length > 1);
  assert.ok(urls.every((url) => url.startsWith('https://tiles.')));
});

test('the browser reads the extract through the same-origin proxy', async () => {
  const calls = [];
  const source = createAlprTileSource({
    proxyOrigin: 'http://localhost:5173',
    tileFetchImpl: async (url) => {
      calls.push(url);
      if (url.endsWith('.json')) {
        const country = url.includes('/ca.json') ? 'ca' : 'us';
        return Response.json({
          ...metadata(country),
          tiles: [`/api/alpr/${country}/{z}/{x}/{y}.mvt`],
        });
      }
      return new Response(fixture);
    },
  });
  const snapshot = await source.fetch(austin);
  assert.ok(snapshot.records.length > 0);
  assert.ok(calls.length > 1);
  assert.ok(
    calls.every(
      (url) =>
        url.startsWith('http://localhost:5173/api/alpr/') ||
        url.startsWith('/api/alpr/'),
    ),
    calls.join('\n'),
  );
});

test('a host without the proxy falls back to the community extract', async () => {
  const calls = [];
  const source = createAlprTileSource({
    proxyOrigin: 'http://localhost:5173',
    tileFetchImpl: async (url) => {
      calls.push(url);
      if (url.startsWith('http://localhost'))
        return new Response('<!doctype html>', { status: 404 });
      return url.endsWith('.json')
        ? Response.json(metadata(url.includes('-ca-') ? 'ca' : 'us'))
        : new Response(fixture);
    },
  });
  const snapshot = await source.fetch(austin);
  assert.ok(snapshot.records.length > 0);
  assert.ok(
    calls.some((url) => url.startsWith('https://tiles.dontgetflocked.com/')),
  );
  const before = calls.filter((url) =>
    url.startsWith('http://localhost'),
  ).length;
  await source.fetch({ south: 32.7, north: 32.85, west: -96.9, east: -96.7 });
  assert.equal(
    calls.filter((url) => url.startsWith('http://localhost')).length,
    before,
    'the missing proxy is not asked again',
  );
});

test('wide views get an overview of every mapped camera position', async () => {
  const tiles = [];
  const source = createAlprTileSource({
    tileFetchImpl: async (url) => {
      if (url.endsWith('.json'))
        return Response.json(metadata(url.includes('-ca-') ? 'ca' : 'us'));
      tiles.push(url);
      // The fixture is z11/467/843; reuse it only for that address.
      return url.endsWith('/11/467/843.mvt')
        ? new Response(fixture)
        : new Response(new Uint8Array(0));
    },
  });
  const texas = { south: 25.8, west: -106.7, north: 36.5, east: -93.5 };
  const zoom = alprOverviewZoom(texas);
  assert.ok(zoom >= 3 && zoom <= 8);
  const overview = await source.fetchOverview(texas);
  assert.equal(overview.noCoverage, false);
  assert.ok(tiles.length > 0 && tiles.length <= 48);
  assert.ok(tiles.every((url) => url.includes(`/${zoom}/`)));
  assert.equal(typeof overview.key, 'string');
  const europe = await source.fetchOverview({
    south: 40,
    west: 0,
    north: 50,
    east: 10,
  });
  assert.equal(europe.noCoverage, true);
  assert.equal(europe.count, 0);
});

test('overview decoding yields lon/lat pairs in the tile', () => {
  const { positions, count } = decodeAlprOverviewTile(fixture, 11, 467, 843);
  assert.ok(count >= 1);
  assert.equal(positions.length, count * 2);
  const [lon, lat] = positions;
  assert.ok(lon > -98 && lon < -97.6, String(lon));
  assert.ok(lat > 30 && lat < 30.5, String(lat));
  assert.deepEqual(decodeAlprOverviewTile(new Uint8Array(0), 3, 1, 3), {
    positions: new Float64Array(0),
    count: 0,
  });
});
