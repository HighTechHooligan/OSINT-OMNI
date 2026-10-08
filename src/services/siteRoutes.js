/**
 * Routes on the globe: plan a camera-aware route (routePlanner.js, the same
 * engine as the phone app), draw it, and keep the last few trips. The ROUTES
 * dock popdown and the Features Code `route` command both call this service.
 */
import * as Cesium from 'cesium';
import { createRoutePlanner, describeRoute } from './routePlanner.js';
import { createWorkerSolver } from './routing/workerSolver.js';

/** Fallbacks for when the theme tokens are not readable (tests, panel builds). */
const ROUTE_FALLBACK_CSS = '#B347F0';
const BASELINE_CSS = '#9AA0B4';
const PASSED_CSS = '#FF4D5E';
const AVOIDED_CSS = '#FFB000';
const START_CSS = '#4CD07D';
const END_CSS = '#E8365D';
const HISTORY_MAX = 12;
const HISTORY_KEY = 'omni.routes.history';

function accentCss() {
  try {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue('--accent')
      .trim();
    return v || ROUTE_FALLBACK_CSS;
  } catch {
    return ROUTE_FALLBACK_CSS;
  }
}

function loadHistory() {
  try {
    const list = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(list) ? list.slice(0, HISTORY_MAX) : [];
  } catch {
    return [];
  }
}

function saveHistory(list) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  } catch {
    // Private window or full storage: history just stays in memory.
  }
}

