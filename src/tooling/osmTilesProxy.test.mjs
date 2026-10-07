import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import {
  OSM_TILE_DEFAULT_UPSTREAMS,
  osmTilesProxy,
  parseOsmTilePath,
  parseOsmTileUpstreams,
  resolveOsmTileUpstreams,
} from '../../server/providers/osmTiles.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

function mount(options) {
  let handler;
  osmTilesProxy({
    cacheDir: mkdtempSync(path.join(os.tmpdir(), 'osm-tiles-')),
    ...options,
  }).configureServer({ middlewares: { use: (_p, h) => (handler = h) } });
  return async (url, method = 'GET') => {
    let status, headers, body;
    await handler(
      { method, url },
      {
        headersSent: false,
        writeHead(s, h) {
          status = s;
          headers = h;
        },
        end(b) {
          body = b;
        },
      },
    );
    return { status, headers, body };
  };
}

test('tile paths and upstream templates are validated', () => {
  assert.deepEqual(parseOsmTilePath('/3/4/5.png'), { z: 3, x: 4, y: 5 });
  assert.equal(parseOsmTilePath('/3/8/0.png'), null);
  assert.equal(parseOsmTilePath('/20/0/0.png'), null);
  assert.equal(parseOsmTilePath('/../etc/passwd'), null);
  assert.deepEqual(
    parseOsmTileUpstreams(
      'https://t.example/{z}/{x}/{y}.png, ftp://x/{z}/{x}/{y}, https://no-y/{z}/{x}',
    ),
    ['https://t.example/{z}/{x}/{y}.png'],
  );
  assert.deepEqual(resolveOsmTileUpstreams(''), [
    ...OSM_TILE_DEFAULT_UPSTREAMS,
  ]);
});

test('fails over to the next upstream, sends a User-Agent, then caches', async () => {
  const seen = [];
  const get = mount({
    upstreams: [
      'https://a.example/{z}/{x}/{y}.png',
      'https://b.example/{z}/{x}/{y}.png',
    ],
    fetchImpl: async (url, init) => {
      seen.push(url);
      assert.match(init.headers['User-Agent'], /osint-omni/);
      if (url.startsWith('https://a.'))
        return new Response('blocked', { status: 403 });
      return new Response(PNG);
    },
  });
  const first = await get('/2/1/3.png');
  assert.equal(first.status, 200);
  assert.equal(first.headers['Content-Type'], 'image/png');
  assert.deepEqual(seen, [
    'https://a.example/2/1/3.png',
    'https://b.example/2/1/3.png',
  ]);
  // a.example is now cooling down, so the next tile goes straight to b.
  await get('/2/0/0.png');
  assert.equal(seen.at(-1), 'https://b.example/2/0/0.png');
  assert.equal(seen.length, 3);
  const again = await get('/2/1/3.png');
  assert.equal(again.headers['X-Osm-Tile-Cache'], 'HIT');
  assert.equal(seen.length, 3);
});

test('non-image answers count as failures and all-down returns 502', async () => {
  const get = mount({
    upstreams: ['https://a.example/{z}/{x}/{y}.png'],
    fetchImpl: async () => new Response('<html>blocked</html>'),
  });
  const out = await get('/1/0/0.png');
  assert.equal(out.status, 502);
  assert.equal((await get('/1/0/0.png', 'POST')).status, 405);
  assert.equal((await get('/1/0/9.png')).status, 404);
});
