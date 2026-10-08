/**
 * SITE: dock popdown with the GUI for every site feature — boundary (draw,
 * import, export, clear), contours (on/off + 2–100 ft slider), canopy,
 * building mode (topography ⇄ clickable buildings/roads/parks) and
 * orbit/record. The viewshed has its own VIEWSHED tab (viewshedTray.js). Each section (or the whole tray) can pop out into a
 * movable panel and from there into its own window. Features Code exposes the same actions as commands; both
 * call the same services.
 */
import { openCoordinatePaste } from './coordinatePaste.js';
import { parseLength, SNAP_STEPS_DEG } from '../services/surveyGeometry.js';
import {
  CONTOUR_MAX_FT,
  CONTOUR_MIN_FT,
  clampIntervalFt,
  normalizeDatum,
} from '../services/contourMath.js';

const DATUM_LABEL = {
  asl: 'ft above sea level (NAVD88)',
  relative: 'ft relative',
};

const ACRES = (s) => (s?.areaAcres != null ? `${s.areaAcres} ac` : '');

const fmtShift = (m, pos, neg) =>
  `${Math.abs(m).toFixed(1)} m ${m >= 0 ? pos : neg}`;

export function mountSiteTray({
  site,
  dock,
  onOpenFeaturesCode,
  panels = null,
} = {}) {
  const { boundary, orbit, contours, buildings } = site;
  const host = dock ?? document.getElementById('command-dock');
  const item = document.createElement('div');
  item.id = 'site-tray';
  item.className = 'site-tray-dock';
  item.innerHTML = `
    <button id="site-tray-toggle" class="site-tray-toggle" type="button"
      aria-expanded="false" aria-controls="site-tray-panel" title="Site boundary, contours and orbit">
      <span class="site-tray-glyph" aria-hidden="true">◬</span>
      <span class="site-tray-label">SITE</span>
    </button>`;
  const locationBar = host?.querySelector('#location-bar');
  if (host && locationBar) host.insertBefore(item, locationBar);
  else if (host) host.prepend(item);
  else {
    item.classList.add('site-tray-floating');
    document.body.appendChild(item);
  }
  const toggle = item.querySelector('button');

  const panel = document.createElement('section');
  panel.id = 'site-tray-panel';
  panel.className = 'site-tray-panel';
  panel.setAttribute('aria-label', 'Site tools');
  panel.hidden = true;
  panel.innerHTML = `
    <header class="site-tray-head">
      <span>SITE</span>
      <button type="button" class="site-tray-pop" data-st="pop-all" title="Pop the whole SITE panel out into a movable window" aria-label="Pop out SITE tools">⧉</button>
      <button type="button" class="site-tray-close" aria-label="Close site tools">×</button>
    </header>
    <div class="site-tray-body">
      <section class="site-tray-section" aria-labelledby="st-boundary-h">
        <h3 id="st-boundary-h">Boundary</h3>
        <p class="site-tray-status" data-st="boundary-status">No boundary yet</p>
        <div class="site-tray-row">
          <button type="button" data-st="draw">Draw</button>
          <button type="button" data-st="import" title="KML, KMZ, or a CSV/TXT list of coordinates">Import KML/CSV</button>
          <button type="button" data-st="paste" title="Paste a coordinate list or KML">Paste coords</button>
          <button type="button" data-st="export" disabled>Export KML</button>
        </div>
        <div class="site-tray-row">
          <button type="button" data-st="circle" title="Click a centre; type a radius or click the edge">Radius circle</button>
          <input type="text" class="site-tray-input" data-st="radius" inputmode="decimal"
            placeholder="radius: 150 m, 500 ft" aria-label="Circle radius" size="12" />
          <label class="site-tray-select">Snap
            <select data-st="snap" aria-label="Angle snap while drawing">
              ${SNAP_STEPS_DEG.map((d) => `<option value="${d}"${d === 15 ? ' selected' : ''}>${d ? `${d}°` : 'Off'}</option>`).join('')}
            </select>
          </label>
        </div>
        <div class="site-tray-row">
          <button type="button" data-st="zoom" disabled>Zoom to</button>
          <button type="button" data-st="clear" disabled>Clear</button>
          <button type="button" data-st="preset" title="Load the Hyland Hills job boundary and GCPs">Hyland preset</button>
        </div>
        <p class="site-tray-note">
          <button type="button" data-st="ai-gcp" disabled aria-describedby="st-ai-note">Suggest GCPs (AI)</button>
          <span id="st-ai-note">Coming with the local AI agent: it will place GCPs inside this boundary as suggestions for you to confirm.</span>
        </p>
      </section>

      <section class="site-tray-section" aria-labelledby="st-contour-h">
        <h3 id="st-contour-h">Contours <small>USGS 3DEP bare earth</small></h3>
        <label class="site-tray-switch">
          <input type="checkbox" id="st-contours" data-st="contours" />
          <span>Show contours inside the boundary</span>
        </label>
        <div class="site-tray-slider">
          <label for="st-interval">Interval</label>
          <input id="st-interval" type="range" min="${CONTOUR_MIN_FT}" max="${CONTOUR_MAX_FT}" step="1" value="10" />
          <output for="st-interval" data-st="interval-out">10 ft</output>
        </div>
        <div class="site-tray-scale" aria-hidden="true"><span>${CONTOUR_MIN_FT} ft</span><span>${CONTOUR_MAX_FT} ft</span></div>
        <label class="site-tray-select">Elevations
          <select id="st-datum" data-st="datum">
            <option value="asl" selected>Above sea level (NAVD88)</option>
            <option value="relative">Relative (0 = lowest point in boundary)</option>
          </select>
        </label>
        <p class="site-tray-status" data-st="contour-status"></p>
        <label class="site-tray-switch">
          <input type="checkbox" id="st-canopy" data-st="canopy" />
          <span>Canopy overlay <small>(Google 3D mesh above ground)</small></span>
        </label>
        <p class="site-tray-status" data-st="canopy-status"></p>
      </section>

      <section class="site-tray-section" aria-labelledby="st-bldg-h">
        <h3 id="st-bldg-h">View <small>topography or buildings</small></h3>
        <div class="site-tray-segment" role="radiogroup" aria-label="Site view">
          <button type="button" role="radio" data-st="view-topo" aria-checked="true">Topography</button>
          <button type="button" role="radio" data-st="view-bldg" aria-checked="false">Buildings</button>
        </div>
        <label class="site-tray-select">Find buildings from
          <select data-st="bldg-source">
            <option value="auto" selected>OSM, then 3D mesh</option>
            <option value="osm">OSM footprints only</option>
            <option value="mesh">3D mesh scan (rectangles + walls)</option>
          </select>
        </label>
        <p class="site-tray-status" data-st="bldg-status"></p>
        <p class="site-tray-legend" aria-hidden="true">
          <span class="lg-osm">OSM building</span><span class="lg-mesh">mesh-detected</span><span class="lg-road">road</span><span class="lg-park">park</span>
        </p>
        <p class="site-tray-note">Click a building, road or park for its dossier. Dossiers open as pop-outs; open several, drag them, or pop one into its own window.</p>
      </section>

      <section class="site-tray-section" aria-labelledby="st-orbit-h">
        <h3 id="st-orbit-h">Orbit</h3>
        <div class="site-tray-row">
          <button type="button" data-st="orbit" disabled>Orbit</button>
          <button type="button" data-st="stop">Stop</button>
          <label class="site-tray-select">Frames
            <select id="st-frames" data-st="frames">
              <option value="72">72</option>
              <option value="144" selected>144</option>
              <option value="288">288</option>
            </select>
          </label>
          <button type="button" data-st="record" disabled>Record GIF</button>
        </div>
        <p class="site-tray-status" data-st="orbit-status"></p>
      </section>
      <p class="site-tray-foot">Same actions in <button type="button" class="site-tray-link" data-st="open-fc">Features Code</button> · type <code>help</code></p>
    </div>`;
  document.body.appendChild(panel);
  // Cache controls up front: a section may live in a pop-out panel (or
  // another window) later, outside this tray's DOM.
  const controls = new Map(
    [...panel.querySelectorAll('[data-st]')].map((el) => [el.dataset.st, el]),
  );
  const $ = (key) => controls.get(key);
  const slider = panel.querySelector('#st-interval');
  const trayBody = panel.querySelector('.site-tray-body');

  const filePicker = document.createElement('input');
  filePicker.type = 'file';
  filePicker.accept = '.kml,.kmz,.csv,.tsv,.txt';
  filePicker.hidden = true;
  document.body.appendChild(filePicker);

  const say = (key, text, tone = '') => {
    const el = $(key);
    el.textContent = text;
    el.dataset.tone = tone;
  };
  const guard =
    (key, fn) =>
    async (...args) => {
      try {
        await fn(...args);
      } catch (error) {
        say(key, error?.message || String(error), 'err');
      }
    };

  function syncBoundary() {
    const s = boundary.describe();
    const has = Boolean(s);
    // While drawing, the draw/circle tool's own hints own the status line.
    if (!boundary.isDrawing)
      say(
        'boundary-status',
        has
          ? `${s.name} · ${ACRES(s)} · ${s.vertices} corners · ${s.points} points`
          : 'No boundary yet',
      );
    for (const key of ['export', 'zoom', 'clear', 'orbit', 'record'])
      $(key).disabled = !has;
    $('draw').textContent = boundary.isDrawing ? 'Finish' : 'Draw';
    $('circle').textContent = boundary.isDrawing ? 'Cancel' : 'Radius circle';
    if (buildings) $('view-bldg').disabled = !has && !buildings.describe().on;
  }

  function alignNote(st) {
    if (st.align?.pending) return ' · aligning to 3D mesh…';
    if (st.align?.ok)
      return ` · aligned to 3D mesh (${fmtShift(st.align.eastM, 'E', 'W')}, ${fmtShift(st.align.northM, 'N', 'S')})`;
    if (st.datumShiftM) return ` · NAD83→WGS84 ${st.datumShiftM} m`;
    return '';
  }

  function syncContours(state = contours.describe()) {
    $('contours').checked = state.contoursOn;
    $('canopy').checked = state.canopyOn;
    slider.value = String(state.intervalFt);
    $('interval-out').textContent = `${state.intervalFt} ft`;
    $('datum').value = normalizeDatum(state.datum);
    const st = state.stats;
    if (state.contoursOn && st) {
      const rel = st.datum === 'relative';
      const base =
        rel && st.baseFt != null ? ` · 0 = ${st.baseFt} ft NAVD88` : '';
      say(
        'contour-status',
        `${st.lines} lines · ${st.minFt}–${st.maxFt} ${DATUM_LABEL[st.datum] ?? 'ft'}${base} · ${st.resM} m grid${st.cached ? ' · cached' : ''}${alignNote(st)}`,
        'ok',
      );
    } else if (!state.contoursOn) say('contour-status', '');
    if (state.canopyOn && state.canopy)
      say(
        'canopy-status',
        `${state.canopy.coveredPct}% under trees/structures`,
        'ok',
      );
    else if (!state.canopyOn) say('canopy-status', '');
  }

  function syncBuildings(state = buildings?.describe()) {
    if (!state) return;
    $('view-topo').setAttribute('aria-checked', String(!state.on));
    $('view-bldg').setAttribute('aria-checked', String(state.on));
    panel.classList.toggle('site-tray-bldg-on', state.on);
    if (state.loading) return say('bldg-status', state.progress || 'Loading…');
    if (state.error) return say('bldg-status', state.error, 'err');
    if (!state.on)
      return say(
        'bldg-status',
        boundary.site
          ? 'Inside the boundary'
          : 'Needs a boundary: import a KML, paste coordinates, draw, or add a radius circle',
      );
    const c = state.counts;
    const from =
      {
        osm: 'OpenStreetMap',
        mesh: '3D mesh scan',
        'osm+mesh': 'OSM + 3D mesh',
      }[state.source] ?? '';
    say(
      'bldg-status',
      `${c.buildings} buildings · ${c.roads} roads · ${c.parks} parks · ${from}${state.osmError ? ` (OSM: ${state.osmError})` : ''}`,
      'ok',
    );
  }

  // ---- boundary ----
  $('draw').addEventListener(
    'click',
    guard('boundary-status', async () => {
      if (boundary.isDrawing) return boundary.finishDraw();
      const done = boundary.startDraw({
        onHint: (t) => say('boundary-status', t),
      });
      syncBoundary();
      await done;
      syncBoundary();
    }),
  );
  $('import').addEventListener('click', () => {
    filePicker.value = '';
    filePicker.click();
  });
  filePicker.addEventListener(
    'change',
    guard('boundary-status', async () => {
      const file = filePicker.files?.[0];
      if (!file) return;
      say('boundary-status', `Loading ${file.name}…`);
      await boundary.loadFile(file);
      await orbit.zoom();
    }),
  );
  $('circle').addEventListener(
    'click',
    guard('boundary-status', async () => {
      if (boundary.isDrawing) return boundary.cancelDraw();
      const typed = $('radius').value.trim();
      const radiusM = typed ? parseLength(typed) : null;
      if (typed && !radiusM)
        return say(
          'boundary-status',
          'Radius like 150, 150 m, 500 ft or 0.5 km',
          'err',
        );
      const done = boundary.startCircle({
        radiusM,
        onHint: (t) => say('boundary-status', t),
      });
      syncBoundary();
      await done;
      syncBoundary();
    }),
  );
  $('snap').addEventListener('change', () => {
    boundary.snapDeg = Number($('snap').value);
  });
  boundary.snapDeg = Number($('snap').value);
  const openPaste = (initialText = '') =>
    panels
      ? openCoordinatePaste({ panels, boundary, orbit, initialText })
      : say('boundary-status', 'Paste needs the pop-out panels', 'err');
  $('paste').addEventListener('click', () => openPaste());
  // Ctrl/Cmd+V anywhere in the open tray (outside inputs) imports the clipboard.
  panel.addEventListener('paste', (event) => {
    if (event.target?.closest?.('input, textarea, select')) return;
    const text = event.clipboardData?.getData('text');
    if (!text?.trim()) return;
    event.preventDefault();
    openPaste(text);
  });
  $('export').addEventListener(
    'click',
    guard('boundary-status', () =>
      say('boundary-status', `Saved ${boundary.exportKml()}`, 'ok'),
    ),
  );
  $('zoom').addEventListener(
    'click',
    guard('boundary-status', () => orbit.zoom()),
  );
  $('clear').addEventListener('click', () => boundary.clear());
  $('preset').addEventListener(
    'click',
    guard('boundary-status', () => boundary.loadPreset('hyland')),
  );

  // ---- contours ----
  $('contours').addEventListener('change', async (event) => {
    const box = event.target;
    try {
      if (!box.checked) return contours.hideContours();
      say('contour-status', 'Loading USGS 3DEP elevation…');
      await contours.showContours();
    } catch (error) {
      box.checked = false;
      contours.hideContours();
      say('contour-status', error?.message || String(error), 'err');
    }
  });
  let sliderTimer = null;
  slider.addEventListener('input', () => {
    const ft = clampIntervalFt(slider.value);
    $('interval-out').textContent = `${ft} ft`;
    clearTimeout(sliderTimer);
    sliderTimer = setTimeout(
      guard('contour-status', () => contours.setContourInterval(ft)),
      250,
    );
  });
  $('datum').addEventListener(
    'change',
    guard('contour-status', () => contours.setDatum($('datum').value)),
  );
  $('canopy').addEventListener('change', async (event) => {
    const box = event.target;
    try {
      if (!box.checked) return contours.hideCanopy();
      await contours.showCanopy({
        onProgress: (d, n) =>
          say(
            'canopy-status',
            `Sampling Google 3D mesh… ${Math.round((d / n) * 100)}%`,
          ),
      });
    } catch (error) {
      box.checked = false;
      say('canopy-status', error?.message || String(error), 'err');
    }
  });

  // ---- view: topography / buildings ----
  if (!buildings)
    panel.querySelector('[aria-labelledby="st-bldg-h"]').hidden = true;
  else {
    const showBuildings = async () => {
      try {
        await buildings.show({ source: $('bldg-source').value });
      } catch (error) {
        say('bldg-status', error?.message || String(error), 'err');
      }
    };
    $('view-bldg').addEventListener('click', showBuildings);
    $('view-topo').addEventListener('click', () => buildings.hide());
    $('bldg-source').addEventListener('change', () => {
      if (buildings.describe().on) showBuildings();
    });
  }

  // ---- pop-outs: any section, or the whole tray, into a movable panel ----
  const sectionTitle = (section) =>
    section.querySelector('h3')?.firstChild?.textContent?.trim() || 'SITE';
  function popOut(node, key, title) {
    if (!panels) return null;
    if (panels.get?.(key)) return panels.get(key).focus?.();
    const home = document.createComment(`site-tray:${key}`);
    node.replaceWith(home);
    node.classList.add('site-tray-popped');
    return panels.open({
      key,
      title,
      subtitle: 'SITE tools',
      kind: 'site',
      render(body) {
        body.classList.add('site-tray-popbody');
        body.appendChild(node);
      },
      onClose() {
        node.classList.remove('site-tray-popped');
        // The node may sit in another window's document after a pop-out.
        home.replaceWith(document.adoptNode(node));
      },
    });
  }
  if (panels) {
    for (const section of panel.querySelectorAll('.site-tray-section')) {
      const h3 = section.querySelector('h3');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'site-tray-pop';
      btn.title = 'Pop this section out into a movable window';
      btn.setAttribute('aria-label', `Pop out ${sectionTitle(section)}`);
      btn.textContent = '⧉';
      btn.addEventListener('click', () => {
        const inPanel = section.classList.contains('site-tray-popped');
        if (inPanel) return panels.get?.(`site-${h3.id}`)?.close?.();
        popOut(section, `site-${h3.id}`, sectionTitle(section));
      });
      h3.appendChild(btn);
    }
    $('pop-all').addEventListener('click', () => {
      popOut(trayBody, 'site-all', 'SITE');
      setOpen(false);
    });
  } else $('pop-all').hidden = true;

  // ---- orbit ----
  $('orbit').addEventListener(
    'click',
    guard('orbit-status', async () => {
      await orbit.zoom();
      orbit.orbit();
      say('orbit-status', 'Orbiting', 'ok');
    }),
  );
  $('stop').addEventListener('click', () => {
    orbit.stop();
    say('orbit-status', 'Stopped');
  });
  $('record').addEventListener(
    'click',
    guard('orbit-status', async () => {
      const frames = Number($('frames').value) || 144;
      const name = await orbit.record({
        frames,
        title: 'DJI LIDAR L2+ORTHO',
        onProgress: (i, n) =>
          say('orbit-status', `Recording… ${Math.round((i / n) * 100)}%`),
      });
      say('orbit-status', `Saved ${name}`, 'ok');
    }),
  );
  $('open-fc').addEventListener('click', () => {
    setOpen(false);
    onOpenFeaturesCode?.();
  });

  // ---- open / close ----
  const place = () => {
    const rect = toggle.getBoundingClientRect();
    const left = Math.max(
      16,
      Math.min(rect.left, window.innerWidth - panel.offsetWidth - 16),
    );
    panel.style.left = `${left}px`;
    panel.style.bottom = `${Math.max(16, window.innerHeight - rect.top + 10)}px`;
  };
  const setOpen = (open) => {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    item.classList.toggle('open', open);
    if (open) {
      syncBoundary();
      syncContours();
      syncBuildings();
      place();
    }
  };
  toggle.addEventListener('click', () => {
    // With the whole tray popped out, the dock button brings that panel up.
    const popped = panels?.get?.('site-all');
    if (popped) return popped.focus();
    setOpen(panel.hidden);
  });
  panel.querySelector('.site-tray-close').addEventListener('click', () => {
    setOpen(false);
    toggle.focus();
  });
  panel.addEventListener('keydown', (event) => {
    event.stopPropagation(); // keep app shortcuts out while using the tray
    if (event.key === 'Escape') {
      setOpen(false);
      toggle.focus();
    }
  });
  const onResize = () => !panel.hidden && place();
  window.addEventListener('resize', onResize);

  const offBoundary = boundary.onChange(() => {
    syncBoundary();
    syncBuildings();
  });
  const offContours = contours.onChange((state) => syncContours(state));
  const offBuildings = buildings?.onChange((state) => syncBuildings(state));

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    destroy() {
      clearTimeout(sliderTimer);
      offBoundary();
      offContours();
      offBuildings?.();
      window.removeEventListener('resize', onResize);
      item.remove();
      panel.remove();
      filePicker.remove();
    },
  };
}
