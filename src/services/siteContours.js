/**
 * Site contours + canopy overlay, drawn only inside the site boundary.
 *
 * Contours: USGS 3DEP bare earth (via /api/elevation/3dep, keyless, cached to
 * disk on the server) → marching squares at a 2–100 ft interval → ground-
 * clamped polylines that drape over terrain and Google 3D Tiles. Every 5th
 * line is a heavier index contour.
 *
 * Canopy: where the Google photorealistic mesh stands well above the 3DEP
 * ground (trees, structures), the cell is shaded green so you can see which
 * contours run under cover. Requires the photoreal map source.
 */
import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import { ensureGeoidReady, geoidHeight } from '../data/geoid.js';
import { buildContours, clampIntervalFt } from './contourMath.js';
import { boundaryAreaM2, pointInRing } from './siteGeometry.js';

export const CONTOUR_DEFAULTS = Object.freeze({
  intervalFt: 10,
  canopyThresholdM: 2.5,
  canopyCellM: 4,
});

const INDEX_CSS = '#FFD27A';
const MINOR_CSS = '#FFF3D6';
const CANOPY_CSS = '#3DDC84';
const MAX_CANOPY_SAMPLES = 40_000;

/** Pick a 3DEP request resolution that keeps the grid modest. */
export function gridResolutionM(areaM2) {
  if (areaM2 <= 1.5e6) return 1; // ≤ ~370 acres at 1 m
  if (areaM2 <= 6e6) return 2;
  return Math.ceil(Math.sqrt(areaM2 / 1.5e6));
}

/** Fetch a bare-earth grid. Missing samples become NaN. */
export async function fetchElevationGrid(
  bbox,
  resM,
  { signal, fetchImpl = fetch } = {},
) {
  const q = new URLSearchParams({
    bbox: [bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat].join(','),
    res: String(resM),
  });
  const response = await fetchImpl(`/api/elevation/3dep?${q}`, { signal });
  if (!response.ok) {
    let message = `elevation request failed (HTTP ${response.status})`;
    try {
      message = (await response.json()).error || message;
    } catch {
      // keep the generic message
    }
    throw new Error(message);
  }
  const width = Number(response.headers.get('X-Grid-Width'));
  const height = Number(response.headers.get('X-Grid-Height'));
  const noData = Number(response.headers.get('X-Grid-NoData') ?? -9999);
  const [minLon, minLat, maxLon, maxLat] = (
    response.headers.get('X-Grid-Bbox') || ''
  )
    .split(',')
    .map(Number);
  const raw = new Float32Array(await response.arrayBuffer());
  if (!width || !height || raw.length !== width * height)
    throw new Error('elevation grid was malformed');
  const values = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++)
    values[i] = raw[i] <= noData ? Number.NaN : raw[i];
  return {
    width,
    height,
    values,
    bbox: { minLon, minLat, maxLon, maxLat },
    cached: response.headers.get('X-Cache') === 'HIT',
  };
}

/** Grid (col,row) → lon/lat. Samples are pixel centres across the bbox. */
export function gridToLonLat(grid, x, y) {
  const { bbox, width, height } = grid;
  const dx = (bbox.maxLon - bbox.minLon) / width;
  const dy = (bbox.maxLat - bbox.minLat) / height;
  return [bbox.minLon + (x + 0.5) * dx, bbox.maxLat - (y + 0.5) * dy];
}

/** 1 for samples inside the boundary ring, else 0. */
export function boundaryMask(grid, ring) {
  const mask = new Uint8Array(grid.width * grid.height);
  for (let r = 0; r < grid.height; r++)
    for (let c = 0; c < grid.width; c++)
      mask[r * grid.width + c] = pointInRing(gridToLonLat(grid, c, r), ring)
        ? 1
        : 0;
  return mask;
}

