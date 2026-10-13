import test from 'node:test';
import assert from 'node:assert/strict';
import {
  airspaceAt,
  describeRow,
  isBackgroundClassE,
  normalizeClassAirspace,
  normalizeFacilityMap,
  normalizeSpecialUse,
  normalizeTfrs,
  parseBboxParam,
  polygonsContain,
  prop,
  quantizeBbox,
  tfrNotamId,
  tileAround,
  verticalLimit,
} from './records.js';

const square = (w, s, e, n) => ({
  type: 'Polygon',
  coordinates: [
    [
      [w, s],
      [e, s],
      [e, n],
      [w, n],
      [w, s],
    ],
  ],
});

test('prop reads aliases case-insensitively and skips empties', () => {
  assert.equal(prop({ Name: 'X' }, 'NAME'), 'X');
  assert.equal(prop({ A: '', b: 2 }, 'A', 'B'), 2);
  assert.equal(prop(null, 'A'), null);
});

test('verticalLimit covers SFC, MSL, AGL, FL and sentinels', () => {
  assert.deepEqual(verticalLimit(0, 'FT', 'SFC'), {
    known: true,
    ft: 0,
    ref: 'AGL',
    label: 'SFC',
  });
  assert.equal(verticalLimit(10000, 'FT', 'MSL').label, '10,000 MSL');
  assert.equal(verticalLimit(700, 'FT', 'AGL').ref, 'AGL');
  assert.deepEqual(verticalLimit(180, 'FL', 'STD'), {
    known: true,
    ft: 18000,
    ref: 'MSL',
    label: 'FL180',
  });
  assert.equal(verticalLimit(-9998, 'FT', 'MSL').known, false);
  assert.equal(verticalLimit(null).label, 'see chart');
});

test('class airspace normalizes, derives class from LOCAL_TYPE, skips bad features', () => {
  const rows = normalizeClassAirspace({
    features: [
      {
        properties: {
          GLOBAL_ID: 'a',
          NAME: 'MINNEAPOLIS CLASS B',
          CLASS: 'B',
          LOCAL_TYPE: 'CLASS_B',
          LOWER_VAL: 0,
          LOWER_CODE: 'SFC',
          UPPER_VAL: 10000,
          UPPER_UOM: 'FT',
          UPPER_CODE: 'MSL',
        },
        geometry: square(-94, 44, -93, 45),
      },
      {
        properties: {
          OBJECTID: 7,
          LOCAL_TYPE: 'CLASS_E5',
          LOWER_VAL: 700,
          LOWER_CODE: 'AGL',
        },
        geometry: square(-95, 44, -94, 45),
      },
      { properties: { GLOBAL_ID: 'bad', CLASS: 'D' }, geometry: null },
      {
        properties: { GLOBAL_ID: 'a', CLASS: 'B' },
        geometry: square(0, 0, 1, 1),
      },
    ],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].cls, 'B');
  assert.equal(rows[1].cls, 'E');
  assert.equal(isBackgroundClassE(rows[1]), true);
  assert.match(
    describeRow(rows[0]),
    /Class B · MINNEAPOLIS CLASS B · SFC – 10,000 MSL/,
  );
  assert.match(describeRow(rows[1]), /Class E \(E5\)/);
});

test('SUA type falls back to the name; LAANC needs a ceiling', () => {
  const [moa, restricted] = normalizeSpecialUse({
    features: [
      {
        properties: { OBJECTID: 1, NAME: 'FALLS 1 MOA' },
        geometry: square(0, 0, 1, 1),
      },
      {
        properties: { OBJECTID: 2, NAME: 'R-4808N', TYPE_CODE: 'R' },
        geometry: square(0, 0, 1, 1),
      },
    ],
  });
  assert.equal(moa.suaType, 'MOA');
  assert.equal(restricted.suaType, 'R');
  const grid = normalizeFacilityMap({
    features: [
      {
        properties: { OBJECTID: 1, CEILING: 200, APT1_FAAID: 'FCM' },
        geometry: square(0, 0, 1, 1),
      },
      { properties: { OBJECTID: 2 }, geometry: square(0, 0, 1, 1) },
    ],
  });
  assert.deepEqual(
    grid.map((r) => [r.ceilingFt, r.airport]),
    [[200, 'FCM']],
  );
});

