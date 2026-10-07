/**
 * Features Code: an in-app command line in the command dock, left of LOCATION.
 *
 * Commands call feature services directly, so features run with no AI
 * attached. The command table doubles as the tool surface a local agent can
 * call later; the `js` escape hatch is for the person at the keyboard only.
 */
import { normalizeDatum } from '../services/contourMath.js';

import { parseLength } from '../services/surveyGeometry.js';
import { openCoordinatePaste } from './coordinatePaste.js';

export const FEATURES_CODE_HELP = `Every feature here is also in the SITE panel in the dock.
Boundary
  boundary draw            click corners on the map; double-click/Enter finishes
  boundary import | load   pick a .kml/.kmz, or a .csv/.txt coordinate list
  circle <radius> [lat,lon]  radius circle (150 m, 500 ft); no lat,lon = click centre
  snap <deg> | snap off    angle snap while drawing (5/15/30/45/90)
  paste                    open the paste box (CSV, "lat, lon" lines, KML)
  coords <lat,lon; ...>    import coordinates typed inline as survey outline
  boundary export          save the boundary as .kml
  boundary clear | clear   remove the boundary
  preset hyland            load the Hyland Hills boundary + GCPs
  site                     show what is loaded
Contours (USGS 3DEP bare earth, inside the boundary)
  contours on | off        draw or hide contours
  contour <ft> [asl|rel]   set the interval, 2-100 ft (also: set contour <ft>)
  elev asl | relative      label elevations above sea level (NAVD88) or
                           relative: 0 ft = lowest point in the boundary
                           (also: datum <mode>, set elev <mode>)
  contour align on | off   snap contours to the Google 3D mesh (measured per site)
  canopy on | off          shade tree/structure cover from the Google 3D mesh
Buildings (only inside the site boundary)
  buildings on | off       switch the view from topography to buildings and back
  buildings mesh | osm     find buildings from the 3D mesh scan or OSM only
  dossier <n>              open the dossier for building n of "buildings list"
  buildings list           list what building mode found
  panels close             close every pop-out panel
Camera
  zoom                     fly to the boundary
  orbit [sec]              live orbit, seconds per revolution (default 24)
  go                       zoom, then orbit
  stop                     stop orbiting and release the camera
  record [frames] [w] [h]  record the orbit as a GIF (default 144, 800x450)
Layers
  layer osm on | off       light OSM streets + building footprints
Console
  cls                      clear this console
  js <expression>          run JavaScript (dev only; viewer, site in scope)
Up/Down recalls history. Esc closes.`;

const datumWords = (d) =>
  d === 'relative'
    ? 'relative (0 ft = lowest point in boundary)'
    : 'above sea level (NAVD88)';

/** Split a command line into a lower-cased name, its arguments and raw tail. */
export function parseCommand(line) {
  const text = String(line ?? '').trim();
  if (!text) return null;
  const [head] = text.split(/\s+/, 1);
  const raw = text.slice(head.length).trim();
  return {
    name: head.toLowerCase(),
    args: raw ? raw.split(/\s+/) : [],
    raw,
  };
}

