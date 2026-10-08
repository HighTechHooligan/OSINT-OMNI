import { DEFAULT_ROUTER_URL } from './valhalla.js';
import { DEFAULT_STYLE_URL } from './mapStyle.js';
import { DEFAULT_GEOCODER_URL } from './geocode.js';

/** User settings, kept in localStorage (small, synchronous, per device). */
export const DEFAULT_SETTINGS = Object.freeze({
  hostUrl: '',
  routerUrl: DEFAULT_ROUTER_URL,
  styleUrl: DEFAULT_STYLE_URL,
  geocoderUrl: DEFAULT_GEOCODER_URL,
  costing: 'auto',
  units: 'miles',
  avoidCameras: true,
  cameraBufferM: 40,
  showCameras: true,
  wifiOnlyDownloads: true,
  cellularSaver: true,
  routeMaxAgeHours: 24,
  tileBudgetMB: 512,
});

const KEY = 'omni-portal.settings';

export function loadSettings(storage = globalThis.localStorage) {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(storage?.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings, storage = globalThis.localStorage) {
  try {
    storage?.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* private mode or full storage: settings stay for this session */
  }
}

/** Accept only plain http(s) origins with an optional path, no credentials. */
export function cleanUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return (url.origin + url.pathname).replace(/\/+$/, '');
  } catch {
    return null;
  }
}
