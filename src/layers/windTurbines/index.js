import * as Cesium from 'cesium';
import { governorRequestRender } from '../../renderGovernor.js';
import {
  registerDynamicCredit,
  USWTDB_CREDIT,
} from '../../data/dataCredits.js';
import {
  SITE_OUTLINE_COLOR,
  TIP_COLORS,
  TURBINE_DETAIL_HEIGHT_M,
  TURBINE_VIEW_LIMIT,
  bboxParam,
  dotSize,
  pickModelIds,
  siteCard,
  snapBbox,
  tipClass,
  turbineCard,
} from './records.js';
import { createWindTurbineSource } from './source.js';
import {
  ROTOR_NODE,
  turbineHeading,
  turbineModelUri,
  turbineScale,
} from './turbineModel.js';
export * from './records.js';
export { createWindTurbineSource } from './source.js';
export { turbineScale, buildTurbineGltf } from './turbineModel.js';

export const WIND_TURBINES_LAYER_ID = 'wind-turbines';
export const WIND_TURBINES_OVERLAY_SOURCE_ID = 'wind-turbines';
const TURBINE_PREFIX = 'wind-turbine:';
const SITE_PREFIX = 'wind-farm:';
const MODEL_SUFFIX = ':3d';
const DEFAULT_PARAMS = Object.freeze({
  dots: true,
  models: true,
  sites: false,
});
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});

/**
 * Utility-scale wind turbines from the U.S. Wind Turbine Database, with
 * three sublayers in the layer panel dropdown:
 *  - dots: every turbine in view (thinned to 3,000 for wide views), colored
 *    by blade-tip height and sized by capacity;
 *  - 3D models: close in (≤ 25 km, ≤ 400 in view) one shared turbine model
 *    per turbine, scaled to its hub height with the rotor scaled to its real
 *    diameter;
 *  - sites: wind farm outlines, one per USWTDB project.
 * Clicking a turbine or a site shows a card with what it is.
 */
