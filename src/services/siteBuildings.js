/**
 * Building mode for the site (topography) tools: swaps the contour/canopy
 * view for highlighted buildings, roads and parks, and reports clicks so the
 * UI can open a dossier.
 *
 * Detection, in order:
 *  1. OpenStreetMap footprints (buildings, roads, parks) through the app's
 *     /api/overpass proxy. Heights come from OSM tags or, with the Google
 *     3D map source on, are measured from the mesh (roof minus ground).
 *  2. Fallback (no OSM answer or no footprints, or `source: 'mesh'`): sample
 *     the Google 3D mesh on a grid and keep blobs that are rectangular with
 *     vertical walls (buildingMath.detectBuildingsFromHeights).
 *
 * Area: only inside the site (KML) boundary; with no boundary loaded,
 * building mode refuses and asks for one.
 */
import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import {
  BUILDING_MAX_SPAN_DEG,
  buildingFeatureQuery,
  buildingVolumeM3,
  detectBuildingsFromHeights,
  footprintAreaM2,
  fromLocalMetres,
  lineLengthM,
  measureFootprint,
  openRing,
  parseBuildingFeatures,
  resolveBuildingHeight,
  ringCenter,
  toLocalMetres,
} from './buildingMath.js';
import { boundaryAreaM2, boundaryBbox, pointInRing } from './siteGeometry.js';

export const BUILDING_DEFAULTS = Object.freeze({
  meshMaxSamples: 30_000,
  meshMinCellM: 1.5,
  sampleBatch: 500,
});

const COLORS = Object.freeze({
  building: '#4FC3F7',
  buildingMesh: '#FFB74D',
  road: '#FFD54F',
  park: '#66BB6A',
  selected: '#FF4081',
});
const ALPHA = { building: 0.55, buildingMesh: 0.55, road: 0.85, park: 0.35 };
const M_PER_DEG_LAT = 111_320;

/** Push each vertex `m` metres away from the ring centre. */
function grow(ring, m) {
  const pts = openRing(ring);
  const c = ringCenter(pts);
  const local = toLocalMetres(pts, c).map(([x, y]) => {
    const d = Math.hypot(x, y) || 1;
    return [x + (x / d) * m, y + (y / d) * m];
  });
  return fromLocalMetres(local, c);
}

/** Points halfway between centre and each vertex (roof probes). */
function roofProbes(ring) {
  const pts = openRing(ring);
  const c = ringCenter(pts);
  return [
    c,
    ...pts.slice(0, 6).map(([x, y]) => [(x + c[0]) / 2, (y + c[1]) / 2]),
  ];
}

const color = (css, alpha) =>
  Cesium.ColorGeometryInstanceAttribute.fromColor(
    Cesium.Color.fromCssColorString(css).withAlpha(alpha),
  );

