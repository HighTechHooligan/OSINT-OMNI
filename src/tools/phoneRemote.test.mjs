import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  PAIR_CODE_TTL_MS,
  PAIR_MAX_ATTEMPTS,
  createRemoteHub,
  createResultCache,
  refusePhoneCommand,
  stableKey,
} from '../../server/remote/hub.js';
import {
  createPhoneCatalog,
  createRemoteHandler,
  listensOnLan,
} from '../../server/remote/plugin.js';

let seq = 0;
const fakeRandom = (n) => {
  const buffer = Buffer.alloc(n);
  for (let i = 0; i < n; i += 1) buffer[i] = (seq * 31 + i * 7) % 256;
  seq += 1;
  return buffer;
};

test('pairing codes are single use, expire, and burn after repeated wrong guesses', () => {
  let t = 1000;
  const hub = createRemoteHub({ now: () => t, randomBytes: fakeRandom });
  assert.equal(hub.pair('000000', 'x').ok, false, 'no code active yet');

  const { code } = hub.startPairing();
  assert.match(code, /^\d{6}$/);
  const paired = hub.pair(
    `${code.slice(0, 3)} ${code.slice(3)}`,
    ' Sam\u0007 ',
  );
  assert.equal(paired.ok, true);
  assert.equal(paired.device.name, 'Sam');
  assert.equal(hub.pair(code, 'again').ok, false, 'single use');
  assert.equal(hub.authenticate(paired.token).name, 'Sam');
  assert.equal(hub.authenticate('nope'), null);

  const second = hub.startPairing().code;
  const wrong = second === '111111' ? '222222' : '111111';
  for (let i = 1; i < PAIR_MAX_ATTEMPTS; i += 1)
    assert.match(hub.pair(wrong).error, /does not match/);
  assert.match(hub.pair(wrong).error, /Too many/);
  assert.equal(hub.pair(second).ok, false, 'burned code stops working');

  const third = hub.startPairing().code;
  t += PAIR_CODE_TTL_MS + 1;
  assert.equal(hub.pair(third).ok, false, 'expired');

  assert.equal(hub.revoke(paired.device.id), 1);
  assert.equal(hub.authenticate(paired.token), null);
});

test('phones cannot queue keyboard-only commands', () => {
  assert.match(refusePhoneCommand('js 1+1'), /keyboard/);
  assert.match(refusePhoneCommand('PHONE pair'), /keyboard/);
  assert.match(refusePhoneCommand('  '), /Type a command/);
  assert.equal(refusePhoneCommand('preset hyland'), null);
  const hub = createRemoteHub();
  assert.equal(hub.enqueue({ name: 'p' }, 'js alert(1)').ok, false);
});

test('a queued command reaches a waiting desktop and its result reaches the phone', async () => {
  const hub = createRemoteHub();
  const waiting = hub.nextCommand({ waitMs: 1000 });
  const { command } = hub.enqueue({ name: 'Sam' }, 'zoom');
  const taken = await waiting;
  assert.deepEqual(taken, { id: command.id, line: 'zoom', from: 'Sam' });
  assert.equal(hub.getCommand(command.id).status, 'running');
  assert.equal(
    hub.complete(command.id, {
      ok: true,
      lines: [{ text: 'Zoomed to boundary', tone: 'ok' }],
      image: 'javascript:alert(1)',
    }),
    true,
  );
  const done = hub.getCommand(command.id);
  assert.equal(done.status, 'done');
  assert.deepEqual(done.lines, [{ text: 'Zoomed to boundary', tone: 'ok' }]);
  assert.equal(done.image, null, 'only image data URLs pass');
  assert.ok(hub.deskOnline());
  assert.equal(await hub.nextCommand({ waitMs: 5 }), null);
});

test('the result cache reuses fresh answers, shares in-flight runs and never caches failures', async () => {
  let t = 0;
  const cache = createResultCache({ ttlMs: 1000, now: () => t });
  let runs = 0;
  const produce = async () => ({ n: ++runs });
  const [a, b] = await Promise.all([
    cache.get('k', produce),
    cache.get('k', produce),
  ]);
  assert.equal(runs, 1);
  assert.equal(a.cached, false);
  assert.equal(b.cached, true);
  t = 500;
  assert.equal((await cache.get('k', produce)).ageMs, 500);
  t = 1500;
  assert.equal((await cache.get('k', produce)).value.n, 2);
  await assert.rejects(
    cache.get('bad', async () => {
      throw new Error('down');
    }),
  );
  assert.equal((await cache.get('bad', async () => 'up')).value, 'up');
  assert.equal(
    stableKey({ b: 1, a: [2, { d: 1, c: 2 }] }),
    stableKey({ a: [2, { c: 2, d: 1 }], b: 1 }),
  );
});

test('the phone catalog leaves out app-only tools and keeps drone-job tools', () => {
  const names = createPhoneCatalog({
    apiBase: 'http://localhost:4173',
    cache: createResultCache(),
    fetchImpl: async () => new Response('{}'),
  })
    .list()
    .map((t) => t.name);
  for (const hidden of [
    'panel_request',
    'show_in_gods_eye_view',
    'get_hud_caption',
  ])
    assert.ok(!names.includes(hidden), hidden);
  for (const wanted of [
    'get_wind',
    'get_weather',
    'aircraft_in_area',
    'get_terrain_height',
  ])
    assert.ok(names.includes(wanted), wanted);
});

