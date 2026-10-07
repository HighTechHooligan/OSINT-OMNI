import test from 'node:test';
import assert from 'node:assert/strict';
import { createAirspaceLayer } from './index.js';

const square = (w, s, e, n) => [
  [
    [
      [w, s],
      [e, s],
      [e, n],
      [w, n],
      [w, s],
    ],
  ],
];

function fakeViewer() {
  const sources = [];
  return {
    sources,
    dataSources: {
      add: (ds) => sources.push(ds),
      remove: (ds) => sources.splice(sources.indexOf(ds), 1),
    },
    scene: { canvas: {}, globe: { ellipsoid: {} } },
    camera: { computeViewRectangle: () => null },
  };
}

test('layer loads TFRs, renders entities, toggles kinds and checks a point', async () => {
  const calls = [];
  const source = {
    getTfrs: async () => {
      calls.push('tfr');
      return {
        rows: [
          {
            id: 'tfr:6/1',
            kind: 'tfr',
            notamId: '6/1',
            polygons: square(0, 0, 1, 1),
          },
        ],
      };
    },
    getArea: async (kind, bbox) => {
      calls.push(`${kind}:${bbox.west},${bbox.south}`);
      return {
        rows:
          kind === 'laanc'
            ? [
                {
                  id: 'laanc:1',
                  kind,
                  ceilingFt: 200,
                  polygons: square(0, 0, 0.2, 0.2),
                },
              ]
            : [],
      };
    },
  };
  const layer = createAirspaceLayer({ source });
  const viewer = fakeViewer();
  layer.init(viewer);
  assert.equal(viewer.sources.length, 4);
  layer.enable();
  assert.equal(await layer.update(), true);
  const tfrDs = viewer.sources.find((ds) => ds.name === 'airspace-tfr');
  assert.equal(tfrDs.entities.values.length, 1);
  assert.equal(tfrDs.show, true);
  // No view rectangle → viewport kinds wait for zoom.
  assert.match(layer.getStats().hint, /CLASS \/ SUA/);
  layer.setParams({ tfr: false, volumes: true });
  assert.equal(tfrDs.show, false);
  assert.equal(
    layer.getRowControls().chips.find((c) => c.id === 'tfr').active,
    false,
  );
  const result = await layer.checkAt(0.1, 0.1);
  assert.equal(result.grid.ceilingFt, 200);
  assert.equal(
    result.hits.some((r) => r.kind === 'tfr'),
    true,
  );
  assert.ok(calls.includes('laanc:0,0'));
  layer.destroy();
  assert.equal(viewer.sources.length, 0);
});

test('3D mode extrudes stacked shelves and rims their MSL floors and ceilings', async () => {
  const msl = (ft) => ({ known: true, ft, ref: 'MSL', label: `${ft} MSL` });
  const sfc = { known: true, ft: 0, ref: 'AGL', label: 'SFC' };
  const shelves = [
    {
      id: 'class:core',
      lower: sfc,
      upper: msl(10000),
      polygons: square(0, 0, 1, 1),
    },
    {
      id: 'class:shelf',
      lower: msl(3000),
      upper: msl(10000),
      polygons: square(-1, -1, 2, 2),
    },
  ].map((row) => ({ kind: 'class', cls: 'B', ...row }));
  const source = {
    getTfrs: async () => ({ rows: [] }),
    getArea: async (kind) => ({ rows: kind === 'class' ? shelves : [] }),
  };
  const layer = createAirspaceLayer({ source });
  const viewer = fakeViewer();
  viewer.camera.computeViewRectangle = () => ({
    west: -0.02,
    south: -0.02,
    east: 0.04,
    north: 0.04,
  });
  layer.init(viewer);
  layer.enable();
  layer.setParams({ tfr: false, sua: false, volumes: true });
  await layer.update();
  const ds = viewer.sources.find((d) => d.name === 'airspace-class');
  const ids = ds.entities.values.map((e) => e.id).sort();
  // Core: volume + ceiling rim (SFC floor gets none). Shelf: volume + both rims.
  assert.deepEqual(ids, [
    'airspace:class:core:0',
    'airspace:class:core:0:rim-ceiling',
    'airspace:class:shelf:0',
    'airspace:class:shelf:0:rim-ceiling',
    'airspace:class:shelf:0:rim-floor',
  ]);
  const shelf = ds.entities.getById('airspace:class:shelf:0');
  assert.ok(Math.abs(shelf.polygon.height.getValue() - 914.4) < 0.01);
  layer.setParams({ volumes: false });
  assert.equal(ds.entities.values.length, 2);
  layer.destroy();
});
