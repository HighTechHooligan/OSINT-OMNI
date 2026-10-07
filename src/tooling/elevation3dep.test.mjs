import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEP_MAX_SIDE_PX,
  DEP_NODATA,
  buildUpstreamUrl,
  decodeElevationTiff,
  elevation3depProxy,
  parseBbox,
  planGrid,
  tiffExtent,
} from '../../server/providers/elevation3dep.js';

/** Minimal uncompressed single-strip little-endian Float32 GeoTIFF. */
function floatTiff(width, height, values) {
  const tags = [
    [256, 3, 1, width],
    [257, 3, 1, height],
    [258, 3, 1, 32],
    [259, 3, 1, 1],
    [262, 3, 1, 1],
    [273, 4, 1, 0], // patched below
    [277, 3, 1, 1],
    [278, 3, 1, height],
    [279, 4, 1, width * height * 4],
    [284, 3, 1, 1],
    [339, 3, 1, 3],
  ];
  const ifdSize = 2 + tags.length * 12 + 4;
  const dataOffset = 8 + ifdSize;
  const buf = new ArrayBuffer(dataOffset + width * height * 4);
  const view = new DataView(buf);
  view.setUint16(0, 0x4949, true);
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);
  view.setUint16(8, tags.length, true);
  tags.forEach(([tag, type, count, value], i) => {
    const at = 10 + i * 12;
    view.setUint16(at, tag, true);
    view.setUint16(at + 2, type, true);
    view.setUint32(at + 4, count, true);
    const v = tag === 273 ? dataOffset : value;
    if (type === 3) view.setUint16(at + 8, v, true);
    else view.setUint32(at + 8, v, true);
  });
  values.forEach((v, i) => view.setFloat32(dataOffset + i * 4, v, true));
  return buf;
}

function install(plugin) {
  let handler;
  plugin.configureServer({
    middlewares: { use: (_route, h) => (handler = h) },
  });
  return async (url) => {
    const res = {
      headersSent: false,
      writeHead(status, headers) {
        Object.assign(this, { status, headers, headersSent: true });
      },
      end(body) {
        this.body = body;
      },
    };
    await handler({ url, method: 'GET' }, res);
    return res;
  };
}

test('parseBbox accepts ordered boxes and rejects junk', () => {
  assert.deepEqual(parseBbox('-93.37,44.83,-93.36,44.85'), {
    minLon: -93.37,
    minLat: 44.83,
    maxLon: -93.36,
    maxLat: 44.85,
  });
  assert.equal(parseBbox('-93.36,44.83,-93.37,44.85'), null);
  assert.equal(parseBbox('1,2,3'), null);
  assert.equal(parseBbox('a,b,c,d'), null);
  assert.equal(parseBbox('0,95,1,96'), null);
});

test('planGrid sizes a ~47 acre site at 1 m and caps big boxes', () => {
  const site = planGrid(
    { minLon: -93.3677, minLat: 44.8398, maxLon: -93.3625, maxLat: 44.8469 },
    1,
  );
  assert.ok(site.width > 350 && site.width < 450, `width ${site.width}`);
  assert.ok(site.height > 750 && site.height < 850, `height ${site.height}`);
  assert.ok(Math.abs(site.resM - 1) < 0.01);
  const big = planGrid({ minLon: -94, minLat: 44, maxLon: -93, maxLat: 45 }, 1);
  assert.ok(Math.max(big.width, big.height) <= DEP_MAX_SIDE_PX);
  assert.ok(big.resM > 1);
});

test('upstream URL asks 3DEP for a Float32 lon/lat GeoTIFF', () => {
  const url = new URL(
    buildUpstreamUrl(
      { minLon: -1, minLat: 2, maxLon: 3, maxLat: 4 },
      { width: 10, height: 20 },
    ),
  );
  assert.equal(url.hostname, 'elevation.nationalmap.gov');
  assert.equal(url.searchParams.get('bbox'), '-1,2,3,4');
  assert.equal(url.searchParams.get('imageSR'), '4326');
  assert.equal(url.searchParams.get('size'), '10,20');
  assert.equal(url.searchParams.get('format'), 'tiff');
  assert.equal(url.searchParams.get('pixelType'), 'F32');
});

