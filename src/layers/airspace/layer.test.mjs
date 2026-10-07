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
