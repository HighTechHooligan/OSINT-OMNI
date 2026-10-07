/**
 * Site boundary: the one polygon the site features (orbit, contours, canopy)
 * work inside. A boundary is either DRAWN on the globe or IMPORTED from a
 * KML/KMZ (or a preset), and can be exported back to KML.
 *
 * ── AI integration note ──────────────────────────────────────────────────
 * When the local agent is wired in, it should call this service's existing
 * methods (`setSite`, `loadKml`, `startDraw`, `describe`, `toKml`) as tools,
 * and it can PLACE GCPs AS IS: GCPs are the boundary's `points`
 * ([id, lon, lat]), so an agent proposal is just `setPoints([...])`. The
 * suggested placement rules are already written out in the DJI LIDAR L2+ORTHO
 * doc: ~6 targets spread around the edges plus one central, on flat, open,
 * hard or low-cover ground with clear sky, kept 50+ ft from check shots.
 * Agent-placed points must be labelled as suggestions (hypothesis tier) until
 * a person confirms them on the ground.
 */
import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import { claimPointer, releasePointer } from '../data/inputOwnership.js';
import {
  boundaryAreaM2,
  boundaryBbox,
  FEET_PER_METRE,
  normalizeBoundary,
  siteToKml,
  slug,
  summarizeBoundary,
} from './siteGeometry.js';
import {
  circleRing,
  looksLikeKml,
  measureSegment,
  outlineRing,
  parseCoordinateList,
  snapVertex,
  wrapKml,
} from './surveyGeometry.js';

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

const BOUNDARY_CSS = '#FFB000';
const DRAW_CSS = '#B347F0';
const POINT_CSS = '#E8365D';
const POINTER_OWNER = 'site-boundary';

/** Window position of a world point, or null when off-screen/behind. */
export function projectToWindow(scene, position, result) {
  const fn =
    Cesium.SceneTransforms.worldToWindowCoordinates ??
    Cesium.SceneTransforms.wgs84ToWindowCoordinates;
  const win = fn?.(scene, position, result);
  return win && Number.isFinite(win.x) && Number.isFinite(win.y) ? win : null;
}