test('decodeElevationTiff keeps elevations and masks no-data', async () => {
  const tiff = floatTiff(3, 2, [250.5, 251, 252, DEP_NODATA, Number.NaN, 253]);
  const { values, validFraction } = await decodeElevationTiff(tiff, {
    width: 3,
    height: 2,
  });
  assert.deepEqual(Array.from(values), [
    250.5,
    251,
    252,
    DEP_NODATA,
    DEP_NODATA,
    253,
  ]);
  assert.ok(Math.abs(validFraction - 4 / 6) < 1e-9);
  await assert.rejects(
    decodeElevationTiff(tiff, { width: 4, height: 2 }),
    /expected 4x2/,
  );
});

test("tiffExtent reads the raster's own georeferencing", () => {
  const image = (rasterType, origin = [-93.27, 44.978]) => ({
    getOrigin: () => [...origin, 0],
    getResolution: () => [0.0001, -0.0001, 0],
    getWidth: () => 100,
    getHeight: () => 80,
    geoKeys: { GTRasterTypeGeoKey: rasterType },
  });
  const close = (a, b) =>
    a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-9, `${a} vs ${b}`));
  // PixelIsArea: tie point is the outer NW corner.
  close(tiffExtent(image(1)), [-93.27, 44.97, -93.26, 44.978]);
  // PixelIsPoint: tie point is the NW pixel centre, half a pixel inside.
  close(tiffExtent(image(2)), [-93.27005, 44.97005, -93.26005, 44.97805]);
  assert.equal(tiffExtent(image(1, [500000, 4980000])), null);
  assert.equal(
    tiffExtent({
      getOrigin: () => {
        throw new Error('no transform');
      },
    }),
    null,
  );
});

test('proxy serves the grid, caches it, and reports errors', async (t) => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'dep-'));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  let calls = 0;
  let lastUrl = '';
  const fetchImpl = async (url) => {
    calls++;
    lastUrl = url;
    const size = new URL(url).searchParams.get('size').split(',').map(Number);
    const [w, h] = size;
    return new Response(
      floatTiff(
        w,
        h,
        Array.from({ length: w * h }, (_, i) => 250 + i * 0.01),
      ),
      {
        headers: { 'content-type': 'image/tiff' },
      },
    );
  };
  const request = install(elevation3depProxy({ fetchImpl, cacheDir }));
  const bbox = '-93.3677,44.8398,-93.3625,44.8469';

  const first = await request(`/?bbox=${bbox}&res=4`);
  assert.equal(first.status, 200);
  assert.equal(first.headers['X-Cache'], 'MISS');
  const w = Number(first.headers['X-Grid-Width']);
  const h = Number(first.headers['X-Grid-Height']);
  assert.equal(first.body.length, w * h * 4);
  assert.match(lastUrl, /exportImage/);
  const grid = new Float32Array(
    first.body.buffer,
    first.body.byteOffset,
    w * h,
  );
  assert.ok(Math.abs(grid[0] - 250) < 1e-3);
  // No georeferencing in the test TIFF → falls back to the requested box.
  assert.equal(first.headers['X-Grid-Bbox'], bbox);
  assert.equal(first.headers['X-Grid-Datum'], 'NAD83');

  const second = await request(`/?bbox=${bbox}&res=4`);
  assert.equal(second.headers['X-Cache'], 'HIT');
  assert.equal(calls, 1);
  assert.equal((await readdir(cacheDir)).length, 2);

  assert.equal((await request('/?bbox=nope')).status, 400);
  assert.equal((await request('/?bbox=-95,43,-93,45')).status, 413);

  const failing = install(
    elevation3depProxy({
      cacheDir,
      fetchImpl: async () => new Response('down', { status: 503 }),
    }),
  );
  const res = await failing('/?bbox=-93.30,44.80,-93.29,44.81&res=5');
  assert.equal(res.status, 502);
  assert.match(res.body, /3DEP elevation unavailable/);
});
