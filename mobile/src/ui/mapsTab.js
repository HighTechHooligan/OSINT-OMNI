import maplibregl from 'maplibre-gl';
import { h, toast } from './dom.js';
import { rewriteStyle } from '../lib/mapStyle.js';
import { currentPosition, watchPosition, onConnectionChange } from '../lib/platform.js';
import { createNavigator, formatDistance, formatDuration, routeLengthM } from '../lib/nav.js';
import { bboxOf } from '../lib/geo.js';
import { openOfflinePanel } from './offlinePanel.js';

const ACCENT = () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#b347f0';
const MODES = [
  ['auto', 'Car'],
  ['bicycle', 'Bike'],
  ['pedestrian', 'Walk'],
];
const LONG_PRESS_MS = 550;

export function mountMaps(root, services) {
  const s = () => services.settings;
  const state = {
    from: null, // {lonLat, label} | null = my location
    to: null,
    record: null,
    origin: null,
    nav: null,
    stopWatch: null,
    me: null,
  };

  // ---------- layout ----------
  const mapEl = h('div.map');
  const fromInput = h('input', { type: 'search', placeholder: 'My location', 'aria-label': 'From', autocomplete: 'off' });
  const toInput = h('input', { type: 'search', placeholder: 'Where to?', 'aria-label': 'To', autocomplete: 'off' });
  const suggestions = h('ul.suggestions', { hidden: true });
  const modeButtons = MODES.map(([value, label]) =>
    h('button.chip', { 'data-mode': value, 'aria-pressed': String(s().costing === value), text: label, onclick: () => setMode(value) }),
  );
  const avoidToggle = h('input', { type: 'checkbox', checked: s().avoidCameras, onchange: (e) => services.updateSettings({ avoidCameras: e.target.checked }) });
  const goButton = h('button.primary', { text: 'Route', onclick: () => plan() });
  const progress = h('p.progress', { hidden: true });
  const netBadge = h('span.badge');
  const search = h(
    'section.search-card',
    {},
    h('div.field-row', {}, h('span.dot.from'), fromInput),
    h('div.field-row', {}, h('span.dot.to'), toInput),
    suggestions,
    h(
      'div.controls-row',
      {},
      h('div.chips', {}, modeButtons),
      h('label.switch', { title: 'Route around mapped ALPR cameras' }, avoidToggle, h('span', { text: 'Avoid cameras' })),
    ),
    h('div.controls-row', {}, netBadge, goButton),
    progress,
  );
  const fab = h(
    'div.fabs',
    {},
    h('button.fab', { 'aria-label': 'Offline maps and data', onclick: () => openOfflinePanel(services, { map }), html: icon('download') }),
    h('button.fab', { 'aria-label': 'Show cameras', onclick: toggleCameras, html: icon('camera') }),
    h('button.fab', { 'aria-label': 'My location', onclick: locate, html: icon('locate') }),
  );
  const result = h('section.result', { hidden: true });
  const navBanner = h('section.nav-banner', { hidden: true });
  root.append(mapEl, search, fab, navBanner, result);

  // ---------- map ----------
  const map = new maplibregl.Map({
    container: mapEl,
    style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#11111a' } }] },
    center: [-97.7431, 30.2672],
    zoom: 11,
    attributionControl: { compact: true, customAttribution: 'Cameras: OpenStreetMap ALPR extract (ODbL)' },
    dragRotate: false,
    pitchWithRotate: false,
  });
  loadBasemap();
  services.onSettings((_settings, patch) => {
    if ('styleUrl' in patch) loadBasemap();
    if ('costing' in patch) for (const b of modeButtons) b.setAttribute('aria-pressed', String(b.dataset.mode === s().costing));
  });

  async function loadBasemap() {
    try {
      const url = s().styleUrl;
      const body = await services.tiles.get(url, { category: 'style' });
      const style = rewriteStyle(JSON.parse(new TextDecoder().decode(body)), url);
      map.setStyle(style);
    } catch (error) {
      toast(`Map style unavailable: ${error.message}`);
    }
  }
  map.on('style.load', addOverlays);

  function addOverlays() {
    const empty = { type: 'FeatureCollection', features: [] };
    for (const id of ['baseline', 'route', 'cameras', 'me', 'pins'])
      if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: empty });
    if (!map.getLayer('baseline'))
      map.addLayer({ id: 'baseline', type: 'line', source: 'baseline', paint: { 'line-color': '#8a8aa0', 'line-width': 4, 'line-dasharray': [1.5, 1.5], 'line-opacity': 0.8 } });
    if (!map.getLayer('route-casing'))
      map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#0b0b12', 'line-width': 9 } });
    if (!map.getLayer('route'))
      map.addLayer({ id: 'route', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ACCENT(), 'line-width': 6 } });
    if (!map.getLayer('cameras'))
      map.addLayer({
        id: 'cameras',
        type: 'circle',
        source: 'cameras',
        layout: { visibility: s().showCameras ? 'visible' : 'none' },
        paint: {
          'circle-radius': ['case', ['get', 'onRoute'], 7, 4.5],
          'circle-color': ['case', ['get', 'onRoute'], '#ff4d6a', '#52d4ff'],
          'circle-stroke-color': '#0b0b12',
          'circle-stroke-width': 1.5,
        },
      });
    if (!map.getLayer('pins'))
      map.addLayer({ id: 'pins', type: 'circle', source: 'pins', paint: { 'circle-radius': 8, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
    if (!map.getLayer('me'))
      map.addLayer({ id: 'me', type: 'circle', source: 'me', paint: { 'circle-radius': 7, 'circle-color': '#3b9bff', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2.5 } });
    if (state.record) drawRecord(state.record);
    drawPins();
    if (state.me) setMe(state.me);
  }

  map.on('click', 'cameras', (e) => {
    const p = e.features?.[0]?.properties || {};
    new maplibregl.Popup({ closeButton: false })
      .setLngLat(e.lngLat)
      .setHTML(`<strong>${escapeHtml(p.brand || 'ALPR camera')}</strong><br>${escapeHtml(p.operator || 'Operator not mapped')}<br><small>Mapped in OpenStreetMap, not verified</small>`)
      .addTo(map);
  });

  // Long press (or right click) drops a pin with "Route here / Start here".
  let pressTimer = null;
  const cancelPress = () => clearTimeout(pressTimer);
  map.on('touchstart', (e) => {
    if (e.originalEvent.touches.length !== 1) return;
    pressTimer = setTimeout(() => pinMenu(e.lngLat), LONG_PRESS_MS);
  });
  for (const ev of ['touchend', 'touchmove', 'touchcancel', 'movestart']) map.on(ev, cancelPress);
  map.on('contextmenu', (e) => pinMenu(e.lngLat));

  function pinMenu(lngLat) {
    const lonLat = [lngLat.lng, lngLat.lat];
    const label = `${lngLat.lat.toFixed(5)}, ${lngLat.lng.toFixed(5)}`;
    const popup = new maplibregl.Popup({ closeButton: false }).setLngLat(lngLat);
    const body = h(
      'div.pin-menu',
      {},
      h('button', { text: 'Route here', onclick: () => (popup.remove(), setTo({ lonLat, label }), plan()) }),
      h('button', { text: 'Start here', onclick: () => (popup.remove(), setFrom({ lonLat, label })) }),
    );
    popup.setDOMContent(body).addTo(map);
  }

  // ---------- inputs ----------
  let suggestFor = null;
  let suggestTimer = null;
  for (const input of [fromInput, toInput]) {
    input.addEventListener('input', () => {
      clearTimeout(suggestTimer);
      if (input === fromInput) state.from = null;
      else state.to = null;
      suggestTimer = setTimeout(() => suggest(input), 450);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(suggestTimer);
        suggest(input, true);
      }
    });
  }

  async function suggest(input, pickFirst = false) {
    const text = input.value.trim();
    suggestFor = input;
    if (text.length < 3) return void (suggestions.hidden = true);
    try {
      const c = map.getCenter();
      const results = await services.geocoder.search(text, { near: [c.lng, c.lat] });
      if (suggestFor !== input) return;
      if (pickFirst && results[0]) return choose(input, results[0]);
      suggestions.replaceChildren(
        ...results.map((r) => h('li', {}, h('button', { text: r.label, onclick: () => choose(input, r) }))),
      );
      suggestions.hidden = !results.length;
      if (!results.length && !services.connection().online) toast('Offline: search only finds places searched before, or type "lat, lon".');
    } catch (error) {
      toast(`Search failed: ${error.message}`);
    }
  }

  function choose(input, r) {
    clearTimeout(suggestTimer);
    suggestFor = null;
    suggestions.hidden = true;
    const place = { lonLat: [r.lon, r.lat], label: r.label };
    if (input === fromInput) setFrom(place);
    else {
      setTo(place);
      plan();
    }
  }

  function setFrom(place) {
    state.from = place;
    fromInput.value = place ? shortLabel(place.label) : '';
    drawPins();
  }
  function setTo(place) {
    state.to = place;
    toInput.value = place ? shortLabel(place.label) : '';
    drawPins();
  }
  function setMode(value) {
    services.updateSettings({ costing: value });
  }

  // ---------- routing ----------
  async function plan({ force = false } = {}) {
    if (!state.to) {
      if (toInput.value.trim()) return suggest(toInput, true);
      return toast('Pick a destination first (search, or long-press the map).');
    }
    goButton.disabled = true;
    goButton.textContent = 'Routing…';
    const onProgress = (stage, done, total) => {
      progress.hidden = false;
      progress.textContent = total ? `${stage} ${done}/${total}` : `${stage}…`;
    };
    try {
      let from = state.from;
      if (!from) {
        const lonLat = await currentPosition();
        from = { lonLat, label: 'My location' };
        setMe({ lonLat });
      }
      const { record, from: origin } = await services.planner.plan({
        from: from.lonLat,
        to: state.to.lonLat,
        fromLabel: from.label,
        toLabel: state.to.label,
        force,
        onProgress,
      });
      showRecord(record, origin);
    } catch (error) {
      toast(error.message || String(error));
    } finally {
      goButton.disabled = false;
      goButton.textContent = 'Route';
      progress.hidden = true;
    }
  }

  function showRecord(record, origin = 'cache') {
    state.record = record;
    state.origin = origin;
    if (record.fromLabel !== 'My location') setFrom({ lonLat: record.from, label: record.fromLabel });
    setTo({ lonLat: record.to, label: record.toLabel });
    drawRecord(record);
    renderResult();
    map.fitBounds(bboxOf(record.route.coords), { padding: { top: 220, bottom: 260, left: 40, right: 40 }, duration: 600 });
  }

  function drawRecord(record) {
    if (!map.getSource('route')) return;
    const line = (coords) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} });
    map.getSource('route').setData(line(record.route.coords));
    map.getSource('baseline').setData(record.baseline ? line(record.baseline.coords) : { type: 'FeatureCollection', features: [] });
    refreshCameraDots(record);
  }

  async function refreshCameraDots(record) {
    const onRoute = new Set((record?.cameras || []).map((c) => c.id));
    let all = record?.cameras || [];
    try {
      const nearby = await services.cameras.forLine(record.route.coords, { preferCache: true });
      all = [...new Map([...nearby.cameras, ...all].map((c) => [c.id, c])).values()];
    } catch {
      /* dots for on-route cameras still show */
    }
    map.getSource('cameras')?.setData({
      type: 'FeatureCollection',
      features: all.map((c) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
        properties: { onRoute: onRoute.has(c.id), brand: c.brand, operator: c.operator },
      })),
    });
  }

  function renderResult() {
    const r = state.record;
    if (!r) return void (result.hidden = true);
    const units = r.route.units;
    const lengthM = routeLengthM(r.route);
    const camLine = cameraSummary(r);
    const age = r.at ? timeAgo(r.at) : '';
    const steps = h(
      'ol.steps',
      { hidden: true },
      r.route.maneuvers.map((m) =>
        h('li', {}, h('span', { text: m.instruction }), m.length ? h('small', { text: formatDistance(m.length * (units === 'kilometers' ? 1000 : 1609.344), s().units) }) : null),
      ),
    );
    result.replaceChildren(
      h(
        'div.result-head',
        {},
        h('div', {}, h('strong.big', { text: formatDuration(r.route.time) }), h('span.muted', { text: ` · ${formatDistance(lengthM, s().units)}` })),
        h('span.badge', { class: `badge ${state.origin === 'cache' ? 'cached' : 'fresh'}`, text: state.origin === 'cache' ? `Kept route · ${age}` : 'Fresh' }),
      ),
      h('p.camline', { class: `camline ${r.cameras.length ? 'warn' : 'ok'}`, text: camLine }),
      r.engine === 'valhalla' && r.avoid ? h('p.muted', { text: 'Camera-aware routing could not run for this trip.' }) : '',
      h(
        'div.result-actions',
        {},
        h('button.primary', { text: state.nav ? 'Stop' : 'Start', onclick: () => (state.nav ? stopNav() : startNav()) }),
        h('button', { text: 'Steps', onclick: () => (steps.hidden = !steps.hidden) }),
        h('button', { text: r.saved ? 'Saved ✓' : 'Save', onclick: () => toggleSave() }),
        h('button', { text: 'Refresh', onclick: () => plan({ force: true }), disabled: !services.connection().online }),
      ),
      steps,
    );
    result.hidden = false;
  }

  async function toggleSave() {
    const r = state.record;
    state.record = r.saved ? await services.savedRoutes.unsave(r.id) : await services.savedRoutes.save(r.id);
    renderResult();
    toast(state.record.saved ? 'Saved. Find it in the Routes tab; its map is kept on the phone.' : 'Removed from saved routes.');
  }

  // ---------- navigation ----------
  async function startNav() {
    const r = state.record;
    state.nav = createNavigator(r.route, r.cameras);
    state.stopWatch = await watchPosition(({ lonLat, heading }) => {
      setMe({ lonLat });
      const p = state.nav.update(lonLat);
      renderNav(p);
      map.easeTo({ center: lonLat, zoom: Math.max(map.getZoom(), 16), bearing: Number.isFinite(heading) ? heading : map.getBearing(), duration: 800 });
    });
    renderResult();
    root.classList.add('navigating');
    navBanner.hidden = false;
    navBanner.replaceChildren(h('div.nav-next', { text: 'Waiting for GPS…' }));
  }

  function stopNav() {
    state.stopWatch?.();
    state.stopWatch = null;
    state.nav = null;
    root.classList.remove('navigating');
    navBanner.hidden = true;
    map.easeTo({ bearing: 0 });
    renderResult();
  }

  function renderNav(p) {
    const units = s().units;
    const parts = [
      h('div.nav-next', {}, h('strong', { text: formatDistance(p.toNext, units) }), h('span', { text: ` ${p.next?.verbalPre || p.next?.instruction || ''}` })),
      h('div.nav-sub', { text: `${formatDistance(p.remaining, units)} to go` }),
    ];
    if (p.camera && p.toCamera < 1600) parts.push(h('div.nav-cam', { text: `Camera ahead in ${formatDistance(p.toCamera, units)}${p.camera.brand ? ` (${p.camera.brand})` : ''}` }));
    if (p.offRoute)
      parts.push(
        h(
          'div.nav-off',
          {},
          h('span', { text: `Off route by ${formatDistance(p.offBy, units)}` }),
          services.connection().online ? h('button', { text: 'Reroute', onclick: () => ((state.from = null), stopNav(), plan({ force: true })) }) : h('span.muted', { text: ' · no signal, follow the line back' }),
        ),
      );
    navBanner.replaceChildren(...parts);
  }

  // ---------- misc ----------
  async function locate() {
    try {
      const lonLat = await currentPosition();
      setMe({ lonLat });
      map.easeTo({ center: lonLat, zoom: Math.max(map.getZoom(), 14) });
    } catch (error) {
      toast(`Location unavailable: ${error.message || error}`);
    }
  }

  function setMe(me) {
    state.me = me;
    map.getSource('me')?.setData({ type: 'Feature', geometry: { type: 'Point', coordinates: me.lonLat }, properties: {} });
  }

  function drawPins() {
    const features = [];
    if (state.from) features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: state.from.lonLat }, properties: { color: '#3bd17a' } });
    if (state.to) features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: state.to.lonLat }, properties: { color: '#e8365d' } });
    map.getSource('pins')?.setData({ type: 'FeatureCollection', features });
  }

  function toggleCameras() {
    const show = !s().showCameras;
    services.updateSettings({ showCameras: show });
    if (map.getLayer('cameras')) map.setLayoutProperty('cameras', 'visibility', show ? 'visible' : 'none');
    if (show && !state.record) showCamerasInView();
    toast(show ? 'Showing mapped ALPR cameras' : 'Cameras hidden');
  }

  async function showCamerasInView() {
    if (map.getZoom() < 10) return toast('Zoom in to see cameras.');
    const b = map.getBounds();
    try {
      const { cameras } = await services.cameras.forBbox([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
      map.getSource('cameras')?.setData({
        type: 'FeatureCollection',
        features: cameras.map((c) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [c.lon, c.lat] }, properties: { onRoute: false, brand: c.brand, operator: c.operator } })),
      });
    } catch (error) {
      toast(`Cameras unavailable: ${error.message}`);
    }
  }

  function updateNetBadge() {
    const c = services.connection();
    netBadge.className = `badge net ${c.online ? c.type : 'offline'}`;
    netBadge.textContent = !c.online ? 'Offline · kept maps and routes only' : c.onCellular ? (s().cellularSaver ? 'Cellular · saver on' : 'Cellular') : c.type === 'wifi' ? 'Wi-Fi' : 'Online';
    if (state.record) renderResult();
  }
  updateNetBadge();
  onConnectionChange(updateNetBadge);

  return { shown: () => map.resize(), map, showRecord };
}

