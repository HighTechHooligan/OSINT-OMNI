/**
 * Site orbit: load a survey boundary (KML/KMZ or preset), drape it on the
 * globe, fly to it, orbit it, and record the orbit as a looping GIF.
 *
 * Runs without any AI attached. The Features Code console drives it today;
 * the same methods are the tool surface a local agent can call later.
 */
import * as Cesium from 'cesium';
import {
  governorRequestRender,
  holdContinuousRender,
  releaseContinuousRender,
} from '../renderGovernor.js';

export const SITE_PRESETS = Object.freeze({
  hyland: Object.freeze({
    name: 'Hyland Hills LiDAR · 8800 Chalet Rd, Bloomington MN',
    boundary: Object.freeze([
      [-93.3676942, 44.84030533],
      [-93.36703429, 44.83986795],
      [-93.36652921, 44.83985231],
      [-93.36585962, 44.84027806],
      [-93.36519303, 44.84027127],
      [-93.36456583, 44.84074493],
      [-93.36444377, 44.84152465],
      [-93.36420866, 44.84185081],
      [-93.36387822, 44.84226525],
      [-93.36352726, 44.84261533],
      [-93.36332711, 44.84267214],
      [-93.36287246, 44.84288384],
      [-93.36251648, 44.84314293],
      [-93.36320968, 44.84575812],
      [-93.36373801, 44.84680325],
      [-93.36573552, 44.8468794],
      [-93.3676942, 44.84030533],
    ]),
    points: Object.freeze([
      ['GCP01', -93.36662, 44.8402],
      ['GCP02', -93.3661, 44.84355],
      ['GCP03', -93.36542, 44.84578],
      ['GCP04', -93.36361, 44.84606],
      ['GCP05', -93.36333, 44.84464],
      ['GCP06', -93.36431, 44.84205],
    ]),
  }),
});

export const ORBIT_DEFAULTS = Object.freeze({
  frames: 144, // 2.5° per frame: smooth full revolution
  delayMs: 40, // 144 × 40 ms ≈ 5.8 s loop
  width: 800,
  height: 450,
  pitchDeg: -35,
  secondsPerRev: 24,
  rangeFactor: 2.6, // camera range = site radius × factor
});

const BOUNDARY_CSS = '#FFB000';
const POINT_CSS = '#DC143C';
const RENDER_HOLD = 'site-orbit';
const EARTH_RADIUS_M = 6_371_008.8;

/** Great-circle distance in metres between two [lon, lat] degree pairs. */
export function haversineMeters([lon1, lat1], [lon2, lat2]) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Close a ring, drop invalid vertices, and require at least three corners. */
export function normalizeBoundary(boundary) {
  if (!Array.isArray(boundary))
    throw new TypeError('Boundary must be an array');
  const ring = boundary
    .map((p) => [Number(p?.[0]), Number(p?.[1])])
    .filter(
      ([lon, lat]) =>
        Number.isFinite(lon) &&
        Number.isFinite(lat) &&
        Math.abs(lon) <= 180 &&
        Math.abs(lat) <= 90,
    );
  if (ring.length < 3)
    throw new Error('Boundary needs at least 3 valid points');
  const [first, last] = [ring[0], ring.at(-1)];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([...first]);
  return ring;
}

/** Bounding-box centre and the furthest vertex distance from it. */
export function summarizeBoundary(boundary) {
  const lons = boundary.map((p) => p[0]);
  const lats = boundary.map((p) => p[1]);
  const center = {
    lon: (Math.min(...lons) + Math.max(...lons)) / 2,
    lat: (Math.min(...lats) + Math.max(...lats)) / 2,
  };
  let radiusM = 0;
  for (const p of boundary) {
    radiusM = Math.max(radiusM, haversineMeters([center.lon, center.lat], p));
  }
  return { center, radiusM: Math.max(radiusM, 50) };
}

