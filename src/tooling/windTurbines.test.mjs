import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  normalizeTurbine,
  parseBbox,
  parseLimit,
  queryTurbines,
  resolveUswtdbUpstream,
  uswtdbPageUrl,
  windTurbinesProxy,
} from '../../server/providers/windTurbines.js';

const row = (id, lon, lat, extra = {}) => ({
  case_id: id,
  xlong: lon,
  ylat: lat,
  p_name: 'Test Wind',
  p_year: 2019,
  t_cap: 2500,
  t_hh: 90,
  t_rd: 116,
  t_ttlh: 148,
  t_state: 'TX',
  t_manu: 'GE Wind',
  t_model: 'GE2.5-116',
  ...extra,
});

test('rows normalize, -9999 becomes null, bad positions drop', () => {
  const t = normalizeTurbine(row(7, -100.1234567, 32.5, { t_hh: -9999 }));
  assert.equal(t.id, '7');
  assert.equal(t.lon, -100.123457);
  assert.equal(t.hubM, null);
  assert.equal(t.tipM, 148);
  assert.equal(t.kw, 2500);
  assert.equal(normalizeTurbine(row(8, 'x', 32)), null);
  assert.equal(normalizeTurbine(row(9, -200, 32)), null);
});

test('bbox, limit and upstream parsing', () => {
  assert.deepEqual(parseBbox('-101,32,-100,33'), {
    west: -101,
    south: 32,
    east: -100,
    north: 33,
  });
  for (const bad of ['', '1,2,3', '-100,32,-101,33', '0,0,0,0', 'a,b,c,d'])
    assert.equal(parseBbox(bad), null, bad);
  assert.equal(parseLimit(undefined), 3000);
  assert.equal(parseLimit('50'), 50);
  assert.equal(parseLimit('999999'), 10000);
  assert.equal(
    resolveUswtdbUpstream(''),
    'https://energy.usgs.gov/api/uswtdb/v1',
  );
  assert.equal(
    resolveUswtdbUpstream('http://10.0.0.5:3000/uswtdb/'),
    'http://10.0.0.5:3000/uswtdb',
  );
  assert.equal(
    resolveUswtdbUpstream('file:///etc'),
    'https://energy.usgs.gov/api/uswtdb/v1',
  );
  assert.match(
    uswtdbPageUrl(20000, 'https://h/v1'),
    /^https:\/\/h\/v1\/turbines\?order=case_id&limit=10000&offset=20000$/,
  );
});

test('queries summarize the whole view and thin the sample', () => {
  const all = [];
  for (let i = 0; i < 100; i++)
    all.push(
      normalizeTurbine(
        row(i, -100 + i * 0.001, 32, { t_ttlh: i === 42 ? 200 : 150 }),
      ),
    );
  all.push(normalizeTurbine(row(999, -80, 40, { p_name: 'Elsewhere' })));
  const result = queryTurbines(
    all,
    { west: -101, south: 31, east: -99, north: 33 },
    10,
  );
  assert.equal(result.total, 101);
  assert.equal(result.inView, 100);
  assert.equal(result.turbines.length, 10);
  assert.equal(result.sampled, true);
  assert.equal(result.summary.mw, 250);
  assert.equal(result.summary.tallest.id, '42');
  assert.deepEqual(result.summary.topProjects, [
    { name: 'Test Wind', count: 100 },
  ]);
});

function harness(fetchImpl, opts = {}) {
  const cacheDir = mkdtempSync(path.join(tmpdir(), 'uswtdb-'));
  let handler;
  const plugin = windTurbinesProxy({
    fetchImpl,
    cacheDir,
    upstream: 'https://up/v1',
    ...opts,
  });
  plugin.configureServer({
    middlewares: { use: (_mount, fn) => (handler = fn) },
  });
  async function get(url) {
    const res = {
      headersSent: false,
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
        this.headersSent = true;
      },
      end(body) {
        this.body = body ? JSON.parse(body) : null;
      },
    };
    await handler({ method: 'GET', url }, res);
    return res;
  }
  return { get, cleanup: () => rmSync(cacheDir, { recursive: true }) };
}

const okJson = (rows) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(rows),
});

test('proxy pages once, caches, and serves stale when USGS fails', async () => {
  let calls = 0;
  let fail = false;
  let clock = 0;
  const h = harness(
    async (url) => {
      calls++;
      if (fail) return { ok: false, status: 503, text: async () => '' };
      assert.match(url, /^https:\/\/up\/v1\/turbines\?/);
      return okJson([row(1, -100, 32), row(2, -90, 40)]);
    },
    { now: () => clock },
  );
  try {
    const first = await h.get('/?bbox=-101,31,-99,33');
    assert.equal(first.status, 200);
    assert.equal(first.headers['X-Uswtdb-Cache'], 'MISS');
    assert.equal(first.body.inView, 1);
    assert.equal(first.body.total, 2);
    const second = await h.get('/?bbox=-91,39,-89,41');
    assert.equal(second.headers['X-Uswtdb-Cache'], 'HIT');
    assert.equal(calls, 1);
    fail = true;
    clock = 8 * 24 * 3600 * 1000;
    const stale = await h.get('/?bbox=-101,31,-99,33');
    assert.equal(stale.status, 200);
    assert.equal(stale.headers['X-Uswtdb-Cache'], 'STALE');
    assert.equal((await h.get('/?bbox=nope')).status, 400);
  } finally {
    h.cleanup();
  }
});

test('proxy reports 502 with no cache and a dead upstream', async () => {
  const h = harness(async () => ({
    ok: false,
    status: 500,
    text: async () => '',
  }));
  try {
    const res = await h.get('/?bbox=-101,31,-99,33');
    assert.equal(res.status, 502);
  } finally {
    h.cleanup();
  }
});
