/**
 * Site orbit: fly to the site boundary, orbit it, and record the orbit as a
 * looping GIF. The boundary itself (draw / import / presets) lives in
 * siteBoundary.js; this service only drives the camera and the recorder.
 */
import * as Cesium from 'cesium';
import {
  holdContinuousRender,
  releaseContinuousRender,
} from '../renderGovernor.js';
import { orbitFileName } from './siteGeometry.js';
import { projectToWindow } from './siteBoundary.js';

export {
  haversineMeters,
  normalizeBoundary,
  orbitFileName,
  summarizeBoundary,
} from './siteGeometry.js';
export { SITE_PRESETS } from './siteBoundary.js';

export const ORBIT_DEFAULTS = Object.freeze({
  frames: 144, // 2.5° per frame: smooth full revolution
  delayMs: 40, // 144 × 40 ms ≈ 5.8 s loop
  width: 800,
  height: 450,
  pitchDeg: -35,
  secondsPerRev: 24,
  rangeFactor: 2.6, // camera range = site radius × factor
});

const TITLE_CSS = '#E8365D';
const RENDER_HOLD = 'site-orbit';
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
 * @param {{ boundary: ReturnType<import('./siteBoundary.js').createSiteBoundary>,
 *   beforeCameraControl?: () => void }} options
 *   beforeCameraControl stops other camera owners (e.g. the O-key orbit).
 */
export function createSiteOrbit(
  viewer,
  { boundary, beforeCameraControl } = {},
) {
  if (!viewer?.scene)
    throw new TypeError('Site orbit requires a Cesium viewer');
  if (!boundary) throw new TypeError('Site orbit requires a site boundary');
  const scene = viewer.scene;
  let spin = null;
  let recording = false;
  let site = null;
  const requireSite = () => {
    site = boundary.requireSite();
    return site;
  };

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
      const win = projectToWindow(scene, position, scratch);
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
    ctx.fillStyle = TITLE_CSS;
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

  return {
    zoom,
    orbit,
    stop,
    record,
    destroy: stop,
    get isOrbiting() {
      return Boolean(spin);
    },
    get isRecording() {
      return recording;
    },
  };
}
