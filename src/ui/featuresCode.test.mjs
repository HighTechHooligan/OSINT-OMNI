import test from 'node:test';
import assert from 'node:assert/strict';
import { createFeatureCommands, intArg, parseCommand } from './featuresCode.js';

function fakeOrbit() {
  const calls = [];
  const site = {
    name: 'Test Site',
    vertices: 4,
    points: 2,
    acrossM: 120,
    center: { lon: 0, lat: 0 },
  };
  let loaded = false;
  return {
    calls,
    loadPreset: async (key) => {
      calls.push(['loadPreset', key]);
      loaded = true;
      return site;
    },
    loadKml: async (file, name) => {
      calls.push(['loadKml', name]);
      loaded = true;
      return site;
    },
    zoom: async () => calls.push(['zoom']),
    orbit: (opts) => calls.push(['orbit', opts]),
    stop: () => calls.push(['stop']),
    record: async (opts) => {
      calls.push(['record', opts]);
      opts.onProgress(1, opts.frames);
      return 'test_site_orbit.gif';
    },
    describe: () => (loaded ? site : null),
    clear: () => {
      loaded = false;
      calls.push(['clear']);
    },
  };
}

function harness(extra = {}) {
  const orbit = fakeOrbit();
  const lines = [];
  const print = (text, tone = '') => {
    const line = { text, tone };
    lines.push(line);
    return {
      set textContent(value) {
        line.text = value;
      },
    };
  };
  let cleared = 0;
  const api = createFeatureCommands({
    orbit,
    print,
    clearOutput: () => cleared++,
    pickFile: async () => ({ name: 'Hyland_Hills.kmz' }),
    viewer: { id: 'viewer' },
    ...extra,
  });
  return { ...api, orbit, lines, cleared: () => cleared };
}

test('parseCommand splits name, args and raw tail', () => {
  assert.equal(parseCommand('   '), null);
  assert.deepEqual(parseCommand('  Record 72  640 360 '), {
    name: 'record',
    args: ['72', '640', '360'],
    raw: '72  640 360',
  });
  assert.deepEqual(parseCommand('go'), { name: 'go', args: [], raw: '' });
});

test('intArg clamps and falls back', () => {
  assert.equal(intArg('72', 144, 12, 720), 72);
  assert.equal(intArg('5', 144, 12, 720), 12);
  assert.equal(intArg('99999', 144, 12, 720), 720);
  assert.equal(intArg(undefined, 144, 12, 720), 144);
  assert.equal(intArg('abc', 144, 12, 720), 144);
});

test('preset, go and record drive the orbit service in order', async () => {
  const h = harness();
  assert.equal(await h.run('preset hyland'), true);
  assert.equal(await h.run('go'), true);
  assert.equal(await h.run('record 72 640 360'), true);
  const names = h.orbit.calls.map(([name]) => name);
  assert.deepEqual(names, ['loadPreset', 'zoom', 'orbit', 'record']);
  const recordOpts = h.orbit.calls.at(-1)[1];
  assert.equal(recordOpts.frames, 72);
  assert.equal(recordOpts.width, 640);
  assert.equal(recordOpts.height, 360);
  assert.equal(recordOpts.title, 'DJI LIDAR L2+ORTHO');
  assert.match(h.lines.at(-1).text, /Saved test_site_orbit\.gif/);
});

test('record defaults to 144 frames', async () => {
  const h = harness();
  await h.run('record');
  assert.equal(h.orbit.calls.at(-1)[1].frames, 144);
});

test('load passes the file name without extension', async () => {
  const h = harness();
  await h.run('load');
  assert.deepEqual(h.orbit.calls[0], ['loadKml', 'Hyland_Hills']);
});

test('unknown commands and inherited names are rejected', async () => {
  const h = harness();
  assert.equal(await h.run('launch'), false);
  assert.equal(await h.run('constructor'), false);
  assert.equal(await h.run('toString'), false);
  assert.match(h.lines.at(-1).text, /Unknown command/);
});

test('service errors are printed, not thrown', async () => {
  const h = harness();
  h.orbit.zoom = async () => {
    throw new Error('No site loaded.');
  };
  assert.equal(await h.run('zoom'), false);
  assert.deepEqual(h.lines.at(-1), { text: 'No site loaded.', tone: 'err' });
});

test('js is unavailable unless eval is allowed', async () => {
  const off = harness();
  assert.equal(await off.run('js 1 + 1'), false);
  const on = harness({ allowEval: true });
  assert.equal(await on.run('js 6 * 7'), true);
  assert.equal(on.lines.at(-1).text, '42');
  assert.equal(await on.run('js viewer.id'), true);
  assert.equal(on.lines.at(-1).text, 'viewer');
});

test('site, clear and cls report state', async () => {
  const h = harness();
  await h.run('site');
  assert.equal(h.lines.at(-1).text, 'Nothing loaded');
  await h.run('preset');
  await h.run('site');
  assert.match(
    h.lines.at(-1).text,
    /Test Site · 4 vertices · 2 points · ~120 m across/,
  );
  await h.run('clear');
  await h.run('cls');
  assert.equal(h.cleared(), 1);
});