function cameraSummary(r) {
  if (r.message) return r.message;
  if (!r.avoid) return r.cameras.length ? `Passes ${r.cameras.length} mapped camera${r.cameras.length === 1 ? '' : 's'}. Turn on Avoid cameras to route around them.` : 'No mapped cameras on this route.';
  const extra = r.extraTime > 30 ? ` Detour adds ${formatDuration(r.extraTime)}.` : '';
  if (!r.cameras.length)
    return r.baselineCameraCount ? `Avoids all ${r.baselineCameraCount} mapped camera${r.baselineCameraCount === 1 ? '' : 's'} on the direct route.${extra}` : 'No mapped cameras on this route.';
  const avoided = Math.max(0, r.baselineCameraCount - r.cameras.length);
  return `Passes ${r.cameras.length} mapped camera${r.cameras.length === 1 ? '' : 's'} with no way around${avoided ? ` (avoided ${avoided})` : ''}.${extra}`;
}

function shortLabel(label = '') {
  return label.split(',').slice(0, 2).join(',');
}

function timeAgo(at) {
  const mins = Math.round((Date.now() - at) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function icon(name) {
  const paths = {
    download: 'M11 3h2v9.2l3.3-3.3 1.4 1.4L12 16l-5.7-5.7 1.4-1.4 3.3 3.3V3ZM4 18h16v2H4v-2Z',
    camera: 'M4 7h3l2-2h6l2 2h3v12H4V7Zm8 3a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z',
    locate: 'M11 2h2v3.1A7 7 0 0 1 18.9 11H22v2h-3.1A7 7 0 0 1 13 18.9V22h-2v-3.1A7 7 0 0 1 5.1 13H2v-2h3.1A7 7 0 0 1 11 5.1V2Zm1 5a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0 3a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name]}"/></svg>`;
}
