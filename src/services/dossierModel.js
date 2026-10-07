/**
 * Dossier content for a building, road or park picked in building mode.
 * Pure: takes a feature record (from siteBuildings) plus any address that
 * was looked up, and returns titled sections of label/value rows that the
 * pop-out panel renders. No DOM, no Cesium.
 */

import { CUFT_PER_M3, SQFT_PER_M2, osmAddress } from './buildingMath.js';
import { FEET_PER_METRE } from './siteGeometry.js';
import { planLocationResearch } from '../tools/locationResearch.js';

const int = (n) => Math.round(n).toLocaleString('en-US');

export const fmtArea = (m2) =>
  Number.isFinite(m2) ? `${int(m2)} m² · ${int(m2 * SQFT_PER_M2)} ft²` : '—';
export const fmtLength = (m) =>
  Number.isFinite(m)
    ? m >= 1000
      ? `${(m / 1000).toFixed(2)} km · ${((m * FEET_PER_METRE) / 5280).toFixed(2)} mi`
      : `${m.toFixed(1)} m · ${int(m * FEET_PER_METRE)} ft`
    : '—';
export const fmtVolume = (m3) =>
  Number.isFinite(m3) ? `${int(m3)} m³ · ${int(m3 * CUFT_PER_M3)} ft³` : '—';
export const fmtCoord = ([lon, lat]) => `${lat.toFixed(6)}, ${lon.toFixed(6)}`;

const HEIGHT_SOURCES = Object.freeze({
  'osm-height': 'OSM height tag',
  mesh: 'measured from Google 3D mesh',
  'osm-levels': 'OSM levels × 3.2 m',
  default: 'not known; 8 m assumed',
});

/** "123 Main St, Town, ST 55555" from a Nominatim reverse `address` object. */
export function formatReverseAddress(result) {
  const a = result?.address ?? {};
  const street = a.road || a.pedestrian || a.footway || a.path;
  const line1 = [a.house_number, street].filter(Boolean).join(' ');
  const town = a.city || a.town || a.village || a.hamlet || a.suburb;
  const tail = [a.state, a.postcode].filter(Boolean).join(' ');
  const text = [line1, town, tail].filter(Boolean).join(', ');
  return text || result?.displayName || null;
}

/** Town/city name from a reverse result, for research anchors. */
export function reverseLocality(result) {
  const a = result?.address ?? {};
  return a.city || a.town || a.village || a.suburb || a.county || null;
}

