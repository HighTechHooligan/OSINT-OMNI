/**
 * Viewshed inside the site boundary: put an observer (click, or lat/lon) at
 * an eye height and shade what they can see (green) and can't (red).
 *
 * Height model, in order (`source: 'auto'`):
 *  1. Google 3D mesh (with the photoreal map source on): a surface model, so
 *     buildings and trees block the view.
 *  2. USGS 3DEP bare earth (/api/elevation/3dep): terrain only.
 *  3. The globe's terrain provider, when it has real heights.
 * The math is viewshedMath.computeViewshed; only cells inside the boundary
 * are judged, but everything in its bounding box can block a sight line.
 */
import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import {
  fetchElevationGrid,
  gridDatumShift,
  gridPixelMetres,
  gridToLonLat,
} from './siteContours.js';
import { boundaryBbox, haversineMeters, pointInRing } from './siteGeometry.js';
import {
  VIEWSHED,
  VIEWSHED_DEFAULTS,
  computeViewshed,
  rowRuns,
} from './viewshedMath.js';

export const SITE_VIEWSHED_DEFAULTS = Object.freeze({
  ...VIEWSHED_DEFAULTS,
  source: 'auto',
  demMaxCells: 40_000,
  meshMaxCells: 25_000,
  sampleBatch: 500,
});

const COLORS = { visible: '#3DDC84', hidden: '#FF5252', observer: '#FFFFFF' };
const ALPHA = { visible: 0.42, hidden: 0.3 };
const M_PER_DEG_LAT = 111_320;
const SOURCE_LABEL = {
  mesh: 'Google 3D mesh (buildings + trees block)',
  dem: 'USGS 3DEP bare earth',
  terrain: 'globe terrain',
};