export function createSiteRoutes(viewer, { planner, fetchImpl, geocode } = {}) {
  if (!viewer?.scene) throw new TypeError('Routes require a Cesium viewer');
  const solve = createWorkerSolver();
  planner ??= createRoutePlanner({ fetchImpl, geocode, solve });
  const listeners = new Set();
  const source = new Cesium.CustomDataSource('omni-routes');
  viewer.dataSources.add(source);
  let current = null;
  let busy = false;
  let history = loadHistory();
  let token = 0;

  const emit = (reason, extra) => {
    for (const fn of listeners) {
      try {
        fn(reason, describe(), extra);
      } catch (error) {
        console.warn('[routes] listener failed', error);
      }
    }
  };

  function viewCenter() {
    const canvas = viewer.scene.canvas;
    const ray = viewer.camera.getPickRay(
      new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2),
    );
    const hit = ray && viewer.scene.globe.pick(ray, viewer.scene);
    const carto = hit
      ? Cesium.Cartographic.fromCartesian(hit)
      : viewer.camera.positionCartographic;
    return [
      Cesium.Math.toDegrees(carto.longitude),
      Cesium.Math.toDegrees(carto.latitude),
    ];
  }

  const positions = (coords) =>
    Cesium.Cartesian3.fromDegreesArray(coords.flat());

  function draw(r) {
    source.entities.removeAll();
    if (!r) return;
    if (r.baseline) {
      source.entities.add({
        polyline: {
          positions: positions(r.baseline.coords),
          width: 3,
          clampToGround: true,
          material: new Cesium.PolylineDashMaterialProperty({
            color:
              Cesium.Color.fromCssColorString(BASELINE_CSS).withAlpha(0.85),
            dashLength: 14,
          }),
        },
      });
    }
    source.entities.add({
      polyline: {
        positions: positions(r.route.coords),
        width: 6,
        clampToGround: true,
        material: new Cesium.PolylineOutlineMaterialProperty({
          color: Cesium.Color.fromCssColorString(accentCss()),
          outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
          outlineWidth: 1.5,
        }),
      },
    });
    const passedIds = new Set(r.passed.map((c) => c.id));
    const cameraDot = (c, css, text) =>
      source.entities.add({
        position: Cesium.Cartesian3.fromDegrees(c.lon, c.lat),
        point: {
          pixelSize: 11,
          color: Cesium.Color.fromCssColorString(css),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        description: text,
      });
    for (const c of r.passed)
      cameraDot(
        c,
        PASSED_CSS,
        `Reads your plate on this route${c.brand ? ` (${c.brand})` : ''}`,
      );
    for (const c of r.baselineCameras)
      if (!passedIds.has(c.id))
        cameraDot(c, AVOIDED_CSS, 'On the usual route; avoided');
    const pin = (at, css) =>
      source.entities.add({
        position: Cesium.Cartesian3.fromDegrees(at[0], at[1]),
        point: {
          pixelSize: 14,
          color: Cesium.Color.fromCssColorString(css),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    pin(r.from, START_CSS);
    pin(r.to, END_CSS);
  }

  async function zoom() {
    if (!current) throw new Error('No route to zoom to');
    let w = 180;
    let s = 90;
    let e = -180;
    let n = -90;
    for (const [lon, lat] of current.route.coords) {
      w = Math.min(w, lon);
      e = Math.max(e, lon);
      s = Math.min(s, lat);
      n = Math.max(n, lat);
    }
    const padLon = Math.max(0.004, (e - w) * 0.15);
    const padLat = Math.max(0.004, (n - s) * 0.15);
    await viewer.camera.flyTo({
      destination: Cesium.Rectangle.fromDegrees(
        w - padLon,
        s - padLat,
        e + padLon,
        n + padLat,
      ),
      duration: 1.6,
    });
  }

  function remember(r) {
    const entry = {
      from: r.from,
      to: r.to,
      fromLabel: r.fromLabel,
      toLabel: r.toLabel,
      mode: r.mode,
      avoid: r.avoid,
      summary: `${describeRoute(r)} · ${r.passed.length} camera${r.passed.length === 1 ? '' : 's'}`,
      at: r.at,
    };
    history = [
      entry,
      ...history.filter(
        (h) =>
          !(
            h.mode === entry.mode &&
            h.avoid === entry.avoid &&
            Math.abs(h.from[0] - entry.from[0]) < 1e-4 &&
            Math.abs(h.from[1] - entry.from[1]) < 1e-4 &&
            Math.abs(h.to[0] - entry.to[0]) < 1e-4 &&
            Math.abs(h.to[1] - entry.to[1]) < 1e-4
          ),
      ),
    ].slice(0, HISTORY_MAX);
    saveHistory(history);
  }

  /**
   * Plan and draw. `from` / `to`: [lon, lat], "lat, lon", "here" (the map
   * view), or a place name.
   */
  async function plan({
    from,
    to,
    mode = 'car',
    avoid = true,
    onProgress = () => {},
    fly = true,
  }) {
    const mine = ++token;
    busy = true;
    emit('busy');
    try {
      const r = await planner.plan({
        from,
        to,
        mode,
        avoid,
        here: viewCenter(),
        onProgress: (stage, done, total) => {
          if (mine !== token) return;
          onProgress(stage, done, total);
          emit('progress', { stage, done, total });
        },
      });
      if (mine !== token) return null;
      current = r;
      draw(r);
      remember(r);
      emit('route');
      if (fly) await zoom().catch(() => {});
      return r;
    } finally {
      if (mine === token) {
        busy = false;
        emit('idle');
      }
    }
  }

  function clear() {
    token++;
    busy = false;
    current = null;
    draw(null);
    emit('clear');
  }

  function describe() {
    return {
      busy,
      route: current,
      summary: current ? describeRoute(current) : null,
      history: history.slice(),
    };
  }

  /** One click on the globe, as [lon, lat]; Esc or a second call cancels. */
  let picking = null;
  function pickPoint() {
    picking?.cancel();
    return new Promise((resolve) => {
      const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      const done = (value) => {
        handler.destroy();
        window.removeEventListener('keydown', onKey, true);
        document.body.classList.remove('routes-picking');
        picking = null;
        resolve(value);
      };
      const onKey = (event) => event.key === 'Escape' && done(null);
      handler.setInputAction(({ position }) => {
        const ray = viewer.camera.getPickRay(position);
        const hit = ray && viewer.scene.globe.pick(ray, viewer.scene);
        if (!hit) return;
        const c = Cesium.Cartographic.fromCartesian(hit);
        done([
          Cesium.Math.toDegrees(c.longitude),
          Cesium.Math.toDegrees(c.latitude),
        ]);
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
      window.addEventListener('keydown', onKey, true);
      document.body.classList.add('routes-picking');
      picking = { cancel: () => done(null) };
    });
  }

  return {
    plan,
    clear,
    pickPoint,
    zoom,
    describe,
    viewCenter,
    steps: () => current?.route.maneuvers ?? [],
    history: () => history.slice(),
    forget(index) {
      history.splice(index, 1);
      saveHistory(history);
      emit('history');
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    destroy() {
      picking?.cancel();
      token++;
      listeners.clear();
      solve.terminate?.();
      viewer.dataSources?.remove(source, true);
    },
  };
}