test('TFRs fold multi-area NOTAMs and merge list descriptions', () => {
  assert.equal(tfrNotamId('6/4045-1-FDC-F'), '6/4045');
  const rows = normalizeTfrs(
    {
      features: [
        {
          properties: { NOTAM_KEY: '6/4045-1-FDC-F', LEGAL: 'security' },
          geometry: square(0, 0, 1, 1),
        },
        {
          properties: { NOTAM_KEY: '6/4045-2-FDC-F' },
          geometry: square(2, 2, 3, 3),
        },
        { properties: { NOTAM_KEY: 'none' }, geometry: square(0, 0, 1, 1) },
      ],
    },
    [{ notam_id: '6/4045', description: 'VIP movement', facility: 'ZMP' }],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].polygons.length, 2);
  assert.equal(rows[0].type, 'SECURITY');
  assert.equal(rows[0].facility, 'ZMP');
  assert.equal(rows[0].name, 'VIP movement');
  assert.match(rows[0].url, /detail_6_4045$/);
});

test('bbox quantization, parsing and point tiles', () => {
  assert.deepEqual(
    quantizeBbox({ west: -93.3, south: 44.9, east: -93.1, north: 45.05 }),
    {
      west: -93.5,
      south: 44.75,
      east: -93,
      north: 45.25,
    },
  );
  assert.equal(
    quantizeBbox({ west: 170, south: 0, east: -170, north: 1 }),
    null,
  );
  assert.equal(parseBboxParam('1,2,3'), null);
  assert.equal(parseBboxParam('-200,0,1,1'), null);
  assert.deepEqual(parseBboxParam('-93.3,44.9,-93.1,45.05'), {
    west: -93.5,
    south: 44.75,
    east: -93,
    north: 45.25,
  });
  const t = tileAround(-93.2, 44.9);
  assert.ok(t.west <= -93.2 && t.east >= -93.2 && t.east - t.west === 0.25);
});

test('point-in-polygon respects holes', () => {
  const donut = [
    [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
      [
        [4, 4],
        [6, 4],
        [6, 6],
        [4, 6],
        [4, 4],
      ],
    ],
  ];
  assert.equal(polygonsContain(donut, 2, 2), true);
  assert.equal(polygonsContain(donut, 5, 5), false);
  assert.equal(polygonsContain(donut, 11, 5), false);
});

test('airspaceAt stacks hits and gives a Part 107 advisory', () => {
  const classD = normalizeClassAirspace({
    features: [
      {
        properties: {
          OBJECTID: 1,
          CLASS: 'D',
          LOWER_VAL: 0,
          LOWER_CODE: 'SFC',
          UPPER_VAL: 3000,
          UPPER_CODE: 'MSL',
        },
        geometry: square(0, 0, 2, 2),
      },
    ],
  });
  const grid = normalizeFacilityMap({
    features: [
      {
        properties: { OBJECTID: 1, CEILING: 100 },
        geometry: square(0, 0, 1, 1),
      },
      {
        properties: { OBJECTID: 2, CEILING: 0 },
        geometry: square(0.5, 0.5, 1, 1),
      },
    ],
  });
  const inside = airspaceAt([...grid, ...classD], 0.25, 0.25);
  assert.equal(inside.level, 'auth');
  assert.equal(inside.hits[0].kind, 'class');
  assert.match(
    inside.notes.join(' '),
    /Class D at the surface.*max 100 ft AGL/,
  );
  const lowest = airspaceAt([...grid, ...classD], 0.75, 0.75);
  assert.equal(lowest.grid.ceilingFt, 0);
  const outside = airspaceAt(classD, 5, 5);
  assert.equal(outside.level, 'ok');
  assert.match(outside.notes[0], /Class G/);
  const tfr = normalizeTfrs({
    features: [
      { properties: { NOTAM_KEY: '6/1' }, geometry: square(0, 0, 9, 9) },
    ],
  });
  const stopped = airspaceAt([...tfr, ...classD], 1, 1);
  assert.equal(stopped.level, 'stop');
  assert.match(stopped.notes[0], /TFR over this point \(6\/1\)/);
  assert.match(stopped.notes.at(-1), /not a clearance/);
});
