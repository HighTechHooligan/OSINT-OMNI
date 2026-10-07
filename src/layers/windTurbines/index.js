import * as Cesium from 'cesium';
import { governorRequestRender } from '../../renderGovernor.js';
import {
  registerDynamicCredit,
  USWTDB_CREDIT,
} from '../../data/dataCredits.js';
import {
  TIP_COLORS,
  TURBINE_DETAIL_HEIGHT_M,
  TURBINE_TOWER_MAX,
  TURBINE_VIEW_LIMIT,
  bboxParam,
  dotSize,
  snapBbox,
  tipClass,
} from './records.js';
import { createWindTurbineSource } from './source.js';
export * from './records.js';
export { createWindTurbineSource } from './source.js';

export const WIND_TURBINES_LAYER_ID = 'wind-turbines';
const TOWER_RADIUS_M = 2.5;

/**
 * Utility-scale wind turbines from the U.S. Wind Turbine Database. Every
 * view loads the turbines inside it (thinned to 3,000 for wide views) as
 * ground-clamped dots colored by blade-tip height and sized by capacity.
 * Close in, with few turbines in view, each also gets a tower drawn to its
 * real hub height so obstruction heights read correctly against terrain.
 */
export function createWindTurbinesLayer({
  source = createWindTurbineSource(),
} = {}) {
  let viewer = null;
  let dataSource = null;
  let enabled = false;
  let request = null;
  let loadedKey = null;
  let last = null;
  let lastError = null;
  let lastUpdate = null;
  let status = 'idle';

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

  function draw(turbines, towers) {
    const entities = dataSource.entities;
    entities.suspendEvents();
    entities.removeAll();
    for (const t of turbines) {
      const color = Cesium.Color.fromCssColorString(
        TIP_COLORS[tipClass(t.tipM)],
      );
      entities.add({
        id: `wind-turbine:${t.id}`,
        position: Cesium.Cartesian3.fromDegrees(t.lon, t.lat),
        point: {
          pixelSize: dotSize(t.kw),
          color: color.withAlpha(0.95),
          outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
          outlineWidth: 1,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        properties: { turbine: t },
      });
      if (towers && t.hubM) {
        entities.add({
          id: `wind-turbine-tower:${t.id}`,
          position: Cesium.Cartesian3.fromDegrees(t.lon, t.lat, t.hubM / 2),
          cylinder: {
            length: t.hubM,
            topRadius: TOWER_RADIUS_M * 0.6,
            bottomRadius: TOWER_RADIUS_M,
            material: Cesium.Color.WHITE.withAlpha(0.85),
            heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
          },
        });
      }
    }
    entities.resumeEvents();
    governorRequestRender(WIND_TURBINES_LAYER_ID);
  }

  const layer = {
    id: WIND_TURBINES_LAYER_ID,
    name: 'Wind Turbines (US)',
    icon: '✣',
    source: 'USGS USWTDB',
    updateInterval: 2500,

    init(v) {
      viewer = v;
      dataSource = new Cesium.CustomDataSource(WIND_TURBINES_LAYER_ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      if (viewer) registerDynamicCredit(viewer, USWTDB_CREDIT);
      governorRequestRender(WIND_TURBINES_LAYER_ID);
    },

    disable() {
      enabled = false;
      request?.abort();
      request = null;
      if (dataSource) dataSource.show = false;
      governorRequestRender(WIND_TURBINES_LAYER_ID);
    },

    async update() {
      if (!enabled || !viewer || !dataSource) return false;
      const rect = viewRectangle();
      const bbox = rect && snapBbox(rect);
      if (!bbox) return false;
      const height = viewer.camera.positionCartographic?.height ?? Infinity;
      const close = height <= TURBINE_DETAIL_HEIGHT_M;
      const key = `${bboxParam(bbox)}|${close}`;
      if (key === loadedKey) return false;
      request?.abort();
      const controller = new AbortController();
      request = controller;
      status = 'loading';
      try {
        const response = await source.getView(bbox, {
          limit: TURBINE_VIEW_LIMIT,
          signal: controller.signal,
        });
        if (controller.signal.aborted || !enabled) return false;
        draw(
          response.turbines,
          close && response.turbines.length <= TURBINE_TOWER_MAX,
        );
        last = response;
        loadedKey = key;
        lastUpdate = Date.now();
        lastError = null;
        status = 'ready';
        return true;
      } catch (error) {
        if (controller.signal.aborted) return false;
        lastError = error?.message || 'USWTDB unavailable';
        status = 'error';
        return false;
      } finally {
        if (request === controller) request = null;
      }
    },

    /** Last viewport response: { summary, turbines, inView, sampled, ... }. */
    getView() {
      return last;
    },

    /** Plain turbine records currently drawn, for the analyst/agent tools. */
    getAnalystRecords(maxCount = 2000) {
      if (!enabled || !last) return [];
      return last.turbines.slice(0, Math.max(1, Math.floor(maxCount)));
    },

    getStats() {
      return {
        count: last?.turbines.length ?? 0,
        inView: last?.inView ?? 0,
        mw: last?.summary?.mw ?? 0,
        status,
        lastUpdate,
        error: lastError,
        hint:
          status === 'ready' && last && !last.inView
            ? 'USWTDB covers the US only'
            : null,
      };
    },

    destroy() {
      request?.abort();
      request = null;
      if (viewer && dataSource) viewer.dataSources.remove(dataSource, true);
      dataSource = null;
      viewer = null;
      enabled = false;
      last = null;
      loadedKey = null;
    },
  };
  return layer;
}
