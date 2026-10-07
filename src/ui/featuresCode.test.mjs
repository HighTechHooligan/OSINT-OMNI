import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFeatureCommands,
  intArg,
  parseCommand,
  switchArg,
} from './featuresCode.js';

function fakeSite() {
  const calls = [];
  const summary = {
    name: 'Test Site',
    areaAcres: 47,
    vertices: 4,
    points: 2,
    acrossM: 120,
    center: { lon: 0, lat: 0 },
  };
  let loaded = false;
  const contourState = {
    intervalFt: 10,
    datum: 'asl',
    contoursOn: false,
    canopyOn: false,
    stats: null,
    canopy: null,
  };
  const boundary = {
    loadPreset: async (key) => {
      calls.push(['loadPreset', key]);
      loaded = true;
      return summary;
    },
    loadKml: async (_file, name) => {
      calls.push(['loadKml', name]);
      loaded = true;
      return summary;
    },
    startDraw: async () => {
      calls.push(['startDraw']);
      loaded = true;
      return summary;
    },
    finishDraw: () => calls.push(['finishDraw']),
    cancelDraw: () => calls.push(['cancelDraw']),
    exportKml: () => {
      calls.push(['exportKml']);
      return 'test_site_boundary.kml';
    },
    describe: () => (loaded ? summary : null),
    clear: () => {
      loaded = false;
      calls.push(['clear']);
    },
  };
  const orbit = {
    zoom: async () => calls.push(['zoom']),
    orbit: (opts) => calls.push(['orbit', opts]),
    stop: () => calls.push(['stop']),
    record: async (opts) => {
      calls.push(['record', opts]);
      opts.onProgress(1, opts.frames);
      return 'test_site_orbit.gif';
    },
  };
  const contours = {
    describe: () => ({ ...contourState }),
    showContours: async ({ intervalFt, datum } = {}) => {
      if (intervalFt !== undefined)
        contourState.intervalFt = Math.min(100, Math.max(2, intervalFt));
      if (datum) contourState.datum = datum;
      calls.push(['showContours', contourState.intervalFt]);
      contourState.contoursOn = true;
      const rel = contourState.datum === 'relative';
      contourState.stats = {
        lines: 120,
        datum: contourState.datum,
        baseFt: 840,
        minFt: rel ? 0 : 840,
        maxFt: rel ? 170 : 1010,
        resM: 1,
        cached: false,
      };
      return { ...contourState };
    },
    hideContours: () => {
      calls.push(['hideContours']);
      contourState.contoursOn = false;
    },
    setDatum: async (datum) => {
      contourState.datum = datum;
      calls.push(['setDatum', datum]);
      return { ...contourState };
    },
    setContourInterval: async (ft) => {
      contourState.intervalFt = Math.min(100, Math.max(2, Math.round(ft)));
      calls.push(['setContourInterval', contourState.intervalFt]);
      return { ...contourState };
    },
    showCanopy: async ({ onProgress }) => {
      calls.push(['showCanopy']);
      onProgress(1, 1);
      contourState.canopyOn = true;
      contourState.canopy = { coveredPct: 38, cellM: 4 };
      return { ...contourState };
    },
    hideCanopy: () => {
      calls.push(['hideCanopy']);
      contourState.canopyOn = false;
    },
    async setAutoAlign(on) {
      contourState.autoAlign = on;
      calls.push(['setAutoAlign', on]);
      return { ...contourState };
    },
  };
  return { calls, site: { boundary, orbit, contours } };
}

