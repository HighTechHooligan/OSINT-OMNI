import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { normalizeAlprNode } from './records.js';

/** Map extract attributes without treating an OSM edit date as a field verification. */
export function normalizeAlprTileFeature(feature) {
  const p = feature?.properties || {};
  if (feature?.geometry?.type !== 'Point' || p.osmType !== 'node') return null;
  const [lon, lat] = feature.geometry.coordinates;
  const record = normalizeAlprNode({
    type: 'node',
    id: Number(p.osmId),
    lat,
    lon,
    tags: {
      'surveillance:type': 'ALPR',
      operator: p.operator,
      manufacturer: p.brand,
      'camera:type': p.cameraType,
      'camera:direction': p.direction,
      'surveillance:zone': p.surveillanceZone,
      ref: p.ref,
      check_date: p.check_date,
    },
  });
  return record ? { ...record, osmTimestamp: p.osmTimestamp || null } : null;
}

/** Decode detail-level camera points; geometry-only heatmap tiles are not records. */
export function decodeAlprTile(bytes, z, x, y) {
  const layer = new VectorTile(new PbfReader(bytes)).layers.cameras;
  if (!layer) return [];
  if (layer.length > 40_000)
    throw new Error('Camera tile feature limit exceeded');
  const records = [];
  for (let i = 0; i < layer.length; i++) {
    const record = normalizeAlprTileFeature(
      layer.feature(i).toGeoJSON(x, y, z),
    );
    if (record) records.push(record);
  }
  return records;
}

/**
 * Decode any extract tile to bare camera positions for the zoomed-out overview.
 * Low-zoom tiles are geometry-only; a `point_count`/`count` attribute (from
 * clustering) is summed so the overview total stays honest.
 * @returns {{positions: Float64Array, count: number}} lon/lat pairs and the
 *   number of mapped cameras they stand for.
 */
export function decodeAlprOverviewTile(bytes, z, x, y) {
  const layer = new VectorTile(new PbfReader(bytes)).layers.cameras;
  if (!layer) return { positions: new Float64Array(0), count: 0 };
  if (layer.length > 200_000)
    throw new Error('Camera tile feature limit exceeded');
  const out = [];
  let count = 0;
  const n = 2 ** z;
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    if (feature.type !== 1) continue;
    const weight = Number(
      feature.properties.point_count ?? feature.properties.count,
    );
    const extent = feature.extent;
    let points = 0;
    for (const ring of feature.loadGeometry())
      for (const p of ring) {
        const lon = ((x + p.x / extent) / n) * 360 - 180;
        const merc = Math.PI * (1 - (2 * (y + p.y / extent)) / n);
        const lat = (Math.atan(Math.sinh(merc)) * 180) / Math.PI;
        if (Number.isFinite(lon) && Number.isFinite(lat)) {
          out.push(lon, lat);
          points++;
        }
      }
    count += Number.isFinite(weight) && weight > 0 ? weight : points;
  }
  return { positions: Float64Array.from(out), count };
}
