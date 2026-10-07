/**
 * Viewshed inside the site boundary: put an observer (click, or lat/lon)
 * and shade what they can see. Eye height is one value or a band (default
 * 1–2.5 m): green = seen even from the low eye, amber = seen only from the
 * high eye, red = hidden. A white outline marks the edge of what the high
 * eye sees and a cyan secondary outline the edge for the low eye.
 *
 * Height model, in order (`source: 'auto'`):
 *  1. Google 3D mesh (with the photoreal map source on): a surface model, so
 *     buildings and trees block the view.
 *  2. USGS 3DEP bare earth (/api/elevation/3dep), at the contours'
 *     resolution so both share the server's cache.
 *  3. The globe's terrain provider, when it has real heights.
 * Heights load once per boundary; changing heights only re-runs the sight
 * lines, which go to the GPU (viewshedEngine) or, failing that, CPU workers.
 */
import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import {
  fetchElevationGrid,
  gridDatumShift,
  gridPixelMetres,
  gridResolutionM,
  gridToLonLat,
} from './siteContours.js';
import {
  boundaryAreaM2,
  boundaryBbox,
  haversineMeters,
  pointInRing,
} from './siteGeometry.js';
import { createViewshedEngine } from './viewshedEngine.js';
import {
  BAND,
  VIEWSHED_DEFAULTS,
  bandOutlines,
  bandStats,
  downsampleHeights,
  rowRuns,
} from './viewshedMath.js';

export const SITE_VIEWSHED_DEFAULTS = Object.freeze({
  ...VIEWSHED_DEFAULTS,
  lowM: 1,
  highM: 2.5,
  source: 'auto',
  gpu: 'dedicated',
  meshMaxCells: 40_000,
  terrainMaxCells: 40_000,
  sampleBatch: 1000,
  sampleConcurrency: 4,
});

const COLORS = {
  both: '#3DDC84',
  highOnly: '#FFC400',
  hidden: '#FF5252',
  highEdge: '#FFFFFF',
  lowEdge: '#00E5FF',
  observer: '#FFFFFF',
};
const ALPHA = { both: 0.42, highOnly: 0.45, hidden: 0.3 };
const M_PER_DEG_LAT = 111_320;
const SOURCE_LABEL = {
  mesh: 'Google 3D mesh (buildings + trees block)',
  dem: 'USGS 3DEP bare earth',
  terrain: 'globe terrain',
};

