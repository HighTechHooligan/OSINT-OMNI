import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleRings,
  buildingFeatureQuery,
  buildingVolumeM3,
  detectBuildingsFromHeights,
  fromLocalMetres,
  measureFootprint,
  minAreaRect,
  osmAddress,
  parseBuildingFeatures,
  parseOsmLength,
  resolveBuildingHeight,
} from './buildingMath.js';
import { sanitizeOverpassBody } from '../../server/providers/overpass/query.js';

const ORIGIN = [-93.3, 44.85];

/** A w×h metre rectangle rotated by `deg`, as a closed lon/lat ring. */
function rectRing(w, h, deg = 0) {
  const t = (deg * Math.PI) / 180;
  const pts = [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ].map(([x, y]) => [
    x * Math.cos(t) - y * Math.sin(t),
    x * Math.sin(t) + y * Math.cos(t),
  ]);
  const ring = fromLocalMetres(pts, ORIGIN);
  return [...ring, ring[0]];
}

test('footprint of a rotated 20×10 m rectangle', () => {
  const m = measureFootprint(rectRing(20, 10, 30));
  assert.ok(Math.abs(m.areaM2 - 200) < 1, `${m.areaM2}`);
  assert.ok(Math.abs(m.perimeterM - 60) < 0.5, `${m.perimeterM}`);
  assert.ok(Math.abs(m.lengthM - 20) < 0.1);
  assert.ok(Math.abs(m.widthM - 10) < 0.1);
  assert.ok(m.rectangularity > 0.99);
  // Long side 30° counter-clockwise from east = bearing 60°.
  assert.equal(m.bearingDeg, 60);
});

test('L-shaped footprint is less rectangular', () => {
  const ring = fromLocalMetres(
    [
      [0, 0],
      [20, 0],
      [20, 5],
      [5, 5],
      [5, 20],
      [0, 20],
      [0, 0],
    ],
    ORIGIN,
  );
  assert.ok(measureFootprint(ring).rectangularity < 0.5);
});

test('minAreaRect of a single point is degenerate, not a crash', () => {
  assert.equal(minAreaRect([[1, 1]]).area, 0);
});

test('OSM address, lengths, height priority and volume', () => {
  assert.equal(
    osmAddress({
      'addr:housenumber': '7600',
      'addr:street': 'Normandale Boulevard',
      'addr:city': 'Bloomington',
      'addr:state': 'MN',
      'addr:postcode': '55435',
    }),
    '7600 Normandale Boulevard, Bloomington, MN 55435',
  );
  assert.equal(osmAddress({ name: 'No address' }), null);
  assert.equal(parseOsmLength('12'), 12);
  assert.equal(parseOsmLength('12.5 m'), 12.5);
  assert.ok(Math.abs(parseOsmLength("40'") - 12.192) < 1e-6);
  assert.ok(Math.abs(parseOsmLength('10 ft 6"') - 3.2004) < 1e-6);
  assert.equal(parseOsmLength('tall'), null);

  assert.deepEqual(resolveBuildingHeight({ height: '30' }, 12), {
    heightM: 30,
    source: 'osm-height',
  });
  assert.deepEqual(resolveBuildingHeight({ 'building:levels': '3' }, 11), {
    heightM: 11,
    source: 'mesh',
  });
  assert.equal(
    resolveBuildingHeight({ 'building:levels': '3' }).source,
    'osm-levels',
  );
  assert.equal(resolveBuildingHeight({}).source, 'default');
  assert.equal(buildingVolumeM3(200, 10), 2000);
  assert.equal(buildingVolumeM3(200, 10, 4), 1200);
});

test('feature query passes the Overpass proxy guard', () => {
  const q = buildingFeatureQuery({
    minLon: -93.31,
    minLat: 44.84,
    maxLon: -93.29,
    maxLat: 44.86,
  });
  const result = sanitizeOverpassBody(
    new URLSearchParams({ data: q }).toString(),
  );
  assert.equal(result.ok, true, result.error);
});

