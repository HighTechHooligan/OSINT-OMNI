import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aircraftFromPick,
  airframeRows,
  flightRows,
  modelFactRows,
  parseTrackedId,
  resolveModel,
  sourceLinks,
  triviaQuery,
} from './aircraftInfo.js';
import { AIRCRAFT_TYPE_CODES, lookupAircraftType } from './aircraftTypes.js';

const has = (layerId, id) =>
  (layerId === 'flights' && id === 'a1b2c3') ||
  (layerId === 'military' && id === 'ae1234');

test('a pick resolves to the aircraft through every id shape', () => {
  assert.equal(aircraftFromPick(null, has), null);
  assert.deepEqual(aircraftFromPick({ primitive: { id: 'a1b2c3' } }, has), {
    layerId: 'flights',
    id: 'a1b2c3',
  });
  assert.deepEqual(aircraftFromPick({ id: 'ae1234' }, has), {
    layerId: 'military',
    id: 'ae1234',
  });
  assert.deepEqual(
    aircraftFromPick({ id: { gevTrackedId: 'military:ae1234' } }, has),
    { layerId: 'military', id: 'ae1234' },
  );
  assert.equal(
    aircraftFromPick({ primitive: { id: 'building-7' } }, has),
    null,
  );
  assert.equal(parseTrackedId('vessels:123'), null);
  assert.equal(parseTrackedId('flights:'), null);
});

test('flight rows convert units and skip unknowns', () => {
  const rows = Object.fromEntries(
    flightRows(
      {
        icao24: 'a1b2c3',
        callsign: 'UAL123',
        airline: 'United Airlines',
        altitudeM: 10668,
        velocityMps: 231.5,
        track: 359.6,
        latitude: 30.1234567,
        longitude: -97.7654321,
        route: {
          origin: { code: 'AUS', name: 'Austin' },
          destination: { code: 'ORD', name: 'Chicago' },
        },
      },
      'flights',
    ),
  );
  assert.equal(rows.Altitude, '35,000 ft (10,668 m)');
  assert.equal(rows['Ground speed'], '450 kt');
  assert.equal(rows.Heading, '000°');
  assert.equal(rows.Route, 'AUS Austin → ORD Chicago');
  assert.equal(rows['ICAO hex'], 'A1B2C3');
  assert.equal(rows.Position, '30.1235, -97.7654');
  assert.equal(rows.Registration, undefined);
  assert.match(rows.Source, /Civil/);
  assert.equal(
    Object.fromEntries(
      flightRows({ onGround: true, altitudeM: 200 }, 'military'),
    ).Altitude,
    'On the ground',
  );
});

test('airframe rows prefer the adsbdb record and do not repeat the tail', () => {
  const rows = airframeRows(
    { registration: 'N123UA', typeCode: 'B738' },
    {
      typeName: 'Boeing 737-824',
      typeCode: 'B738',
      registration: 'N123UA',
      owner: 'United Airlines',
      ownerCountry: 'United States',
    },
  );
  assert.deepEqual(rows, [
    ['Type', 'Boeing 737-824'],
    ['ICAO type code', 'B738'],
    ['Registered owner', 'United Airlines'],
    ['Owner country', 'United States'],
  ]);
});

test('types resolve to their family article and notes', () => {
  const max = lookupAircraftType('b38m', 'Boeing 737-8');
  assert.equal(max.article, 'Boeing 737 MAX');
  assert.ok(max.notes.some((n) => /Lion Air/.test(n)));
  const unknown = lookupAircraftType('ZZZZ', 'Odd Plane 1');
  assert.equal(unknown.article, null);
  assert.equal(unknown.name, 'Odd Plane 1');
  assert.ok(AIRCRAFT_TYPE_CODES.includes('A388'));
  assert.equal(lookupAircraftType('DC10').article, 'McDonnell Douglas DC-10');
  // The airframe lookup's type wins over the live feed's.
  assert.equal(
    resolveModel({ typeCode: 'B738' }, { typeCode: 'B39M' }).article,
    'Boeing 737 MAX',
  );
});

test('trivia query and facts', () => {
  assert.equal(
    triviaQuery({ article: 'Airbus A380', name: 'x' }, 'A6-EDA'),
    'article=Airbus+A380&reg=A6-EDA',
  );
  assert.equal(triviaQuery({ name: 'Odd Plane' }, ''), 'name=Odd+Plane');
  assert.equal(triviaQuery({}, null), null);
  assert.deepEqual(
    modelFactRows({ firstFlight: '2005-04-27', numberBuilt: 254 }),
    [
      ['First flight', '2005-04-27'],
      ['Number built', '254'],
    ],
  );
});

test('source links only for identities that fit their site', () => {
  const links = sourceLinks({
    icao24: 'A1B2C3',
    callsign: 'UAL123',
    registration: 'N123UA',
  });
  assert.deepEqual(
    links.map((l) => l.label),
    [
      'ADS-B Exchange track',
      'FlightAware: UAL123',
      'Planespotters airframe history: N123UA',
      'FAA registry: N123UA',
    ],
  );
  assert.equal(
    sourceLinks({ icao24: 'zz', registration: 'G-EZTA' }).some((l) =>
      /FAA/.test(l.label),
    ),
    false,
  );
});
