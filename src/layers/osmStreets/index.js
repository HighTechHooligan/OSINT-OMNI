import * as Cesium from 'cesium';
import { governorRequestRender } from '../../renderGovernor.js';
import { showOsmCredit, hideOsmCredit } from '../../data/dataCredits.js';
import { OSM_MAX_VIEW_HEIGHT_M, tilesForView } from './records.js';
import { createOsmStreetsSource } from './source.js';
export * from './records.js';
export { createOsmStreetsSource } from './source.js';

export const OSM_STREETS_LAYER_ID = 'osm-streets';
const ROAD_COLORS = ['#F4F1EA', '#E9E4DA', '#DCD6CB', '#C9C3B8'];
const BUILDING_FILL = '#EDE7F6';
const MAX_CACHED_TILES = 48;

/**
 * Light street lines and building footprints from OpenStreetMap, drawn flat
 * on the ground. Loads only when zoomed in (≤ 4 km camera height) and only
 * the tiles in view, so it is a cheap way to navigate without the Google
 * photoreal tiles. Each tile becomes two batched ground primitives.
 */
export function createOsmStreetsLayer({
  source = createOsmStreetsSource(),
} = {}) {
  let viewer = null;
  let enabled = false;
  let request = null;
  let lastError = null;
  let lastUpdate = null;
  let status = 'idle';
  /** @type {Map<string, {roads: object|null, buildings: object|null, counts: {roads:number, buildings:number}}>} */
  const tiles = new Map();

  function dropTile(key) {
    const tile = tiles.get(key);
    if (!tile) return;
    if (tile.roads) viewer?.scene.groundPrimitives.remove(tile.roads);
    if (tile.buildings) viewer?.scene.groundPrimitives.remove(tile.buildings);
    tiles.delete(key);
  }

  function setShown(show) {
    for (const tile of tiles.values()) {
      if (tile.roads) tile.roads.show = show;
      if (tile.buildings) tile.buildings.show = show;
    }
    governorRequestRender('osm-streets');
  }

  function buildTile({ roads, buildings }) {
    const scene = viewer.scene;
    let roadPrimitive = null;
    let buildingPrimitive = null;
    const roadInstances = roads.map(
      (road) =>
        new Cesium.GeometryInstance({
          geometry: new Cesium.GroundPolylineGeometry({
            positions: Cesium.Cartesian3.fromDegreesArray(road.coords.flat()),
            width: road.width,
          }),
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(
              Cesium.Color.fromCssColorString(
                ROAD_COLORS[road.rank] ?? ROAD_COLORS[3],
              ).withAlpha(0.9),
            ),
          },
        }),
    );
    if (roadInstances.length) {
      roadPrimitive = new Cesium.GroundPolylinePrimitive({
        geometryInstances: roadInstances,
        appearance: new Cesium.PolylineColorAppearance(),
        classificationType: Cesium.ClassificationType.BOTH,
        asynchronous: true,
      });
      scene.groundPrimitives.add(roadPrimitive);
    }
    const buildingInstances = buildings.map(
      (b) =>
        new Cesium.GeometryInstance({
          geometry: new Cesium.PolygonGeometry({
            polygonHierarchy: new Cesium.PolygonHierarchy(
              Cesium.Cartesian3.fromDegreesArray(b.ring.flat()),
            ),
          }),
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(
              Cesium.Color.fromCssColorString(BUILDING_FILL).withAlpha(0.55),
            ),
          },
        }),
    );
    if (buildingInstances.length) {
      buildingPrimitive = new Cesium.GroundPrimitive({
        geometryInstances: buildingInstances,
        appearance: new Cesium.PerInstanceColorAppearance({
          flat: true,
          translucent: true,
        }),
        classificationType: Cesium.ClassificationType.BOTH,
        asynchronous: true,
      });
      scene.groundPrimitives.add(buildingPrimitive);
    }
    return {
      roads: roadPrimitive,
      buildings: buildingPrimitive,
      counts: { roads: roads.length, buildings: buildings.length },
    };
  }

  function viewRectangle() {
    const rect = viewer.camera.computeViewRectangle(
      viewer.scene.globe.ellipsoid,
    );
    if (!rect) return null;
    return {
      west: Cesium.Math.toDegrees(rect.west),
      south: Cesium.Math.toDegrees(rect.south),
      east: Cesium.Math.toDegrees(rect.east),
      north: Cesium.Math.toDegrees(rect.north),
    };
  }

  const layer = {
    id: OSM_STREETS_LAYER_ID,
    name: 'OSM Streets & Buildings',
    icon: '▦',
    source: 'OpenStreetMap',
    updateInterval: 3000,

    init(v) {
      viewer = v;
    },

    enable() {
      enabled = true;
      setShown(true);
      if (viewer) showOsmCredit(viewer, OSM_STREETS_LAYER_ID);
    },

    disable() {
      enabled = false;
      request?.abort();
      request = null;
      setShown(false);
      if (viewer) hideOsmCredit(viewer, OSM_STREETS_LAYER_ID);
    },

    async update() {
      if (!enabled || !viewer) return false;
      const height = viewer.camera.positionCartographic?.height ?? Infinity;
      if (height > OSM_MAX_VIEW_HEIGHT_M) {
        status = 'zoom-in';
        return false;
      }
      const rect = viewRectangle();
      if (!rect) return false;
      const wanted = tilesForView(rect).filter((k) => !tiles.has(k));
      if (!wanted.length) {
        status = 'ready';
        return false;
      }
      request?.abort();
      const controller = new AbortController();
      request = controller;
      status = 'loading';
      let added = 0;
      try {
        for (const key of wanted) {
          const data = await source.getTile(key, { signal: controller.signal });
          if (controller.signal.aborted || !enabled) return false;
          tiles.set(key, buildTile(data));
          added++;
        }
        while (tiles.size > MAX_CACHED_TILES)
          dropTile(tiles.keys().next().value);
        lastUpdate = Date.now();
        lastError = null;
        status = 'ready';
        governorRequestRender('osm-streets');
        return added > 0;
      } catch (error) {
        if (controller.signal.aborted) return false;
        lastError = error?.message || 'OSM unavailable';
        status = 'error';
        return false;
      } finally {
        if (request === controller) request = null;
      }
    },

    getStats() {
      let roads = 0;
      let buildings = 0;
      for (const tile of tiles.values()) {
        roads += tile.counts.roads;
        buildings += tile.counts.buildings;
      }
      return {
        count: roads + buildings,
        roads,
        buildings,
        tiles: tiles.size,
        status,
        lastUpdate,
        error: lastError,
        hint:
          status === 'zoom-in' ? 'Zoom in below 4 km to load streets' : null,
      };
    },

    destroy() {
      request?.abort();
      request = null;
      if (viewer) hideOsmCredit(viewer, OSM_STREETS_LAYER_ID);
      for (const key of [...tiles.keys()]) dropTile(key);
      viewer = null;
      enabled = false;
    },
  };
  return layer;
}
