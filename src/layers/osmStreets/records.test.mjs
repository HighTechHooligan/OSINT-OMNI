import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OSM_MAX_TILES_PER_VIEW,
  overpassTileQuery,
  parseOsmTile,
  roadStyle,
  tileBbox,
  tileKey,
  tilesForView,
} from './records.js';
import { sanitizeOverpassBody } from '../../../server/providers/overpass/query.js';

test('tile keys round-trip to 0.01° boxes', () => {
  const key = tileKey(-93.3651, 44.8434);
  assert.equal(key, '-9337:4484');
  const b = tileBbox(key);
  assert.ok(b.west <= -93.3651 && b.east > -93.3651);
  assert.ok(b.south <= 44.8434 && b.north > 44.8434);
});

test('view tiles are capped and nearest-first', () => {
  const view = { west: -93.405, south: 44.802, east: -93.302, north: 44.903 };
  const keys = tilesForView(view);
  assert.equal(keys.length, OSM_MAX_TILES_PER_VIEW);
  assert.equal(
    keys[0],
    tileKey((view.west + view.east) / 2, (view.south + view.north) / 2),
  );
  assert.deepEqual(tilesForView({ west: 1, south: 1, east: 0, north: 2 }), []);
});

test('tile query passes the Overpass proxy sanitizer', () => {
  const body = new URLSearchParams({
    data: overpassTileQuery('-9337:4484'),
  }).toString();
  assert.equal(sanitizeOverpassBody(body).ok, true);
});

test('parseOsmTile splits styled roads from building rings', () => {
  const json = {
    elements: [
      {
        type: 'way',
        id: 1,
        tags: { highway: 'residential' },
        geometry: [
          { lon: 0, lat: 0 },
          { lon: 1, lat: 0 },
        ],
      },
      {
        type: 'way',
        id: 2,
        tags: { building: 'yes', 'building:levels': '2' },
        geometry: [
          { lon: 0, lat: 0 },
          { lon: 1, lat: 0 },
          { lon: 1, lat: 1 },
          { lon: 0, lat: 0 },
        ],
      },
      {
        type: 'way',
        id: 3,
        tags: { highway: 'proposed' },
        geometry: [
          { lon: 0, lat: 0 },
          { lon: 1, lat: 1 },
        ],
      },
      { type: 'node', id: 4 },
    ],
  };
  const { roads, buildings } = parseOsmTile(json);
  assert.equal(roads.length, 1);
  assert.equal(roads[0].width, 2.5);
  assert.equal(buildings.length, 1);
  assert.equal(buildings[0].levels, 2);
  assert.equal(roadStyle('primary_link').width, 4);
  assert.equal(roadStyle('construction'), null);
});
