import test from 'node:test';
import assert from 'node:assert/strict';
import {
  circleRing,
  looksLikeKml,
  measureSegment,
  outlineRing,
  parseCoordinateList,
  parseLength,
  snapVertex,
  wrapKml,
} from './surveyGeometry.js';
import { footprintAreaM2 } from './buildingMath.js';
import { haversineMeters } from './siteGeometry.js';

test('lengths with units', () => {
  assert.equal(parseLength('150'), 150);
  assert.equal(parseLength('2km'), 2000);
  assert.ok(Math.abs(parseLength('500 ft') - 152.4) < 1e-9);
  assert.ok(Math.abs(parseLength('0.25 mi') - 402.336) < 1e-9);
  assert.equal(parseLength('ten'), null);
  assert.equal(parseLength('0'), null);
});

test('circle ring has the right radius and area', () => {
  const center = [-93.36, 44.84];
  const ring = circleRing(center, 100);
  assert.equal(ring.length, 73);
  assert.deepEqual(ring[0], ring.at(-1));
  for (const p of ring)
    assert.ok(Math.abs(haversineMeters(center, p) - 100) < 0.5);
  const area = footprintAreaM2(ring);
  assert.ok(Math.abs(area - Math.PI * 100 ** 2) / (Math.PI * 100 ** 2) < 0.01);
});

test('first segment snaps to absolute bearings, later ones to turn angles', () => {
  const a = [-93.36, 44.84];
  const cursor = [a[0] + 0.001, a[1] + 0.0001]; // roughly east, a bit north
  const s1 = snapVertex([a], cursor, 90);
  const m1 = measureSegment(a, s1);
  assert.ok(Math.abs(m1.bearingDeg - 90) < 1e-6);
  assert.ok(Math.abs(m1.lengthM - measureSegment(a, cursor).lengthM) < 1e-6);
  // Segment at bearing 30°, then a cursor ~85° to its right → snaps to a 90° turn.
  const b = [a[0] + 0.0005, a[1] + 0.0008];
  const ref = measureSegment(a, b).bearingDeg;
  const cur = [b[0] + 0.0009, b[1] - 0.0004];
  const s2 = snapVertex([a, b], cur, 90);
  const turn = (measureSegment(b, s2).bearingDeg - ref + 360) % 360;
  assert.ok(Math.abs(turn - 90) < 1e-6, `${turn}`);
  assert.deepEqual(snapVertex([a], cursor, 0), cursor);
  assert.deepEqual(snapVertex([], cursor, 15), cursor);
});

test('CSV with a header in any column order', () => {
  const out = parseCoordinateList(
    'id,longitude,latitude\nGCP01,-93.36662,44.8402\nGCP02,-93.3661,44.84355\nbad,x,y',
  );
  assert.equal(out.header, true);
  assert.deepEqual(out.points[0], {
    name: 'GCP01',
    lon: -93.36662,
    lat: 44.8402,
  });
  assert.equal(out.points.length, 2);
  assert.equal(out.skipped, 1);
});

test('headerless lists: lat,lon by default, lon,lat detected, names kept', () => {
  const latlon = parseCoordinateList('44.8402, -93.36662\n44.84355 -93.3661');
  assert.equal(latlon.order, 'latlon');
  assert.equal(latlon.points[1].lon, -93.3661);
  const lonlat = parseCoordinateList('-93.36662,44.8402\n-93.3661,44.84355');
  assert.equal(lonlat.order, 'lonlat');
  assert.equal(lonlat.points[0].lat, 44.8402);
  const named = parseCoordinateList('Tower\t44.85\t-93.35');
  assert.equal(named.points[0].name, 'Tower');
  const forced = parseCoordinateList('10, 20', { order: 'lonlat' });
  assert.deepEqual(forced.points[0], { name: 'P1', lon: 10, lat: 20 });
});

test('KML detection and wrapping, outline ring', () => {
  assert.ok(
    looksLikeKml(
      '<Placemark><Point><coordinates>1,2</coordinates></Point></Placemark>',
    ),
  );
  assert.ok(!looksLikeKml('44.8, -93.3'));
  assert.match(
    wrapKml('<Polygon></Polygon>'),
    /<kml[^>]*><Document><Placemark><Polygon>/,
  );
  const ring = outlineRing([
    [0, 0],
    [0.001, 0],
    [0.0005, 0.0002],
    [0.001, 0.001],
    [0, 0.001],
  ]);
  assert.equal(ring.length, 5);
  assert.equal(
    outlineRing([
      [0, 0],
      [1, 1],
    ]),
    null,
  );
});