export function createSiteBoundary(viewer) {
  if (!viewer?.scene)
    throw new TypeError('Site boundary requires a Cesium viewer');
  const scene = viewer.scene;
  const listeners = new Set();
  let site = null;
  let entities = [];
  let labelLayer = null;
  let removeLabelListener = null;
  let draw = null;
  let snapDeg = 15;

  const emit = (reason) => {
    for (const fn of listeners) {
      try {
        fn(reason, describe());
      } catch (error) {
        console.warn('[site-boundary] listener failed', error);
      }
    }
  };

  // ---------- heights ----------
  function hasVisibleTileset() {
    for (let i = 0; i < scene.primitives.length; i++) {
      const p = scene.primitives.get(i);
      if (p instanceof Cesium.Cesium3DTileset && p.show) return true;
    }
    return false;
  }

  async function sampleHeights(lonLats) {
    const cartos = lonLats.map(([lon, lat]) =>
      Cesium.Cartographic.fromDegrees(lon, lat),
    );
    // Only sample the scene when a 3D tileset is showing; on a flat basemap
    // a bogus height put the site zoom camera underground.
    if (hasVisibleTileset())
      try {
        const sampled = await scene.sampleHeightMostDetailed(cartos);
        if (sampled.every((c) => Number.isFinite(c?.height)))
          return sampled.map((c) => c.height);
      } catch {
        // sampling unsupported: fall back to terrain
      }
    // Flat ellipsoid terrain: the ground is height 0 (globe.getHeight has
    // been seen returning -410 m here).
    if (viewer.terrainProvider instanceof Cesium.EllipsoidTerrainProvider)
      return cartos.map(() => 0);
    try {
      const sampled = await Cesium.sampleTerrainMostDetailed(
        viewer.terrainProvider,
        cartos.map((c) => c.clone()),
      );
      if (sampled.every((c) => Number.isFinite(c?.height)))
        return sampled.map((c) => c.height);
    } catch {
      // ellipsoid or unavailable terrain: use the globe below
    }
    return cartos.map((c) => {
      const h = scene.globe?.getHeight?.(c);
      return Number.isFinite(h) ? h : 0;
    });
  }

  // ---------- rendering ----------
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
        const win = projectToWindow(scene, position, scratch);
        const el = nodes[i];
        el.hidden = !win;
        if (win)
          el.style.transform = `translate(${win.x}px, ${win.y - 26}px) translateX(-50%)`;
      });
    });
  }

  function render() {
    removeDrawing();
    entities.push(
      viewer.entities.add({
        name: `${site.name} boundary`,
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(site.boundary.flat()),
          width: 4,
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
            pixelSize: 13,
            color: Cesium.Color.fromCssColorString(POINT_CSS),
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 3,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        }),
      );
    }
    drawLabels();
    governorRequestRender('site-boundary');
  }

  // ---------- state ----------
  async function setSite({
    name = 'Site',
    boundary,
    points = [],
    origin = 'api',
  }) {
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
      origin,
      boundary: ring,
      points: pts,
      ...summary,
      bbox: boundaryBbox(ring),
      groundM: heights[0],
      pointPositions: pts.map(([, lon, lat], i) =>
        Cesium.Cartesian3.fromDegrees(lon, lat, heights[i + 1] + 1),
      ),
    };
    render();
    emit('set');
    return describe();
  }

  /** Replace the points (e.g. GCPs) on the current boundary. */
  function setPoints(points = []) {
    requireSite();
    return setSite({ ...site, points });
  }

  function describe() {
    if (!site) return null;
    const areaM2 = boundaryAreaM2(site.boundary);
    return {
      name: site.name,
      origin: site.origin,
      vertices: site.boundary.length - 1,
      points: site.points.length,
      acrossM: Math.round(site.radiusM * 2),
      areaAcres: Math.round((areaM2 / 4046.856) * 10) / 10,
      center: { ...site.center },
    };
  }

  function requireSite() {
    if (!site)
      throw new Error(
        'No boundary yet. Draw one, import a KML/KMZ, or run "preset hyland".',
      );
    return site;
  }

  // ---------- import / export ----------
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
      origin: 'import',
    });
  }

  function loadPreset(key = 'hyland') {
    const preset = SITE_PRESETS[String(key).toLowerCase()];
    if (!preset) {
      throw new Error(
        `Unknown preset "${key}". Available: ${Object.keys(SITE_PRESETS).join(', ')}`,
      );
    }
    return setSite({ ...preset, origin: 'preset' });
  }

  /** A radius circle around [lon, lat] as the boundary. */
  function setCircle(center, radiusM, name) {
    const label = `${Math.round(radiusM)} m / ${Math.round(radiusM * FEET_PER_METRE)} ft radius`;
    return setSite({
      name: name || `Radius circle · ${label}`,
      boundary: circleRing(center, radiusM),
      points: [['CENTER', center[0], center[1]]],
      origin: 'circle',
    });
  }

  /**
   * Import pasted text: KML (whole file or a fragment) or a coordinate list
   * (CSV/TSV/"lat, lon" lines).
   * mode 'boundary' joins the points in order; 'outline' draws the outline
   * around them and keeps them as survey points; 'points' adds them as
   * survey points to the current boundary (or outlines them if none).
   * @returns {Promise<{ site: object, kind: 'kml'|'list', count: number,
   *   skipped: number, order?: string }>}
   */
  async function importText(
    text,
    { mode = 'outline', order = 'auto', name } = {},
  ) {
    if (looksLikeKml(text)) {
      const blob = new Blob([wrapKml(text)], {
        type: 'application/vnd.google-earth.kml+xml',
      });
      const summary = await loadKml(blob, name || 'Pasted KML');
      return {
        site: summary,
        kind: 'kml',
        count: summary.vertices,
        skipped: 0,
      };
    }
    const parsed = parseCoordinateList(text, { order });
    const pts = parsed.points.map((p) => [p.name, p.lon, p.lat]);
    const lonLats = parsed.points.map((p) => [p.lon, p.lat]);
    if (!pts.length)
      throw new Error(
        'No coordinates found. Paste "lat, lon" lines, CSV with lat/lon columns, or KML.',
      );
    let summary;
    if (mode === 'points' && site) {
      summary = await setSite({ ...site, points: [...site.points, ...pts] });
    } else if (mode === 'boundary') {
      if (lonLats.length < 3)
        throw new Error('A boundary needs at least 3 coordinates.');
      summary = await setSite({
        name: name || 'Pasted boundary',
        boundary: lonLats,
        origin: 'paste',
      });
    } else {
      const ring = outlineRing(lonLats);
      if (!ring) {
        if (lonLats.length === 1) {
          // One point: a 100 m circle around it so there is an area to work in.
          summary = await setCircle(
            lonLats[0],
            100,
            name || `${pts[0][0]} · 100 m radius`,
          );
          summary = await setSite({ ...site, points: pts });
        } else
          throw new Error(
            'Need 3 or more spread-out coordinates to outline an area.',
          );
      } else
        summary = await setSite({
          name: name || 'Pasted survey',
          boundary: ring,
          points: pts,
          origin: 'paste',
        });
    }
    return {
      site: summary,
      kind: 'list',
      count: pts.length,
      skipped: parsed.skipped,
      order: parsed.order,
    };
  }

  /** Import a picked file: .kml/.kmz through the KML loader, .csv/.txt as a list. */
  async function loadFile(file, options = {}) {
    if (/\.(csv|tsv|txt)$/i.test(file.name || ''))
      return (
        await importText(await file.text(), {
          mode: 'outline',
          name: file.name.replace(/\.\w+$/, ''),
          ...options,
        })
      ).site;
    return loadKml(file, (file.name || '').replace(/\.km[lz]$/i, ''));
  }

  function toKml() {
    requireSite();
    return siteToKml(site);
  }

  /** Save the boundary as a .kml download. Returns the file name. */
  function exportKml() {
    const text = toKml();
    const name = `${slug(site.name)}_boundary.kml`;
    const url = URL.createObjectURL(
      new Blob([text], { type: 'application/vnd.google-earth.kml+xml' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return name;
  }

  // ---------- drawing ----------
  function pickLonLat(position) {
    let cartesian;
    if (scene.pickPositionSupported) {
      try {
        cartesian = scene.pickPosition(position);
      } catch {
        cartesian = undefined;
      }
    }
    if (!cartesian) {
      const ray = scene.camera.getPickRay(position);
      cartesian =
        (ray && scene.globe?.pick?.(ray, scene)) ||
        scene.camera.pickEllipsoid(position, scene.globe?.ellipsoid);
    }
    if (!cartesian) return null;
    const c = Cesium.Cartographic.fromCartesian(cartesian);
    if (!c) return null;
    return [
      Cesium.Math.toDegrees(c.longitude),
      Cesium.Math.toDegrees(c.latitude),
    ];
  }

  /**
   * Click corners on the globe. Double-click or Enter finishes, Backspace
   * removes the last corner, Escape cancels.
   * @param {{ name?: string, onHint?: (text: string) => void }} [options]
   * @returns {Promise<object|null>} the new site summary, or null if cancelled
   */
  function startDraw({ name = 'Drawn boundary', onHint = () => {} } = {}) {
    if (draw) throw new Error('Already drawing a boundary');
    const lease = claimPointer(POINTER_OWNER);
    if (!lease)
      throw new Error('Another tool is using the pointer. Close it first.');
    const vertices = [];
    let cursor = null;
    let free = false; // Alt held: no snapping
    const snapped = (p) => (p && !free ? snapVertex(vertices, p, snapDeg) : p);
    const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
    const stock = viewer.screenSpaceEventHandler;
    const savedClick = stock.getInputAction(
      Cesium.ScreenSpaceEventType.LEFT_CLICK,
    );
    const savedDouble = stock.getInputAction(
      Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
    );
    stock.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_CLICK);
    stock.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

    const preview = viewer.entities.add({
      polyline: {
        positions: new Cesium.CallbackProperty(() => {
          const pts = cursor ? [...vertices, cursor] : vertices;
          if (pts.length < 2) return [];
          const ring = pts.length > 2 ? [...pts, pts[0]] : pts;
          return Cesium.Cartesian3.fromDegreesArray(ring.flat());
        }, false),
        width: 3,
        clampToGround: true,
        material: new Cesium.PolylineDashMaterialProperty({
          color: Cesium.Color.fromCssColorString(DRAW_CSS),
        }),
      },
    });
    const segment = () => {
      const last = vertices.at(-1);
      if (!last || !cursor) return '';
      const m = measureSegment(last, cursor);
      return ` · ${m.lengthM.toFixed(1)} m (${Math.round(m.lengthM * FEET_PER_METRE)} ft) at ${m.bearingDeg.toFixed(0)}°`;
    };
    const snapNote = () =>
      snapDeg && !free ? ` Snap ${snapDeg}° (hold Alt for free).` : '';
    const hint = () =>
      onHint(
        vertices.length < 3
          ? `Click corners on the map (${vertices.length}/3 minimum)${segment()}.${snapNote()} Esc cancels.`
          : `${vertices.length} corners${segment()}. Double-click or Enter to finish, Backspace to undo.${snapNote()}`,
      );

    let resolveDone;
    const done = new Promise((resolve) => (resolveDone = resolve));
    document.body.classList.add('site-boundary-drawing');

    const cleanup = () => {
      handler.destroy();
      if (savedClick)
        stock.setInputAction(
          savedClick,
          Cesium.ScreenSpaceEventType.LEFT_CLICK,
        );
      if (savedDouble)
        stock.setInputAction(
          savedDouble,
          Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
        );
      viewer.entities.remove(preview);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('keyup', onKeyUp, true);
      document.body.classList.remove('site-boundary-drawing');
      releasePointer(lease);
      draw = null;
      governorRequestRender('site-boundary-draw');
    };

    const finish = async () => {
      if (vertices.length < 3) {
        onHint('Need at least 3 corners.');
        return;
      }
      const ring = [...vertices];
      cleanup();
      try {
        resolveDone(await setSite({ name, boundary: ring, origin: 'draw' }));
      } catch (error) {
        onHint(error.message);
        resolveDone(null);
      }
    };
    const cancel = () => {
      cleanup();
      onHint('Drawing cancelled.');
      resolveDone(null);
    };
    function onKeyUp(event) {
      if (event.key === 'Alt') {
        free = false;
        hint();
      }
    }
    function onKey(event) {
      if (event.key === 'Alt') {
        event.preventDefault();
        free = true;
        hint();
        return;
      }
      if (event.target?.closest?.('input, textarea')) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        void finish();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancel();
      } else if (event.key === 'Backspace' && vertices.length) {
        event.preventDefault();
        vertices.pop();
        hint();
        governorRequestRender('site-boundary-draw');
      }
    }

    handler.setInputAction((e) => {
      const p = snapped(pickLonLat(e.position));
      if (!p) return;
      const last = vertices.at(-1);
      if (
        last &&
        Math.abs(last[0] - p[0]) < 1e-7 &&
        Math.abs(last[1] - p[1]) < 1e-7
      )
        return;
      vertices.push(p);
      hint();
      governorRequestRender('site-boundary-draw');
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    handler.setInputAction((e) => {
      cursor = snapped(pickLonLat(e.endPosition));
      if (vertices.length) hint();
      governorRequestRender('site-boundary-draw');
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
    handler.setInputAction(
      () => void finish(),
      Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
    );
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('keyup', onKeyUp, true);
    draw = { finish, cancel, done };
    hint();
    return done;
  }

  /**
   * Radius circle: click the centre, then click again (or pass `radiusM`)
   * to set the radius. Esc cancels.
   * @param {{ radiusM?: number|null, onHint?: (text: string) => void }} [options]
   */
  function startCircle({ radiusM = null, onHint = () => {} } = {}) {
    if (draw) throw new Error('Already drawing a boundary');
    const lease = claimPointer(POINTER_OWNER);
    if (!lease)
      throw new Error('Another tool is using the pointer. Close it first.');
    let center = null;
    let cursor = null;
    const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
    const stock = viewer.screenSpaceEventHandler;
    const savedClick = stock.getInputAction(
      Cesium.ScreenSpaceEventType.LEFT_CLICK,
    );
    stock.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_CLICK);
    const radiusNow = () =>
      radiusM ??
      (center && cursor ? measureSegment(center, cursor).lengthM : 0);
    const preview = viewer.entities.add({
      polyline: {
        positions: new Cesium.CallbackProperty(() => {
          const r = radiusNow();
          if (!center || r < 0.5) return [];
          return Cesium.Cartesian3.fromDegreesArray(
            circleRing(center, r).flat(),
          );
        }, false),
        width: 3,
        clampToGround: true,
        material: new Cesium.PolylineDashMaterialProperty({
          color: Cesium.Color.fromCssColorString(DRAW_CSS),
        }),
      },
    });
    const say = () => {
      const r = radiusNow();
      onHint(
        !center
          ? `Click the circle centre${radiusM ? ` (radius ${Math.round(radiusM)} m)` : ''}. Esc cancels.`
          : `Radius ${r.toFixed(1)} m (${Math.round(r * FEET_PER_METRE)} ft). Click to set. Esc cancels.`,
      );
    };
    let resolveDone;
    const done = new Promise((resolve) => (resolveDone = resolve));
    document.body.classList.add('site-boundary-drawing');
    const cleanup = () => {
      handler.destroy();
      if (savedClick)
        stock.setInputAction(
          savedClick,
          Cesium.ScreenSpaceEventType.LEFT_CLICK,
        );
      viewer.entities.remove(preview);
      document.removeEventListener('keydown', onKey, true);
      document.body.classList.remove('site-boundary-drawing');
      releasePointer(lease);
      draw = null;
      governorRequestRender('site-boundary-draw');
    };
    const finish = async () => {
      const r = radiusNow();
      if (!center || r < 0.5) return onHint('Click the centre, then the edge.');
      const c = center;
      cleanup();
      try {
        resolveDone(await setCircle(c, r));
      } catch (error) {
        onHint(error.message);
        resolveDone(null);
      }
    };
    const cancel = () => {
      cleanup();
      onHint('Circle cancelled.');
      resolveDone(null);
    };
    function onKey(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancel();
      } else if (event.key === 'Enter' && center) {
        event.preventDefault();
        void finish();
      }
    }
    handler.setInputAction((e) => {
      const p = pickLonLat(e.position);
      if (!p) return;
      if (!center) {
        center = p;
        if (radiusM) return void finish();
        say();
      } else {
        cursor = p;
        void finish();
      }
      governorRequestRender('site-boundary-draw');
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    handler.setInputAction((e) => {
      cursor = pickLonLat(e.endPosition);
      if (center) say();
      governorRequestRender('site-boundary-draw');
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
    document.addEventListener('keydown', onKey, true);
    draw = { finish, cancel, done };
    say();
    return done;
  }

  function finishDraw() {
    return draw?.finish();
  }

  function cancelDraw() {
    draw?.cancel();
  }

  function clear() {
    cancelDraw();
    removeDrawing();
    site = null;
    governorRequestRender('site-boundary-clear');
    emit('clear');
  }

  return {
    get site() {
      return site;
    },
    get isDrawing() {
      return Boolean(draw);
    },
    describe,
    requireSite,
    setSite,
    setPoints,
    setCircle,
    importText,
    loadFile,
    startCircle,
    get snapDeg() {
      return snapDeg;
    },
    set snapDeg(value) {
      const n = Number(value);
      snapDeg = Number.isFinite(n) && n >= 0 && n <= 90 ? n : 0;
    },
    loadKml,
    loadPreset,
    toKml,
    exportKml,
    startDraw,
    finishDraw,
    cancelDraw,
    clear,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    destroy() {
      clear();
      listeners.clear();
    },
  };
}
