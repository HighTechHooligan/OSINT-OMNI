import test from 'node:test';
import assert from 'node:assert/strict';
import { haversineM, pointSegmentM, distanceToLineM, bboxOf } from '../src/lib/geo.js';
import { lonLatToTile, countTiles, tilesAlongLine, tilesInBbox } from '../src/lib/tiles.js';
import { decodePolyline, encodePolyline } from '../src/lib/polyline.js';

test('haversine matches a known distance', () => {
  // One degree of latitude is ~111.2 km.
  assert.ok(Math.abs(haversineM([0, 0], [0, 1]) - 111195) < 50);
});

test('point to segment distance clamps to the segment ends', () => {
  const a = [-97.7, 30.3];
  const b = [-97.69, 30.3];
  assert.ok(pointSegmentM([-97.695, 30.3], a, b) < 0.01);
  const off = pointSegmentM([-97.695, 30.3005], a, b);
  assert.ok(Math.abs(off - 55.6) < 1, String(off));
  assert.ok(Math.abs(pointSegmentM([-97.71, 30.3], a, b) - haversineM([-97.71, 30.3], a)) < 2);
});

test('distance to line reports the nearest segment', () => {
  const line = [[0, 0], [0.01, 0], [0.01, 0.01]];
  const r = distanceToLineM([0.0105, 0.005], line);
  assert.equal(r.index, 1);
  assert.ok(r.distance < 60);
});

test('bbox padding grows the box', () => {
  const [w, s, e, n] = bboxOf([[-97.7, 30.3]], 1000);
  assert.ok(e - w > 0.018 && n - s > 0.017);
});

test('tile math matches the Austin fixture tile', () => {
  assert.deepEqual(lonLatToTile(-97.74, 30.27, 11), { x: 467, y: 843 });
});

test('tile counts and iteration agree', () => {
  const box = [-97.8, 30.2, -97.6, 30.4];
  assert.equal([...tilesInBbox(box, 10, 13)].length, countTiles(box, 10, 13));
});

test('tiles along a line include padded neighbours across an edge', () => {
  const line = [[-97.74, 30.27], [-97.5, 30.27]];
  const plain = tilesAlongLine(line, 11);
  assert.ok(plain.length >= 2);
  const padded = tilesAlongLine(line, 11, 0.2);
  assert.ok(padded.length > plain.length);
});

test('polyline6 round trip', () => {
  const pts = [[-97.743061, 30.267153], [-97.74, 30.27], [-97.7, 30.31]];
  const back = decodePolyline(encodePolyline(pts));
  pts.forEach((p, i) => {
    assert.ok(Math.abs(p[0] - back[i][0]) < 1e-6);
    assert.ok(Math.abs(p[1] - back[i][1]) < 1e-6);
  });
});
