/**
 * Click a shape on the globe: a point, a route (line), an area (polygon) or
 * a radius circle. A clone of the SITE boundary's draw and circle tools
 * (siteBoundary.js) with the same keys: double-click or Enter finishes,
 * Backspace removes the last point, Escape cancels, Alt draws without the
 * angle snap. Used by the viewshed to pick its observer shape.
 */
import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import { claimPointer, releasePointer } from '../data/inputOwnership.js';
import { FEET_PER_METRE } from './siteGeometry.js';
import { circleRing, measureSegment, snapVertex } from './surveyGeometry.js';
import { pathLengthM } from './viewshedShapes.js';

const DRAW_CSS = '#B347F0';
const POINTER_OWNER = 'viewshed-shape';
const MIN_POINTS = { point: 1, line: 2, area: 3 };

/** Globe position under a window position as [lon, lat], or null. */
export function pickLonLatAt(scene, position) {
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
  const c = cartesian && Cesium.Cartographic.fromCartesian(cartesian);
  return c
    ? [Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude)]
    : null;
}

/**
 * @param {Cesium.Viewer} viewer
 * @param {{ kind: 'point'|'line'|'area'|'circle', radiusM?: number|null,
 *   snapDeg?: number, onHint?: (text: string) => void,
 *   pickLonLat?: (position: Cesium.Cartesian2) => number[]|null }} options
 * @returns {{ done: Promise<object|null>, finish: () => void,
 *   cancel: () => void }} done resolves to a viewshedShapes shape, or null
 *   when cancelled
 */
export function pickShape(
  viewer,
  {
    kind,
    radiusM = null,
    snapDeg = 15,
    onHint = () => {},
    pickLonLat = (position) => pickLonLatAt(viewer.scene, position),
  },
) {
  const scene = viewer.scene;
  const lease = claimPointer(POINTER_OWNER);
  if (!lease)
    throw new Error('Another tool is using the pointer. Close it first.');
  const circle = kind === 'circle';
  const vertices = [];
  let cursor = null;
  let free = false; // Alt held: no snapping
  const snapped = (p) =>
    p && !free && !circle && kind !== 'point'
      ? snapVertex(vertices, p, snapDeg)
      : p;
  const radiusNow = () =>
    radiusM ??
    (vertices[0] && cursor ? measureSegment(vertices[0], cursor).lengthM : 0);

  const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
  const stock = viewer.screenSpaceEventHandler;
  const saved = [
    Cesium.ScreenSpaceEventType.LEFT_CLICK,
    Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
  ].map((type) => [type, stock.getInputAction(type)]);
  for (const [type] of saved) stock.removeInputAction(type);

  const preview = viewer.entities.add({
    polyline: {
      positions: new Cesium.CallbackProperty(() => {
        if (circle) {
          const r = radiusNow();
          return vertices[0] && r >= 0.5
            ? Cesium.Cartesian3.fromDegreesArray(
                circleRing(vertices[0], r).flat(),
              )
            : [];
        }
        const pts = cursor ? [...vertices, cursor] : vertices;
        if (pts.length < 2) return [];
        const ring = kind === 'area' && pts.length > 2 ? [...pts, pts[0]] : pts;
        return Cesium.Cartesian3.fromDegreesArray(ring.flat());
      }, false),
      width: 3,
      clampToGround: true,
      material: new Cesium.PolylineDashMaterialProperty({
        color: Cesium.Color.fromCssColorString(DRAW_CSS),
      }),
    },
  });

  const snapNote = () =>
    snapDeg && !free && (kind === 'line' || kind === 'area')
      ? ` Snap ${snapDeg}° (hold Alt for free).`
      : '';
  const hint = () => {
    if (kind === 'point')
      return onHint('Click the observer spot. Esc cancels.');
    if (circle) {
      const r = radiusNow();
      return onHint(
        !vertices[0]
          ? `Click the circle centre${radiusM ? ` (radius ${Math.round(radiusM)} m)` : ''}. Esc cancels.`
          : `Radius ${r.toFixed(1)} m (${Math.round(r * FEET_PER_METRE)} ft). Click to set. Esc cancels.`,
      );
    }
    const pts = cursor ? [...vertices, cursor] : vertices;
    const len = pts.length > 1 ? pathLengthM(pts) : 0;
    const total = len
      ? ` · ${len >= 1000 ? `${(len / 1000).toFixed(2)} km` : `${Math.round(len)} m`}`
      : '';
    const min = MIN_POINTS[kind];
    const noun = kind === 'line' ? 'route points' : 'corners';
    onHint(
      vertices.length < min
        ? `Click ${noun} on the map (${vertices.length}/${min} minimum)${total}.${snapNote()} Esc cancels.`
        : `${vertices.length} ${noun}${total}. Double-click or Enter to finish, Backspace to undo.${snapNote()}`,
    );
  };

  let resolveDone;
  const done = new Promise((resolve) => (resolveDone = resolve));
  document.body.classList.add('site-boundary-drawing');
  let live = true;

  const cleanup = () => {
    live = false;
    handler.destroy();
    for (const [type, action] of saved)
      if (action) stock.setInputAction(action, type);
    viewer.entities.remove(preview);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('keyup', onKeyUp, true);
    document.body.classList.remove('site-boundary-drawing');
    releasePointer(lease);
    governorRequestRender('viewshed-shape');
  };

  const finish = () => {
    if (!live) return;
    let shape;
    if (kind === 'point') {
      if (!vertices[0]) return;
      shape = { kind: 'point', at: vertices[0] };
    } else if (circle) {
      const r = radiusNow();
      if (!vertices[0] || r < 0.5)
        return onHint('Click the centre, then the edge.');
      shape = {
        kind: 'area',
        ring: circleRing(vertices[0], r),
        circle: { center: vertices[0], radiusM: r },
      };
    } else {
      if (vertices.length < MIN_POINTS[kind])
        return onHint(
          kind === 'line'
            ? 'A route needs at least 2 points.'
            : 'An area needs at least 3 corners.',
        );
      shape =
        kind === 'line'
          ? { kind: 'line', path: [...vertices] }
          : { kind: 'area', ring: [...vertices] };
    }
    cleanup();
    resolveDone(shape);
  };
  const cancel = () => {
    if (!live) return;
    cleanup();
    onHint('Cancelled.');
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
      finish();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      cancel();
    } else if (event.key === 'Backspace' && vertices.length && !circle) {
      event.preventDefault();
      vertices.pop();
      hint();
      governorRequestRender('viewshed-shape');
    }
  }

  handler.setInputAction((e) => {
    const p = snapped(pickLonLat(e.position));
    if (!p) return;
    if (circle && vertices[0]) {
      cursor = p;
      return finish();
    }
    const last = vertices.at(-1);
    if (
      last &&
      Math.abs(last[0] - p[0]) < 1e-7 &&
      Math.abs(last[1] - p[1]) < 1e-7
    )
      return;
    vertices.push(p);
    if (kind === 'point' || (circle && radiusM)) return finish();
    hint();
    governorRequestRender('viewshed-shape');
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  handler.setInputAction((e) => {
    cursor = snapped(pickLonLat(e.endPosition));
    if (vertices.length) hint();
    governorRequestRender('viewshed-shape');
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
  handler.setInputAction(
    () => finish(),
    Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
  );
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('keyup', onKeyUp, true);
  hint();
  return { done, finish, cancel };
}
