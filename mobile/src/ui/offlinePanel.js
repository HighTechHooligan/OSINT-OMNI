import { h, sheet, toast } from './dom.js';
import { loadBasemap, planRegion, REGION_MAX_ZOOM, REGION_TILE_LIMIT } from '../lib/mapStyle.js';
import { formatBytes } from '../lib/netMeter.js';
import { cleanUrl } from '../lib/settings.js';

let activeDownload = null;

/** Offline maps, storage, cellular data, and settings. Saved routes live in the Routes tab. */
export function openOfflinePanel(services, { map }) {
  const body = h('div.offline');
  const panel = sheet('Offline & data', body);
  render();

  async function render() {
    const s = services.settings;
    const conn = services.connection();
    const regions = (await services.store.entries('regions')).map(([, r]) => r).sort((a, b) => b.at - a.at);
    const stats = await services.tiles.stats();
    const meter = services.meter.snapshot();
    const b = map.getBounds();
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];

    const downloadSection = h('section', {}, h('h3', { text: 'Download this map area' }));
    try {
      const plan = await regionPlan(services, bbox);
      const tooBig = plan.tileCount > REGION_TILE_LIMIT;
      const blocked = !conn.online || (s.wifiOnlyDownloads && conn.onCellular);
      const nameInput = h('input', { type: 'text', value: `Area ${new Date().toLocaleDateString()}`, 'aria-label': 'Area name' });
      downloadSection.append(
        ...[
        h('p.muted', {
          text: `${plan.tileCount.toLocaleString()} map tiles to z${REGION_MAX_ZOOM}, about ${formatBytes(plan.estimateBytes)}, plus the mapped cameras.`,
        }),
        tooBig ? h('p.warn', { text: `Too large (limit ${REGION_TILE_LIMIT.toLocaleString()} tiles). Zoom in and try again.` }) : null,
        blocked ? h('p.warn', { text: conn.online ? 'On cellular. Downloads wait for Wi-Fi (change below).' : 'Offline.' }) : null,
        activeDownload
          ? activeDownload.view
          : h('div.row', {}, nameInput, h('button.primary', { text: 'Download', disabled: tooBig || blocked, onclick: () => startDownload(nameInput.value, bbox, plan) })),
        ].filter(Boolean),
      );
    } catch (error) {
      downloadSection.append(h('p.warn', { text: `Can't plan a download: ${error.message}` }));
    }

    body.replaceChildren(
      locationSection(services, map, render),
      downloadSection,
      h(
        'section',
        {},
        h('h3', { text: 'Downloaded areas' }),
        regions.length
          ? h(
              'ul.list',
              {},
              regions.map((r) =>
                h(
                  'li',
                  {},
                  h('div', {}, h('strong', { text: r.name }), h('small.muted', { text: `${r.tiles.toLocaleString()} tiles · ${formatBytes(r.bytes)} · ${r.cameras} cameras · ${new Date(r.at).toLocaleDateString()}${r.failed ? ` · ${r.failed} failed` : ''}` })),
                  h('div.row', {}, h('button', { text: 'Show', onclick: () => (panel.close(), map.fitBounds(r.bbox, { padding: 20 })) }), h('button.danger', { text: 'Delete', onclick: () => deleteRegion(r) })),
                ),
              ),
            )
          : h('p.muted', { text: 'None yet. Places you look at are also kept automatically, up to the storage budget.' }),
      ),
      h(
        'section',
        {},
        h('h3', { text: 'Storage' }),
        h('p', { text: `Downloaded areas: ${formatBytes(stats.pinned)}. Browsing cache: ${formatBytes(stats.browse)} of ${formatBytes(stats.budget)}.` }),
        h('button', { text: 'Clear browsing cache', onclick: async () => (await services.tiles.clearBrowse(), render()) }),
      ),
      h(
        'section',
        {},
        h('h3', { text: `Data used since ${new Date(meter.since).toLocaleDateString()}` }),
        h('p', { text: `Cellular ${formatBytes(meter.bytes.cellular || 0)} · Wi-Fi ${formatBytes(meter.bytes.wifi || 0)} · other ${formatBytes((meter.bytes.unknown || 0) + (meter.bytes.ethernet || 0))}` }),
        h('p.muted', { text: `Kept data saved about ${formatBytes(meter.saved.all || 0)} of downloads.` }),
        h('button', { text: 'Reset counter', onclick: () => (services.meter.reset(), render()) }),
      ),
      settingsSection(services, render),
    );
  }

  function startDownload(name, bbox, plan) {
    const id = `g${Date.now().toString(36)}`;
    const bar = h('progress', { max: plan.tileCount + plan.extras.length, value: 0 });
    const label = h('small.muted', { text: 'Starting…' });
    const cancel = h('button', { text: 'Cancel', onclick: () => (job.cancelled = true) });
    const job = { cancelled: false, view: h('div', {}, bar, label, cancel) };
    activeDownload = job;
    render();
    downloadRegion(services, { id, name: name.trim() || 'Area', bbox, plan, job, onProgress: (done, failed, bytes) => {
      bar.value = done;
      label.textContent = `${done.toLocaleString()} / ${bar.max.toLocaleString()} · ${formatBytes(bytes)}${failed ? ` · ${failed} failed` : ''}`;
    } })
      .then((r) => toast(job.cancelled ? 'Download stopped. What finished is kept.' : `${r.name} is on this phone.`))
      .catch((error) => toast(`Download failed: ${error.message}`))
      .finally(() => {
        activeDownload = null;
        if (document.body.contains(panel.el)) render();
      });
  }

  async function deleteRegion(r) {
    await services.tiles.unpinRegion(r.id);
    await services.store.delete('regions', r.id);
    render();
  }
}