const titleCase = (s) =>
  String(s || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

const OSM_DETAIL_TAGS = [
  ['amenity', 'Amenity'],
  ['shop', 'Shop'],
  ['office', 'Office'],
  ['operator', 'Operator'],
  ['owner', 'Owner'],
  ['start_date', 'Built'],
  ['building:material', 'Material'],
  ['roof:shape', 'Roof'],
  ['website', 'Website'],
  ['phone', 'Phone'],
  ['opening_hours', 'Hours'],
  ['access', 'Access'],
  ['surface', 'Surface'],
  ['lanes', 'Lanes'],
  ['maxspeed', 'Speed limit'],
  ['oneway', 'One way'],
  ['bridge', 'Bridge'],
  ['tunnel', 'Tunnel'],
  ['ref', 'Route'],
];

const osmRows = (tags = {}) =>
  OSM_DETAIL_TAGS.filter(([k]) => tags[k]).map(([k, label]) => [
    label,
    String(tags[k]),
  ]);

/**
 * @param {object} record a siteBuildings feature record
 * @param {{ reverse?: object|null, addressState?: 'loading'|'error'|null }} [extra]
 * @returns {{ id:string, kind:string, title:string, subtitle:string,
 *   center:number[], sections:{title:string, rows:string[][]}[],
 *   links:{label:string, href:string}[], research:object[],
 *   address:string|null }}
 */
export function buildDossier(
  record,
  { reverse = null, addressState = null } = {},
) {
  const tags = record.tags ?? {};
  const tagged = osmAddress(tags);
  const looked = formatReverseAddress(reverse);
  const address = tagged || looked;
  const addressValue =
    address ??
    (addressState === 'loading'
      ? 'Looking up…'
      : addressState === 'error'
        ? 'Address lookup unavailable'
        : '—');
  const where = [
    ['Address', addressValue],
    ...(tagged && looked && looked !== tagged
      ? [['Nearest geocode', looked]]
      : []),
    ['Coordinates', fmtCoord(record.center)],
  ];
  const links = [];
  if (record.osmType && record.osmId)
    links.push({
      label: `OSM ${record.osmType} ${record.osmId}`,
      href: `https://www.openstreetmap.org/${record.osmType}/${record.osmId}`,
    });
  const [lon, lat] = record.center;
  links.push({
    label: 'Street-level imagery (Mapillary)',
    href: `https://www.mapillary.com/app/?lat=${lat.toFixed(6)}&lng=${lon.toFixed(6)}&z=18`,
  });

  let title;
  let subtitle;
  const sections = [{ title: 'Location', rows: where }];
  if (record.kind === 'building') {
    title = tags.name || address || 'Building';
    subtitle = `${titleCase(tags.building && tags.building !== 'yes' ? tags.building : 'building')} · ${
      record.source === 'mesh'
        ? 'detected from 3D mesh'
        : 'OpenStreetMap footprint'
    }`;
    const m = record.measure;
    const rows = [
      ['Footprint', fmtArea(m.areaM2)],
      [
        'Dimensions',
        `${m.lengthM.toFixed(1)} × ${m.widthM.toFixed(1)} m · long side ${m.bearingDeg}° from north`,
      ],
      ['Perimeter', fmtLength(m.perimeterM)],
      [
        'Height',
        `${fmtLength(record.height.heightM)} (${HEIGHT_SOURCES[record.height.source]})`,
      ],
    ];
    if (tags['building:levels'])
      rows.push(['Levels', String(tags['building:levels'])]);
    rows.push([
      'Volume',
      `${fmtVolume(record.volumeM3)}${record.height.source === 'default' ? ' (estimate)' : ''}`,
    ]);
    if (record.meshHeightM != null && record.height.source !== 'mesh')
      rows.push(['Mesh height', fmtLength(record.meshHeightM)]);
    sections.push({ title: 'Footprint & volume', rows });
    if (record.detection)
      sections.push({
        title: 'Detection',
        rows: [
          ['Method', 'Rectangle + vertical-wall test on the Google 3D mesh'],
          [
            'Rectangularity',
            `${Math.round(record.detection.rectangularity * 100)}%`,
          ],
          ['Wall share', `${Math.round(record.detection.verticality * 100)}%`],
          [
            'Confidence',
            `${Math.round(Math.max(0, record.detection.confidence) * 100)}%`,
          ],
        ],
      });
  } else if (record.kind === 'road') {
    title = tags.name || tags.ref || titleCase(tags.highway) || 'Road';
    subtitle = `${titleCase(tags.highway)} road · OpenStreetMap`;
    sections.push({
      title: 'Road',
      rows: [
        ['Class', titleCase(tags.highway)],
        ['Length in view', fmtLength(record.lengthM)],
      ],
    });
  } else {
    title = tags.name || titleCase(tags.leisure || tags.landuse) || 'Park';
    subtitle = `${titleCase(tags.leisure || tags.landuse)} · OpenStreetMap`;
    sections.push({
      title: 'Grounds',
      rows: [
        ['Type', titleCase(tags.leisure || tags.landuse)],
        ['Area', fmtArea(record.areaM2)],
        [
          'Acres',
          Number.isFinite(record.areaM2)
            ? (record.areaM2 / 4046.856).toFixed(2)
            : '—',
        ],
        ['Perimeter', fmtLength(record.perimeterM)],
      ],
    });
  }
  const details = osmRows(tags);
  if (details.length)
    sections.push({ title: 'OpenStreetMap tags', rows: details });

  return {
    id: record.id,
    kind: record.kind,
    title,
    subtitle,
    center: record.center,
    address: address ?? null,
    sections,
    links,
    research: planLocationResearch({
      kind: record.kind,
      name: tags.name ?? null,
      address,
      locality: reverseLocality(reverse),
      lat,
      lon,
    }),
  };
}