/** Build a GIF file name from a site name. */
export function orbitFileName(siteName) {
  const stem = String(siteName || 'site')
    .split(/[·—]/)[0]
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${stem || 'site'}_orbit.gif`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Load the GIF encoder only when a recording starts (ESM or CJS build). */
async function loadGifEncoder() {
  const mod = await import('gifenc');
  const api = mod.GIFEncoder ? mod : mod.default;
  if (typeof api?.GIFEncoder !== 'function')
    throw new Error('GIF encoder failed to load');
  return api;
}

/**
 * @param {Cesium.Viewer} viewer
 * @param {{ beforeCameraControl?: () => void }} [options]
 *   beforeCameraControl stops other camera owners (e.g. the O-key orbit).
 */
export function createSiteOrbit(viewer, { beforeCameraControl } = {}) {
  if (!viewer?.scene)
    throw new TypeError('Site orbit requires a Cesium viewer');
  const scene = viewer.scene;
  let site = null;
  let entities = [];
  let labelLayer = null;
  let removeLabelListener = null;
  let spin = null;
  let recording = false;

  // ---------- heights ----------
  async function sampleHeights(lonLats) {
    const cartos = lonLats.map(([lon, lat]) =>
      Cesium.Cartographic.fromDegrees(lon, lat),
    );
    try {
      const sampled = await scene.sampleHeightMostDetailed(cartos);
      if (sampled.every((c) => Number.isFinite(c?.height)))
        return sampled.map((c) => c.height);
    } catch {
      // No 3D tiles or sampling unsupported: fall back to the globe.
    }
    return cartos.map((c) => {
      const h = scene.globe?.getHeight?.(c);
      return Number.isFinite(h) ? h : 0;
    });
  }

  // ---------- drawing ----------
  function removeDrawing() {
    for (const entity of entities) viewer.entities.remove(entity);
    entities = [];
    removeLabelListener?.();
    removeLabelListener = null;
    labelLayer?.remove();
    labelLayer = null;
  }

  function drawLabels() {
    if (!site.points.length) return;
    labelLayer = document.createElement('div');
    labelLayer.className = 'site-orbit-labels';
    labelLayer.setAttribute('aria-hidden', 'true');
    const nodes = site.points.map(([id]) => {
      const el = document.createElement('span');
      el.className = 'site-orbit-label';
      el.textContent = id;
      labelLayer.appendChild(el);
      return el;
    });
    (viewer.container || document.body).appendChild(labelLayer);
    const scratch = new Cesium.Cartesian2();
    removeLabelListener = scene.postRender.addEventListener(() => {
      site.pointPositions.forEach((position, i) => {
        const win = projectToWindow(position, scratch);
        const el = nodes[i];
        if (!win) {
          el.hidden = true;
          return;
        }
        el.hidden = false;
        el.style.transform = `translate(${win.x}px, ${win.y - 26}px) translateX(-50%)`;
      });
    });
  }

  function projectToWindow(position, result) {
    const fn =
      Cesium.SceneTransforms.worldToWindowCoordinates ??
      Cesium.SceneTransforms.wgs84ToWindowCoordinates;
    const win = fn?.(scene, position, result);
    return win && Number.isFinite(win.x) && Number.isFinite(win.y) ? win : null;
  }

  function draw() {
    removeDrawing();
    entities.push(
      viewer.entities.add({
        name: `${site.name} boundary`,
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(site.boundary.flat()),
          width: 5,
          clampToGround: true, // drapes on terrain and on 3D Tiles
          material: Cesium.Color.fromCssColorString(BOUNDARY_CSS),
        },
      }),
    );
    for (const position of site.pointPositions) {
      entities.push(
        viewer.entities.add({
          position,
          point: {
            pixelSize: 14,
            color: Cesium.Color.fromCssColorString(POINT_CSS),
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 3,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        }),
      );
    }
    drawLabels();
    governorRequestRender('site-orbit-draw');
  }

  async function setSite({ name = 'Site', boundary, points = [] }) {
    const ring = normalizeBoundary(boundary);
    const pts = points
      .map(([id, lon, lat]) => [String(id), Number(lon), Number(lat)])
      .filter(([, lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
    const summary = summarizeBoundary(ring);
    const heights = await sampleHeights([
      [summary.center.lon, summary.center.lat],
      ...pts.map(([, lon, lat]) => [lon, lat]),
    ]);
    site = {
      name,
      boundary: ring,
      points: pts,
      ...summary,
      groundM: heights[0],
      pointPositions: pts.map(([, lon, lat], i) =>
        Cesium.Cartesian3.fromDegrees(lon, lat, heights[i + 1] + 1),
      ),
    };
    draw();
    return describe();
  }

  function describe() {
    if (!site) return null;
    return {
      name: site.name,
      vertices: site.boundary.length - 1,
      points: site.points.length,
      acrossM: Math.round(site.radiusM * 2),
      center: { ...site.center },
    };
  }

  // ---------- inputs ----------
  async function loadKml(source, name) {
    const ds = await Cesium.KmlDataSource.load(source, {
      camera: scene.camera,
      canvas: scene.canvas,
      clampToGround: true,
    });
    const now = viewer.clock.currentTime;
    const toLonLat = (cartesian) => {
      const c = Cesium.Cartographic.fromCartesian(cartesian);
      return [
        Cesium.Math.toDegrees(c.longitude),
        Cesium.Math.toDegrees(c.latitude),
      ];
    };
    let ring = null;
    let foundName = name;
    const points = [];
    for (const entity of ds.entities.values) {
      if (!ring && entity.polygon) {
        ring = entity.polygon.hierarchy?.getValue(now)?.positions;
        foundName ||= entity.name;
      } else if (!ring && entity.polyline) {
        ring = entity.polyline.positions?.getValue(now);
        foundName ||= entity.name;
      } else if (entity.position && !entity.polygon && !entity.polyline) {
        const p = entity.position.getValue(now);
        if (p)
          points.push([entity.name || `P${points.length + 1}`, ...toLonLat(p)]);
      }
    }
    if (!ring?.length) throw new Error('No polygon or line found in that file');
    return setSite({
      name: foundName || 'KML site',
      boundary: ring.map(toLonLat),
      points,
    });
  }

  function loadPreset(key = 'hyland') {
    const preset = SITE_PRESETS[String(key).toLowerCase()];
    if (!preset) {
      throw new Error(
        `Unknown preset "${key}". Available: ${Object.keys(SITE_PRESETS).join(', ')}`,
      );
    }
    return setSite(preset);
  }

  // ---------- camera ----------
  function requireSite() {
    if (!site)
      throw new Error('No site loaded. Run "preset hyland" or "load" first.');
  }

  const targetCartesian = () =>
    Cesium.Cartesian3.fromDegrees(
      site.center.lon,
      site.center.lat,
      site.groundM,
    );
  const autoRange = () => site.radiusM * ORBIT_DEFAULTS.rangeFactor;

  function takeCamera() {
    stop();
    beforeCameraControl?.();
  }

  function zoom({ pitchDeg = -45, durationS = 2.5 } = {}) {
    requireSite();
    takeCamera();
    return new Promise((resolve) => {
      viewer.camera.flyToBoundingSphere(
        new Cesium.BoundingSphere(targetCartesian(), site.radiusM),
        {
          offset: new Cesium.HeadingPitchRange(
            0,
            Cesium.Math.toRadians(pitchDeg),
            autoRange(),
          ),
          duration: durationS,
          complete: resolve,
          cancel: resolve,
        },
      );
    });
  }

  function orbit({
    secondsPerRev = ORBIT_DEFAULTS.secondsPerRev,
    pitchDeg = ORBIT_DEFAULTS.pitchDeg,
    rangeM,
  } = {}) {
    requireSite();
    takeCamera();
    const target = targetCartesian();
    const range = rangeM ?? autoRange();
    const pitch = Cesium.Math.toRadians(pitchDeg);
    const rate = Cesium.Math.TWO_PI / Math.max(2, secondsPerRev);
    let heading = viewer.camera.heading;
    let last = performance.now();
    holdContinuousRender(RENDER_HOLD);
    const remove = scene.preRender.addEventListener(() => {
      const now = performance.now();
      heading += rate * ((now - last) / 1000);
      last = now;
      viewer.camera.lookAt(
        target,
        new Cesium.HeadingPitchRange(heading, pitch, range),
      );
    });
    spin = { remove };
  }

  function stop() {
    if (spin) {
      spin.remove();
      spin = null;
      releaseContinuousRender(RENDER_HOLD);
    }
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  }

  // ---------- recording ----------
  function findTilesets() {
    const found = [];
    const walk = (collection) => {
      for (let i = 0; i < collection.length; i++) {
        const p = collection.get(i);
        if (p instanceof Cesium.Cesium3DTileset) found.push(p);
        else if (
          p &&
          typeof p.length === 'number' &&
          typeof p.get === 'function'
        )
          walk(p);
      }
    };
    walk(scene.primitives);
    return found;
  }

  async function settleTiles(tilesets, maxMs = 6000) {
    const start = performance.now();
    while (performance.now() - start < maxMs) {
      scene.render();
      const tilesReady = tilesets.every((t) => t.tilesLoaded);
      if (tilesReady && scene.globe.tilesLoaded !== false) return;
      await sleep(40);
    }
  }

  function paintFrame(ctx, width, height, title, headingDeg) {
    const src = scene.canvas;
    const aspect = width / height;
    let sw = src.width;
    let sh = sw / aspect;
    if (sh > src.height) {
      sh = src.height;
      sw = sh * aspect;
    }
    const sx = (src.width - sw) / 2;
    const sy = (src.height - sh) / 2;
    ctx.drawImage(src, sx, sy, sw, sh, 0, 0, width, height);

    // GCP labels (Cesium labels are not used in this app; paint them here)
    const scale = width / sw;
    const scratch = new Cesium.Cartesian2();
    ctx.font = `bold ${Math.round(height * 0.032)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#000';
    ctx.fillStyle = '#fff';
    const pixelRatio = src.width / (src.clientWidth || src.width);
    site.pointPositions.forEach((position, i) => {
      const win = projectToWindow(position, scratch);
      if (!win) return;
      const x = (win.x * pixelRatio - sx) * scale;
      const y = (win.y * pixelRatio - sy) * scale - height * 0.04;
      if (x < 0 || x > width || y < 0 || y > height) return;
      ctx.strokeText(site.points[i][0], x, y);
      ctx.fillText(site.points[i][0], x, y);
    });
    ctx.textAlign = 'left';

    const pad = Math.round(width * 0.02);
    ctx.fillStyle = 'rgba(9, 18, 27, 0.78)';
    ctx.fillRect(pad, pad, Math.round(width * 0.64), Math.round(height * 0.13));
    ctx.fillStyle = BOUNDARY_CSS;
    ctx.font = `bold ${Math.round(height * 0.045)}px sans-serif`;
    ctx.fillText(title, pad * 2, pad + height * 0.055, width * 0.6);
    ctx.fillStyle = '#E8EAED';
    ctx.font = `${Math.round(height * 0.03)}px sans-serif`;
    ctx.fillText(site.name, pad * 2, pad + height * 0.1, width * 0.6);

    ctx.font = `${Math.round(height * 0.026)}px sans-serif`;
    ctx.fillText(
      `HDG ${String(Math.round(headingDeg) % 360).padStart(3, '0')}°`,
      pad * 2,
      height - Math.round(height * 0.025),
    );
    // Provider attribution travels with every captured frame.
    const credit = 'Map data ©Google';
    const cw = ctx.measureText(credit).width + pad;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(
      width - cw - pad / 2,
      height - Math.round(height * 0.06),
      cw,
      Math.round(height * 0.06),
    );
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(credit, width - cw, height - Math.round(height * 0.018));
  }

  function saveBytes(bytes, filename) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/gif' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async function record({
    frames = ORBIT_DEFAULTS.frames,
    width = ORBIT_DEFAULTS.width,
    height = ORBIT_DEFAULTS.height,
    delayMs = ORBIT_DEFAULTS.delayMs,
    pitchDeg = ORBIT_DEFAULTS.pitchDeg,
    rangeM,
    title = 'SITE ORBIT',
    filename,
    onProgress = () => {},
    signal,
  } = {}) {
    requireSite();
    if (recording) throw new Error('A recording is already running');
    const { GIFEncoder, applyPalette, quantize } = await loadGifEncoder();
    recording = true;
    takeCamera();
    holdContinuousRender(RENDER_HOLD);
    const tilesets = findTilesets();
    const target = targetCartesian();
    const range = rangeM ?? autoRange();
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const gif = GIFEncoder();
    try {
      for (let i = 0; i < frames; i++) {
        signal?.throwIfAborted();
        const headingDeg = (360 / frames) * i;
        viewer.camera.lookAt(
          target,
          new Cesium.HeadingPitchRange(
            Cesium.Math.toRadians(headingDeg),
            Cesium.Math.toRadians(pitchDeg),
            range,
          ),
        );
        await settleTiles(tilesets);
        scene.render(); // copy the canvas in the same task as the render
        paintFrame(ctx, width, height, title, headingDeg);
        const { data } = ctx.getImageData(0, 0, width, height);
        const palette = quantize(data, 256);
        gif.writeFrame(applyPalette(data, palette), width, height, {
          palette,
          delay: delayMs,
        });
        onProgress(i + 1, frames);
      }
      gif.finish();
      const name = filename || orbitFileName(site.name);
      saveBytes(gif.bytes(), name);
      return name;
    } finally {
      viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      releaseContinuousRender(RENDER_HOLD);
      recording = false;
    }
  }

  function clear() {
    stop();
    removeDrawing();
    site = null;
    governorRequestRender('site-orbit-clear');
  }

  return {
    describe,
    loadKml,
    loadPreset,
    setSite,
    zoom,
    orbit,
    stop,
    record,
    clear,
    destroy: clear,
    get isOrbiting() {
      return Boolean(spin);
    },
    get isRecording() {
      return recording;
    },
  };
}
