import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boundaryAreaM2,
  boundaryBbox,
  normalizeBoundary,
  pointInRing,
  siteToKml,
  slug,
} from './siteGeometry.js';
import { SITE_PRESETS } from './siteBoundary.js';

test('Hyland preset measures about 47 acres', () => {
  const acres = boundaryAreaM2(SITE_PRESETS.hyland.boundary) / 4046.856;
  assert.ok(acres > 44 && acres < 50, `${acres} ac`);
});

test('bbox and point-in-ring', () => {
  const ring = normalizeBoundary([
    [0, 0],
    [2, 0],
    [2, 2],
    [0, 2],
  ]);
  assert.deepEqual(boundaryBbox(ring), {
    minLon: 0,
    minLat: 0,
    maxLon: 2,
    maxLat: 2,
  });
  assert.equal(pointInRing([1, 1], ring), true);
  assert.equal(pointInRing([3, 1], ring), false);
});

test('siteToKml writes a closed polygon and escaped names', () => {
  const kml = siteToKml({
    name: 'Lot <7> & Co',
    boundary: [
      [0, 0],
      [1, 0],
      [1, 1],
    ],
    points: [['GCP01', 0.5, 0.5]],
  });
  assert.match(kml, /<Polygon>/);
  assert.match(kml, /0,0,0 1,0,0 1,1,0 0,0,0/);
  assert.match(kml, /Lot &lt;7&gt; &amp; Co/);
  assert.match(kml, /<name>GCP01<\/name><Point><coordinates>0.5,0.5,0/);
});

test('slug makes file-safe stems', () => {
  assert.equal(slug(SITE_PRESETS.hyland.name), 'hyland_hills_lidar');
  assert.equal(slug(''), 'site');
});