test('parse buildings, roads, parks and relation rings', () => {
  const g = (pts) => pts.map(([lon, lat]) => ({ lon, lat }));
  const square = [
    [0, 0],
    [0.001, 0],
    [0.001, 0.001],
    [0, 0.001],
    [0, 0],
  ];
  const json = {
    elements: [
      {
        type: 'way',
        id: 1,
        tags: { building: 'yes', height: '9' },
        geometry: g(square),
      },
      {
        type: 'way',
        id: 2,
        tags: { highway: 'residential', name: 'Elm St' },
        geometry: g([
          [0, 0],
          [0.002, 0],
        ]),
      },
      {
        type: 'way',
        id: 3,
        tags: { leisure: 'park', name: 'Green' },
        geometry: g(square),
      },
      { type: 'way', id: 4, tags: { building: 'no' }, geometry: g(square) },
      {
        type: 'relation',
        id: 5,
        tags: { building: 'yes', type: 'multipolygon' },
        members: [
          {
            type: 'way',
            role: 'outer',
            geometry: g([
              [0, 0],
              [0.001, 0],
              [0.001, 0.001],
            ]),
          },
          {
            type: 'way',
            role: 'outer',
            geometry: g([
              [0, 0],
              [0, 0.001],
              [0.001, 0.001],
            ]),
          },
          { type: 'way', role: 'inner', geometry: g(square) },
        ],
      },
    ],
  };
  const out = parseBuildingFeatures(json);
  assert.deepEqual(
    out.buildings.map((b) => b.osmId),
    [1, 5],
  );
  assert.equal(out.buildings[1].ring.length, 5);
  assert.equal(out.roads[0].tags.name, 'Elm St');
  assert.equal(out.parks[0].tags.name, 'Green');
  assert.equal(assembleRings([]).length, 0);
});

test('mesh fallback finds box buildings and skips tree crowns', () => {
  const W = 80;
  const H = 80;
  const surface = new Float64Array(W * H);
  const ground = (c, r) => 250 + 0.03 * c + 0.02 * r; // gentle slope
  for (let r = 0; r < H; r++)
    for (let c = 0; c < W; c++) surface[r * W + c] = ground(c, r);
  // Axis-aligned 12×20 m box, 9 m tall.
  for (let r = 5; r < 25; r++)
    for (let c = 5; c < 17; c++) surface[r * W + c] = ground(c, r) + 9;
  // 16×10 m box rotated 30°, 6 m tall.
  const t = Math.PI / 6;
  for (let r = 0; r < H; r++)
    for (let c = 0; c < W; c++) {
      const x = c + 0.5 - 50;
      const y = r + 0.5 - 20;
      const u = x * Math.cos(t) + y * Math.sin(t);
      const v = -x * Math.sin(t) + y * Math.cos(t);
      if (Math.abs(u) <= 8 && Math.abs(v) <= 5)
        surface[r * W + c] = ground(c, r) + 6;
    }
  // Two conical tree crowns, 8 m tall, 7 m radius.
  for (const [cx, cy] of [
    [20, 60],
    [55, 60],
  ])
    for (let r = 0; r < H; r++)
      for (let c = 0; c < W; c++) {
        const d = Math.hypot(c + 0.5 - cx, r + 0.5 - cy);
        if (d < 7) surface[r * W + c] = ground(c, r) + 8 * (1 - d / 7);
      }
  const found = detectBuildingsFromHeights({
    surface,
    width: W,
    height: H,
    cellM: 1,
  });
  assert.equal(found.length, 2, JSON.stringify(found.map((f) => f.areaM2)));
  const [a, b] = found;
  assert.ok(Math.abs(a.areaM2 - 240) < 1);
  assert.ok(Math.abs(a.heightM - 9) < 1, `${a.heightM}`);
  assert.equal(a.bearingDeg, 0);
  assert.ok(Math.abs(a.lengthM - 20) < 1.5 && Math.abs(a.widthM - 12) < 1.5);
  assert.ok(Math.abs(b.heightM - 6) < 1);
  assert.equal(b.bearingDeg, 120);
  assert.ok(Math.abs(b.lengthM - 16) < 2, `${b.lengthM}`);
  assert.equal(a.corners.length, 4);
});
