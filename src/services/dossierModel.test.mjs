import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDossier, formatReverseAddress } from './dossierModel.js';

const building = {
  id: 'osm-way-1',
  kind: 'building',
  source: 'osm',
  osmType: 'way',
  osmId: 1,
  tags: {
    building: 'office',
    name: 'Tower',
    'addr:housenumber': '1',
    'addr:street': 'Main St',
  },
  center: [-93.3, 44.85],
  measure: {
    areaM2: 200,
    perimeterM: 60,
    lengthM: 20,
    widthM: 10,
    bearingDeg: 60,
  },
  height: { heightM: 12, source: 'mesh' },
  meshHeightM: 12,
  volumeM3: 2400,
};

test('building dossier: address from tags, volume, OSM link, research plan', () => {
  const d = buildDossier(building, {
    reverse: { address: { house_number: '3', road: 'Main St', city: 'Edina' } },
  });
  assert.equal(d.title, 'Tower');
  assert.match(d.subtitle, /^Office · OpenStreetMap/);
  assert.equal(d.address, '1 Main St');
  const rows = Object.fromEntries(d.sections.flatMap((s) => s.rows));
  assert.equal(rows['Nearest geocode'], '3 Main St, Edina');
  assert.equal(rows.Coordinates, '44.850000, -93.300000');
  assert.match(rows.Volume, /^2,400 m³ · 84,755 ft³$/);
  assert.match(rows.Height, /measured from Google 3D mesh/);
  assert.equal(d.links[0].href, 'https://www.openstreetmap.org/way/1');
  assert.ok(d.research.length > 0);
});

test('mesh-detected building shows detection metrics; loading address', () => {
  const d = buildDossier(
    {
      ...building,
      id: 'mesh-1',
      source: 'mesh',
      osmType: null,
      osmId: null,
      tags: {},
      height: { heightM: 8, source: 'default' },
      detection: { rectangularity: 0.93, verticality: 0.8, confidence: 0.7 },
    },
    { addressState: 'loading' },
  );
  const rows = Object.fromEntries(d.sections.flatMap((s) => s.rows));
  assert.equal(rows.Address, 'Looking up…');
  assert.equal(rows.Rectangularity, '93%');
  assert.match(rows.Volume, /\(estimate\)$/);
  assert.equal(d.links.length, 1);
});

test('road and park dossiers', () => {
  const road = buildDossier({
    id: 'r',
    kind: 'road',
    tags: { highway: 'primary', name: 'France Ave', lanes: '4' },
    center: [0, 0],
    lengthM: 1500,
  });
  assert.equal(road.title, 'France Ave');
  assert.ok(
    road.sections.some((s) =>
      s.rows.some(([k, v]) => k === 'Lanes' && v === '4'),
    ),
  );
  const park = buildDossier({
    id: 'p',
    kind: 'park',
    tags: { leisure: 'park' },
    center: [0, 0],
    areaM2: 4046.856,
    perimeterM: 254,
  });
  assert.equal(park.title, 'Park');
  assert.ok(
    park.sections[1].rows.some(([k, v]) => k === 'Acres' && v === '1.00'),
  );
});

test('reverse address formatting falls back to display name', () => {
  assert.equal(formatReverseAddress({ displayName: 'Somewhere' }), 'Somewhere');
  assert.equal(formatReverseAddress(null), null);
});