export function createSiteContours(viewer, { boundary, fetchImpl } = {}) {
  if (!viewer?.scene)
    throw new TypeError('Site contours require a Cesium viewer');
  if (!boundary) throw new TypeError('Site contours require a site boundary');
  const scene = viewer.scene;
  const state = {
    intervalFt: CONTOUR_DEFAULTS.intervalFt,
    contoursOn: false,
    canopyOn: false,
    grid: null,
    gridKey: '',
    stats: null,
    canopyStats: null,
  };
  let contourPrimitives = [];
  let canopyPrimitive = null;
  let run = 0;
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => fn(describe()));

  function removeContours() {
    for (const p of contourPrimitives) scene.groundPrimitives.remove(p);
    contourPrimitives = [];
  }
  function removeCanopy() {
    if (canopyPrimitive) scene.groundPrimitives.remove(canopyPrimitive);
    canopyPrimitive = null;
  }

  async function loadGrid(site, signal) {
    const key = site.boundary.flat().join(',');
    if (state.grid && state.gridKey === key) return state.grid;
    const res = gridResolutionM(boundaryAreaM2(site.boundary));
    const grid = await fetchElevationGrid(site.bbox, res, {
      signal,
      fetchImpl,
    });
    grid.resM = res;
    grid.mask = boundaryMask(grid, site.boundary);
    state.grid = grid;
    state.gridKey = key;
    return grid;
  }

  function polylineInstances(grid, lines, index) {
    const instances = [];
    for (const line of lines) {
      if (line.index !== index) continue;
      const positions = Cesium.Cartesian3.fromDegreesArray(
        line.points.flatMap(([x, y]) => gridToLonLat(grid, x, y)),
      );
      if (positions.length < 2) continue;
      instances.push(
        new Cesium.GeometryInstance({
          geometry: new Cesium.GroundPolylineGeometry({
            positions,
            width: index ? 3 : 1.5,
          }),
        }),
      );
    }
    return instances;
  }

  /** Draw (or redraw) contours at the current interval. */
  async function showContours({ intervalFt } = {}) {
    if (intervalFt !== undefined)
      state.intervalFt = clampIntervalFt(intervalFt);
    const site = boundary.requireSite();
    const id = ++run;
    state.contoursOn = true;
    const grid = await loadGrid(site);
    if (id !== run) return describe();
    const result = buildContours(
      grid.values,
      grid.width,
      grid.height,
      state.intervalFt,
      {
        mask: grid.mask,
      },
    );
    removeContours();
    for (const index of [false, true]) {
      const instances = polylineInstances(grid, result.lines, index);
      if (!instances.length) continue;
      const primitive = new Cesium.GroundPolylinePrimitive({
        geometryInstances: instances,
        appearance: new Cesium.PolylineMaterialAppearance({
          material: Cesium.Material.fromType('Color', {
            color: Cesium.Color.fromCssColorString(
              index ? INDEX_CSS : MINOR_CSS,
            ).withAlpha(index ? 0.95 : 0.7),
          }),
        }),
        classificationType: Cesium.ClassificationType.BOTH,
        asynchronous: true,
      });
      scene.groundPrimitives.add(primitive);
      contourPrimitives.push(primitive);
    }
    state.stats = {
      lines: result.lines.length,
      levels: result.levels.length,
      minFt: result.range ? Math.round(result.range.min * 3.2808) : null,
      maxFt: result.range ? Math.round(result.range.max * 3.2808) : null,
      resM: grid.resM,
      cached: grid.cached,
    };
    governorRequestRender('site-contours');
    emit();
    return describe();
  }

  function hideContours() {
    run++;
    state.contoursOn = false;
    removeContours();
    governorRequestRender('site-contours');
    emit();
  }

  async function setContourInterval(intervalFt) {
    state.intervalFt = clampIntervalFt(intervalFt);
    if (state.contoursOn) return showContours();
    emit();
    return describe();
  }

  function hasPhotorealTiles() {
    for (let i = 0; i < scene.primitives.length; i++) {
      const p = scene.primitives.get(i);
      if (p instanceof Cesium.Cesium3DTileset && p.show) return true;
    }
    return false;
  }

  /**
   * Shade cells where the Google mesh is ≥ threshold above 3DEP ground.
   * @param {{ onProgress?: (done:number, total:number) => void }} [options]
   */
  async function showCanopy({
    thresholdM = CONTOUR_DEFAULTS.canopyThresholdM,
    onProgress = () => {},
  } = {}) {
    const site = boundary.requireSite();
    if (!hasPhotorealTiles())
      throw new Error('Canopy needs the Google 3D (photoreal) map source.');
    const grid = await loadGrid(site);
    await ensureGeoidReady();
    const area = boundaryAreaM2(site.boundary);
    const cellM = Math.max(
      CONTOUR_DEFAULTS.canopyCellM,
      Math.sqrt(area / MAX_CANOPY_SAMPLES),
    );
    const stride = Math.max(1, Math.round(cellM / grid.resM));
    const cells = [];
    for (let r = 0; r < grid.height; r += stride)
      for (let c = 0; c < grid.width; c += stride) {
        const i = r * grid.width + c;
        if (grid.mask[i] && Number.isFinite(grid.values[i]))
          cells.push([r, c, i]);
      }
    const cartos = cells.map(([r, c]) => {
      const [lon, lat] = gridToLonLat(grid, c, r);
      return Cesium.Cartographic.fromDegrees(lon, lat);
    });
    const surface = new Float64Array(cells.length).fill(Number.NaN);
    const BATCH = 400;
    for (let s = 0; s < cartos.length; s += BATCH) {
      const batch = cartos.slice(s, s + BATCH);
      try {
        const sampled = await scene.sampleHeightMostDetailed(batch);
        sampled.forEach((c, j) => (surface[s + j] = c?.height ?? Number.NaN));
      } catch {
        // leave NaN; those cells are simply not shaded
      }
      onProgress(Math.min(cartos.length, s + BATCH), cartos.length);
    }
    const dLon = ((grid.bbox.maxLon - grid.bbox.minLon) / grid.width) * stride;
    const dLat = ((grid.bbox.maxLat - grid.bbox.minLat) / grid.height) * stride;
    const instances = [];
    let covered = 0;
    let measured = 0;
    // Merge consecutive covered cells along each row into one rectangle.
    let strip = null; // { west, east, lat, row, lastCol }
    const flush = () => {
      if (!strip) return;
      instances.push(
        new Cesium.GeometryInstance({
          geometry: new Cesium.RectangleGeometry({
            rectangle: Cesium.Rectangle.fromDegrees(
              strip.west,
              strip.lat - dLat / 2,
              strip.east,
              strip.lat + dLat / 2,
            ),
          }),
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(
              Cesium.Color.fromCssColorString(CANOPY_CSS).withAlpha(0.32),
            ),
          },
        }),
      );
      strip = null;
    };
    cells.forEach(([r, c, i], j) => {
      const [lon, lat] = gridToLonLat(grid, c, r);
      const above = surface[j] - (grid.values[i] + geoidHeight(lat, lon));
      if (!Number.isFinite(above)) {
        flush();
        return;
      }
      measured++;
      if (above < thresholdM) {
        flush();
        return;
      }
      covered++;
      if (run && run.row === r && run.lastCol === c - stride) {
        run.east = lon + dLon / 2;
        run.lastCol = c;
      } else {
        flush();
        run = {
          west: lon - dLon / 2,
          east: lon + dLon / 2,
          lat,
          row: r,
          lastCol: c,
        };
      }
    });
    flush();
    removeCanopy();
    if (instances.length) {
      canopyPrimitive = new Cesium.GroundPrimitive({
        geometryInstances: instances,
        appearance: new Cesium.PerInstanceColorAppearance({
          flat: true,
          translucent: true,
        }),
        classificationType: Cesium.ClassificationType.BOTH,
        asynchronous: true,
      });
      scene.groundPrimitives.add(canopyPrimitive);
    }
    state.canopyOn = true;
    state.canopyStats = {
      cellM: Math.round(stride * grid.resM * 10) / 10,
      coveredPct: measured ? Math.round((covered / measured) * 100) : 0,
      measured,
    };
    governorRequestRender('site-canopy');
    emit();
    return describe();
  }

  function hideCanopy() {
    state.canopyOn = false;
    removeCanopy();
    governorRequestRender('site-canopy');
    emit();
  }

  function describe() {
    return {
      intervalFt: state.intervalFt,
      contoursOn: state.contoursOn,
      canopyOn: state.canopyOn,
      stats: state.stats,
      canopy: state.canopyStats,
    };
  }

  // A new or cleared boundary invalidates the grid and the overlays.
  const offBoundary = boundary.onChange(() => {
    state.grid = null;
    state.gridKey = '';
    const wasContours = state.contoursOn;
    removeContours();
    removeCanopy();
    state.canopyOn = false;
    if (wasContours && boundary.site) {
      showContours().catch((error) =>
        console.warn('[site-contours]', error.message),
      );
    } else {
      state.contoursOn = false;
      emit();
    }
  });

  return {
    describe,
    showContours,
    hideContours,
    setContourInterval,
    showCanopy,
    hideCanopy,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    destroy() {
      offBoundary();
      run++;
      removeContours();
      removeCanopy();
      listeners.clear();
    },
  };
}