export function createWindTurbinesLayer({
  source = createWindTurbineSource(),
  overlayHost = null,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
} = {}) {
  let viewer = null;
  let turbineDs = null;
  let modelDs = null;
  let siteDs = null;
  let enabled = false;
  let request = null;
  let siteRequest = null;
  let loadedKey = null;
  let siteKey = null;
  let last = null;
  let lastSites = null;
  let close = false;
  let lastError = null;
  let lastUpdate = null;
  let status = 'idle';
  let clickHandler = null;
  let rowControlsListener = null;
  let card = null;
  const params = { ...DEFAULT_PARAMS };
  /** id → turbine / site record, for click lookups. */
  const turbinesById = new Map();
  const sitesById = new Map();

  const notify = () => {
    try {
      rowControlsListener?.();
    } catch {
      // A panel listener must never break the layer.
    }
  };

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

  /** Ids currently drawn as 3D models, and where the camera was then. */
  let modeled = new Set();
  let modelCenter = null;

  function cameraGround() {
    const c = viewer?.camera.positionCartographic;
    return c
      ? {
          lon: Cesium.Math.toDegrees(c.longitude),
          lat: Cesium.Math.toDegrees(c.latitude),
        }
      : null;
  }

  function turbineEntity(t) {
    return {
      id: `${TURBINE_PREFIX}${t.id}`,
      position: Cesium.Cartesian3.fromDegrees(t.lon, t.lat),
      point: {
        pixelSize: dotSize(t.kw),
        color: Cesium.Color.fromCssColorString(
          TIP_COLORS[tipClass(t.tipM)],
        ).withAlpha(0.95),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
        outlineWidth: 1,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    };
  }

  function modelEntity(t) {
    const { hubM, rotorScale } = turbineScale(t);
    const position = Cesium.Cartesian3.fromDegrees(t.lon, t.lat);
    return {
      id: `${TURBINE_PREFIX}${t.id}${MODEL_SUFFIX}`,
      position,
      orientation: Cesium.Transforms.headingPitchRollQuaternion(
        position,
        new Cesium.HeadingPitchRoll(turbineHeading(t.id), 0, 0),
      ),
      model: {
        uri: turbineModelUri(),
        scale: hubM,
        minimumPixelSize: 0,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        nodeTransformations: {
          [ROTOR_NODE]: new Cesium.NodeTransformationProperty({
            scale: new Cesium.Cartesian3(rotorScale, rotorScale, rotorScale),
          }),
        },
      },
    };
  }

  /**
   * Swap the nearest turbines from dots to 3D models (and back). Models are
   * their own entities (one shared glTF; each carries only its scale and
   * rotor size), added and removed as the camera moves.
   */
  function syncModels() {
    if (!turbineDs || !modelDs) return;
    const at = params.models && close ? cameraGround() : null;
    const next = at ? pickModelIds(last?.turbines, at.lon, at.lat) : new Set();
    modelCenter = at;
    const models = modelDs.entities;
    models.suspendEvents();
    for (const id of modeled)
      if (!next.has(id))
        models.removeById(`${TURBINE_PREFIX}${id}${MODEL_SUFFIX}`);
    for (const id of next)
      if (!modeled.has(id) && turbinesById.has(id))
        models.add(modelEntity(turbinesById.get(id)));
    models.resumeEvents();
    // A 3D turbine drops its dot; a dot comes back as a fresh entity, since a
    // clamped point that was hidden can come back without its ground height.
    const points = turbineDs.entities;
    points.suspendEvents();
    for (const id of next)
      if (!modeled.has(id)) points.removeById(`${TURBINE_PREFIX}${id}`);
    for (const id of modeled)
      if (!next.has(id) && turbinesById.has(id))
        points.add(turbineEntity(turbinesById.get(id)));
    points.resumeEvents();
    modeled = next;
    governorRequestRender(WIND_TURBINES_LAYER_ID);
  }

  function drawTurbines() {
    if (!turbineDs) return;
    const entities = turbineDs.entities;
    entities.suspendEvents();
    entities.removeAll();
    turbinesById.clear();
    for (const t of last?.turbines ?? []) {
      turbinesById.set(t.id, t);
      entities.add(turbineEntity(t));
    }
    entities.resumeEvents();
    modelDs?.entities.removeAll();
    modeled = new Set();
    syncModels();
  }

  /** True when the camera has moved far enough to re-pick the 3D set. */
  function modelsStale() {
    if (!params.models || !close) return modeled.size > 0;
    const at = cameraGround();
    if (!at || !modelCenter) return true;
    const k = Math.cos((at.lat * Math.PI) / 180);
    const km =
      Math.hypot((at.lon - modelCenter.lon) * k, at.lat - modelCenter.lat) *
      111.32;
    return km > 1;
  }

  function drawSites() {
    if (!siteDs) return;
    const entities = siteDs.entities;
    entities.suspendEvents();
    entities.removeAll();
    sitesById.clear();
    const color = Cesium.Color.fromCssColorString(SITE_OUTLINE_COLOR);
    for (const s of params.sites ? (lastSites?.sites ?? []) : []) {
      if (s.ring.length < 3) continue;
      sitesById.set(s.id, s);
      const positions = Cesium.Cartesian3.fromDegreesArray(s.ring.flat());
      entities.add({
        id: `${SITE_PREFIX}${s.id}`,
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(positions),
          material: color.withAlpha(0.08),
          classificationType: Cesium.ClassificationType.BOTH,
        },
      });
      entities.add({
        id: `${SITE_PREFIX}${s.id}:outline`,
        polyline: {
          positions: [...positions, positions[0]],
          width: 2,
          material: color.withAlpha(0.9),
          clampToGround: true,
        },
      });
    }
    entities.resumeEvents();
    governorRequestRender(WIND_TURBINES_LAYER_ID);
  }

  // ---------- pop-up card ----------

  function clearCard() {
    if (!card) return;
    card = null;
    overlayHost?.setEntries(
      WIND_TURBINES_OVERLAY_SOURCE_ID,
      [],
      CARD_HOST_OPTIONS,
    );
  }

  function showCard({ title, details }, lon, lat, heightM = 0) {
    if (!overlayHost) return;
    card = { title };
    overlayHost.setVisible?.(WIND_TURBINES_OVERLAY_SOURCE_ID, true);
    overlayHost.setEntries(
      WIND_TURBINES_OVERLAY_SOURCE_ID,
      [
        {
          id: 'wind-turbine-card',
          selected: true,
          interactive: false,
          title,
          details,
          accent: SITE_OUTLINE_COLOR,
          priority: Number.MAX_SAFE_INTEGER,
          gapPx: 15,
          verticalOnly: true,
          placement: 'above',
          position: Cesium.Cartesian3.fromDegrees(lon, lat, heightM),
        },
      ],
      CARD_HOST_OPTIONS,
    );
  }

  /** Show the card for a turbine (by USWTDB id); false when not loaded. */
  function selectTurbine(id) {
    const t = turbinesById.get(String(id));
    if (!t) return false;
    const { hubM, estimated } = turbineScale(t);
    showCard(
      turbineCard(t, { estimatedHub: estimated && modeled.has(t.id) }),
      t.lon,
      t.lat,
      modeled.has(t.id) ? hubM : 0,
    );
    return true;
  }

  function selectSite(id) {
    const s = sitesById.get(String(id));
    if (!s) return false;
    showCard(
      siteCard(s),
      (s.bbox.west + s.bbox.east) / 2,
      (s.bbox.south + s.bbox.north) / 2,
    );
    return true;
  }

  function installClickHandler() {
    if (clickHandler || !viewer || !screenSpaceEventHandlerFactory || !picking)
      return;
    clickHandler = screenSpaceEventHandlerFactory(viewer);
    clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const picked = viewer.scene.pick(click.position);
      const pickId = picked ? picking.resolvePickId(picked) : null;
      if (typeof pickId === 'string' && pickId.startsWith(TURBINE_PREFIX)) {
        selectTurbine(pickId.slice(TURBINE_PREFIX.length).replace(/:3d$/, ''));
        return;
      }
      if (typeof pickId === 'string' && pickId.startsWith(SITE_PREFIX)) {
        selectSite(pickId.slice(SITE_PREFIX.length).replace(/:outline$/, ''));
        return;
      }
      clearCard();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClickHandler() {
    clickHandler?.destroy();
    clickHandler = null;
  }

  // ---------- loading ----------

  async function loadSites(bbox) {
    const key = bboxParam(bbox);
    if (!params.sites || key === siteKey) return false;
    siteRequest?.abort();
    const controller = new AbortController();
    siteRequest = controller;
    try {
      const response = await source.getSites(bbox, {
        signal: controller.signal,
      });
      if (controller.signal.aborted || !enabled || !params.sites) return false;
      lastSites = response;
      siteKey = key;
      drawSites();
      notify();
      return true;
    } finally {
      if (siteRequest === controller) siteRequest = null;
    }
  }

  const layer = {
    id: WIND_TURBINES_LAYER_ID,
    name: 'Wind Turbines (US)',
    icon: '✣',
    source: 'USGS USWTDB',
    updateInterval: 2500,

    init(v) {
      viewer = v;
      turbineDs = new Cesium.CustomDataSource(WIND_TURBINES_LAYER_ID);
      siteDs = new Cesium.CustomDataSource(`${WIND_TURBINES_LAYER_ID}-sites`);
      modelDs = new Cesium.CustomDataSource(`${WIND_TURBINES_LAYER_ID}-3d`);
      turbineDs.show = false;
      siteDs.show = false;
      modelDs.show = false;
      viewer.dataSources.add(siteDs);
      viewer.dataSources.add(turbineDs);
      viewer.dataSources.add(modelDs);
    },

    enable() {
      enabled = true;
      if (turbineDs) turbineDs.show = params.dots;
      if (siteDs) siteDs.show = true;
      if (modelDs) modelDs.show = true;
      if (viewer) registerDynamicCredit(viewer, USWTDB_CREDIT);
      picking?.registerPickOwner?.(
        WIND_TURBINES_LAYER_ID,
        (id) => id.startsWith(TURBINE_PREFIX) || id.startsWith(SITE_PREFIX),
      );
      installClickHandler();
      notify();
      governorRequestRender(WIND_TURBINES_LAYER_ID);
    },

    disable() {
      enabled = false;
      request?.abort();
      siteRequest?.abort();
      request = null;
      siteRequest = null;
      if (turbineDs) turbineDs.show = false;
      if (siteDs) siteDs.show = false;
      if (modelDs) modelDs.show = false;
      clearCard();
      removeClickHandler();
      picking?.unregisterPickOwner?.(WIND_TURBINES_LAYER_ID);
      notify();
      governorRequestRender(WIND_TURBINES_LAYER_ID);
    },

    async update() {
      if (!enabled || !viewer || !turbineDs) return false;
      const rect = viewRectangle();
      const bbox = rect && snapBbox(rect);
      if (!bbox) return false;
      const height = viewer.camera.positionCartographic?.height ?? Infinity;
      const nextClose = height <= TURBINE_DETAIL_HEIGHT_M;
      const key = bboxParam(bbox);
      let changed = false;
      const sites = loadSites(bbox).catch((error) => {
        lastError = error?.message || 'Wind farm sites unavailable';
        return false;
      });
      if (key !== loadedKey) {
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
          last = response;
          close = nextClose;
          loadedKey = key;
          lastUpdate = Date.now();
          lastError = null;
          status = 'ready';
          drawTurbines();
          notify();
          changed = true;
        } catch (error) {
          if (controller.signal.aborted) return false;
          lastError = error?.message || 'USWTDB unavailable';
          status = 'error';
          notify();
          return false;
        } finally {
          if (request === controller) request = null;
        }
      } else if (nextClose !== close || modelsStale()) {
        // Same box, camera moved: re-pick which turbines are 3D in place.
        close = nextClose;
        syncModels();
        changed = true;
      }
      return (await sites) || changed;
    },

    setParams(next = {}) {
      let turbinesDirty = false;
      for (const key of Object.keys(DEFAULT_PARAMS)) {
        if (typeof next[key] !== 'boolean' || next[key] === params[key])
          continue;
        params[key] = next[key];
        if (key === 'sites') {
          siteKey = null;
          if (!next.sites) drawSites();
        } else turbinesDirty = true;
      }
      if (turbineDs) turbineDs.show = enabled && params.dots;
      if (turbinesDirty) syncModels();
      clearCard();
      notify();
      if (enabled) queueMicrotask(() => void layer.update());
      return true;
    },

    getParams() {
      return { ...params };
    },

    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    getRowControls() {
      const toggle = (key, label, title) => ({
        id: key,
        label,
        title,
        active: params[key],
        params: { [key]: !params[key] },
      });
      const models = modeled.size > 0;
      return {
        chips: [
          toggle(
            'dots',
            'TURBINES',
            'Every turbine as a dot, colored by tip height',
          ),
          toggle(
            'models',
            '3D MODELS',
            'Turbine models scaled to hub height when zoomed in: the 400 nearest within 15 km',
          ),
          toggle('sites', 'SITES', 'Wind farm outlines, one per project'),
        ],
        legend: [
          { label: 'Tip < 100 m', color: TIP_COLORS.low },
          { label: 'Tip 100–150 m', color: TIP_COLORS.mid },
          { label: 'Tip 150–200 m', color: TIP_COLORS.tall },
          { label: 'Tip 200 m +', color: TIP_COLORS.xl },
          ...(params.sites
            ? [
                {
                  label: 'Wind farm site',
                  color: SITE_OUTLINE_COLOR,
                  count: lastSites?.inView,
                },
              ]
            : []),
        ],
        info: last
          ? `${last.inView.toLocaleString('en-US')} turbines in view${models ? ` · ${modeled.size} in 3D` : params.models ? ' · zoom in for 3D' : ''} · click one for make and model`
          : null,
      };
    },

    /** Show a turbine's card by USWTDB id (Features Code / agent seam). */
    selectTurbine,

    /** Last viewport response: { summary, turbines, inView, sampled, ... }. */
    getView() {
      return last;
    },

    /** Last site response: { sites, inView, sampled }, or null. */
    getSites() {
      return params.sites ? lastSites : null;
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
        models: modeled.size,
        status,
        lastUpdate,
        error: lastError,
        hint:
          status === 'ready' && last && !last.inView
            ? 'USWTDB covers the US only'
            : null,
      };
    },

    destroy(v = viewer) {
      request?.abort();
      siteRequest?.abort();
      request = null;
      siteRequest = null;
      removeClickHandler();
      picking?.unregisterPickOwner?.(WIND_TURBINES_LAYER_ID);
      overlayHost?.clearSource?.(WIND_TURBINES_OVERLAY_SOURCE_ID);
      if (v && turbineDs) v.dataSources.remove(turbineDs, true);
      if (v && siteDs) v.dataSources.remove(siteDs, true);
      if (v && modelDs) v.dataSources.remove(modelDs, true);
      turbineDs = null;
      modelDs = null;
      modeled = new Set();
      siteDs = null;
      viewer = null;
      enabled = false;
      last = null;
      lastSites = null;
      loadedKey = null;
      siteKey = null;
      card = null;
      rowControlsListener = null;
      turbinesById.clear();
      sitesById.clear();
    },
  };
  return layer;
}
