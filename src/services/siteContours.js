/**
 * Site contours + canopy overlay, drawn only inside the site boundary.
 *
 * Contours: USGS 3DEP bare earth (via /api/elevation/3dep, keyless, cached to
 * disk on the server) → marching squares at a 2–100 ft interval → ground-
 * clamped polylines that drape over terrain and Google 3D Tiles. Every 5th
 * line is a heavier index contour.
 *
 * Placement: 3DEP lon/lats are NAD83, so every sample is shifted onto WGS84
 * (datum.js). With the Google 3D mesh on, the remaining offset between the
 * DEM and the mesh is measured at the site (meshAlign.js) and applied too.
 *
 * Canopy: where the Google photorealistic mesh stands well above the 3DEP
 * ground (trees, structures), the cell is shaded green so you can see which
 * contours run under cover. Requires the photoreal map source.
 */
import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import { ensureGeoidReady, geoidHeight } from '../data/geoid.js';
import { buildContours, clampIntervalFt } from './contourMath.js';
import { nad83ShiftAt } from './datum.js';
import { estimateMeshOffset } from './meshAlign.js';
import { boundaryAreaM2, pointInRing } from './siteGeometry.js';

export const CONTOUR_DEFAULTS = Object.freeze({
  intervalFt: 10,
  canopyThresholdM: 2.5,
  canopyCellM: 4,
  autoAlign: true,
  alignSamples: 1500,
});

const M_PER_DEG_LAT = 111_320;

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
  const datum = response.headers.get('X-Grid-Datum') || 'NAD83';
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
    datum,
    cached: response.headers.get('X-Cache') === 'HIT',
  };
}

/**
 * Datum shift (degrees) for a grid: NAD83 → WGS84 at the grid centre, or
 * zero for grids already in WGS84.
 */
export function gridDatumShift(grid, epoch) {
  if (grid.datum && !/^NAD83/i.test(grid.datum))
    return { dLon: 0, dLat: 0, eastM: 0, northM: 0 };
  const lon = (grid.bbox.minLon + grid.bbox.maxLon) / 2;
  const lat = (grid.bbox.minLat + grid.bbox.maxLat) / 2;
  return nad83ShiftAt(lon, lat, epoch);
}

/** Metres per grid column (east) and row (south) at the grid centre. */
export function gridPixelMetres(grid) {
  const { bbox, width, height } = grid;
  const midLat = ((bbox.minLat + bbox.maxLat) / 2) * (Math.PI / 180);
  return {
    pxEastM:
      ((bbox.maxLon - bbox.minLon) / width) * M_PER_DEG_LAT * Math.cos(midLat),
    pxSouthM: ((bbox.maxLat - bbox.minLat) / height) * M_PER_DEG_LAT,
  };
}

/**
 * Grid (col,row) → WGS84 lon/lat. Samples are pixel centres across the
 * bbox, moved by the grid's datum shift and any measured mesh alignment
 * (`grid.shift` / `grid.align`, both optional).
 */
export function gridToLonLat(grid, x, y) {
  const { bbox, width, height } = grid;
  const dx = (bbox.maxLon - bbox.minLon) / width;
  const dy = (bbox.maxLat - bbox.minLat) / height;
  let lon = bbox.minLon + (x + 0.5) * dx;
  let lat = bbox.maxLat - (y + 0.5) * dy;
  if (grid.shift) {
    lon += grid.shift.dLon;
    lat += grid.shift.dLat;
  }
  if (grid.align?.ok) {
    const midLat = ((bbox.minLat + bbox.maxLat) / 2) * (Math.PI / 180);
    lon += grid.align.eastM / (M_PER_DEG_LAT * Math.cos(midLat));
    lat += grid.align.northM / M_PER_DEG_LAT;
  }
  return [lon, lat];
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

export function createSiteContours(
  viewer,
  { boundary, fetchImpl, autoAlign = CONTOUR_DEFAULTS.autoAlign } = {},
) {
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
    autoAlign,
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
    grid.shift = gridDatumShift(grid);
    grid.align = null;
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

  /**
   * Measure the DEM↔mesh offset once per grid by sampling the Google mesh
   * inside the boundary. Never throws; a failed or unclear measurement
   * leaves grid.align.ok false and contours stay at the datum-corrected
   * position.
   */
  function measureAlignment(grid) {
    if (!grid.alignPromise && hasPhotorealTiles())
      grid.alignPromise = sampleAlignment(grid);
    return grid.alignPromise ?? Promise.resolve(null);
  }

  async function sampleAlignment(grid) {
    grid.align = { ok: false, pending: true, eastM: 0, northM: 0 };
    const inside = [];
    for (let i = 0; i < grid.mask.length; i++)
      if (grid.mask[i] && Number.isFinite(grid.values[i])) inside.push(i);
    const stride = Math.max(
      1,
      Math.floor(inside.length / CONTOUR_DEFAULTS.alignSamples),
    );
    const points = [];
    for (let k = 0; k < inside.length; k += stride) {
      const i = inside[k];
      points.push({ x: i % grid.width, y: Math.floor(i / grid.width) });
    }
    const cartos = points.map(({ x, y }) => {
      const [lon, lat] = gridToLonLat(grid, x, y);
      return Cesium.Cartographic.fromDegrees(lon, lat);
    });
    let result;
    try {
      const sampled = await scene.sampleHeightMostDetailed(cartos);
      const samples = points.map((p, j) => ({
        ...p,
        h: sampled[j]?.height ?? Number.NaN,
      }));
      result = estimateMeshOffset(
        { ...gridPixelMetres(grid), ...grid },
        samples,
      );
    } catch (error) {
      result = {
        ok: false,
        eastM: 0,
        northM: 0,
        reason: error?.message || 'mesh sampling failed',
      };
    }
    if (!state.autoAlign) {
      grid.align = null;
      return null;
    }
    grid.align = result;
    return result;
  }

  function drawContours(grid) {
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
      datumShiftM: grid.shift
        ? Math.round(Math.hypot(grid.shift.eastM, grid.shift.northM) * 10) / 10
        : 0,
      align: grid.align?.pending
        ? { pending: true }
        : grid.align
          ? {
              ok: grid.align.ok,
              eastM: grid.align.eastM,
              northM: grid.align.northM,
              reason: grid.align.reason,
            }
          : null,
    };
    governorRequestRender('site-contours');
    emit();
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
    // Draw first, then refine: the user sees contours immediately and they
    // settle onto the mesh once it has been sampled.
    const settled = grid.align && !grid.align.pending;
    const aligning =
      state.autoAlign && !settled ? measureAlignment(grid) : null;
    drawContours(grid);
    aligning?.then((align) => {
      if (!align || id !== run || state.grid !== grid || !state.contoursOn)
        return;
      drawContours(grid);
    });
    return describe();
  }

  /** Turn mesh alignment on/off (it is measured per site, never hand-set). */
  async function setAutoAlign(on) {
    state.autoAlign = Boolean(on);
    if (state.grid && !state.autoAlign) {
      state.grid.align = null;
      state.grid.alignPromise = null;
    }
    if (state.contoursOn) return showContours();
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
      if (strip && strip.row === r && strip.lastCol === c - stride) {
        strip.east = lon + dLon / 2;
        strip.lastCol = c;
      } else {
        flush();
        strip = {
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
      autoAlign: state.autoAlign,
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
    setAutoAlign,
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