test('only a wildcard bind counts as reachable from a phone', () => {
  assert.equal(listensOnLan({ address: '127.0.0.1' }), false);
  assert.equal(listensOnLan({ address: '::1' }), false);
  assert.equal(listensOnLan({ address: '0.0.0.0' }), true);
  assert.equal(listensOnLan(null), false);
});

/** fetch() cannot set Host, so a LAN Host header needs node:http. */
const statusWithHost = (port, route, host) =>
  new Promise((resolve, reject) => {
    httpRequest(
      { port, host: '127.0.0.1', path: route, headers: { Host: host } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    )
      .on('error', reject)
      .end();
  });

async function serve(options) {
  const handle = createRemoteHandler(options);
  const server = createServer(async (req, res) => {
    if ((await handle(req, res)) === false) {
      res.writeHead(418);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const request = (route, { method = 'GET', body, token } = {}) =>
    fetch(`${base}${route}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  return { server, request, port };
}

test('the HTTP surface pairs a phone, runs tools and relays commands to the desktop', async (t) => {
  const calls = [];
  const fakeCatalog = {
    list: () => [
      {
        name: 'get_wind',
        title: 'Wind',
        description: 'd',
        inputSchema: { type: 'object' },
        kind: 'query',
      },
    ],
    call: async (name, args) => {
      calls.push([name, args]);
      return { summary: 'Calm', data: { speed: 1 } };
    },
  };
  const dir = await mkdtemp(path.join(tmpdir(), 'phone-'));
  const feedbackFile = path.join(dir, 'feedback.jsonl');
  const { server, request, port } = await serve({
    catalogFor: () => fakeCatalog,
    feedbackFile,
    deskWaitMs: 2000,
    boundAddress: () => ({ address: '0.0.0.0' }),
    addresses: () => ['192.168.1.20'],
    env: {},
  });
  t.after(() => server.close());

  const page = await request('/phone/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /OMNI Phone/);
  assert.match(await (await request('/phone/tokens.css')).text(), /--accent:/);
  assert.equal((await request('/phone/package.json')).status, 404);
  assert.equal(
    (await request('/elsewhere')).status,
    418,
    'other routes pass through',
  );

  assert.equal((await request('/remote/api/status')).status, 401);
  // Desktop routes need a loopback Host; a LAN name is refused.
  assert.equal(
    await statusWithHost(port, '/remote/desk/state', '192.168.1.20:4173'),
    403,
  );

  const pairing = await (
    await request('/remote/desk/pair', { method: 'POST', body: {} })
  ).json();
  assert.match(pairing.pairing.code, /^\d{6}$/);
  assert.deepEqual(pairing.urls, [
    `http://192.168.1.20:${server.address().port}/phone/`,
  ]);
  const paired = await (
    await request('/remote/pair', {
      method: 'POST',
      body: { code: pairing.pairing.code, name: 'Sam' },
    })
  ).json();
  assert.equal(paired.ok, true);
  const token = paired.token;

  const status = await (await request('/remote/api/status', { token })).json();
  assert.equal(status.device.name, 'Sam');
  assert.equal(status.desktopOnline, false);

  const tool = await (
    await request('/remote/api/tools/get_wind', {
      method: 'POST',
      token,
      body: { location: { place: 'Denver' } },
    })
  ).json();
  assert.equal(tool.summary, 'Calm');
  assert.deepEqual(calls, [['get_wind', { location: { place: 'Denver' } }]]);

  const refused = await request('/remote/api/commands', {
    method: 'POST',
    token,
    body: { line: 'js 1' },
  });
  assert.equal(refused.status, 400);

  const desk = request('/remote/desk/next');
  const queued = await (
    await request('/remote/api/commands', {
      method: 'POST',
      token,
      body: { line: 'zoom' },
    })
  ).json();
  const { command } = await (await desk).json();
  assert.equal(command.line, 'zoom');
  await request('/remote/desk/result', {
    method: 'POST',
    body: { id: command.id, ok: true, lines: [{ text: 'Zoomed', tone: 'ok' }] },
  });
  const result = await (
    await request(`/remote/api/commands/${queued.command.id}`, { token })
  ).json();
  assert.equal(result.command.status, 'done');
  assert.equal(result.command.lines[0].text, 'Zoomed');

  assert.equal(
    (
      await request('/remote/api/feedback', {
        method: 'POST',
        token,
        body: { rating: 'unclear', about: 'Wind', note: 'tiny' },
      })
    ).status,
    200,
  );
  const saved = JSON.parse(await readFile(feedbackFile, 'utf8'));
  assert.equal(saved.device, 'Sam');
  assert.equal(saved.rating, 'unclear');

  const revoked = await (
    await request('/remote/desk/revoke', {
      method: 'POST',
      body: { id: 'all' },
    })
  ).json();
  assert.deepEqual(revoked.devices, []);
  assert.equal((await request('/remote/api/status', { token })).status, 401);
});

test('the phone API is off while launcher sharing is on', async (t) => {
  const { server, request } = await serve({
    env: { PINOKIO_SHARE_CLOUDFLARE: '1' },
    catalogFor: () => ({ list: () => [], call: async () => ({}) }),
  });
  t.after(() => server.close());
  assert.equal(
    (await request('/remote/pair', { method: 'POST', body: { code: '1' } }))
      .status,
    403,
  );
  assert.equal(
    (await request('/remote/desk/pair', { method: 'POST', body: {} })).status,
    403,
  );
});
