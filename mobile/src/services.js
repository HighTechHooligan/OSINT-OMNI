import maplibregl from 'maplibre-gl';
import { createIdbStore } from './lib/store.js';
import { createTileCache } from './lib/tileCache.js';
import { createCameraSource, cameraTileTemplate } from './lib/cameras.js';
import { createRouteCache } from './lib/routeCache.js';
import { createPlanner } from './lib/planner.js';
import { createGeocoder } from './lib/geocode.js';
import { createNetMeter } from './lib/netMeter.js';
import { loadSettings, saveSettings } from './lib/settings.js';
import { SCHEME, unwrap, rewriteTileJson } from './lib/mapStyle.js';
import { fetchBytes, getConnection, httpPostForm, startNetworkWatch } from './lib/platform.js';
import { createRoadSource } from './lib/roads.js';
import { createWorkerSolver } from '../../src/services/routing/workerSolver.js';
import { createSavedRoutes } from './lib/savedRoutes.js';
import { loadLink } from './lib/hostLink.js';

/**
 * App services, created once. UI modules call these; no logic lives in the UI.
 */
export async function createServices() {
  let settings = loadSettings();
  const store = createIdbStore();
  await startNetworkWatch();
  navigator.storage?.persist?.().catch(() => {});

  const connection = () => {
    const c = getConnection();
    return { online: c.connected, onCellular: c.connectionType === 'cellular', type: c.connectionType };
  };
  const METER_KEY = 'omni-portal.meter';
  const meter = createNetMeter({
    load: () => {
      try {
        return JSON.parse(localStorage.getItem(METER_KEY) || 'null');
      } catch {
        return null;
      }
    },
    save: (s) => {
      try {
        localStorage.setItem(METER_KEY, JSON.stringify(s));
      } catch {
        /* ignore */
      }
    },
    connection: () => connection().type,
  });
  const metered = (category) => async (url, init) => {
    const res = await fetch(url, init);
    res
      .clone()
      .arrayBuffer()
      .then((b) => meter.add(category, b.byteLength))
      .catch(() => {});
    return res;
  };

  const canFetch = () => connection().online;
  const tiles = createTileCache({
    store,
    meter,
    canFetch,
    budgetBytes: settings.tileBudgetMB * 1024 * 1024,
  });
  const cameras = createCameraSource({
    store,
    fetchBytes,
    template: () => cameraTileTemplate(settings.hostUrl),
    canFetch,
    meter,
  });
  const routes = createRouteCache({ store });
  const roads = createRoadSource({
    store,
    post: httpPostForm,
    // The paired (or named) OMNI host's cached Overpass proxy first, then public Overpass.
    endpoints: () => {
      const host = loadLink()?.hostUrl || settings.hostUrl;
      return host ? [`${host}/api/overpass`, settings.overpassUrl] : [settings.overpassUrl];
    },
    canFetch,
    meter,
  });
  const solve = createWorkerSolver();
  const planner = createPlanner({
    routes,
    cameras,
    roads,
    solve,
    settings: () => settings,
    connection,
    fetchImpl: metered('routes'),
  });
  const savedRoutes = createSavedRoutes({ routes, tiles, cameras, planner, styleUrl: () => settings.styleUrl });
  const geocoder = createGeocoder({
    store,
    fetchImpl: metered('search'),
    baseUrl: () => settings.geocoderUrl,
    canFetch,
  });

  // Every map resource goes through the phone cache.
  maplibregl.addProtocol(SCHEME.replace('://', ''), async (params) => {
    const url = unwrap(params.url);
    const category = params.type === 'json' ? 'style' : 'tiles';
    const body = await tiles.get(url, { category });
    if (params.type === 'json') {
      const json = JSON.parse(new TextDecoder().decode(body));
      return { data: rewriteTileJson(json, url) };
    }
    return { data: body };
  });

  const listeners = new Set();
  return {
    store,
    tiles,
    cameras,
    roads,
    routes,
    savedRoutes,
    planner,
    geocoder,
    meter,
    connection,
    get settings() {
      return settings;
    },
    updateSettings(patch) {
      settings = { ...settings, ...patch };
      saveSettings(settings);
      if ('tileBudgetMB' in patch) tiles.setBudget(settings.tileBudgetMB * 1024 * 1024);
      for (const fn of listeners) fn(settings, patch);
    },
    onSettings: (fn) => listeners.add(fn),
  };
}
