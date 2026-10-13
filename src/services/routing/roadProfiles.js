/**
 * Travel profiles: which OpenStreetMap roads each mode may use, how fast, and
 * whether one-way streets apply.
 */
const CAR_KMH = {
  motorway: 105,
  motorway_link: 60,
  trunk: 90,
  trunk_link: 55,
  primary: 70,
  primary_link: 50,
  secondary: 60,
  secondary_link: 45,
  tertiary: 50,
  tertiary_link: 40,
  unclassified: 40,
  residential: 35,
  living_street: 15,
  service: 20,
  road: 30,
};
const MAJOR = [
  'motorway',
  'motorway_link',
  'trunk',
  'trunk_link',
  'primary',
  'primary_link',
  'secondary',
  'secondary_link',
  'tertiary',
  'tertiary_link',
  'unclassified',
];
const BIKE_EXTRA = [
  'cycleway',
  'path',
  'track',
  'footway',
  'pedestrian',
  'bridleway',
];
const FOOT_EXTRA = [...BIKE_EXTRA, 'steps', 'corridor'];

export const PROFILES = Object.freeze({
  car: {
    id: 'car',
    highways: Object.keys(CAR_KMH),
    major: MAJOR,
    maxKmh: 110,
    speedKmh(tags) {
      const posted = parseMaxspeed(tags.maxspeed);
      const base = CAR_KMH[tags.highway] ?? 30;
      const service =
        tags.highway === 'service' &&
        /^(parking_aisle|driveway|drive-through)$/.test(tags.service || '')
          ? 10
          : null;
      return service ?? (posted ? Math.min(posted * 0.9, 130) : base);
    },
    allowed(tags) {
      if (!(tags.highway in CAR_KMH)) return false;
      if (tags.area === 'yes') return false;
      const access =
        tags.motor_vehicle || tags.motorcar || tags.vehicle || tags.access;
      return (
        !/^(no|private|agricultural|forestry|delivery|customers|destination_no)$/.test(
          access || '',
        ) || tags.motorcar === 'yes'
      );
    },
    oneway: (tags) =>
      onewayOf(
        tags,
        tags.highway === 'motorway' ||
          tags.junction === 'roundabout' ||
          tags.junction === 'circular',
      ),
  },
  bicycle: {
    id: 'bicycle',
    highways: [
      ...Object.keys(CAR_KMH).filter((h) => !/^motorway/.test(h)),
      ...BIKE_EXTRA,
    ],
    major: [...MAJOR.filter((h) => !/^motorway/.test(h)), 'cycleway'],
    maxKmh: 25,
    speedKmh: (tags) =>
      /^(primary|trunk)/.test(tags.highway)
        ? 16
        : tags.highway === 'track'
          ? 12
          : 18,
    allowed(tags) {
      if (/^motorway/.test(tags.highway)) return false;
      if (
        tags.bicycle === 'no' ||
        tags.access === 'no' ||
        tags.access === 'private'
      )
        return tags.bicycle === 'yes' || tags.bicycle === 'designated';
      if (tags.highway === 'footway' || tags.highway === 'pedestrian')
        return tags.bicycle === 'yes' || tags.bicycle === 'designated';
      return true;
    },
    oneway: (tags) =>
      tags['oneway:bicycle'] === 'no'
        ? 0
        : onewayOf(tags, tags.junction === 'roundabout'),
  },
  pedestrian: {
    id: 'pedestrian',
    highways: [
      ...Object.keys(CAR_KMH).filter((h) => !/^(motorway|trunk)/.test(h)),
      ...FOOT_EXTRA,
    ],
    major: [
      ...MAJOR.filter((h) => !/^(motorway|trunk)/.test(h)),
      'footway',
      'path',
      'pedestrian',
      'cycleway',
    ],
    maxKmh: 6,
    speedKmh: (tags) => (tags.highway === 'steps' ? 2 : 5),
    allowed: (tags) =>
      !/^(motorway|trunk)/.test(tags.highway) &&
      tags.foot !== 'no' &&
      !(
        /^(no|private)$/.test(tags.access || '') &&
        !/^(yes|designated)$/.test(tags.foot || '')
      ),
    oneway: () => 0,
  },
});

/** Valhalla-style costing names map onto profiles. */
export function profileFor(mode) {
  if (mode === 'auto' || mode === 'car') return PROFILES.car;
  if (mode === 'bicycle' || mode === 'bike') return PROFILES.bicycle;
  return PROFILES.pedestrian;
}

/** 1 forward only, -1 reverse only, 0 both ways. */
function onewayOf(tags, implied) {
  const v = tags.oneway;
  if (v === '-1' || v === 'reverse') return -1;
  if (v === 'yes' || v === 'true' || v === '1') return 1;
  if (v === 'no' || v === 'false' || v === '0') return 0;
  return implied ? 1 : 0;
}

/** "45 mph" -> 72.4, "50" -> 50, anything else -> null. */
export function parseMaxspeed(raw) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh)?\s*$/i.exec(
    String(raw ?? ''),
  );
  if (!m) return null;
  const v = Number(m[1]);
  return /mph/i.test(m[2] || '') ? v * 1.609344 : v;
}
