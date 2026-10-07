import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  alprTilesProxy,
  alprUpstreamUrl,
  parseAlprPath,
  resolveAlprUpstream,
  rewriteAlprTileJson,
  unwrapTileBytes,
} from './alprTiles.js';

test('ALPR proxy paths are parsed strictly', () => {
  assert.deepEqual(parseAlprPath('/us.json'), {
    kind: 'tilejson',
    country: 'us',
  });
  assert.deepEqual(parseAlprPath('/ca/11/467/843.mvt'), {
    kind: 'tile',
    country: 'ca',
    z: 11,
    x: 467,
    y: 843,
  });
  for (const bad of [
    '/mx.json',
    '/us/15/0/0.mvt',
    '/us/2/4/0.mvt',
    '/us/../../etc/passwd',
    '/us/1/0/0.png',
  ])
    assert.equal(parseAlprPath(bad), null, bad);
});

test('upstream URLs, overrides and TileJSON rewriting', () => {
  assert.equal(resolveAlprUpstream(''), 'https://tiles.dontgetflocked.com');
  assert.equal(
    resolveAlprUpstream('ftp://x'),
    'https://tiles.dontgetflocked.com',
  );
  assert.equal(
    resolveAlprUpstream('https://tiles.example.org/alpr/'),
    'https://tiles.example.org/alpr',
  );
  assert.equal(
    alprUpstreamUrl(
      { kind: 'tile', country: 'us', z: 1, x: 0, y: 1 },
      'https://h',
    ),
    'https://h/cameras-us-hourly/1/0/1.mvt',
  );
  const json = rewriteAlprTileJson(
    {
      tiles: ['https://h/cameras-us-hourly/{z}/{x}/{y}.mvt'],
      bounds: [1, 2, 3, 4],
    },
    'us',
  );
  assert.deepEqual(json.tiles, ['/api/alpr/us/{z}/{x}/{y}.mvt']);
  assert.deepEqual(json.bounds, [1, 2, 3, 4]);
  assert.throws(() => rewriteAlprTileJson({}, 'us'), /invalid TileJSON/);
});

test('gzip-wrapped tiles are unwrapped; plain tiles pass through', () => {
  const raw = Buffer.from([0x1a, 0x02, 0x03]);
  assert.deepEqual(unwrapTileBytes(gzipSync(raw)), raw);
  assert.equal(unwrapTileBytes(raw), raw);
});

function harness({ fetchImpl, now }) {
  const cacheDir = mkdtempSync(path.join(tmpdir(), 'alpr-proxy-'));
  let handler;
  const plugin = alprTilesProxy({
    fetchImpl,
    cacheDir,
    now,
    upstream: 'https://up',
  });
  plugin.configureServer({
    middlewares: { use: (_mount, fn) => (handler = fn) },
  });
  async function get(url) {
    return new Promise((resolve) => {
      const res = {
        headersSent: false,
        writeHead(status, headers) {
          this.status = status;
          this.headers = headers;
          this.headersSent = true;
        },
        end(body) {
          resolve({ status: this.status, headers: this.headers, body });
        },
      };
      handler({ method: 'GET', url }, res);
    });
  }
  return {
    get,
    cleanup: () => rmSync(cacheDir, { recursive: true, force: true }),
  };
}

test('tiles are cached, refreshed after an hour, and served stale on failure', async () => {
  let clock = 1_000_000;
  let calls = 0;
  let failing = false;
  const { get, cleanup } = harness({
    now: () => clock,
    fetchImpl: async (url) => {
      calls++;
      assert.equal(url, 'https://up/cameras-us-hourly/11/467/843.mvt');
      if (failing) throw new Error('network down');
      return new Response(gzipSync(Buffer.from([1, 2, 3])));
    },
  });
  try {
    const first = await get('/us/11/467/843.mvt');
    assert.equal(first.status, 200);
    assert.equal(first.headers['X-Alpr-Cache'], 'MISS');
    assert.deepEqual([...first.body], [1, 2, 3]);
    const second = await get('/us/11/467/843.mvt');
    assert.equal(second.headers['X-Alpr-Cache'], 'HIT');
    assert.equal(calls, 1);
    clock += 2 * 60 * 60 * 1000;
    failing = true;
    const stale = await get('/us/11/467/843.mvt');
    assert.equal(stale.status, 200);
    assert.equal(stale.headers['X-Alpr-Cache'], 'STALE');
    assert.deepEqual([...stale.body], [1, 2, 3]);
    assert.equal(calls, 2);
  } finally {
    cleanup();
  }
});

test('TileJSON is rewritten to the proxy; failures without cache are 502', async () => {
  const { get, cleanup } = harness({
    now: () => 0,
    fetchImpl: async (url) =>
      url.endsWith('us.json') || url.endsWith('us-hourly.json')
        ? Response.json({
            tiles: ['https://up/cameras-us-hourly/{z}/{x}/{y}.mvt'],
            bounds: [-160, 17, -64, 62],
          })
        : new Response('nope', { status: 500 }),
  });
  try {
    const meta = await get('/us.json');
    assert.equal(meta.status, 200);
    assert.deepEqual(JSON.parse(meta.body).tiles, [
      '/api/alpr/us/{z}/{x}/{y}.mvt',
    ]);
    const missing = await get('/us/3/1/2.mvt');
    assert.equal(missing.status, 502);
    const unknown = await get('/zz.json');
    assert.equal(unknown.status, 404);
  } finally {
    cleanup();
  }
});

test('an upstream 404 tile is an empty, cacheable tile', async () => {
  const { get, cleanup } = harness({
    now: () => 0,
    fetchImpl: async () => new Response('', { status: 404 }),
  });
  try {
    const empty = await get('/ca/5/9/10.mvt');
    assert.equal(empty.status, 200);
    assert.equal(empty.body.length, 0);
  } finally {
    cleanup();
  }
});