export function createSiteViewshed(
  viewer,
  { boundary, fetchImpl = (...a) => fetch(...a) } = {},
) {
  if (!viewer?.scene) throw new TypeError('Viewshed requires a Cesium viewer');
  const scene = viewer.scene;
  const state = {
    on: false,
    loading: false,
    picking: false,
    progress: '',
    error: null,
    eyeM: SITE_VIEWSHED_DEFAULTS.eyeM,
    targetM: SITE_VIEWSHED_DEFAULTS.targetM,
    source: SITE_VIEWSHED_DEFAULTS.source,
    observer: null, // [lon, lat]
    result: null,
  };
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => fn(describe()));
  const say = (text) => {
    state.progress = text;
    emit();
  };
  let overlay = null;
  let marker = null;
  let handler = null;
  let cancelPick = null;
  let gridCache = { key: null, grid: null };
  let run = 0;

  function hasPhotorealTiles() {
    for (let i = 0; i < scene.primitives.length; i++) {
      const p = scene.primitives.get(i);
      if (p instanceof Cesium.Cesium3DTileset && p.show) return true;
    }
    return false;
  }

  function requireArea() {
    if (!boundary?.site)
      throw new Error(
        'The viewshed works inside a site boundary. Import a KML, paste coordinates, draw one, or add a radius circle first.',
      );
    const ring = boundary.site.boundary;
    return { ring, bbox: boundaryBbox(ring) };
  }

  /** A regular lon/lat grid over the bbox with about `maxCells` cells. */
  function lonLatGrid(bbox, maxCells) {
    const midLat = ((bbox.minLat + bbox.maxLat) / 2) * (Math.PI / 180);
    const wM = (bbox.maxLon - bbox.minLon) * M_PER_DEG_LAT * Math.cos(midLat);
    const hM = (bbox.maxLat - bbox.minLat) * M_PER_DEG_LAT;
    const cellM = Math.max(1, Math.sqrt((wM * hM) / maxCells));
    const width = Math.max(2, Math.ceil(wM / cellM));
    const height = Math.max(2, Math.ceil(hM / cellM));
    return {
      width,
      height,
      bbox,
      values: new Float64Array(width * height).fill(Number.NaN),
    };
  }

  async function sampleMesh(grid) {
    const B = SITE_VIEWSHED_DEFAULTS.sampleBatch;
    const n = grid.width * grid.height;
    for (let s = 0; s < n; s += B) {
      const batch = [];
      for (let i = s; i < Math.min(n, s + B); i++) {
        const [lon, lat] = gridToLonLat(
          grid,
          i % grid.width,
          Math.floor(i / grid.width),
        );
        batch.push(Cesium.Cartographic.fromDegrees(lon, lat));
      }
      try {
        const out = await scene.sampleHeightMostDetailed(batch);
        out.forEach((c, j) => (grid.values[s + j] = c?.height ?? Number.NaN));
      } catch {
        // leave NaN
      }
      say(
        `Sampling the 3D mesh… ${Math.round((Math.min(n, s + B) / n) * 100)}%`,
      );
    }
    return grid;
  }

  async function sampleTerrain(grid) {
    if (viewer.terrainProvider instanceof Cesium.EllipsoidTerrainProvider)
      throw new Error('the globe has flat terrain');
    const cartos = [];
    for (let r = 0; r < grid.height; r++)
      for (let c = 0; c < grid.width; c++) {
        const [lon, lat] = gridToLonLat(grid, c, r);
        cartos.push(Cesium.Cartographic.fromDegrees(lon, lat));
      }
    const out = await Cesium.sampleTerrainMostDetailed(
      viewer.terrainProvider,
      cartos,
    );
    out.forEach((c, i) => (grid.values[i] = c?.height ?? Number.NaN));
    return grid;
  }

  async function loadDem(bbox) {
    const midLat = ((bbox.minLat + bbox.maxLat) / 2) * (Math.PI / 180);
    const areaM2 =
      (bbox.maxLon - bbox.minLon) *
      M_PER_DEG_LAT *
      Math.cos(midLat) *
      (bbox.maxLat - bbox.minLat) *
      M_PER_DEG_LAT;
    const res = Math.max(
      1,
      Math.ceil(Math.sqrt(areaM2 / SITE_VIEWSHED_DEFAULTS.demMaxCells)),
    );
    const grid = await fetchElevationGrid(bbox, res, { fetchImpl });
    grid.shift = gridDatumShift(grid);
    return grid;
  }

  /** Height grid for the area, cached per boundary + source. */
  async function loadGrid(area, source) {
    const key = `${source}|${area.ring.flat().join(',')}`;
    if (gridCache.key === key) return gridCache.grid;
    const tries =
      source === 'mesh'
        ? ['mesh']
        : source === 'dem'
          ? ['dem']
          : [...(hasPhotorealTiles() ? ['mesh'] : []), 'dem', 'terrain'];
    const errors = [];
    for (const kind of tries) {
      try {
        let grid;
        if (kind === 'mesh') {
          if (!hasPhotorealTiles())
            throw new Error('needs the Google 3D map source');
          grid = await sampleMesh(
            lonLatGrid(area.bbox, SITE_VIEWSHED_DEFAULTS.meshMaxCells),
          );
        } else if (kind === 'dem') {
          say('Loading USGS 3DEP elevation…');
          grid = await loadDem(area.bbox);
        } else {
          say('Sampling globe terrain…');
          grid = await sampleTerrain(
            lonLatGrid(area.bbox, SITE_VIEWSHED_DEFAULTS.demMaxCells),
          );
        }
        if (!grid.values.some(Number.isFinite))
          throw new Error('no heights came back');
        grid.kind = kind;
        grid.mask = new Uint8Array(grid.width * grid.height);
        for (let r = 0; r < grid.height; r++)
          for (let c = 0; c < grid.width; c++)
            grid.mask[r * grid.width + c] = pointInRing(
              gridToLonLat(grid, c, r),
              area.ring,
            )
              ? 1
              : 0;
        gridCache = { key, grid };
        return grid;
      } catch (error) {
        errors.push(`${SOURCE_LABEL[kind]}: ${error?.message || error}`);
      }
    }
    throw new Error(`No elevation for the viewshed (${errors.join('; ')})`);
  }

  /** Grid cell nearest a WGS84 lon/lat. */
  function cellAt(grid, [lon, lat]) {
    const { bbox, width, height } = grid;
    const dLon = grid.shift?.dLon ?? 0;
    const dLat = grid.shift?.dLat ?? 0;
    const col =
      ((lon - dLon - bbox.minLon) / (bbox.maxLon - bbox.minLon)) * width - 0.5;
    const row =
      ((bbox.maxLat - (lat - dLat)) / (bbox.maxLat - bbox.minLat)) * height -
      0.5;
    return {
      col: Math.min(width - 1, Math.max(0, Math.round(col))),
      row: Math.min(height - 1, Math.max(0, Math.round(row))),
    };
  }

  function removeOverlay() {
    if (overlay) scene.groundPrimitives.remove(overlay);
    overlay = null;
    if (marker) viewer.entities.remove(marker);
    marker = null;
  }

  /** The result as one image (row 0 = north), coloured per cell. */
  function overlayImage(grid, vis) {
    const canvas = document.createElement('canvas');
    canvas.width = grid.width;
    canvas.height = grid.height;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(grid.width, grid.height);
    const rgba = (css, alpha) => {
      const c = Cesium.Color.fromCssColorString(css);
      return [c.red * 255, c.green * 255, c.blue * 255, alpha * 255];
    };
    const seen = rgba(COLORS.visible, ALPHA.visible);
    const hidden = rgba(COLORS.hidden, ALPHA.hidden);
    for (let i = 0; i < vis.length; i++) {
      const px =
        vis[i] === VIEWSHED.VISIBLE
          ? seen
          : vis[i] === VIEWSHED.HIDDEN
            ? hidden
            : null;
      if (px) img.data.set(px, i * 4);
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  /**
   * One draped textured rectangle: far cheaper to render than a strip per
   * row run, which slowed every frame. Strips remain the fallback where
   * ground primitives can't take materials.
   */
  function drawImage(grid, vis) {
    const [west, north] = gridToLonLat(grid, -0.5, -0.5);
    const [east, south] = gridToLonLat(
      grid,
      grid.width - 0.5,
      grid.height - 0.5,
    );
    overlay = new Cesium.GroundPrimitive({
      geometryInstances: new Cesium.GeometryInstance({
        geometry: new Cesium.RectangleGeometry({
          rectangle: Cesium.Rectangle.fromDegrees(west, south, east, north),
          vertexFormat: Cesium.MaterialAppearance.VERTEX_FORMAT,
        }),
      }),
      appearance: new Cesium.MaterialAppearance({
        material: Cesium.Material.fromType('Image', {
          image: overlayImage(grid, vis),
        }),
        flat: true,
        translucent: true,
      }),
      classificationType: Cesium.ClassificationType.BOTH,
      asynchronous: true,
    });
    scene.groundPrimitives.add(overlay);
  }

  function draw(grid, vis, observer) {
    removeOverlay();
    if (Cesium.GroundPrimitive.supportsMaterials(scene)) drawImage(grid, vis);
    else drawStrips(grid, vis);
    drawMarker(observer);
    governorRequestRender('site-viewshed');
  }

  function drawStrips(grid, vis) {
    const dLon = (grid.bbox.maxLon - grid.bbox.minLon) / grid.width;
    const dLat = (grid.bbox.maxLat - grid.bbox.minLat) / grid.height;
    const instances = rowRuns(vis, grid.width, grid.height).map((run) => {
      const [west, lat] = gridToLonLat(grid, run.col0, run.row);
      const [east] = gridToLonLat(grid, run.col1, run.row);
      const seen = run.value === VIEWSHED.VISIBLE;
      return new Cesium.GeometryInstance({
        geometry: new Cesium.RectangleGeometry({
          rectangle: Cesium.Rectangle.fromDegrees(
            west - dLon / 2,
            lat - dLat / 2,
            east + dLon / 2,
            lat + dLat / 2,
          ),
        }),
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(
            Cesium.Color.fromCssColorString(
              seen ? COLORS.visible : COLORS.hidden,
            ).withAlpha(seen ? ALPHA.visible : ALPHA.hidden),
          ),
        },
      });
    });
    if (instances.length) {
      overlay = new Cesium.GroundPrimitive({
        geometryInstances: instances,
        appearance: new Cesium.PerInstanceColorAppearance({
          flat: true,
          translucent: true,
        }),
        classificationType: Cesium.ClassificationType.BOTH,
        asynchronous: true,
      });
      scene.groundPrimitives.add(overlay);
    }
  }

  function drawMarker(observer) {
    marker = viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(observer[0], observer[1], 0),
      point: {
        pixelSize: 12,
        color: Cesium.Color.fromCssColorString(COLORS.observer),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }

  /**
   * Compute and draw the viewshed from `at` ([lon, lat]; default: the last
   * observer). Options persist for the next run.
   */
  async function compute({ at, eyeM, targetM, source } = {}) {
    const area = requireArea();
    if (eyeM != null) state.eyeM = Number(eyeM);
    if (targetM != null) state.targetM = Number(targetM);
    if (source) state.source = source;
    const observer = at ?? state.observer;
    if (!observer) throw new Error('Place an observer first.');
    if (!pointInRing(observer, area.ring))
      throw new Error('Put the observer inside the site boundary.');
    const id = ++run;
    state.observer = observer;
    state.loading = true;
    state.error = null;
    emit();
    try {
      const grid = await loadGrid(area, state.source);
      if (id !== run) return describe();
      say('Tracing sight lines…');
      await new Promise((r) => setTimeout(r, 0)); // let the status paint
      const px = grid.kind === 'dem' ? gridPixelMetres(grid) : null;
      const cellXM =
        px?.pxEastM ??
        ((grid.bbox.maxLon - grid.bbox.minLon) / grid.width) *
          M_PER_DEG_LAT *
          Math.cos(
            ((grid.bbox.minLat + grid.bbox.maxLat) / 2) * (Math.PI / 180),
          );
      const cellYM =
        px?.pxSouthM ??
        ((grid.bbox.maxLat - grid.bbox.minLat) / grid.height) * M_PER_DEG_LAT;
      const cell = cellAt(grid, observer);
      const out = computeViewshed({
        heights: grid.values,
        width: grid.width,
        height: grid.height,
        cellXM,
        cellYM,
        observer: cell,
        eyeM: state.eyeM,
        targetM: state.targetM,
        mask: grid.mask,
      });
      const cellArea = cellXM * cellYM;
      state.result = {
        ...out.stats,
        visibleM2: Math.round(out.stats.visible * cellArea),
        hiddenM2: Math.round(out.stats.hidden * cellArea),
        cellM: Math.round(Math.sqrt(cellArea) * 10) / 10,
        source: grid.kind,
        sourceLabel: SOURCE_LABEL[grid.kind],
        observerGroundM: Math.round(out.observerGroundM * 10) / 10,
        observer: [...observer],
      };
      draw(grid, out.grid, observer);
      state.on = true;
      return describe();
    } catch (error) {
      if (id === run) state.error = error?.message || String(error);
      throw error;
    } finally {
      if (id === run) {
        state.loading = false;
        state.progress = '';
        emit();
      }
    }
  }

  /** Click the map to place (or move) the observer, then compute. */
  function pickObserver(options = {}) {
    requireArea();
    stopPicking();
    state.picking = true;
    state.error = null;
    emit();
    return new Promise((resolve, reject) => {
      handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
      const onKey = (event) => {
        if (event.key === 'Escape') finish(null);
      };
      const finish = (value) => {
        stopPicking();
        resolve(value);
      };
      cancelPick = () => {
        window.removeEventListener('keydown', onKey, true);
        cancelPick = null;
      };
      window.addEventListener('keydown', onKey, true);
      handler.setInputAction((event) => {
        const p = boundary.pickLonLat?.(event.position);
        if (!p) return;
        stopPicking();
        compute({ ...options, at: p }).then(resolve, reject);
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    });
  }

  function stopPicking() {
    handler?.destroy();
    handler = null;
    cancelPick?.();
    if (state.picking) {
      state.picking = false;
      emit();
    }
  }

  function clear() {
    run++;
    stopPicking();
    removeOverlay();
    state.on = false;
    state.loading = false;
    state.result = null;
    state.observer = null;
    state.error = null;
    governorRequestRender('site-viewshed');
    emit();
  }

  function setOptions({ eyeM, targetM, source } = {}) {
    if (eyeM != null && Number.isFinite(Number(eyeM)))
      state.eyeM = Number(eyeM);
    if (targetM != null && Number.isFinite(Number(targetM)))
      state.targetM = Number(targetM);
    if (source) state.source = source;
    emit();
  }

  /** Distance from the observer to a point, for dossier-style readouts. */
  function distanceTo(point) {
    return state.observer ? haversineMeters(state.observer, point) : null;
  }

  function describe() {
    return {
      on: state.on,
      loading: state.loading,
      picking: state.picking,
      progress: state.progress,
      error: state.error,
      eyeM: state.eyeM,
      targetM: state.targetM,
      source: state.source,
      observer: state.observer ? [...state.observer] : null,
      result: state.result ? { ...state.result } : null,
    };
  }

  const offBoundary = boundary?.onChange?.(() => {
    gridCache = { key: null, grid: null };
    if (!boundary.site && (state.on || state.picking)) clear();
  });

  return {
    describe,
    compute,
    pickObserver,
    stopPicking,
    clear,
    setOptions,
    distanceTo,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    destroy() {
      clear();
      offBoundary?.();
      listeners.clear();
    },
  };
}
