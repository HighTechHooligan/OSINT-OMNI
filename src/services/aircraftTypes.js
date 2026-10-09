/**
 * ICAO type designator → the Wikipedia article for its model family, plus a
 * few hand-checked notable events for the most common airliners.
 *
 * Dates such as first flight and service entry come live from Wikidata (see
 * server/providers/aircraft/trivia.js); this table only fixes the article
 * when a search on the type name would land on the wrong page, and carries
 * the notes a reader most often wants for a type.
 */

const MAX_NOTES = Object.freeze([
  'Grounded worldwide from March 2019 after the Lion Air Flight 610 (October 2018) and Ethiopian Airlines Flight 302 (March 2019) crashes; the FAA cleared it to fly again in November 2020.',
  'January 2024: a door plug blew out of Alaska Airlines Flight 1282, a MAX 9, shortly after take-off from Portland; the MAX 9 fleet was grounded for inspections.',
]);

const FAMILIES = [
  {
    codes: ['A318', 'A319', 'A320', 'A321'],
    article: 'Airbus A320 family',
    notes: [
      'The A320 was the first airliner with digital fly-by-wire flight controls.',
      'US Airways Flight 1549, an A320, ditched in the Hudson River on 15 January 2009; all 155 people aboard survived.',
    ],
  },
  {
    codes: ['A19N', 'A20N', 'A21N'],
    article: 'Airbus A320neo family',
    notes: ['Entered service with Lufthansa in January 2016.'],
  },
  {
    codes: ['A332', 'A333'],
    article: 'Airbus A330',
    notes: [
      'Air France Flight 447, an A330-200, was lost over the Atlantic on 1 June 2009.',
    ],
  },
  { codes: ['A338', 'A339'], article: 'Airbus A330neo' },
  { codes: ['A342', 'A343', 'A345', 'A346'], article: 'Airbus A340' },
  { codes: ['A359', 'A35K'], article: 'Airbus A350' },
  {
    codes: ['A388'],
    article: 'Airbus A380',
    notes: [
      'The largest passenger airliner ever built; Singapore Airlines flew the first commercial service in October 2007.',
      'Qantas Flight 32 suffered an uncontained engine failure after leaving Singapore on 4 November 2010 and landed safely.',
    ],
  },
  { codes: ['BCS1', 'BCS3'], article: 'Airbus A220' },
  { codes: ['B712'], article: 'Boeing 717' },
  { codes: ['B731', 'B732'], article: 'Boeing 737 Original' },
  { codes: ['B733', 'B734', 'B735'], article: 'Boeing 737 Classic' },
  {
    codes: ['B736', 'B737', 'B738', 'B739'],
    article: 'Boeing 737 Next Generation',
  },
  {
    codes: ['B37M', 'B38M', 'B39M', 'B3XM'],
    article: 'Boeing 737 MAX',
    notes: MAX_NOTES,
  },
  { codes: ['B741', 'B742', 'B743', 'B74S'], article: 'Boeing 747' },
  { codes: ['B744', 'B74R'], article: 'Boeing 747-400' },
  {
    codes: ['B748'],
    article: 'Boeing 747-8',
    notes: [
      'The last 747 ever built, a 747-8F, was delivered to Atlas Air on 31 January 2023.',
    ],
  },
  { codes: ['B752', 'B753'], article: 'Boeing 757' },
  {
    codes: ['B762', 'B763', 'B764'],
    article: 'Boeing 767',
    notes: [
      'Air Canada Flight 143, the "Gimli Glider", ran out of fuel in July 1983 and glided to a landing at Gimli, Manitoba.',
    ],
  },
  {
    codes: ['B772', 'B77L', 'B773', 'B77W'],
    article: 'Boeing 777',
    notes: [
      'Malaysia Airlines Flight 370, a 777-200ER, disappeared on 8 March 2014.',
      'Malaysia Airlines Flight 17, a 777-200ER, was shot down over eastern Ukraine on 17 July 2014.',
    ],
  },
  { codes: ['B778', 'B779'], article: 'Boeing 777X' },
  {
    codes: ['B788', 'B789', 'B78X'],
    article: 'Boeing 787 Dreamliner',
    notes: [
      'All 787s were grounded in January 2013 after lithium-ion battery fires.',
    ],
  },
  {
    codes: ['E170', 'E75L', 'E75S', 'E190', 'E195'],
    article: 'Embraer E-Jet family',
  },
  { codes: ['E290', 'E295'], article: 'Embraer E-Jet E2 family' },
  { codes: ['E135', 'E145'], article: 'Embraer ERJ family' },
  { codes: ['CRJ1', 'CRJ2'], article: 'Bombardier CRJ100/200' },
  { codes: ['CRJ7', 'CRJ9', 'CRJX'], article: 'Bombardier CRJ700 series' },
  {
    codes: ['DH8A', 'DH8B', 'DH8C', 'DH8D'],
    article: 'De Havilland Canada Dash 8',
  },
  { codes: ['AT43', 'AT45', 'AT46'], article: 'ATR 42' },
  { codes: ['AT72', 'AT75', 'AT76'], article: 'ATR 72' },
  { codes: ['MD11'], article: 'McDonnell Douglas MD-11' },
  {
    codes: ['MD81', 'MD82', 'MD83', 'MD87', 'MD88'],
    article: 'McDonnell Douglas MD-80',
  },
  { codes: ['MD90'], article: 'McDonnell Douglas MD-90' },
  { codes: ['DC10'], article: 'McDonnell Douglas DC-10' },
  {
    codes: ['C172'],
    article: 'Cessna 172',
    notes: ['More 172s have been built than any other aircraft.'],
  },
  { codes: ['C182'], article: 'Cessna 182 Skylane' },
  { codes: ['C208'], article: 'Cessna 208 Caravan' },
  { codes: ['SR20'], article: 'Cirrus SR20' },
  { codes: ['SR22'], article: 'Cirrus SR22' },
  { codes: ['PC12'], article: 'Pilatus PC-12' },
  { codes: ['BE20', 'BE30', 'B350'], article: 'Beechcraft King Air' },
  { codes: ['GLF4'], article: 'Gulfstream IV' },
  { codes: ['GLF5', 'GL5T'], article: 'Gulfstream V' },
  { codes: ['GLF6'], article: 'Gulfstream G650' },
  { codes: ['GLEX', 'GL7T'], article: 'Bombardier Global Express' },
  // Military
  { codes: ['C17'], article: 'Boeing C-17 Globemaster III' },
  { codes: ['C130', 'C30J'], article: 'Lockheed C-130 Hercules' },
  { codes: ['C5', 'C5M'], article: 'Lockheed C-5 Galaxy' },
  { codes: ['K35R', 'K35E'], article: 'Boeing KC-135 Stratotanker' },
  { codes: ['KC46'], article: 'Boeing KC-46 Pegasus' },
  { codes: ['KC10'], article: 'McDonnell Douglas KC-10 Extender' },
  { codes: ['R135'], article: 'Boeing RC-135' },
  { codes: ['E3TF', 'E3CF'], article: 'Boeing E-3 Sentry' },
  { codes: ['E6'], article: 'Boeing E-6 Mercury' },
  { codes: ['P8'], article: 'Boeing P-8 Poseidon' },
  { codes: ['B52'], article: 'Boeing B-52 Stratofortress' },
  { codes: ['B1'], article: 'Rockwell B-1 Lancer' },
  { codes: ['B2'], article: 'Northrop B-2 Spirit' },
  { codes: ['U2'], article: 'Lockheed U-2' },
  { codes: ['Q4'], article: 'Northrop Grumman RQ-4 Global Hawk' },
  { codes: ['F16'], article: 'General Dynamics F-16 Fighting Falcon' },
  { codes: ['F35'], article: 'Lockheed Martin F-35 Lightning II' },
  { codes: ['F18', 'F18S'], article: 'McDonnell Douglas F/A-18 Hornet' },
  { codes: ['A10'], article: 'Fairchild Republic A-10 Thunderbolt II' },
  { codes: ['T38'], article: 'Northrop T-38 Talon' },
  { codes: ['H60'], article: 'Sikorsky UH-60 Black Hawk' },
  { codes: ['H47'], article: 'Boeing CH-47 Chinook' },
  { codes: ['V22'], article: 'Bell Boeing V-22 Osprey' },
];

const BY_CODE = new Map();
for (const family of FAMILIES)
  for (const code of family.codes)
    if (!BY_CODE.has(code)) BY_CODE.set(code, family);

/**
 * Resolve a type to the article and notes the pop-out shows.
 * @param {string|null} typeCode ICAO designator, e.g. "B38M"
 * @param {string|null} typeName free text, e.g. "Boeing 737-8 MAX"
 * @returns {{ code:string|null, article:string|null, name:string|null, notes:string[] }}
 */
export function lookupAircraftType(typeCode, typeName = null) {
  const code =
    String(typeCode ?? '')
      .trim()
      .toUpperCase() || null;
  const family = code ? BY_CODE.get(code) : null;
  const name = String(typeName ?? '').trim() || null;
  return {
    code,
    article: family?.article ?? null,
    name,
    notes: family?.notes ? [...family.notes] : [],
  };
}

export const AIRCRAFT_TYPE_CODES = Object.freeze([...BY_CODE.keys()]);