function harness(extra = {}) {
  const { calls, site } = fakeSite();
  const lines = [];
  const print = (text, tone = '') => {
    const line = { text, tone };
    lines.push(line);
    return {
      set textContent(value) {
        line.text = value;
      },
      set className(value) {
        line.tone = value;
      },
    };
  };
  let cleared = 0;
  const api = createFeatureCommands({
    site,
    print,
    clearOutput: () => cleared++,
    pickFile: async () => ({ name: 'Hyland_Hills.kmz' }),
    viewer: { id: 'viewer' },
    ...extra,
  });
  const names = () => calls.map(([name]) => name);
  return { ...api, calls, names, lines, cleared: () => cleared };
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

test('intArg clamps and falls back; switchArg reads on/off', () => {
  assert.equal(intArg('72', 144, 12, 720), 72);
  assert.equal(intArg('5', 144, 12, 720), 12);
  assert.equal(intArg('99999', 144, 12, 720), 720);
  assert.equal(intArg(undefined, 144, 12, 720), 144);
  assert.equal(switchArg('ON'), true);
  assert.equal(switchArg('off'), false);
  assert.equal(switchArg(undefined), null);
});

test('preset, go and record drive the services in order', async () => {
  const h = harness();
  assert.equal(await h.run('preset hyland'), true);
  assert.equal(await h.run('go'), true);
  assert.equal(await h.run('record 72 640 360'), true);
  assert.deepEqual(h.names(), ['loadPreset', 'zoom', 'orbit', 'record']);
  const opts = h.calls.at(-1)[1];
  assert.equal(opts.frames, 72);
  assert.equal(opts.title, 'DJI LIDAR L2+ORTHO');
  assert.match(h.lines.at(-1).text, /Saved test_site_orbit\.gif/);
});

test('record defaults to 144 frames', async () => {
  const h = harness();
  await h.run('record');
  assert.equal(h.calls.at(-1)[1].frames, 144);
});

test('boundary draw, import, export and clear', async () => {
  const h = harness();
  await h.run('boundary draw');
  await h.run('boundary import');
  await h.run('load');
  await h.run('boundary export');
  await h.run('boundary');
  await h.run('boundary clear');
  assert.deepEqual(h.names(), [
    'startDraw',
    'loadKml',
    'loadKml',
    'exportKml',
    'clear',
  ]);
  assert.equal(h.calls[1][1], 'Hyland_Hills');
  assert.ok(h.lines.some((l) => /Test Site · 47 ac/.test(l.text)));
});

test('contour interval is a variable: contour <ft> and set contour <ft>', async () => {
  const h = harness();
  await h.run('contour 5');
  assert.deepEqual(h.calls.at(-1), ['setContourInterval', 5]);
  assert.match(h.lines.at(-1).text, /set to 5 ft/);
  await h.run('contours on');
  assert.deepEqual(h.calls.at(-1), ['showContours', 5]);
  assert.match(h.lines.at(-1).text, /every 5 ft · 120 lines · 840–1010 ft/);
  await h.run('set contour 200');
  assert.deepEqual(h.calls.at(-1), ['showContours', 100]);
  assert.match(h.lines.at(-1).text, /every 100 ft/);
  await h.run('contours off');
  assert.deepEqual(h.calls.at(-1), ['hideContours']);
  await h.run('contour align off');
  assert.deepEqual(h.calls.at(-1), ['setAutoAlign', false]);
  assert.match(h.lines.at(-1).text, /alignment off/);
  await h.run('contour align on');
  assert.deepEqual(h.calls.at(-1), ['setAutoAlign', true]);
  assert.equal(await h.run('contour abc'), true);
  assert.match(h.lines.at(-1).text, /Usage: contour/);
});

test('elevations switch between sea level and relative to the low point', async () => {
  const h = harness();
  await h.run('elev');
  assert.match(h.lines.at(-1).text, /above sea level/);
  await h.run('elev relative');
  assert.deepEqual(h.calls.at(-1), ['setDatum', 'relative']);
  await h.run('contours on');
  assert.match(
    h.lines.at(-1).text,
    /0–170 ft relative \(0 = 840 ft NAVD88, lowest in boundary\)/,
  );
  await h.run('datum asl');
  assert.match(h.lines.at(-1).text, /840–1010 ft NAVD88/);
  await h.run('contour 20 rel');
  assert.deepEqual(h.calls.at(-1), ['showContours', 20]);
  assert.match(h.lines.at(-1).text, /every 20 ft .* ft relative/);
  await h.run('set elev sea');
  assert.match(h.lines.at(-1).text, /ft NAVD88/);
  await h.run('elev sideways');
  assert.equal(h.lines.at(-1).text, 'Usage: elev asl | relative');
  await h.run('contours off');
  await h.run('contour 5 relative');
  assert.ok(h.calls.some(([n, v]) => n === 'setDatum' && v === 'relative'));
  assert.match(h.lines.at(-1).text, /5 ft, relative \(0 ft = lowest point/);
});

test('canopy on/off reports coverage', async () => {
  const h = harness();
  await h.run('canopy on');
  assert.match(h.lines.at(-1).text, /38% of the site/);
  await h.run('canopy off');
  assert.deepEqual(h.calls.at(-1), ['hideCanopy']);
});

test('layer osm toggles through the data manager', async () => {
  let enabled = false;
  const toggles = [];
  const dm = {
    layers: new Map([['osm-streets', {}]]),
    isEffectivelyEnabled: () => enabled,
    toggle: async (id) => {
      toggles.push(id);
      enabled = !enabled;
    },
  };
  const h = harness({ getDataManager: () => dm });
  await h.run('layer osm on');
  await h.run('layer osm on');
  await h.run('layer streets off');
  assert.deepEqual(toggles, ['osm-streets', 'osm-streets']);
  await h.run('layer nope on');
  assert.match(h.lines.at(-1).text, /Unknown layer/);
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
  const failing = createFeatureCommands({
    site: {
      boundary: {},
      contours: {},
      orbit: {
        zoom: async () => {
          throw new Error('No boundary yet.');
        },
      },
    },
    print: (text, tone) => {
      h.lines.push({ text, tone });
      return {};
    },
    clearOutput: () => {},
    pickFile: async () => null,
  });
  assert.equal(await failing.run('zoom'), false);
  assert.deepEqual(h.lines.at(-1), { text: 'No boundary yet.', tone: 'err' });
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
    /Test Site · 47 ac · 4 vertices · 2 points/,
  );
  await h.run('clear');
  await h.run('cls');
  assert.equal(h.cleared(), 1);
});

test('viewshed: point, route, area, circle, reach, clip, orbit, source, gpu and off', async () => {
  const calls = [];
  const state = {
    lowM: 0,
    highM: 2.5,
    targetM: 0,
    reachM: 1000,
    gpu: 'dedicated',
    shape: null,
    result: null,
  };
  const done = (opts = {}) => {
    for (const k of ['lowM', 'highM', 'targetM'])
      if (opts[k] != null) state[k] = opts[k];
    const kind = opts.shape?.kind ?? 'point';
    state.shape = { kind };
    state.result = {
      kind,
      shapeLabel: { point: 'Point', line: 'Route', area: 'Area' }[kind],
      banded: state.highM > state.lowM,
      lowM: state.lowM,
      highM: state.highM,
      lowPct: 40,
      highPct: 62.5,
      bothM2: 5000,
      highOnlyM2: 2000,
      hiddenM2: 9000,
      reachM: state.reachM,
      farthestHighM: 410,
      observers: 120,
      spacingM: 8,
      sourceLabel: 'USGS 3DEP bare earth',
      cellM: 1,
      cells: 1_000_000,
      heightsMs: 1200,
      heightsCached: false,
      computeMs: 80,
      engine: 'GPU (Test GPU)',
    };
    return { ...state };
  };
  const viewshed = {
    describe: () => ({ ...state }),
    compute: async (opts = {}) => (calls.push(['compute', opts]), done(opts)),
    pickObserver: async (opts) => (calls.push(['pick', opts]), done(opts)),
    pickShape: async (kind, opts) => (
      calls.push(['pickShape', kind, opts]),
      done({ shape: { kind: kind === 'circle' ? 'area' : kind } })
    ),
    useSiteBoundary: async () => (
      calls.push(['useSite']),
      done({ shape: { kind: 'area' } })
    ),
    setOptions: (opts) => {
      calls.push(['setOptions', opts]);
      Object.assign(state, opts);
    },
    clear: () => calls.push(['clear']),
  };
  const viewshedOrbit = {
    zoom: async () => calls.push(['zoom']),
    orbit: () => calls.push(['orbit']),
    stop: () => calls.push(['stop']),
  };
  const { site } = fakeSite();
  const h = harness({ site: { ...site, viewshed, viewshedOrbit } });
  await h.run('viewshed 44.84,-93.36 1-2.5m 6ft');
  assert.deepEqual(calls[0][1].at, [-93.36, 44.84]);
  assert.equal(calls[0][1].lowM, 1);
  assert.equal(calls[0][1].highM, 2.5);
  assert.ok(Math.abs(calls[0][1].targetM - 1.8288) < 1e-9);
  assert.match(
    h.lines.at(-1).text,
    /Viewshed \(Point\): 40% seen from 1 m, 62.5% from 2.5 m/,
  );
  assert.match(h.lines.at(-1).text, /farthest 410 m/);
  assert.match(h.lines.at(-1).text, /heights 1.2 s, sight lines 80 ms on GPU/);
  await h.run('viewshed 30ft');
  assert.equal(calls[1][0], 'pick');
  assert.ok(Math.abs(calls[1][1].highM - 9.144) < 1e-9);
  calls.length = 0;
  await h.run('viewshed route 44.84,-93.36; 44.85,-93.35; 44.86,-93.35');
  assert.equal(calls[0][0], 'compute');
  assert.deepEqual(calls[0][1].shape.path, [
    [-93.36, 44.84],
    [-93.35, 44.85],
    [-93.35, 44.86],
  ]);
  assert.match(
    h.lines.at(-1).text,
    /Viewshed \(Route\).*120 observers 8 m apart/,
  );
  await h.run('viewshed route');
  assert.deepEqual(calls[1].slice(0, 2), ['pickShape', 'line']);
  await h.run('viewshed area site');
  assert.deepEqual(calls[2], ['useSite']);
  await h.run('viewshed circle 500 ft');
  assert.equal(calls[3][1], 'circle');
  assert.ok(Math.abs(calls[3][2].radiusM - 152.4) < 1e-9);
  await h.run('viewshed reach 2 km');
  assert.deepEqual(calls[4], ['setOptions', { reachM: 2000 }]);
  assert.equal(calls[5][0], 'compute');
  await h.run('viewshed clip on');
  assert.deepEqual(calls[6], ['setOptions', { clip: true }]);
  await h.run('viewshed orbit');
  assert.deepEqual(calls.slice(-2), [['zoom'], ['orbit']]);
  await h.run('viewshed orbit stop');
  assert.deepEqual(calls.at(-1), ['stop']);
  await h.run('viewshed mesh');
  assert.ok(calls.some((c) => c[1]?.source === 'mesh'));
  await h.run('viewshed gpu integrated');
  assert.ok(calls.some((c) => c[1]?.gpu === 'integrated'));
  await h.run('viewshed gpu');
  assert.match(h.lines.at(-1).text, /Computing on: integrated/);
  await h.run('viewshed tall');
  assert.equal(h.lines.at(-1).tone, 'err');
  await h.run('viewshed off');
  assert.deepEqual(calls.at(-1), ['clear']);
});
