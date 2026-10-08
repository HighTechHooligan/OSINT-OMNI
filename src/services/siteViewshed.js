/**
 * Viewshed: what can be seen from a point, along a route (a walking path or
 * a drive), or from anywhere in an area (a park, a radius circle). Eye
 * height is one value or a band (default 0–2.5 m): green = seen even from
 * the low eye, amber = seen only from the high eye, red = hidden. A white
 * outline marks the edge of what the high eye sees and a cyan secondary
 * outline the edge for the low eye.
 *
 * The analysed area is everything within `reachM` (default 1 km, at most
 * 5 km) of the shape, optionally clipped to the SITE boundary. A route or
 * area becomes many observers a few cells apart, each judging only the
 * cells within its reach; a cell takes the best result any observer gives
 * it.
 *
 * Height model, in order (`source: 'auto'`):
 *  1. Google 3D mesh (with the photoreal map source on, areas up to 25 km²):
 *     a surface model, so buildings and trees block the view. One top-down
 *     depth snapshot (meshSnapshot.js).
 *  2. USGS 3DEP bare earth (/api/elevation/3dep); long routes are fetched
 *     as a corridor of tiles and stitched.
 *  3. The globe's terrain provider, when it has real heights.
 * Heights load once per area; changing heights only re-runs the sight
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
import { haversineMeters, pointInRing } from './siteGeometry.js';
import { captureMeshHeights, meshSnapshotSupported } from './meshSnapshot.js';
import { pickShape as pickShapeOnGlobe } from './shapePicker.js';
import { affordableObservers, createViewshedEngine } from './viewshedEngine.js';
import { resourceBudgets } from './resourceBudgets.js';
import {
  BAND,
  VIEWSHED_DEFAULTS,
  bandOutlines,
  bandStats,
  downsampleHeights,
  rowRuns,
} from './viewshedMath.js';
import {
  SHAPE_LIMITS,
  bboxSizeM,
  describeShape,
  expandBbox,
  normalizeShape,
  planDemTiles,
  shapeBbox,
  shapeObservers,
  shapePoints,
  workCellM,
} from './viewshedShapes.js';

export const SITE_VIEWSHED_DEFAULTS = Object.freeze({
  ...VIEWSHED_DEFAULTS,
  lowM: 0,
  highM: 2.5,
  reachM: 1000,
  clip: false,
  source: 'auto',
  gpu: 'dedicated',
  meshMaxCells: 250_000, // one top-down depth snapshot
  meshSampleMaxCells: 40_000, // point-by-point fallback
  meshMaxAreaM2: 25e6, // bigger areas: the snapshot's tiles get too coarse
  meshTimeoutMs: 15_000,
  terrainMaxCells: 40_000,
  sampleBatch: 250,
  sampleConcurrency: 4,
  demConcurrency: 4,
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
const SOURCE_LABEL = {
  mesh: 'Google 3D mesh (buildings + trees block)',
  dem: 'USGS 3DEP bare earth',
  terrain: 'globe terrain',
};
const KIND_LABEL = { point: 'Point', line: 'Route', area: 'Area' };

export function createSiteViewshed(
  viewer,
  {
    boundary,
    fetchImpl = (...a) => fetch(...a),
    createEngine = createViewshedEngine,
    pickShapeImpl = pickShapeOnGlobe,
    budgets = () => resourceBudgets.get(),
  } = {},
) {
  if (!viewer?.scene) throw new TypeError('Viewshed requires a Cesium viewer');
  const scene = viewer.scene;
  const state = {
    on: false,
    loading: false,
    picking: null, // shape kind being drawn
    progress: '',
    error: null,
    lowM: SITE_VIEWSHED_DEFAULTS.lowM,
    highM: SITE_VIEWSHED_DEFAULTS.highM,
    reachM: SITE_VIEWSHED_DEFAULTS.reachM,
    clip: SITE_VIEWSHED_DEFAULTS.clip,
    gpu: SITE_VIEWSHED_DEFAULTS.gpu,
    targetM: SITE_VIEWSHED_DEFAULTS.targetM,
    source: SITE_VIEWSHED_DEFAULTS.source,
    shape: null,
    result: null,
  };
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => fn(describe()));
  const say = (text) => {
    state.progress = text;
    emit();
  };
  let overlay = null;
  let shapeEntities = [];
  let picker = null;
  // Height grids by area + source + cell budget, newest last, kept up to
  // the gridCacheMB budget so switching between areas reuses their heights.
  const gridCache = new Map();
  const gridBytes = (grid) =>
    (grid?.values?.byteLength ?? 0) + (grid?.mask?.byteLength ?? 0);
  function trimGrids() {
    const cap = budgets().gridCacheMB * 1024 * 1024;
    let total = 0;
    for (const entry of gridCache.values()) total += entry.bytes;
    for (const [key, entry] of gridCache) {
      if (total <= cap || gridCache.size <= 1) break;
      if (!entry.bytes) continue; // still loading
      gridCache.delete(key);
      total -= entry.bytes;
    }
  }
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

  /**
   * The analysed area: the shape's bbox grown by the reach, or the SITE
   * boundary's part of it when clipping.
   */
  function analysisArea(shape) {
    let bbox = expandBbox(shapeBbox(shape), state.reachM);
    let ring = null;
    if (state.clip) {
      const site = boundary?.site;
      if (!site)
        throw new Error(
          'Clip to site needs a site boundary. Turn clip off or add one in SITE.',
        );
      ring = site.boundary;
      const s = site.bbox ?? shapeBbox({ kind: 'area', ring });
      bbox = {
        minLon: Math.max(bbox.minLon, s.minLon),
        minLat: Math.max(bbox.minLat, s.minLat),
        maxLon: Math.min(bbox.maxLon, s.maxLon),
        maxLat: Math.min(bbox.maxLat, s.maxLat),
      };
      if (bbox.minLon >= bbox.maxLon || bbox.minLat >= bbox.maxLat)
        throw new Error(
          'The shape and its reach are outside the site boundary.',
        );
    }
    const { widthM, heightM } = bboxSizeM(bbox);
    return { bbox, ring, areaM2: widthM * heightM, shape };
  }

  /** A regular lon/lat grid over the bbox with about `maxCells` cells. */
  function lonLatGrid(bbox, maxCells) {
    const { widthM, heightM } = bboxSizeM(bbox);
    const cellM = Math.max(1, Math.sqrt((widthM * heightM) / maxCells));
    const width = Math.max(2, Math.ceil(widthM / cellM));
    const height = Math.max(2, Math.ceil(heightM / cellM));
    return {
      width,
      height,
      bbox,
      values: new Float64Array(width * height).fill(Number.NaN),
    };
  }

  /**
   * Mesh heights point by point (fallback where depth snapshots are not
   * available): small batches, several in flight, progress from the start.
   */
  async function sampleMesh(grid) {
    const B = SITE_VIEWSHED_DEFAULTS.sampleBatch;
    const n = grid.width * grid.height;
    let next = 0;
    let done = 0;
    say('Sampling the 3D mesh point by point… 0%');
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
      Array.from(
        {
          length:
            budgets().sampleConcurrency ??
            SITE_VIEWSHED_DEFAULTS.sampleConcurrency,
        },
        lane,
      ),
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

  /**
   * Mesh heights from one top-down depth snapshot (seconds), or point
   * sampling where the snapshot is not supported.
   */
  async function loadMesh(area, budget) {
    if (!hasPhotorealTiles()) throw new Error('needs the Google 3D map source');
    if (area.areaM2 > SITE_VIEWSHED_DEFAULTS.meshMaxAreaM2)
      throw new Error('area too big for a mesh snapshot');
    if (meshSnapshotSupported(scene)) {
      const pixels = scene.drawingBufferWidth * scene.drawingBufferHeight;
      const cells = Math.min(
        budget,
        budgets().meshCells ?? SITE_VIEWSHED_DEFAULTS.meshMaxCells,
        Math.max(10_000, Math.floor(pixels / 6)),
      );
      return captureMeshHeights(viewer, lonLatGrid(area.bbox, cells), {
        say,
        timeoutMs: SITE_VIEWSHED_DEFAULTS.meshTimeoutMs,
      });
    }
    return sampleMesh(
      lonLatGrid(
        area.bbox,
        Math.min(budget, SITE_VIEWSHED_DEFAULTS.meshSampleMaxCells),
      ),
    );
  }

  /**
   * 3DEP for the area. A small area is one request at the contours'
   * resolution (a cache hit when contours ran). A long route is a corridor
   * of tiles, each small enough for the proxy, stitched into one grid.
   */
  async function loadDem(area, budget) {
    // 3% headroom: a grid a hair over budget would be halved by fitToBudget.
    const resM = Math.max(
      gridResolutionM(area.areaM2),
      Math.sqrt(area.areaM2 / budget) * 1.03,
    );
    const tiles = planDemTiles(area.bbox, resM, area.shape, state.reachM);
    say('Loading USGS 3DEP elevation…');
    const whole =
      tiles.length === 1 &&
      tiles[0].minLon === area.bbox.minLon &&
      tiles[0].maxLat === area.bbox.maxLat;
    if (whole) {
      const grid = await fetchElevationGrid(area.bbox, resM, { fetchImpl });
      grid.shift = gridDatumShift(grid);
      return fitToBudget(grid, budget);
    }
    const grid = lonLatGrid(area.bbox, budget);
    let next = 0;
    let done = 0;
    let first = null;
    const lane = async () => {
      while (next < tiles.length) {
        const tile = tiles[next++];
        const part = await fetchElevationGrid(tile, resM, { fetchImpl });
        first ??= part;
        pasteInto(grid, part);
        done++;
        say(`Loading USGS 3DEP elevation… ${done}/${tiles.length} tiles`);
      }
    };
    await Promise.all(
      Array.from(
        {
          length:
            budgets().demConcurrency ?? SITE_VIEWSHED_DEFAULTS.demConcurrency,
        },
        lane,
      ),
    );
    grid.datum = first?.datum;
    grid.shift = first ? gridDatumShift({ ...first, bbox: area.bbox }) : null;
    grid.tiles = tiles.length;
    return grid;
  }

  /** Nearest-sample copy of a tile grid into the grid cells it covers. */
  function pasteInto(grid, part) {
    const { bbox: g, width: W, height: H } = grid;
    const { bbox: t, width: w, height: h, values } = part;
    const sx = (g.maxLon - g.minLon) / W;
    const sy = (g.maxLat - g.minLat) / H;
    const c0 = Math.max(0, Math.floor((t.minLon - g.minLon) / sx));
    const c1 = Math.min(W, Math.ceil((t.maxLon - g.minLon) / sx));
    const r0 = Math.max(0, Math.floor((g.maxLat - t.maxLat) / sy));
    const r1 = Math.min(H, Math.ceil((g.maxLat - t.minLat) / sy));
    for (let r = r0; r < r1; r++) {
      const lat = g.maxLat - (r + 0.5) * sy;
      const tr = Math.floor(((t.maxLat - lat) / (t.maxLat - t.minLat)) * h);
      if (tr < 0 || tr >= h) continue;
      for (let c = c0; c < c1; c++) {
        const lon = g.minLon + (c + 0.5) * sx;
        const tc = Math.floor(((lon - t.minLon) / (t.maxLon - t.minLon)) * w);
        if (tc < 0 || tc >= w) continue;
        const v = values[tr * w + tc];
        if (Number.isFinite(v)) grid.values[r * W + c] = v;
      }
    }
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
   * Cells for the area: the engine's budget for a point; for a route or
   * area, the cell size the engine's work budget affords (workCellM), so a
   * run stays around a second on the GPU at hand.
   */
  function cellBudget(area) {
    const e = getEngine();
    if (area.shape.kind === 'point') return e.maxCells;
    const c = workCellM(area.shape, state.reachM, e.work ?? Infinity);
    const fit = c ? Math.floor(area.areaM2 / (c * c)) : Infinity;
    return Math.max(10_000, Math.min(e.maxCellsWide, fit));
  }

  /**
   * Height grid for the area, cached per area + source + cell budget. The
   * promise is cached, so a repeat run with new eye heights reuses it.
   */
  function loadGrid(area, source) {
    const budget = cellBudget(area);
    const b = area.bbox;
    const box = [b.minLon, b.minLat, b.maxLon, b.maxLat]
      .map((v) => v.toFixed(6))
      .join(',');
    const key = `${source}|${budget}|${state.clip}|${box}`;
    const hit = gridCache.get(key);
    if (hit) {
      gridCache.delete(key); // most recently used goes last
      gridCache.set(key, hit);
      return hit.promise;
    }
    const entry = { promise: fetchGrid(area, source, budget), bytes: 0 };
    gridCache.set(key, entry);
    entry.promise.then(
      (grid) => {
        entry.bytes = gridBytes(grid);
        trimGrids();
      },
      () => {
        if (gridCache.get(key) === entry) gridCache.delete(key);
      },
    );
    return entry.promise;
  }

  async function fetchGrid(area, source, budget) {
    const t0 = performance.now();
    const meshOk =
      hasPhotorealTiles() &&
      area.areaM2 <= SITE_VIEWSHED_DEFAULTS.meshMaxAreaM2;
    const tries =
      source === 'mesh'
        ? ['mesh']
        : source === 'dem'
          ? ['dem']
          : [...(meshOk ? ['mesh'] : []), 'dem', 'terrain'];
    const errors = [];
    for (const kind of tries) {
      try {
        let grid;
        if (kind === 'mesh') grid = await loadMesh(area, budget);
        else if (kind === 'dem') grid = await loadDem(area, budget);
        else {
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
        grid.mask = null;
        if (area.ring) {
          grid.mask = new Uint8Array(grid.width * grid.height);
          for (let r = 0; r < grid.height; r++)
            for (let c = 0; c < grid.width; c++)
              grid.mask[r * grid.width + c] = pointInRing(
                gridToLonLat(grid, c, r),
                area.ring,
              )
                ? 1
                : 0;
        }
        grid.loadMs = performance.now() - t0;
        grid.doneAt = performance.now();
        return grid;
      } catch (error) {
        errors.push(`${SOURCE_LABEL[kind]}: ${error?.message || error}`);
      }
    }
    throw new Error(`No elevation for the viewshed (${errors.join('; ')})`);
  }

  /** Grid cell nearest a WGS84 lon/lat; null outside unless clamped. */
  function cellAt(grid, [lon, lat], clamp = true) {
    const { bbox, width, height } = grid;
    const dLon = grid.shift?.dLon ?? 0;
    const dLat = grid.shift?.dLat ?? 0;
    const col = Math.round(
      ((lon - dLon - bbox.minLon) / (bbox.maxLon - bbox.minLon)) * width - 0.5,
    );
    const row = Math.round(
      ((bbox.maxLat - (lat - dLat)) / (bbox.maxLat - bbox.minLat)) * height -
        0.5,
    );
    if (!clamp && (col < 0 || row < 0 || col >= width || row >= height))
      return null;
    return {
      col: Math.min(width - 1, Math.max(0, col)),
      row: Math.min(height - 1, Math.max(0, row)),
    };
  }

  function removeOverlay() {
    if (overlay) scene.groundPrimitives.remove(overlay);
    overlay = null;
  }

  function removeShape() {
    for (const e of shapeEntities) viewer.entities.remove(e);
    shapeEntities = [];
  }

  /** The observer point, route line or area outline on the map. */
  function drawShape(shape) {
    removeShape();
    if (!shape) return;
    const color = Cesium.Color.fromCssColorString(COLORS.observer);
    if (shape.kind === 'point')
      shapeEntities.push(
        viewer.entities.add({
          position: Cesium.Cartesian3.fromDegrees(shape.at[0], shape.at[1], 0),
          point: {
            pixelSize: 12,
            color,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        }),
      );
    else
      shapeEntities.push(
        viewer.entities.add({
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray(
              shapePoints(shape).flat(),
            ),
            width: 4,
            clampToGround: true,
            material: new Cesium.PolylineOutlineMaterialProperty({
              color,
              outlineColor: Cesium.Color.BLACK,
              outlineWidth: 1,
            }),
          },
        }),
      );
    governorRequestRender('site-viewshed');
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

  function draw(grid, vis, banded) {
    removeOverlay();
    if (Cesium.GroundPrimitive.supportsMaterials(scene))
      drawImage(grid, vis, banded);
    else drawStrips(grid, vis);
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

  function applyOptions({
    lowM,
    highM,
    eyeM,
    targetM,
    source,
    gpu,
    reachM,
    clip,
  } = {}) {
    if (eyeM != null && lowM == null && highM == null) lowM = highM = eyeM;
    const lo = lowM != null ? Number(lowM) : state.lowM;
    const hi = highM != null ? Number(highM) : lowM != null ? lo : state.highM;
    if (!(lo >= 0) || !(hi >= 0)) throw new Error('Eye heights must be ≥ 0 m');
    if (reachM != null) {
      const r = Number(reachM);
      if (!(r >= 10) || r > SHAPE_LIMITS.maxReachM)
        throw new Error(
          `Reach must be 10 m to ${SHAPE_LIMITS.maxReachM / 1000} km`,
        );
      state.reachM = r;
    }
    state.lowM = Math.min(lo, hi);
    state.highM = Math.max(lo, hi);
    if (targetM != null && Number.isFinite(Number(targetM)))
      state.targetM = Number(targetM);
    if (source) state.source = source;
    if (clip != null) state.clip = Boolean(clip);
    if (gpu && gpu !== state.gpu) {
      state.gpu = gpu;
      engine?.setMode(gpu);
      // The cell budget may change; grids for other budgets stay cached.
    }
  }

  /** Set the observer shape (point, route or area) without computing. */
  function setShape(shape) {
    state.shape = shape ? normalizeShape(shape) : null;
    state.result = null;
    state.on = false;
    removeOverlay();
    drawShape(state.shape);
    emit();
    return describe();
  }

  /**
   * Compute and draw the viewshed. `at` ([lon, lat]) or `shape` replaces
   * the observer shape; without either, the last shape is used. Options
   * persist for the next run. `eyeM` sets one height; `lowM`/`highM` set the
   * band; `reachM` how far to look; `clip` keeps it inside the SITE
   * boundary.
   */
  async function compute({ at, shape, ...options } = {}) {
    applyOptions(options);
    if (at) setShape({ kind: 'point', at });
    else if (shape) setShape(shape);
    const current = state.shape;
    if (!current)
      throw new Error('Pick a point, route or area for the observer first.');
    const area = analysisArea(current);
    const id = ++run;
    state.loading = true;
    state.error = null;
    emit();
    try {
      const t0 = performance.now();
      const grid = await loadGrid(area, state.source);
      // Heights that finished loading before this run (cached from an
      // earlier run) cost this run nothing.
      const heightsCached = grid.doneAt <= t0;
      if (id !== run) return describe();
      const { pxEastM: cellXM, pxSouthM: cellYM } = gridPixelMetres(grid);
      const cellM = Math.sqrt(cellXM * cellYM);
      // As many observers as the engine affords at this reach (each one
      // walks every cell within it), never closer than two cells.
      const { points, spacingM } = shapeObservers(
        current,
        2 * cellM,
        affordableObservers(
          getEngine().work ?? Infinity,
          state.reachM / cellM,
          getEngine().maxObservers ?? budgets().maxObservers,
        ),
      );
      const seen = new Set();
      const observers = [];
      for (const p of points) {
        const c = cellAt(grid, p, false);
        if (!c) continue;
        const key = c.row * grid.width + c.col;
        if (seen.has(key)) continue;
        seen.add(key);
        observers.push(c);
      }
      if (!observers.length)
        throw new Error('The shape is outside the height grid.');
      const multi = current.kind !== 'point';
      say(
        `Tracing sight lines${multi ? ` from ${observers.length} observers` : ''} on the ${getEngine().kind}…`,
      );
      await new Promise((r) => setTimeout(r, 0)); // let the status paint
      const banded = state.highM > state.lowM;
      const input = {
        heights: grid.values,
        width: grid.width,
        height: grid.height,
        cellXM,
        cellYM,
        lowM: state.lowM,
        highM: state.highM,
        targetM: state.targetM,
        mask: grid.mask,
        maxDistM: state.reachM,
        ...(multi ? { observers } : { observer: observers[0] }),
      };
      const {
        codes,
        engine: usedEngine,
        ms,
        used,
      } = await getEngine().compute(input);
      if (id !== run) return describe();
      if (multi && used === 0)
        throw new Error('No heights under the route or area.');
      const first = observers[0];
      const stats = bandStats(codes, grid.width, cellXM, cellYM, first);
      const cellArea = cellXM * cellYM;
      const info = describeShape(current);
      state.result = {
        ...stats,
        farthestHighM: multi ? null : stats.farthestHighM,
        farthestLowM: multi ? null : stats.farthestLowM,
        kind: current.kind,
        shapeLabel: KIND_LABEL[current.kind],
        lengthM: Math.round(info.lengthM),
        shapeAreaM2: Math.round(info.areaM2),
        observers: multi ? (used ?? observers.length) : 1,
        spacingM: Math.round(spacingM),
        reachM: state.reachM,
        clip: state.clip,
        banded,
        lowM: state.lowM,
        highM: state.highM,
        bothM2: Math.round(stats.both * cellArea),
        highOnlyM2: Math.round(stats.highOnly * cellArea),
        hiddenM2: Math.round(stats.hidden * cellArea),
        cellM: Math.round(cellM * 10) / 10,
        cells: grid.width * grid.height,
        source: grid.kind,
        sourceLabel: SOURCE_LABEL[grid.kind],
        observerGroundM:
          Math.round(grid.values[first.row * grid.width + first.col] * 10) / 10,
        observer: current.kind === 'point' ? [...current.at] : null,
        engine: usedEngine,
        heightsMs: Math.round(grid.loadMs),
        heightsCached,
        computeMs: Math.round(ms),
      };
      draw(grid, codes, banded);
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

  /**
   * Draw the observer shape on the map ('point', 'line' for a route,
   * 'area', or 'circle' with an optional `radiusM`), then compute.
   * Resolves to the result, or null when cancelled.
   */
  async function pickShape(kind, { radiusM = null, onHint, ...options } = {}) {
    stopPicking();
    state.error = null;
    applyOptions(options);
    state.picking = kind;
    emit();
    try {
      picker = pickShapeImpl(viewer, {
        kind,
        radiusM,
        snapDeg: boundary?.snapDeg ?? 15,
        onHint: (text) => {
          onHint?.(text);
          say(text);
        },
        pickLonLat: boundary?.pickLonLat,
      });
    } catch (error) {
      state.picking = null;
      emit();
      throw error;
    }
    const shape = await picker.done;
    picker = null;
    state.picking = null;
    state.progress = '';
    emit();
    if (!shape) return null;
    return compute({ shape });
  }

  /** Click the map to place (or move) a single observer, then compute. */
  function pickObserver(options = {}) {
    return pickShape('point', options);
  }

  /** Finish the shape being drawn (Enter / double-click equivalent). */
  function finishPicking() {
    picker?.finish();
  }

  function stopPicking() {
    picker?.cancel();
    picker = null;
    if (state.picking) {
      state.picking = null;
      state.progress = '';
      emit();
    }
  }

  /** Use the SITE boundary (a park's KML, say) as the observer area. */
  function useSiteBoundary(options = {}) {
    const site = boundary?.site;
    if (!site)
      throw new Error(
        'No SITE boundary yet: import, paste or draw one in SITE.',
      );
    return compute({
      ...options,
      shape: { kind: 'area', ring: site.boundary },
    });
  }

  function clear() {
    run++;
    stopPicking();
    removeOverlay();
    removeShape();
    state.on = false;
    state.loading = false;
    state.result = null;
    state.shape = null;
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
    return state.shape?.kind === 'point'
      ? haversineMeters(state.shape.at, point)
      : null;
  }

  /**
   * What the orbit circles: the shape and its reach, in the form the SITE
   * orbit reads from a boundary.
   */
  function orbitTarget() {
    if (!state.shape) throw new Error('Pick a point, route or area first.');
    const info = describeShape(state.shape);
    return {
      name: `Viewshed · ${KIND_LABEL[state.shape.kind]}`,
      center: { lon: info.center[0], lat: info.center[1] },
      groundM: Number.isFinite(state.result?.observerGroundM)
        ? state.result.observerGroundM
        : 0,
      radiusM: Math.max(150, info.radiusM + Math.min(state.reachM, 1500) * 0.6),
      points: [],
      pointPositions: [],
    };
  }

  function describe() {
    const shape = state.shape;
    const info = shape ? describeShape(shape) : null;
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
      reachM: state.reachM,
      clip: state.clip,
      source: state.source,
      gpu: state.gpu,
      // The engine (a tiny WebGL context) is made on first look, so the
      // tab can flag an integrated GPU before anything is computed.
      engine: getEngine().kind,
      renderer: getEngine().renderer,
      gpuKind: getEngine().gpuKind,
      shape: shape
        ? {
            kind: shape.kind,
            label: KIND_LABEL[shape.kind],
            lengthM: Math.round(info.lengthM),
            areaM2: Math.round(info.areaM2),
            points: shapePoints(shape).length,
            radiusM: shape.circle ? Math.round(shape.circle.radiusM) : null,
          }
        : null,
      observer: shape?.kind === 'point' ? [...shape.at] : null,
      hasSite: Boolean(boundary?.site),
      result: state.result ? { ...state.result } : null,
    };
  }

  const offBoundary = boundary?.onChange?.(() => {
    if (state.clip) gridCache.clear();
    emit();
  });

  return {
    describe,
    compute,
    setShape,
    pickShape,
    pickObserver,
    finishPicking,
    stopPicking,
    useSiteBoundary,
    clear,
    setOptions,
    distanceTo,
    orbitTarget,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    destroy() {
      clear();
      gridCache.clear();
      engine?.destroy();
      offBoundary?.();
      listeners.clear();
    },
  };
}