export function createSiteBuildings(
  viewer,
  { boundary, contours, fetchImpl = (...a) => fetch(...a), onPick } = {},
) {
  if (!viewer?.scene)
    throw new TypeError('Building mode requires a Cesium viewer');
  const scene = viewer.scene;
  const state = {
    on: false,
    loading: false,
    progress: '',
    error: null,
    osmError: null,
    source: null,
    counts: { buildings: 0, roads: 0, parks: 0 },
    area: null,
    selectedId: null,
    restore: null,
  };
  /** @type {Map<string, object>} */
  const records = new Map();
  let primitives = []; // { primitive, collection, kind }
  let markers = null; // PointPrimitiveCollection, one point per building
  let handler = null;
  let run = 0;
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => fn(describe()));
  const say = (text) => {
    state.progress = text;
    emit();
  };

  function hasPhotorealTiles() {
    for (let i = 0; i < scene.primitives.length; i++) {
      const p = scene.primitives.get(i);
      if (p instanceof Cesium.Cesium3DTileset && p.show) return true;
    }
    return false;
  }

  /** Building mode only works inside the site (KML) boundary. */
  function resolveArea() {
    if (!boundary?.site)
      throw new Error(
        'Building mode works inside a site boundary. Import a KML, paste coordinates, draw one, or add a radius circle first.',
      );
    const ring = boundary.site.boundary;
    return {
      ring,
      bbox: boundaryBbox(ring),
      label: boundary.site.name || 'site boundary',
    };
  }

  async function fetchOsm(bbox, signal) {
    const response = await fetchImpl('/api/overpass', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        data: buildingFeatureQuery(bbox),
      }).toString(),
      signal,
    });
    if (!response.ok) {
      let message = `OpenStreetMap request failed (HTTP ${response.status})`;
      try {
        message = (await response.json()).error || message;
      } catch {
        // keep the generic message
      }
      throw new Error(message);
    }
    return parseBuildingFeatures(await response.json());
  }

  /** Ellipsoid heights of the Google mesh at [lon, lat] points (NaN = none). */
  async function sampleMesh(points, label) {
    const out = new Float64Array(points.length).fill(Number.NaN);
    const B = BUILDING_DEFAULTS.sampleBatch;
    for (let s = 0; s < points.length; s += B) {
      const batch = points
        .slice(s, s + B)
        .map(([lon, lat]) => Cesium.Cartographic.fromDegrees(lon, lat));
      try {
        const sampled = await scene.sampleHeightMostDetailed(batch);
        sampled.forEach((c, j) => (out[s + j] = c?.height ?? Number.NaN));
      } catch {
        // leave NaN
      }
      if (label)
        say(
          `${label} ${Math.round((Math.min(points.length, s + B) / points.length) * 100)}%`,
        );
    }
    return out;
  }

  async function sampleTerrain(points) {
    const out = new Float64Array(points.length).fill(Number.NaN);
    try {
      const cartos = points.map(([lon, lat]) =>
        Cesium.Cartographic.fromDegrees(lon, lat),
      );
      const sampled = await Cesium.sampleTerrainMostDetailed(
        viewer.terrainProvider,
        cartos,
      );
      sampled.forEach(
        (c, j) => (out[j] = Number.isFinite(c?.height) ? c.height : Number.NaN),
      );
    } catch {
      // ellipsoid terrain or no terrain: NaN (callers fall back)
    }
    return out;
  }

  /** OSM buildings → records with measured/estimated height and volume. */
  async function osmBuildingRecords(buildings, photoreal) {
    const rows = buildings.map((b) => ({
      b,
      measure: measureFootprint(b.ring),
    }));
    let roof = null;
    let ground = null;
    const probes = [];
    if (photoreal) {
      const roofPts = [];
      const groundPts = [];
      for (const { b } of rows) {
        const r = roofProbes(b.ring);
        const g = grow(b.ring, 3);
        probes.push({
          r: [roofPts.length, r.length],
          g: [groundPts.length, g.length],
        });
        roofPts.push(...r);
        groundPts.push(...g);
      }
      roof = await sampleMesh(roofPts, 'Measuring roofs…');
      ground = await sampleMesh(groundPts, 'Measuring ground…');
    }
    const terrain = await sampleTerrain(
      rows.map(({ measure }) => measure.center),
    );
    const measured = rows.map((_, k) => {
      if (!photoreal) return { groundEll: terrain[k], meshHeightM: null };
      const slice = (arr, [i, n]) =>
        Array.from(arr.subarray(i, i + n)).filter(Number.isFinite);
      const roofs = slice(roof, probes[k].r);
      const grounds = slice(ground, probes[k].g);
      const groundEll = grounds.length ? Math.min(...grounds) : Number.NaN;
      return {
        groundEll,
        meshHeightM:
          roofs.length && grounds.length
            ? Math.max(...roofs) - groundEll
            : null,
      };
    });
    // A building whose ground could not be measured must not fall back to
    // the ellipsoid (height 0): its highlight would sit far underground.
    // Use the neighbours' median ground, then the terrain sample.
    const known = measured
      .map((m) => m.groundEll)
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    const medianGround = known.length
      ? known[Math.floor(known.length / 2)]
      : Number.NaN;
    return rows.map(({ b, measure }, k) => {
      let { groundEll, meshHeightM } = measured[k];
      let groundEstimated = false;
      if (!Number.isFinite(groundEll)) {
        groundEstimated = true;
        groundEll = Number.isFinite(medianGround) ? medianGround : terrain[k];
      }
      const height = resolveBuildingHeight(b.tags, meshHeightM);
      return {
        id: `osm-${b.osmType}-${b.osmId}`,
        kind: 'building',
        source: 'osm',
        osmType: b.osmType,
        osmId: b.osmId,
        tags: b.tags,
        ring: b.ring,
        center: measure.center,
        measure,
        height,
        meshHeightM: Number.isFinite(meshHeightM) ? meshHeightM : null,
        groundEll: Number.isFinite(groundEll) ? groundEll : 0,
        groundEstimated,
        volumeM3: buildingVolumeM3(
          measure.areaM2,
          height.heightM,
          b.tags.min_height,
        ),
      };
    });
  }

  /** Fallback: rectangles with vertical walls in the sampled Google mesh. */
  async function meshBuildingRecords(area) {
    const { bbox, ring } = area;
    const areaM2 = boundaryAreaM2(ring);
    const cellM = Math.max(
      BUILDING_DEFAULTS.meshMinCellM,
      Math.sqrt(areaM2 / BUILDING_DEFAULTS.meshMaxSamples),
    );
    const midLat = ((bbox.minLat + bbox.maxLat) / 2) * (Math.PI / 180);
    const dLat = cellM / M_PER_DEG_LAT;
    const dLon = cellM / (M_PER_DEG_LAT * Math.cos(midLat));
    const width = Math.max(1, Math.ceil((bbox.maxLon - bbox.minLon) / dLon));
    const height = Math.max(1, Math.ceil((bbox.maxLat - bbox.minLat) / dLat));
    const at = (x, y) => [
      bbox.minLon + (x + 0.5) * dLon,
      bbox.maxLat - (y + 0.5) * dLat,
    ];
    const idx = [];
    const pts = [];
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const p = at(x, y);
        if (!pointInRing(p, ring)) continue;
        idx.push(y * width + x);
        pts.push(p);
      }
    const sampled = await sampleMesh(
      pts,
      'Scanning the 3D mesh for buildings…',
    );
    const surface = new Float64Array(width * height).fill(Number.NaN);
    idx.forEach((i, j) => (surface[i] = sampled[j]));
    const found = detectBuildingsFromHeights({ surface, width, height, cellM });
    return found.map((f) => {
      const corners = f.corners.map(([x, y]) => at(x, y));
      const closed = [...corners, corners[0]];
      const measure = measureFootprint(closed);
      measure.areaM2 = f.areaM2; // raster area, not the enclosing rectangle
      const height = resolveBuildingHeight({}, f.heightM);
      return {
        id: f.id,
        kind: 'building',
        source: 'mesh',
        osmType: null,
        osmId: null,
        tags: {},
        ring: closed,
        center: measure.center,
        measure,
        height,
        meshHeightM: f.heightM,
        groundEll: f.groundM,
        volumeM3: buildingVolumeM3(f.areaM2, height.heightM),
        detection: {
          rectangularity: f.rectangularity,
          verticality: f.verticality,
          confidence: f.confidence,
        },
      };
    });
  }

  function clearPrimitives() {
    for (const { primitive, collection } of primitives)
      collection.remove(primitive);
    primitives = [];
    markers = null;
  }

  function add(collection, primitive, kind) {
    collection.add(primitive);
    primitives.push({ primitive, collection, kind });
  }

  function draw(photoreal) {
    clearPrimitives();
    const all = [...records.values()];
    const parks = all.filter((r) => r.kind === 'park');
    const roads = all.filter((r) => r.kind === 'road');
    const buildings = all.filter((r) => r.kind === 'building');
    if (parks.length)
      add(
        scene.groundPrimitives,
        new Cesium.GroundPrimitive({
          geometryInstances: parks.flatMap((p) =>
            p.rings.map(
              (ring, k) =>
                new Cesium.GeometryInstance({
                  id: k === 0 ? p.id : `${p.id}#${k}`,
                  geometry: new Cesium.PolygonGeometry({
                    polygonHierarchy: new Cesium.PolygonHierarchy(
                      Cesium.Cartesian3.fromDegreesArray(openRing(ring).flat()),
                    ),
                  }),
                  attributes: { color: color(COLORS.park, ALPHA.park) },
                }),
            ),
          ),
          appearance: new Cesium.PerInstanceColorAppearance({
            flat: true,
            translucent: true,
          }),
          classificationType: Cesium.ClassificationType.BOTH,
          asynchronous: true,
        }),
        'park',
      );
    if (roads.length)
      add(
        scene.groundPrimitives,
        new Cesium.GroundPolylinePrimitive({
          geometryInstances: roads.map(
            (r) =>
              new Cesium.GeometryInstance({
                id: r.id,
                geometry: new Cesium.GroundPolylineGeometry({
                  positions: Cesium.Cartesian3.fromDegreesArray(
                    r.coords.flat(),
                  ),
                  width: 5,
                }),
                attributes: { color: color(COLORS.road, ALPHA.road) },
              }),
          ),
          appearance: new Cesium.PolylineColorAppearance(),
          classificationType: Cesium.ClassificationType.BOTH,
          asynchronous: true,
        }),
        'road',
      );
    if (buildings.length) {
      const instances = buildings.map((b) => {
        const css = b.source === 'mesh' ? COLORS.buildingMesh : COLORS.building;
        // On the mesh, reach well below the measured ground and above the
        // roof so sloped lots, basements and taller-than-tagged roofs still
        // fall inside the tint volume.
        const below = photoreal ? (b.groundEstimated ? 40 : 10) : 0;
        const above = photoreal ? (b.groundEstimated ? 40 : 6) : 0;
        return new Cesium.GeometryInstance({
          id: b.id,
          geometry: new Cesium.PolygonGeometry({
            polygonHierarchy: new Cesium.PolygonHierarchy(
              Cesium.Cartesian3.fromDegreesArray(openRing(b.ring).flat()),
            ),
            height: b.groundEll - below,
            extrudedHeight: b.groundEll + b.height.heightM + above,
            vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
          }),
          attributes: {
            color: color(
              css,
              b.source === 'mesh' ? ALPHA.buildingMesh : ALPHA.building,
            ),
          },
        });
      });
      // On the Google mesh, classify (tint) the real buildings; otherwise
      // draw translucent blocks of the estimated volume.
      const primitive = photoreal
        ? new Cesium.ClassificationPrimitive({
            geometryInstances: instances,
            classificationType: Cesium.ClassificationType.CESIUM_3D_TILE,
            asynchronous: true,
          })
        : new Cesium.Primitive({
            geometryInstances: instances,
            appearance: new Cesium.PerInstanceColorAppearance({
              translucent: true,
              closed: true,
            }),
            asynchronous: true,
          });
      add(scene.primitives, primitive, 'building');
      // Footprint outlines draped on whatever is underneath (mesh or
      // terrain), so every building stays visible even when its height or
      // ground estimate is off.
      add(
        scene.groundPrimitives,
        new Cesium.GroundPolylinePrimitive({
          geometryInstances: buildings.map(
            (b) =>
              new Cesium.GeometryInstance({
                id: b.id,
                geometry: new Cesium.GroundPolylineGeometry({
                  positions: Cesium.Cartesian3.fromDegreesArray(b.ring.flat()),
                  width: 3,
                }),
                attributes: { color: color(...outlineStyle(b, false)) },
              }),
          ),
          appearance: new Cesium.PolylineColorAppearance(),
          classificationType: Cesium.ClassificationType.BOTH,
          asynchronous: true,
        }),
        'building',
      );
      // One marker per building above its roof, drawn over everything, to
      // find and click each detection.
      markers = new Cesium.PointPrimitiveCollection();
      for (const b of buildings) {
        const [lon, lat] = b.center;
        markers.add({
          id: b.id,
          position: Cesium.Cartesian3.fromDegrees(
            lon,
            lat,
            b.groundEll + b.height.heightM + 3,
          ),
          pixelSize: 9,
          color: Cesium.Color.fromCssColorString(outlineStyle(b, false)[0]),
          outlineColor: Cesium.Color.BLACK.withAlpha(0.7),
          outlineWidth: 1.5,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        });
      }
      add(scene.primitives, markers, 'marker');
    }
    governorRequestRender('site-buildings');
  }

  function outlineStyle(record, selected) {
    if (selected) return [COLORS.selected, 1];
    return [
      record.source === 'mesh' ? COLORS.buildingMesh : COLORS.building,
      0.95,
    ];
  }

  function recolor(id, selected) {
    const record = records.get(id);
    if (!record) return;
    const base =
      record.kind === 'building'
        ? record.source === 'mesh'
          ? [COLORS.buildingMesh, ALPHA.buildingMesh]
          : [COLORS.building, ALPHA.building]
        : [COLORS[record.kind], ALPHA[record.kind]];
    const css = selected ? COLORS.selected : base[0];
    const alpha = selected ? Math.max(0.7, base[1]) : base[1];
    const value = Cesium.ColorGeometryInstanceAttribute.toValue(
      Cesium.Color.fromCssColorString(css).withAlpha(alpha),
    );
    const outline =
      record.kind === 'building'
        ? Cesium.ColorGeometryInstanceAttribute.toValue(
            Cesium.Color.fromCssColorString(
              outlineStyle(record, selected)[0],
            ).withAlpha(outlineStyle(record, selected)[1]),
          )
        : null;
    if (record.kind === 'building' && markers)
      for (let i = 0; i < markers.length; i++) {
        const point = markers.get(i);
        if (point.id !== id) continue;
        point.color = Cesium.Color.fromCssColorString(
          outlineStyle(record, selected)[0],
        );
        point.pixelSize = selected ? 13 : 9;
      }
    for (const { primitive, kind } of primitives) {
      if (kind !== record.kind) continue;
      try {
        const attrs = primitive.getGeometryInstanceAttributes(id);
        if (attrs)
          attrs.color =
            outline && primitive instanceof Cesium.GroundPolylinePrimitive
              ? outline
              : value;
      } catch {
        // primitive not ready yet; colour stays as drawn
      }
    }
    governorRequestRender('site-buildings');
  }

  function select(id) {
    if (state.selectedId) recolor(state.selectedId, false);
    state.selectedId = id && records.has(id) ? id : null;
    if (state.selectedId) recolor(state.selectedId, true);
    emit();
    return state.selectedId ? records.get(state.selectedId) : null;
  }

  /** Select a feature and report it (opens its dossier). */
  function pick(id) {
    const record = select(id);
    if (record) onPick?.(record);
    return record;
  }

  function attachPicking() {
    if (handler) return;
    handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
    handler.setInputAction((event) => {
      if (boundary?.isDrawing) return;
      const picked = scene.pick(event.position);
      const id =
        typeof picked?.id === 'string' ? picked.id.replace(/#\d+$/, '') : null;
      if (id && records.has(id)) pick(id);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function detachPicking() {
    handler?.destroy();
    handler = null;
  }

  /**
   * Turn building mode on: hides contours/canopy (restored on hide), finds
   * features in the area and highlights them.
   * @param {{ source?: 'auto'|'osm'|'mesh' }} [options]
   */
  async function show({ source = 'auto' } = {}) {
    const id = ++run;
    const area = resolveArea();
    const span = Math.max(
      area.bbox.maxLon - area.bbox.minLon,
      area.bbox.maxLat - area.bbox.minLat,
    );
    if (span > BUILDING_MAX_SPAN_DEG)
      throw new Error(
        'Area is too large for building mode (about 2.5 km max). Draw a smaller boundary.',
      );
    if (!state.on && contours) {
      const topo = contours.describe();
      state.restore = { contours: topo.contoursOn, canopy: topo.canopyOn };
      if (topo.contoursOn) contours.hideContours();
      if (topo.canopyOn) contours.hideCanopy();
    }
    state.on = true;
    state.loading = true;
    state.error = null;
    state.osmError = null;
    state.area = area.label;
    records.clear();
    clearPrimitives();
    attachPicking();
    say('Asking OpenStreetMap for buildings, roads and parks…');
    const photoreal = hasPhotorealTiles();
    try {
      let osm = { buildings: [], roads: [], parks: [] };
      if (source !== 'mesh') {
        try {
          osm = await fetchOsm(area.bbox);
        } catch (error) {
          const message = error?.message || String(error);
          state.osmError = /not configured/i.test(message)
            ? `${message} (set OVERPASS_UPSTREAMS on the server)`
            : message;
        }
      }
      if (id !== run) return describe();
      const inside = (p) => pointInRing(p, area.ring);
      const buildings = osm.buildings.filter((b) => inside(ringCenter(b.ring)));
      const roads = osm.roads.filter((r) => r.coords.some(inside));
      const parks = osm.parks.filter(
        (p) => inside(ringCenter(p.rings[0])) || p.rings[0].some(inside),
      );
      const useMesh =
        source === 'mesh' || (source === 'auto' && buildings.length === 0);
      let built = [];
      if (buildings.length && source !== 'mesh')
        built = await osmBuildingRecords(buildings, photoreal);
      if (id !== run) return describe();
      if (useMesh) {
        if (!photoreal) {
          if (!built.length)
            throw new Error(
              `${state.osmError ? `${state.osmError}. ` : 'No OSM buildings here. '}Turn on the Google 3D map source to detect buildings from the mesh.`,
            );
        } else built = built.concat(await meshBuildingRecords(area));
      }
      if (id !== run) return describe();
      for (const b of built) records.set(b.id, b);
      for (const r of roads)
        records.set(`osm-${r.osmType}-${r.osmId}`, {
          id: `osm-${r.osmType}-${r.osmId}`,
          kind: 'road',
          osmType: r.osmType,
          osmId: r.osmId,
          tags: r.tags,
          coords: r.coords,
          center: r.coords[Math.floor(r.coords.length / 2)],
          lengthM: lineLengthM(r.coords),
        });
      for (const p of parks)
        records.set(`osm-${p.osmType}-${p.osmId}`, {
          id: `osm-${p.osmType}-${p.osmId}`,
          kind: 'park',
          osmType: p.osmType,
          osmId: p.osmId,
          tags: p.tags,
          rings: p.rings,
          center: ringCenter(p.rings[0]),
          areaM2: p.rings.reduce((s, r) => s + footprintAreaM2(r), 0),
          perimeterM: lineLengthM(p.rings[0]),
        });
      const meshCount = built.filter((b) => b.source === 'mesh').length;
      state.source =
        meshCount && meshCount < built.length
          ? 'osm+mesh'
          : meshCount
            ? 'mesh'
            : 'osm';
      state.counts = {
        buildings: built.length,
        roads: roads.length,
        parks: parks.length,
      };
      draw(photoreal);
    } catch (error) {
      // Nothing to show: fall back to topography but keep the reason.
      const message = error?.message || String(error);
      if (id === run) {
        await hide();
        state.error = message;
        emit();
      }
      throw error;
    } finally {
      if (id === run) {
        state.loading = false;
        state.progress = '';
        emit();
      }
    }
    return describe();
  }

  /** Back to topography: remove highlights and restore contours/canopy. */
  async function hide() {
    run++;
    detachPicking();
    clearPrimitives();
    records.clear();
    const restore = state.restore;
    Object.assign(state, {
      on: false,
      loading: false,
      progress: '',
      error: null,
      osmError: null,
      source: null,
      counts: { buildings: 0, roads: 0, parks: 0 },
      selectedId: null,
      restore: null,
    });
    governorRequestRender('site-buildings');
    emit();
    try {
      if (restore?.contours) await contours.showContours();
      if (restore?.canopy) await contours.showCanopy();
    } catch (error) {
      console.warn('[site-buildings] restoring topography:', error?.message);
    }
    return describe();
  }

  function flyTo(record) {
    const [lon, lat] = record.center;
    const h =
      record.kind === 'building' ? record.groundEll + record.height.heightM : 0;
    const radius =
      record.kind === 'building'
        ? Math.max(30, record.measure.lengthM)
        : record.kind === 'road'
          ? Math.min(800, Math.max(60, record.lengthM / 2))
          : Math.min(1500, Math.max(60, Math.sqrt(record.areaM2)));
    viewer.camera.flyToBoundingSphere(
      new Cesium.BoundingSphere(
        Cesium.Cartesian3.fromDegrees(lon, lat, h),
        radius,
      ),
      {
        offset: new Cesium.HeadingPitchRange(
          0,
          Cesium.Math.toRadians(-40),
          radius * 3,
        ),
      },
    );
  }

  function describe() {
    return {
      on: state.on,
      loading: state.loading,
      progress: state.progress,
      error: state.error,
      osmError: state.osmError,
      source: state.source,
      counts: { ...state.counts },
      area: state.area,
      selectedId: state.selectedId,
    };
  }

  // A new boundary changes the area: re-run while on.
  const offBoundary = boundary?.onChange?.(() => {
    if (!state.on || boundary.isDrawing) return;
    if (!boundary.site) {
      hide();
      return;
    }
    show().catch((error) => console.warn('[site-buildings]', error?.message));
  });

  return {
    describe,
    show,
    hide,
    select,
    pick,
    flyTo,
    get: (id) => records.get(id) ?? null,
    list: () => [...records.values()],
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    destroy() {
      run++;
      offBoundary?.();
      detachPicking();
      clearPrimitives();
      records.clear();
      listeners.clear();
    },
  };
}
