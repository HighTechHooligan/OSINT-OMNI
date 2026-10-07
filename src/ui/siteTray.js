/**
 * SITE: dock popdown with the GUI for every site feature — boundary (draw,
 * import, export, clear), contours (on/off + 2–100 ft slider), canopy, and
 * orbit/record. Features Code exposes the same actions as commands; both
 * call the same services.
 */
import {
  CONTOUR_MAX_FT,
  CONTOUR_MIN_FT,
  clampIntervalFt,
} from '../services/contourMath.js';

const ACRES = (s) => (s?.areaAcres != null ? `${s.areaAcres} ac` : '');

const fmtShift = (m, pos, neg) =>
  `${Math.abs(m).toFixed(1)} m ${m >= 0 ? pos : neg}`;

export function mountSiteTray({ site, dock, onOpenFeaturesCode } = {}) {
  const { boundary, orbit, contours } = site;
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
      <button type="button" class="site-tray-close" aria-label="Close site tools">×</button>
    </header>
    <div class="site-tray-body">
      <section class="site-tray-section" aria-labelledby="st-boundary-h">
        <h3 id="st-boundary-h">Boundary</h3>
        <p class="site-tray-status" data-st="boundary-status">No boundary yet</p>
        <div class="site-tray-row">
          <button type="button" data-st="draw">Draw</button>
          <button type="button" data-st="import">Import KML/KMZ</button>
          <button type="button" data-st="export" disabled>Export KML</button>
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
        <p class="site-tray-status" data-st="contour-status"></p>
        <label class="site-tray-switch">
          <input type="checkbox" id="st-canopy" data-st="canopy" />
          <span>Canopy overlay <small>(Google 3D mesh above ground)</small></span>
        </label>
        <p class="site-tray-status" data-st="canopy-status"></p>
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
  const $ = (key) => panel.querySelector(`[data-st="${key}"]`);
  const slider = panel.querySelector('#st-interval');

  const filePicker = document.createElement('input');
  filePicker.type = 'file';
  filePicker.accept = '.kml,.kmz';
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
    say(
      'boundary-status',
      boundary.isDrawing
        ? 'Drawing… click corners, double-click or Enter to finish'
        : has
          ? `${s.name} · ${ACRES(s)} · ${s.vertices} corners · ${s.points} points`
          : 'No boundary yet',
    );
    for (const key of ['export', 'zoom', 'clear', 'orbit', 'record'])
      $(key).disabled = !has;
    $('draw').textContent = boundary.isDrawing ? 'Finish' : 'Draw';
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
    const st = state.stats;
    if (state.contoursOn && st)
      say(
        'contour-status',
        `${st.lines} lines · ${st.minFt}–${st.maxFt} ft NAVD88 · ${st.resM} m grid${st.cached ? ' · cached' : ''}${alignNote(st)}`,
        'ok',
      );
    else if (!state.contoursOn) say('contour-status', '');
    if (state.canopyOn && state.canopy)
      say(
        'canopy-status',
        `${state.canopy.coveredPct}% under trees/structures`,
        'ok',
      );
    else if (!state.canopyOn) say('canopy-status', '');
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
      await boundary.loadKml(file, file.name.replace(/\.km[lz]$/i, ''));
    }),
  );
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
      place();
    }
  };
  toggle.addEventListener('click', () => setOpen(panel.hidden));
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

  const offBoundary = boundary.onChange(() => syncBoundary());
  const offContours = contours.onChange((state) => syncContours(state));

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    destroy() {
      clearTimeout(sliderTimer);
      offBoundary();
      offContours();
      window.removeEventListener('resize', onResize);
      item.remove();
      panel.remove();
      filePicker.remove();
    },
  };
}