/** Positive integer argument within bounds, or the fallback. */
export function intArg(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** on/off/toggle parsing; returns true, false or null (toggle). */
export function switchArg(value) {
  const v = String(value ?? '').toLowerCase();
  if (['on', 'show', 'true', '1', 'yes'].includes(v)) return true;
  if (['off', 'hide', 'false', '0', 'no'].includes(v)) return false;
  return null;
}

export const describeSite = (s) =>
  `${s.name} · ${s.areaAcres ?? '?'} ac · ${s.vertices} vertices · ${s.points} points`;

/** Contour status line, in whichever elevation datum is active. */
export function describeContours(state) {
  const st = state.stats;
  if (!st) return `Contours every ${state.intervalFt} ft`;
  const datum =
    st.datum === 'relative'
      ? `ft relative (0 = ${st.baseFt} ft NAVD88, lowest in boundary)`
      : 'ft NAVD88';
  return `Contours every ${state.intervalFt} ft · ${st.lines} lines · ${st.minFt}–${st.maxFt} ${datum} · ${st.resM} m grid${st.cached ? ' (cached)' : ''}`;
}

const DATUM_USAGE = 'Usage: elev asl | relative';

const LAYER_ALIASES = Object.freeze({
  osm: 'osm-streets',
  streets: 'osm-streets',
});

/**
 * Build the command table. Dependencies are injected so it is testable
 * without a DOM or a globe.
 * @param {{ site: {boundary:object, orbit:object, contours:object},
 *   print: Function, clearOutput: Function, pickFile: Function, viewer?: object,
 *   getDataManager?: () => object|null, allowEval?: boolean, recordTitle?: string }} deps
 */
export function createFeatureCommands({
  site,
  print,
  clearOutput,
  pickFile,
  viewer,
  getDataManager = () => null,
  panels = null,
  openPaste = null,
  allowEval = false,
  recordTitle = 'DJI LIDAR L2+ORTHO',
}) {
  const { boundary, orbit, contours, buildings } = site;
  const loadedLine = (summary) =>
    print(`Loaded ${describeSite(summary)}`, 'ok');

  async function importFile() {
    const file = await pickFile();
    if (!file) return print('No file chosen', 'dim');
    loadedLine(
      await boundary.loadKml(file, file.name.replace(/\.km[lz]$/i, '')),
    );
  }

  async function contourSwitch(on, options) {
    if (on === false) {
      contours.hideContours();
      return print('Contours hidden', 'ok');
    }
    const line = print('Loading USGS 3DEP elevation…', 'dim');
    line.textContent = describeContours(await contours.showContours(options));
    line.className = 'fc-ok';
  }

  async function setContour(value, datumArg) {
    const ft = Number(value);
    if (!Number.isFinite(ft))
      return print('Usage: contour <2-100 ft> [asl|relative]', 'err');
    const datum =
      datumArg === undefined ? undefined : normalizeDatum(datumArg, null);
    if (datum === null) return print(DATUM_USAGE, 'err');
    if (contours.describe().contoursOn)
      return contourSwitch(true, { intervalFt: ft, datum });
    if (datum) await contours.setDatum(datum);
    const state = await contours.setContourInterval(ft);
    print(
      `Contour interval set to ${state.intervalFt} ft, ${datumWords(state.datum)} (run "contours on" to draw)`,
      'ok',
    );
  }

  async function setDatum(value) {
    if (value === undefined)
      return print(
        `Elevations: ${datumWords(contours.describe().datum)}. ${DATUM_USAGE}`,
        'dim',
      );
    const datum = normalizeDatum(value, null);
    if (!datum) return print(DATUM_USAGE, 'err');
    if (contours.describe().contoursOn) return contourSwitch(true, { datum });
    await contours.setDatum(datum);
    print(`Elevations: ${datumWords(datum)} (run "contours on" to draw)`, 'ok');
  }

  const commands = {
    help: () => print(FEATURES_CODE_HELP, 'dim'),
    cls: () => clearOutput(),
    async preset([key = 'hyland']) {
      loadedLine(await boundary.loadPreset(key));
    },
    load: importFile,
    async boundary([action = 'status']) {
      switch (action.toLowerCase()) {
        case 'draw': {
          print(
            'Drawing: click corners on the map. Double-click or Enter to finish, Esc to cancel.',
            'dim',
          );
          const done = await boundary.startDraw({
            onHint: (t) => print(t, 'dim'),
          });
          return done ? loadedLine(done) : null;
        }
        case 'import':
        case 'load':
          return importFile();
        case 'export':
          return print(`Saved ${boundary.exportKml()} to Downloads`, 'ok');
        case 'clear':
          boundary.clear();
          return print('Boundary cleared', 'ok');
        case 'finish':
          return boundary.finishDraw();
        case 'cancel':
          return boundary.cancelDraw();
        default: {
          const s = boundary.describe();
          return print(s ? describeSite(s) : 'No boundary yet', 'dim');
        }
      }
    },
    async zoom() {
      await orbit.zoom();
      print('Zoomed to boundary', 'ok');
    },
    orbit([sec]) {
      orbit.orbit({ secondsPerRev: intArg(sec, 24, 4, 600) });
      print('Orbiting. Type "stop" to end.', 'ok');
    },
    async go() {
      await orbit.zoom();
      orbit.orbit();
      print('Zoomed and orbiting. Type "stop" to end.', 'ok');
    },
    stop() {
      orbit.stop();
      print('Stopped', 'ok');
    },
    async record([frames, w, h]) {
      const line = print('Recording… 0%', 'dim');
      const name = await orbit.record({
        frames: intArg(frames, 144, 12, 720),
        width: intArg(w, 800, 160, 1920),
        height: intArg(h, 450, 90, 1080),
        title: recordTitle,
        onProgress: (i, n) => {
          line.textContent = `Recording… ${Math.round((i / n) * 100)}% (${i}/${n})`;
        },
      });
      print(`Saved ${name} to Downloads`, 'ok');
    },
    site() {
      const s = boundary.describe();
      print(s ? describeSite(s) : 'Nothing loaded', 'dim');
    },
    clear() {
      boundary.clear();
      print('Cleared', 'ok');
    },
    contours([value]) {
      return contourSwitch(switchArg(value) ?? !contours.describe().contoursOn);
    },
    async contour([value, arg]) {
      if (/^align$/i.test(value ?? '')) {
        const on = switchArg(arg) ?? !contours.describe().autoAlign;
        await contours.setAutoAlign(on);
        return print(
          on
            ? 'Contour mesh alignment on (needs the Google 3D map source)'
            : 'Contour mesh alignment off',
          'ok',
        );
      }
      const on = switchArg(value);
      if (on !== null) return contourSwitch(on);
      return setContour(value, arg);
    },
    elev([value]) {
      return setDatum(value);
    },
    datum([value]) {
      return setDatum(value);
    },
    set([name, value, datum]) {
      if (/^contours?$/i.test(name ?? '')) return setContour(value, datum);
      if (/^(elev|elevation|elevations|datum)$/i.test(name ?? ''))
        return setDatum(value);
      print('Usage: set contour <2-100 ft> | set elev asl|relative', 'err');
    },
    async canopy([value]) {
      const on = switchArg(value) ?? !contours.describe().canopyOn;
      if (!on) {
        contours.hideCanopy();
        return print('Canopy hidden', 'ok');
      }
      const line = print('Sampling the Google 3D mesh… 0%', 'dim');
      const state = await contours.showCanopy({
        onProgress: (done, total) => {
          line.textContent = `Sampling the Google 3D mesh… ${Math.round((done / total) * 100)}%`;
        },
      });
      line.textContent = `Canopy: ${state.canopy.coveredPct}% of the site under trees/structures (${state.canopy.cellM} m cells)`;
      line.className = 'fc-ok';
    },
    async circle([radius, at]) {
      const radiusM = parseLength(radius ?? '');
      if (!radiusM)
        return print(
          'Usage: circle <radius> [lat,lon], e.g. circle 500ft',
          'err',
        );
      if (at) {
        const [lat, lon] = at.split(',').map(Number);
        if (!Number.isFinite(lat) || !Number.isFinite(lon))
          return print('Centre as lat,lon, e.g. 44.8402,-93.3666', 'err');
        return loadedLine(await boundary.setCircle([lon, lat], radiusM));
      }
      print('Click the circle centre on the map. Esc cancels.', 'dim');
      const done = await boundary.startCircle({
        radiusM,
        onHint: (t) => print(t, 'dim'),
      });
      return done ? loadedLine(done) : null;
    },
    snap([value]) {
      const off = switchArg(value) === false;
      const deg = off ? 0 : Number(value);
      if (!off && !(deg >= 0 && deg <= 90))
        return print(
          `Snap is ${boundary.snapDeg || 'off'}°. Usage: snap <deg> | snap off`,
          'dim',
        );
      boundary.snapDeg = deg;
      print(
        deg ? `Drawing snaps to ${deg}° (hold Alt for free)` : 'Snapping off',
        'ok',
      );
    },
    paste() {
      if (!openPaste) return print('Paste box not available', 'err');
      openPaste();
      print('Paste box open: paste CSV, "lat, lon" lines or KML', 'ok');
    },
    async coords(_args, raw) {
      if (!raw)
        return print(
          'Usage: coords 44.84,-93.36; 44.85,-93.35; 44.85,-93.37',
          'err',
        );
      const out = await boundary.importText(raw.split(';').join('\n'), {
        mode: 'outline',
      });
      loadedLine(out.site);
    },
    async buildings([value]) {
      if (!buildings) return print('Building mode is not available', 'err');
      const v = String(value ?? '').toLowerCase();
      if (v === 'list') {
        const list = buildings.list().filter((r) => r.kind === 'building');
        if (!list.length)
          return print('No buildings yet. Run "buildings on".', 'dim');
        return print(
          list
            .slice(0, 40)
            .map(
              (r, i) =>
                `${i + 1}. ${r.tags.name || r.id} · ${Math.round(r.measure.areaM2)} m² · ${r.height.heightM.toFixed(1)} m · ${Math.round(r.volumeM3)} m³`,
            )
            .join('\n'),
          'dim',
        );
      }
      const on =
        v === 'mesh' || v === 'osm'
          ? true
          : (switchArg(v) ?? !buildings.describe().on);
      if (!on) {
        await buildings.hide();
        return print('Back to topography', 'ok');
      }
      const line = print('Finding buildings…', 'dim');
      const state = await buildings.show({
        source: v === 'mesh' || v === 'osm' ? v : 'auto',
      });
      const c = state.counts;
      line.textContent = `${c.buildings} buildings · ${c.roads} roads · ${c.parks} parks (${state.source})${state.osmError ? ` · OSM: ${state.osmError}` : ''}. Click one for its dossier.`;
      line.className = 'fc-ok';
    },
    dossier([n]) {
      const list = buildings?.list().filter((r) => r.kind === 'building') ?? [];
      const record = list[intArg(n, 0, 1, list.length || 1) - 1];
      if (!record)
        return print('Usage: dossier <n> (see "buildings list")', 'err');
      buildings.pick(record.id);
      print(`Opened dossier for ${record.tags.name || record.id}`, 'ok');
    },
    panels([action]) {
      if (String(action).toLowerCase() !== 'close')
        return print('Usage: panels close', 'err');
      panels?.closeAll();
      print('Closed all pop-out panels', 'ok');
    },
    async layer([name, value]) {
      const id = LAYER_ALIASES[String(name ?? '').toLowerCase()] ?? name;
      const dm = getDataManager();
      if (!id) return print('Usage: layer osm on|off', 'err');
      if (!dm?.layers?.has?.(id))
        return print(`Unknown layer "${name}"`, 'err');
      const want = switchArg(value) ?? !dm.isEffectivelyEnabled(id);
      if (dm.isEffectivelyEnabled(id) !== want)
        await dm.toggle(id, { origin: 'user' });
      print(`${id} ${want ? 'on' : 'off'}`, 'ok');
    },
  };
  if (allowEval) {
    commands.js = async (_args, raw) => {
      if (!raw) return print('Usage: js <expression>', 'dim');
      // Only text typed by the person at the keyboard reaches this.
      const fn = new Function(
        'viewer',
        'site',
        `return (async () => (${raw}))();`,
      );
      const result = await fn(viewer, site);
      if (result !== undefined) {
        let text;
        try {
          text =
            typeof result === 'object'
              ? JSON.stringify(result, null, 2)
              : String(result);
        } catch {
          text = String(result);
        }
        print(text, 'dim');
      }
    };
  }

  async function run(line) {
    const parsed = parseCommand(line);
    if (!parsed) return false;
    const command = Object.hasOwn(commands, parsed.name)
      ? commands[parsed.name]
      : null;
    if (!command) {
      print(`Unknown command "${parsed.name}". Type help.`, 'err');
      return false;
    }
    try {
      await command(parsed.args, parsed.raw);
      return true;
    } catch (error) {
      print(error?.message || String(error), 'err');
      return false;
    }
  }

  return { commands, run };
}

/**
 * Mount the dock button and console panel.
 * @param {{ viewer: object, site: object, getDataManager?: Function, dock?: HTMLElement|null }} options
 */
export function mountFeaturesCode({
  viewer,
  site,
  getDataManager,
  dock,
  panels,
} = {}) {
  const host = dock ?? document.getElementById('command-dock');
  const item = document.createElement('div');
  item.id = 'features-code';
  item.className = 'features-code-dock';
  item.innerHTML = `
    <button id="features-code-toggle" class="features-code-toggle" type="button"
      aria-expanded="false" aria-controls="features-code-panel" title="Open Features Code">
      <span class="features-code-glyph" aria-hidden="true">&gt;_</span>
      <span class="features-code-label">FEATURES CODE</span>
    </button>`;
  const locationBar = host?.querySelector('#location-bar');
  if (host && locationBar) host.insertBefore(item, locationBar);
  else if (host) host.prepend(item);
  else {
    item.classList.add('features-code-floating');
    document.body.appendChild(item);
  }
  const toggle = item.querySelector('button');

  const panel = document.createElement('section');
  panel.id = 'features-code-panel';
  panel.className = 'features-code-panel';
  panel.setAttribute('aria-label', 'Features Code');
  panel.hidden = true;
  panel.innerHTML = `
    <header class="features-code-head">
      <span>FEATURES CODE</span>
      <button type="button" class="features-code-close" aria-label="Close Features Code">×</button>
    </header>
    <div class="features-code-out" role="log" aria-live="polite"></div>
    <label class="features-code-row">
      <span aria-hidden="true">&gt;</span>
      <input id="features-code-input" type="text" spellcheck="false" autocomplete="off"
        placeholder="type help" aria-label="Features command" />
    </label>`;
  document.body.appendChild(panel);
  const out = panel.querySelector('.features-code-out');
  const input = panel.querySelector('input');

  const filePicker = document.createElement('input');
  filePicker.type = 'file';
  filePicker.accept = '.kml,.kmz';
  filePicker.hidden = true;
  document.body.appendChild(filePicker);
  const pickFile = () =>
    new Promise((resolve) => {
      filePicker.value = '';
      filePicker.onchange = () => resolve(filePicker.files?.[0] ?? null);
      filePicker.oncancel = () => resolve(null);
      filePicker.click();
    });

  const print = (text, tone = '') => {
    const line = document.createElement('div');
    if (tone) line.className = `fc-${tone}`;
    line.textContent = text;
    out.appendChild(line);
    out.scrollTop = out.scrollHeight;
    return line;
  };

  const { run } = createFeatureCommands({
    site,
    print,
    getDataManager,
    clearOutput: () => out.replaceChildren(),
    pickFile,
    viewer,
    panels,
    openPaste: panels
      ? () =>
          openCoordinatePaste({
            panels,
            boundary: site.boundary,
            orbit: site.orbit,
          })
      : null,
    allowEval: Boolean(import.meta.env?.DEV),
  });

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
      place();
      input.focus();
    }
  };
  const onToggle = () => setOpen(panel.hidden);
  const onResize = () => {
    if (!panel.hidden) place();
  };
  toggle.addEventListener('click', onToggle);
  panel.querySelector('.features-code-close').addEventListener('click', () => {
    setOpen(false);
    toggle.focus();
  });
  window.addEventListener('resize', onResize);

  const history = [];
  let cursor = 0;
  input.addEventListener('keydown', async (event) => {
    // Keep app shortcuts (Space for voice, number keys for styles) out of the console.
    event.stopPropagation();
    if (event.key === 'Enter') {
      const value = input.value;
      input.value = '';
      if (!value.trim()) return;
      history.push(value);
      cursor = history.length;
      print(`> ${value}`, 'in');
      await run(value);
    } else if (event.key === 'ArrowUp' && cursor > 0) {
      event.preventDefault();
      input.value = history[--cursor];
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      cursor = Math.min(history.length, cursor + 1);
      input.value = history[cursor] ?? '';
    } else if (event.key === 'Escape') {
      setOpen(false);
      toggle.focus();
    }
  });
  input.addEventListener('keyup', (event) => event.stopPropagation());
  input.addEventListener('keypress', (event) => event.stopPropagation());

  print(
    'Features Code ready. Try: preset hyland, then go, then record. Type help for all commands.',
    'dim',
  );

  return {
    run,
    open: () => setOpen(true),
    close: () => setOpen(false),
    destroy() {
      window.removeEventListener('resize', onResize);
      toggle.removeEventListener('click', onToggle);
      item.remove();
      panel.remove();
      filePicker.remove();
    },
  };
}
