/**
 * Where the phone is, for every feature (routing from "My location",
 * turn-by-turn, the locate button, sending a position to the desktop).
 *
 * With a location set by hand the app never asks the device's GPS: no
 * location permission is needed and no fix is taken, so the app can run with
 * location turned off for it. Without one it uses the GPS as before.
 */
export class LocationOffError extends Error {}

export const LOCATION_OFF_HINT =
  'Location is off for this app. Set your location by hand: long-press the map and pick "Set my location here", or type it under My location in the download panel.';

/**
 * @param {object} o
 * @param {() => object} o.settings current settings (reads `manualLocation`)
 * @param {(patch: object) => void} o.updateSettings
 * @param {{current: () => Promise<[number,number]>, watch: (cb: Function) => Promise<Function>}} o.gps
 */
export function createLocationSource({ settings, updateSettings, gps, now = Date.now }) {
  const listeners = new Set();
  const manual = () => {
    const m = settings().manualLocation;
    return m && Array.isArray(m.lonLat) && m.lonLat.every(Number.isFinite) ? m : null;
  };
  const emit = () => {
    for (const fn of listeners) fn(manual());
  };

  return {
    /** The location set by hand, or null when the GPS is used. */
    manual,
    /** Current position as [lon, lat]. */
    async current() {
      const m = manual();
      if (m) return m.lonLat;
      try {
        return await gps.current();
      } catch (error) {
        throw new LocationOffError(`${LOCATION_OFF_HINT} (${error?.message || error})`);
      }
    },
    /** Follow the position; returns a stop function. A set location is reported once. */
    async watch(callback) {
      const m = manual();
      if (m) {
        callback({ lonLat: m.lonLat, accuracy: 0, heading: null, manual: true });
        return () => {};
      }
      return gps.watch(callback);
    },
    set(lonLat, label = null) {
      const [lon, lat] = lonLat.map(Number);
      if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
        throw new Error('That is not a place on the map');
      updateSettings({ manualLocation: { lonLat: [lon, lat], label: label || `${lat.toFixed(5)}, ${lon.toFixed(5)}`, at: now() } });
      emit();
    },
    /** Go back to the device's GPS. */
    clear() {
      updateSettings({ manualLocation: null });
      emit();
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