export function createSiteViewshed(
  viewer,
  {
    boundary,
    fetchImpl = (...a) => fetch(...a),
    createEngine = createViewshedEngine,
  } = {},
) {
  if (!viewer?.scene) throw new TypeError('Viewshed requires a Cesium viewer');
  const scene = viewer.scene;
  const state = {
    on: false,
    loading: false,
    picking: false,
    progress: '',
    error: null,
    lowM: SITE_VIEWSHED_DEFAULTS.lowM,
    highM: SITE_VIEWSHED_DEFAULTS.highM,
    gpu: SITE_VIEWSHED_DEFAULTS.gpu,
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
  let gridCache = { key: null, promise: null };
  let engine = null;
  let run = 0;

  function getEngine() {
    engine ??= createEngine({ mode: state.gpu });
    return engine;
  }

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
    return { ring, bbox: boundary.site.bbox ?? boundaryBbox(ring) };
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

  /** Mesh heights, several batches in flight at once. */
  async function sampleMesh(grid) {
    const B = SITE_VIEWSHED_DEFAULTS.sampleBatch;
    const n = grid.width * grid.height;
    let next = 0;
    let done = 0;
    const lane = async () => {
      while (next < n) {
        const s = next;
        next += B;
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
        done += batch.length;
        say(`Sampling the 3D mesh… ${Math.round((done / n) * 100)}%`);
      }
    };
    await Promise.all(
      Array.from({ length: SITE_VIEWSHED_DEFAULTS.sampleConcurrency }, lane),
    );
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

  /** 3DEP at the contours' resolution: a cache hit when contours ran. */
  async function loadDem(area) {
    const res = gridResolutionM(boundaryAreaM2(area.ring));
    const grid = await fetchElevationGrid(area.bbox, res, { fetchImpl });
    grid.shift = gridDatumShift(grid);
    return grid;
  }

  /** Shrink a grid to the engine's cell budget, trimming its bbox to match. */
  function fitToBudget(grid, maxCells) {
    const cells = grid.width * grid.height;
    if (cells <= maxCells) return grid;
    const f = Math.ceil(Math.sqrt(cells / maxCells));
    const d = downsampleHeights(grid.values, grid.width, grid.height, f);
    const dx = (grid.bbox.maxLon - grid.bbox.minLon) / grid.width;
    const dy = (grid.bbox.maxLat - grid.bbox.minLat) / grid.height;
    return {
      ...grid,
      values: d.values,
      width: d.width,
      height: d.height,
      bbox: {
        minLon: grid.bbox.minLon,
        maxLat: grid.bbox.maxLat,
        maxLon: grid.bbox.minLon + d.width * f * dx,
        minLat: grid.bbox.maxLat - d.height * f * dy,
      },
    };
  }

  /**
   * Height grid for the area, cached per boundary + source + cell budget.
   * The promise is cached, so a load started while the user is still
   * choosing the observer spot is reused.
   */
  function loadGrid(area, source) {
    const budget = getEngine().maxCells;
    const key = `${source}|${budget}|${area.ring.flat().join(',')}`;
    if (gridCache.key !== key) {
      const promise = fetchGrid(area, source, budget);
      gridCache = { key, promise };
      promise.catch(() => {
        if (gridCache.promise === promise)
          gridCache = { key: null, promise: null };
      });
    }
    return gridCache.promise;
  }

  async function fetchGrid(area, source, budget) {
    const t0 = performance.now();
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
            lonLatGrid(
              area.bbox,
              Math.min(budget, SITE_VIEWSHED_DEFAULTS.meshMaxCells),
            ),
          );
        } else if (kind === 'dem') {
          say('Loading USGS 3DEP elevation…');
          grid = fitToBudget(await loadDem(area), budget);
        } else {
          say('Sampling globe terrain…');
          grid = await sampleTerrain(
            lonLatGrid(
              area.bbox,
              Math.min(budget, SITE_VIEWSHED_DEFAULTS.terrainMaxCells),
            ),
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
        grid.loadMs = performance.now() - t0;
        grid.doneAt = performance.now();
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

  /**
   * The result as one image (row 0 = north): a colour per cell, with the
   * outlines painted in. Painting them here costs nothing per frame, where
   * draped polylines slowed every redraw.
   */
  function overlayImage(grid, vis, banded) {
    const cells = document.createElement('canvas');
    cells.width = grid.width;
    cells.height = grid.height;
    const cctx = cells.getContext('2d');
    const img = cctx.createImageData(grid.width, grid.height);
    const rgba = (css, alpha) => {
      const c = Cesium.Color.fromCssColorString(css);
      return [c.red * 255, c.green * 255, c.blue * 255, alpha * 255];
    };
    const palette = [
      null,
      rgba(COLORS.hidden, ALPHA.hidden),
      rgba(COLORS.highOnly, ALPHA.highOnly),
      rgba(COLORS.both, ALPHA.both),
    ];
    for (let i = 0; i < vis.length; i++) {
      const px = palette[vis[i]];
      if (px) img.data.set(px, i * 4);
    }
    cctx.putImageData(img, 0, 0);
    // Upscale so outlines can be thinner than a cell.
    const scale = Math.max(
      1,
      Math.min(4, Math.floor(4096 / Math.max(grid.width, grid.height))),
    );
    const canvas = document.createElement('canvas');
    canvas.width = grid.width * scale;
    canvas.height = grid.height * scale;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(cells, 0, 0, canvas.width, canvas.height);
    const levels = banded
      ? [
          ['high', COLORS.highEdge],
          ['low', COLORS.lowEdge],
        ]
      : [['high', COLORS.highEdge]];
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1.5, scale * 0.9);
    for (const [level, css] of levels) {
      ctx.strokeStyle = css;
      ctx.beginPath();
      for (const line of bandOutlines(vis, grid.width, grid.height, level))
        line.forEach(([x, y], k) =>
          ctx[k ? 'lineTo' : 'moveTo']((x + 0.5) * scale, (y + 0.5) * scale),
        );
      ctx.stroke();
    }
    return canvas;
  }

  /**
   * One draped textured rectangle: far cheaper to render than a strip per
   * row run, which slowed every frame. Strips remain the fallback where
   * ground primitives can't take materials.
   */
  function drawImage(grid, vis, banded) {
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
          image: overlayImage(grid, vis, banded),
        }),
        flat: true,
        translucent: true,
      }),
      classificationType: Cesium.ClassificationType.BOTH,
      asynchronous: true,
    });
    scene.groundPrimitives.add(overlay);
  }

  function draw(grid, vis, observer, banded) {
    removeOverlay();
    if (Cesium.GroundPrimitive.supportsMaterials(scene))
      drawImage(grid, vis, banded);
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
      const key =
        run.value === BAND.BOTH
          ? 'both'
          : run.value === BAND.HIGH_ONLY
            ? 'highOnly'
            : 'hidden';
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
            Cesium.Color.fromCssColorString(COLORS[key]).withAlpha(ALPHA[key]),
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

  function applyOptions({ lowM, highM, eyeM, targetM, source, gpu } = {}) {
    if (eyeM != null && lowM == null && highM == null) lowM = highM = eyeM;
    const lo = lowM != null ? Number(lowM) : state.lowM;
    const hi = highM != null ? Number(highM) : lowM != null ? lo : state.highM;
    if (!(lo >= 0) || !(hi >= 0)) throw new Error('Eye heights must be ≥ 0 m');
    state.lowM = Math.min(lo, hi);
    state.highM = Math.max(lo, hi);
    if (targetM != null && Number.isFinite(Number(targetM)))
      state.targetM = Number(targetM);
    if (source) state.source = source;
    if (gpu && gpu !== state.gpu) {
      state.gpu = gpu;
      engine?.setMode(gpu);
      gridCache = { key: null, promise: null }; // the cell budget may change
    }
  }

  /**
   * Compute and draw the viewshed from `at` ([lon, lat]; default: the last
   * observer). Options persist for the next run. `eyeM` sets one height;
   * `lowM`/`highM` set the band.
   */
  async function compute({ at, ...options } = {}) {
    const area = requireArea();
    applyOptions(options);
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
      const t0 = performance.now();
      const grid = await loadGrid(area, state.source);
      // Heights that finished loading before this run (cached, or fetched
      // while the user was picking the spot) cost this run nothing.
      const heightsCached = grid.doneAt <= t0;
      if (id !== run) return describe();
      say(`Tracing sight lines on the ${getEngine().kind}…`);
      await new Promise((r) => setTimeout(r, 0)); // let the status paint
      const { pxEastM: cellXM, pxSouthM: cellYM } = gridPixelMetres(grid);
      const cell = cellAt(grid, observer);
      const banded = state.highM > state.lowM;
      const {
        codes,
        engine: used,
        ms,
      } = await getEngine().compute({
        heights: grid.values,
        width: grid.width,
        height: grid.height,
        cellXM,
        cellYM,
        observer: cell,
        lowM: state.lowM,
        highM: state.highM,
        targetM: state.targetM,
        mask: grid.mask,
      });
      if (id !== run) return describe();
      const stats = bandStats(codes, grid.width, cellXM, cellYM, cell);
      const cellArea = cellXM * cellYM;
      state.result = {
        ...stats,
        banded,
        lowM: state.lowM,
        highM: state.highM,
        bothM2: Math.round(stats.both * cellArea),
        highOnlyM2: Math.round(stats.highOnly * cellArea),
        hiddenM2: Math.round(stats.hidden * cellArea),
        cellM: Math.round(Math.sqrt(cellArea) * 10) / 10,
        cells: grid.width * grid.height,
        source: grid.kind,
        sourceLabel: SOURCE_LABEL[grid.kind],
        observerGroundM:
          Math.round(grid.values[cell.row * grid.width + cell.col] * 10) / 10,
        observer: [...observer],
        engine: used,
        heightsMs: Math.round(grid.loadMs),
        heightsCached,
        computeMs: Math.round(ms),
      };
      draw(grid, codes, observer, banded);
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
    applyOptions(options);
    // Start loading heights now, while the user picks the spot.
    loadGrid(requireArea(), state.source).catch(() => {});
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

  function setOptions(options = {}) {
    applyOptions(options);
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
      lowM: state.lowM,
      highM: state.highM,
      eyeM: state.highM,
      targetM: state.targetM,
      source: state.source,
      gpu: state.gpu,
      engine: engine ? engine.kind : null,
      renderer: engine?.renderer ?? null,
      observer: state.observer ? [...state.observer] : null,
      result: state.result ? { ...state.result } : null,
    };
  }

  const offBoundary = boundary?.onChange?.(() => {
    gridCache = { key: null, promise: null };
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
      engine?.destroy();
      offBoundary?.();
      listeners.clear();
    },
  };
}