async function regionPlan(services, bbox) {
  const styleUrl = services.settings.styleUrl;
  const { style, tileJsons } = await loadBasemap(services.tiles, styleUrl);
  return planRegion({ style, styleUrl, tileJsons, bbox });
}

async function downloadRegion(services, { id, name, bbox, plan, job, onProgress }) {
  const styleUrl = services.settings.styleUrl;
  // Pin the style and TileJSON to this region so it renders offline.
  await services.tiles.get(styleUrl, { category: 'style', region: id });
  const style = JSON.parse(new TextDecoder().decode(await services.tiles.get(styleUrl, { category: 'style' })));
  for (const source of Object.values(style.sources || {}))
    if (source.url) await services.tiles.get(new URL(source.url, styleUrl).href, { category: 'style', region: id });

  const urls = plan.urls();
  let done = 0;
  let failed = 0;
  let bytes = 0;
  const worker = async () => {
    for (let next = urls.next(); !next.done && !job.cancelled; next = urls.next()) {
      try {
        const body = await services.tiles.get(next.value, { category: 'tiles', region: id });
        bytes += body.byteLength;
      } catch {
        failed++;
      }
      done++;
      if (done % 10 === 0) onProgress(done, failed, bytes);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  onProgress(done, failed, bytes);
  let cameras = 0;
  try {
    cameras = (await services.cameras.forBbox(bbox)).cameras.length;
  } catch {
    /* too large an area for camera tiles; routes still fetch their corridor */
  }
  const record = { id, name, bbox, tiles: done, failed, bytes, cameras, at: Date.now(), complete: !job.cancelled };
  await services.store.put('regions', id, record);
  return record;
}

/** My location: set by hand (no GPS, no location permission) or back to GPS. */
function locationSection(services, map, rerender) {
  const m = services.location.manual();
  const input = h('input', { type: 'search', placeholder: 'lat, lon or a place', 'aria-label': 'My location', value: m?.label || '' });
  const set = async () => {
    try {
      const [hit] = await services.geocoder.search(input.value);
      if (!hit) return toast('No place found. Try "lat, lon".');
      services.location.set([hit.lon, hit.lat], hit.label);
      toast('Location set. GPS is not used until you pick Use GPS.');
      rerender();
    } catch (error) {
      toast(error.message || String(error));
    }
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && set());
  return h(
    'section',
    {},
    h('h3', { text: 'My location' }),
    h('p.muted', {
      text: m
        ? `Set by hand: ${m.label}. The app does not use the GPS and needs no location permission.`
        : 'From the GPS. Set it by hand to keep your real position private, or when location is turned off for this app.',
    }),
    h('div.row', {}, input, h('button.primary', { text: 'Set', onclick: set })),
    h(
      'div.row',
      {},
      h('button', {
        text: 'Use map center',
        onclick: () => {
          const c = map.getCenter();
          services.location.set([c.lng, c.lat]);
          rerender();
        },
      }),
      m ? h('button', { text: 'Use GPS', onclick: () => (services.location.clear(), rerender()) }) : '',
    ),
  );
}

function settingsSection(services, rerender) {
  const s = services.settings;
  const toggle = (key, label) =>
    h('label.switch', {}, h('input', { type: 'checkbox', checked: s[key], onchange: (e) => (services.updateSettings({ [key]: e.target.checked }), rerender()) }), h('span', { text: label }));
  const number = (key, label, min, max) =>
    h('label.field', {}, h('span', { text: label }), h('input', { type: 'number', min, max, value: s[key], onchange: (e) => {
      const v = Math.min(max, Math.max(min, Number(e.target.value) || s[key]));
      services.updateSettings({ [key]: v });
    } }));
  const url = (key, label) =>
    h('label.field', {}, h('span', { text: label }), h('input', { type: 'url', value: s[key], onchange: (e) => {
      const v = cleanUrl(e.target.value);
      if (!v) return toast('Enter an http(s) address.');
      services.updateSettings({ [key]: v });
    } }));
  return h(
    'section',
    {},
    h('h3', { text: 'Settings' }),
    toggle('cellularSaver', 'Cellular saver: reuse kept routes and camera data on cellular'),
    toggle('wifiOnlyDownloads', 'Download areas on Wi-Fi only'),
    h('label.field', {}, h('span', { text: 'Units' }), h('select', { onchange: (e) => services.updateSettings({ units: e.target.value }) }, ['miles', 'kilometers'].map((u) => h('option', { value: u, selected: s.units === u, text: u })))),
    number('cameraRangeM', 'Camera read range (m, incl. map error)', 15, 120),
    toggle('cameraFrontPlates', 'Cameras read front plates too (most states require one)'),
    number('routeMaxAgeHours', 'Reuse a kept route for (hours)', 0, 720),
    number('tileBudgetMB', 'Browsing cache budget (MB)', 50, 8000),
    url('routerUrl', 'Router (Valhalla)'),
    url('styleUrl', 'Map style'),
    url('geocoderUrl', 'Place search (Nominatim)'),
    url('overpassUrl', 'Road data (Overpass; the host proxy is tried first when paired)'),
  );
}

