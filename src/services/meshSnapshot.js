/**
 * Heights of the Google 3D mesh over an area from one top-down render.
 *
 * scene.sampleHeightMostDetailed() loads the finest tiles under every point
 * and resolves a batch only when all of them are in, which took minutes for
 * a site. Here the camera looks straight down at the area once, the tiles
 * for that view load (seconds), and the depth buffer of a single frame gives
 * a 3D point for every screen pixel. Each point lands in its grid cell and
 * the highest one wins, so roofs and canopy block sight lines as before.
 *
 * Reads Cesium's pick-depth framebuffers in one readPixels per frustum
 * (scene.pickPosition does the same read one pixel at a time). That is
 * internal Cesium API, so meshSnapshotSupported() checks for it and callers
 * fall back to sampleHeightMostDetailed() when it is missing.
 */
import * as Cesium from 'cesium';
import { surfaceGrid } from './viewshedMath.js';

const UNPACK = [1, 1 / 255, 1 / 65025, 1 / 16581375];

export function meshSnapshotSupported(scene) {
  return Boolean(
    scene?.pickPositionSupported &&
    scene.useDepthPicking !== false &&
    typeof scene._picking?.getPickDepth === 'function' &&
    scene.defaultView?.frustumCommandsList &&
    typeof Cesium.SceneTransforms?.drawingBufferToWorldCoordinates ===
      'function',
  );
}

const frame = () =>
  new Promise((resolve) =>
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(() => resolve())
      : setTimeout(resolve, 16),
  );

function tilesets(scene) {
  const list = [];
  for (let i = 0; i < scene.primitives.length; i++) {
    const p = scene.primitives.get(i);
    if (p instanceof Cesium.Cesium3DTileset && p.show) list.push(p);
  }
  return list;
}

/**
 * Wait until the visible tilesets have every tile for the
 * current view, or `timeoutMs` passes; whatever is loaded by then is used.
 */
async function waitForTiles(scene, sets, { timeoutMs, say }) {
  const t0 = performance.now();
  let pending = 0;
  const offs = sets.map((t) =>
    t.loadProgress.addEventListener((requests, processing) => {
      pending = requests + processing;
    }),
  );
  try {
    let settled = 0;
    for (let n = 0; ; n++) {
      scene.requestRender();
      await frame();
      const done = n >= 3 && sets.every((t) => t.tilesLoaded);
      settled = done ? settled + 1 : 0;
      if (settled >= 2) return true;
      const ms = performance.now() - t0;
      if (ms > timeoutMs) return false;
      say?.(
        `Loading 3D tiles for a top-down height snapshot… ${pending ? `${pending} tiles to go, ` : ''}${(ms / 1000).toFixed(1)} s`,
      );
    }
  } finally {
    offs.forEach((off) => off());
  }
}

/** World points for the last rendered frame, about `want` of them. */
function readDepthPoints(scene, want) {
  const { context, frameState, camera, defaultView } = scene;
  const { uniformState } = context;
  const W = scene.drawingBufferWidth;
  const H = scene.drawingBufferHeight;
  const stride = Math.max(1, Math.floor(Math.sqrt((W * H) / want)));
  scene.view = defaultView;
  scene.updateFrameState();
  uniformState.update(frameState);
  const frustum = camera.frustum.clone();
  const ellipsoid = scene.globe?.ellipsoid ?? Cesium.Ellipsoid.WGS84;
  const pos = new Cesium.Cartesian2();
  const world = new Cesium.Cartesian3();
  const carto = new Cesium.Cartographic();
  const taken = new Uint8Array(Math.ceil(W / stride) * Math.ceil(H / stride));
  const cols = Math.ceil(W / stride);
  const out = [];
  const lists = defaultView.frustumCommandsList;
  for (let f = 0; f < lists.length; f++) {
    const fb = scene._picking.getPickDepth(scene, f).framebuffer;
    if (!fb) continue;
    const px = context.readPixels({
      x: 0,
      y: 0,
      width: W,
      height: H,
      framebuffer: fb,
    });
    frustum.near =
      lists[f].near * (f !== 0 ? scene.opaqueFrustumNearOffset : 1);
    frustum.far = lists[f].far;
    uniformState.updateFrustum(frustum);
    for (let y = 0; y < H; y += stride)
      for (let x = 0; x < W; x += stride) {
        const slot = (y / stride) * cols + x / stride;
        if (taken[slot]) continue; // a nearer frustum already has this pixel
        const k = (y * W + x) * 4;
        const depth =
          (px[k] * UNPACK[0] +
            px[k + 1] * UNPACK[1] +
            px[k + 2] * UNPACK[2] +
            px[k + 3] * UNPACK[3]) /
          255;
        if (!(depth > 0 && depth < 1)) continue;
        pos.x = x;
        pos.y = y;
        Cesium.SceneTransforms.drawingBufferToWorldCoordinates(
          scene,
          pos,
          depth,
          world,
        );
        if (!Cesium.Cartographic.fromCartesian(world, ellipsoid, carto))
          continue;
        taken[slot] = 1;
        out.push(
          Cesium.Math.toDegrees(carto.longitude),
          Cesium.Math.toDegrees(carto.latitude),
          carto.height,
        );
      }
  }
  return out;
}

/**
 * Fill `grid.values` (north-up lon/lat grid over `grid.bbox`) with mesh
 * surface heights. Moves the camera for the snapshot and puts it back.
 * @param {{ say?: (text: string) => void, timeoutMs?: number }} [options]
 */
export async function captureMeshHeights(
  viewer,
  grid,
  { say, timeoutMs = 15_000 } = {},
) {
  const scene = viewer.scene;
  if (!meshSnapshotSupported(scene))
    throw new Error('depth snapshots are not supported here');
  const sets = tilesets(scene);
  if (!sets.length) throw new Error('needs the Google 3D map source');
  const camera = scene.camera;
  const saved = {
    destination: camera.positionWC.clone(),
    orientation: {
      direction: camera.directionWC.clone(),
      up: camera.upWC.clone(),
    },
  };
  // Everything that is not the mesh (markers, highlights, outlines) stays
  // out of the depth buffer for the snapshot frame.
  const hidden = [];
  for (let i = 0; i < scene.primitives.length; i++) {
    const p = scene.primitives.get(i);
    if (!(p instanceof Cesium.Cesium3DTileset) && p.show) {
      p.show = false;
      hidden.push(p);
    }
  }
  const { bbox } = grid;
  const padLon = (bbox.maxLon - bbox.minLon) * 0.04;
  const padLat = (bbox.maxLat - bbox.minLat) * 0.04;
  try {
    say?.('Looking straight down at the area for a 3D mesh snapshot…');
    camera.setView({
      destination: Cesium.Rectangle.fromDegrees(
        bbox.minLon - padLon,
        bbox.minLat - padLat,
        bbox.maxLon + padLon,
        bbox.maxLat + padLat,
      ),
      orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
    });
    const complete = await waitForTiles(scene, sets, { timeoutMs, say });
    say?.('Reading mesh heights from the depth buffer…');
    scene.requestRender(); // render even in requestRenderMode
    if (typeof viewer.render === 'function') viewer.render();
    else scene.render();
    const points = readDepthPoints(scene, grid.width * grid.height * 4);
    const { values, hits } = surfaceGrid(points, bbox, grid.width, grid.height);
    if (!hits) throw new Error('the snapshot saw no mesh');
    grid.values = values;
    grid.complete = complete;
    return grid;
  } finally {
    for (const p of hidden) p.show = true;
    camera.setView(saved);
    scene.requestRender();
  }
}
