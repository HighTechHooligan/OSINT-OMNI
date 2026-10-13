/**
 * Aircraft dossier: double-click a plane to ride in its cockpit and open a
 * pop-out with the flight, the airframe, and the model's history.
 *
 * The GUI (double-click on the globe, the panel's Cockpit button) and the
 * Features Code `plane` command both call this service.
 */
import * as Cesium from 'cesium';
import {
  AIRCRAFT_LAYERS,
  aircraftFromPick,
  parseTrackedId,
} from './aircraftInfo.js';

/** A double-click this soon after a click changed tracking is on that plane. */
const RECENT_TRACK_MS = 900;

/**
 * @param {object} viewer Cesium viewer
 * @param {{ getStyleManager: () => object|null, getDataManager: () => object|null,
 *   openPanel: (spec: { target:object, describe:Function,
 *     onCockpit:Function }) => object|null }} deps
 *   `openPanel` draws the pop-out (src/ui/aircraftPanel.js), so this service
 *   holds no DOM.
 */
export function createAircraftDossier(
  viewer,
  { getStyleManager, getDataManager, openPanel },
) {
  let lastTrackChangeMs = -Infinity;
  const removeTrackListener = viewer.trackedEntityChanged?.addEventListener(
    () => {
      lastTrackChangeMs = performance.now();
    },
  );

  const layer = (layerId) =>
    getDataManager()?.layers?.get?.(layerId)?.module ?? null;

  const has = (layerId, id) => layer(layerId)?.hasContact?.(id) === true;

  /** Live descriptor for a target, or null when the plane is gone. */
  function describe(target) {
    const module = layer(target?.layerId);
    if (!module) return null;
    const tracked = module.getTrackedInfo?.();
    if (tracked?.icao24 === target.id) return tracked;
    const found = module.findByQuery?.(target.id);
    if (found?.icao24 !== target.id) return null;
    const { position: _position, ...rest } = found;
    return rest;
  }

  /** The aircraft currently followed by the camera or the cockpit, if any. */
  function current() {
    const cockpit = getStyleManager()?.cockpitView;
    const entity = viewer.trackedEntity || cockpit?.trackedEntity;
    const fromEntity = parseTrackedId(entity?.gevTrackedId);
    if (fromEntity) return fromEntity;
    for (const layerId of AIRCRAFT_LAYERS) {
      const info = layer(layerId)?.getTrackedInfo?.();
      if (info?.icao24) return { layerId, id: info.icao24 };
    }
    return null;
  }

  /** Find an aircraft by callsign, registration or hex across both layers. */
  function find(query) {
    const q = String(query ?? '').trim();
    if (!q) return current();
    for (const layerId of AIRCRAFT_LAYERS) {
      const found = layer(layerId)?.findByQuery?.(q);
      if (found?.icao24) return { layerId, id: found.icao24 };
    }
    return null;
  }

  /** Which aircraft sits under a screen position. */
  function targetAt(position) {
    let picked = null;
    try {
      picked = viewer.scene.pick(position);
    } catch {
      picked = null;
    }
    const hit = aircraftFromPick(picked, has);
    if (hit) return hit;
    // The first click of the double-click already started following the
    // plane, so the camera may have moved off it before the second click.
    if (performance.now() - lastTrackChangeMs < RECENT_TRACK_MS)
      return current();
    return null;
  }

  function inCockpit() {
    return Boolean(getStyleManager()?.cockpitView?.active);
  }

  /** Open (or focus) the pop-out for an aircraft. */
  function openDetails(target) {
    if (!target) return null;
    return (
      openPanel?.({
        target,
        describe,
        onCockpit: () => enterCockpit(target),
      }) ?? null
    );
  }

  /** Ride in the aircraft's cockpit; starts Contacts first when needed. */
  async function enterCockpit(target) {
    const sm = getStyleManager();
    if (!sm?.controlCockpit) return { ok: false, error: 'Cockpit unavailable' };
    if (!target) return { ok: false, error: 'No aircraft selected' };
    const cockpit = sm.cockpitView;
    if (cockpit?.active) {
      const riding = parseTrackedId(cockpit.trackedEntity?.gevTrackedId);
      if (riding?.layerId === target.layerId && riding.id === target.id)
        return { ok: true, already: true };
      cockpit.exit({ restoreTracking: false });
    }
    const state = sm.getContextModeState?.() ?? {};
    if (!(state.mode === 'flights' && !state.changing)) {
      // Cockpit needs the Contacts context; this is the entry's own
      // precondition, not an operator style change.
      const ctx = await sm.setContextMode?.('flights', {
        claimVisualAuthority: false,
      });
      if (ctx?.ok !== true)
        return {
          ok: false,
          error: ctx?.error || 'Contacts could not start for Cockpit',
        };
    }
    const result = await sm.controlCockpit('enter', {
      selectedTarget: target,
    });
    return { ok: result?.ok === true, error: result?.error ?? null };
  }

  /** Cockpit plus details: what a double-click does. */
  async function flyIn(target) {
    if (!target) return { ok: false, error: 'No aircraft found' };
    const entry = await enterCockpit(target);
    const panel = openDetails(target);
    if (!entry.ok)
      panel?.update({
        note: `Cockpit view unavailable: ${entry.error || 'unknown reason'}`,
      });
    return entry;
  }

  function exitCockpit() {
    return Boolean(getStyleManager()?.cockpitView?.exit());
  }

  // Take over the viewer's stock double-click (which would only follow the
  // entity). Anything that is not an aircraft still goes to the stock action,
  // and tools that borrow the double-click (draw, boundary) save and restore
  // this action like any other.
  const DOUBLE = Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK;
  const stock = viewer.screenSpaceEventHandler;
  const previous = stock?.getInputAction(DOUBLE) ?? null;
  const onDoubleClick = (event) => {
    const target = targetAt(event.position);
    if (!target) return previous?.(event);
    // In the cockpit the double-click only opens details; the camera stays.
    if (inCockpit()) return void openDetails(target);
    void flyIn(target);
  };
  stock?.setInputAction(onDoubleClick, DOUBLE);

  return {
    find,
    current,
    describe,
    openDetails,
    enterCockpit,
    flyIn,
    exitCockpit,
    inCockpit,
    destroy() {
      removeTrackListener?.();
      if (viewer.isDestroyed?.() || !stock || stock.isDestroyed?.()) return;
      if (stock.getInputAction(DOUBLE) !== onDoubleClick) return;
      if (previous) stock.setInputAction(previous, DOUBLE);
      else stock.removeInputAction(DOUBLE);
    },
  };
}
