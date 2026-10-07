/**
 * Features Code: an in-app command line in the command dock, left of LOCATION.
 *
 * Commands call feature services directly, so features run with no AI
 * attached. The command table doubles as the tool surface a local agent can
 * call later; the `js` escape hatch is for the person at the keyboard only.
 */
import { normalizeDatum } from '../services/contourMath.js';
import { describeRow as describeAirspace } from '../layers/airspace/records.js';
import { parseLength } from '../services/surveyGeometry.js';
import { parseHeightM, parseHeightRange } from '../services/viewshedMath.js';
import { openCoordinatePaste } from './coordinatePaste.js';
import {
  describeSummary,
  describeTurbine,
  nearestTurbine,
} from '../layers/windTurbines/records.js';
import { formatCountdown } from '../services/phoneLink.js';

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
Viewshed (only inside the site boundary)
  viewshed [eye]           click the observer spot; eye height (1.7m, 30ft)
                           or a band (1-2.5m: green = low eye, amber = high only)
  viewshed <lat,lon> [eye] [target]  observer at lat,lon; target 0 = ground
  viewshed mesh | dem | auto  heights: 3D mesh (buildings + trees block),
                           USGS bare earth, or auto (mesh when it is on)
  viewshed gpu dedicated | integrated | cpu  which processor runs it
  viewshed off             clear the viewshed
Aircraft (or double-click a plane on the globe)
  plane [callsign|tail|hex]  ride in its cockpit and open its details;
                           no name = the plane you are following
  plane info [name]        open the details pop-out only
  plane exit               leave the cockpit view
Camera
  zoom                     fly to the boundary
  orbit [sec]              live orbit, seconds per revolution (default 24)
  go                       zoom, then orbit
  stop                     stop orbiting and release the camera
  record [frames] [w] [h]  record the orbit as a GIF (default 144, 800x450)
Layers
  layer osm on | off       light OSM streets + building footprints
  turbines [on | off]      US wind turbines (USGS USWTDB); bare = summary
                           of turbines in view (count, MW, tallest)
  turbines near            the turbine nearest the view centre
Airspace (FAA open data; advisory, not a clearance)
  airspace on | off        TFRs, Class B/C/D/E, special use, LAANC grid
  airspace tfr|class|sua|laanc on | off
                           show or hide one kind
  airspace 3d on | off     extrude floors/ceilings and LAANC ceilings
  airspace check           what is over the boundary center (or screen
                           center) + Part 107 advisory
Places
  goto <place | lat, lon>  fly there (same search as the LOCATION bar)
Phone remote (also the PHONE button in the dock)
  phone pair               show a code to pair a phone on this Wi-Fi
  phone devices            list paired phones
  phone revoke <id|all>    unpair a phone
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
  airspace: 'airspace',
  faa: 'airspace',
  turbines: 'wind-turbines',
  uswtdb: 'wind-turbines',
});

const AIRSPACE_USAGE =
  'Usage: airspace on|off | airspace tfr|class|sua|laanc|3d on|off | airspace check';
const AIRSPACE_KIND_ARGS = Object.freeze({
  tfr: 'tfr',
  tfrs: 'tfr',
  class: 'class',
  classes: 'class',
  sua: 'sua',
  laanc: 'laanc',
  grid: 'laanc',
  '3d': 'volumes',
  volumes: 'volumes',
});

const TURBINES_ID = 'wind-turbines';

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
  aircraft = null,
  openPaste = null,
  getViewCenter = () => null,
  allowEval = false,
  recordTitle = 'DJI LIDAR L2+ORTHO',
  phone = null,
  goTo = null,
}) {
  const { boundary, orbit, contours, buildings, viewshed } = site;
  function viewshedLine(state) {
    const r = state.result;
    if (!r) return print('No viewshed', 'err');
    const eyes = r.banded
      ? `${r.lowPct}% of the site seen from ${r.lowM} m, ${r.highPct}% from ${r.highM} m`
      : `${r.highPct}% of the site visible from ${r.highM} m`;
    const secs = (ms) => `${(ms / 1000).toFixed(2)} s`;
    print(
      `Viewshed: ${eyes} (target ${state.targetM} m) · farthest ${r.farthestHighM} m · ${r.sourceLabel}, ${r.cellM} m cells · heights ${r.heightsCached ? 'ready' : secs(r.heightsMs)}, sight lines ${secs(r.computeMs)} on ${r.engine}`,
      'ok',
    );
  }
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

  async function ensureLayer(dm, id, want = true) {
    if (dm.isEffectivelyEnabled(id) !== want)
      await dm.toggle(id, { origin: 'user' });
  }

  async function airspaceCommand([action, value]) {
    const dm = getDataManager();
    if (!dm?.layers?.has?.('airspace'))
      return print('Airspace layer is not available', 'err');
    const module = dm.layers.get('airspace').module;
    const word = String(action ?? '').toLowerCase();
    const on = switchArg(word);
    if (!word || on !== null) {
      const want = on ?? !dm.isEffectivelyEnabled('airspace');
      await ensureLayer(dm, 'airspace', want);
      return print(`airspace ${want ? 'on' : 'off'}`, 'ok');
    }
    if (Object.hasOwn(AIRSPACE_KIND_ARGS, word)) {
      const key = AIRSPACE_KIND_ARGS[word];
      const want = switchArg(value) ?? !module.getParams()[key];
      await ensureLayer(dm, 'airspace');
      if (!dm.setLayerParams('airspace', { [key]: want }, { origin: 'user' }))
        module.setParams({ [key]: want });
      return print(`airspace ${word} ${want ? 'on' : 'off'}`, 'ok');
    }
    if (word === 'check' || word === 'here') {
      const s = boundary.describe();
      const at = s?.center ?? getViewCenter();
      if (!at) return print('No boundary and no screen center to check', 'err');
      await ensureLayer(dm, 'airspace');
      const line = print('Checking FAA airspace…', 'dim');
      const result = await module.checkAt(at.lon, at.lat);
      line.textContent = `Airspace at ${s ? `${s.name} center` : 'screen center'} (${at.lat.toFixed(5)}, ${at.lon.toFixed(5)}):`;
      for (const row of result.hits) print(`  ${describeAirspace(row)}`, 'dim');
      if (!result.hits.length) print('  no charted airspace found', 'dim');
      for (const note of result.notes)
        print(note, result.level === 'stop' ? 'err' : 'ok');
      return;
    }
    print(AIRSPACE_USAGE, 'err');
  }

  /** Turn a data layer on/off (null toggles) through the data manager. */
  async function setLayer(id, want, label = id) {
    const dm = getDataManager();
    if (!dm?.layers?.has?.(id)) return print(`Unknown layer "${label}"`, 'err');
    const target = want ?? !dm.isEffectivelyEnabled(id);
    if (dm.isEffectivelyEnabled(id) !== target)
      await dm.toggle(id, { origin: 'user' });
    print(`${id} ${target ? 'on' : 'off'}`, 'ok');
  }

  const commands = {
    airspace: airspaceCommand,
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
    async viewshed(args) {
      if (!viewshed) return print('Viewshed is not available', 'err');
      const [first, ...rest] = args;
      if (switchArg(first) === false) {
        viewshed.clear();
        return print('Viewshed cleared', 'ok');
      }
      if (first === 'gpu') {
        const mode = rest[0];
        if (!['dedicated', 'integrated', 'cpu'].includes(mode))
          return print(
            `Computing on: ${viewshed.describe().gpu}. Usage: viewshed gpu dedicated|integrated|cpu`,
            'dim',
          );
        viewshed.setOptions({ gpu: mode });
        if (!viewshed.describe().observer)
          return print(`Viewshed will compute on: ${mode}`, 'ok');
        return viewshedLine(await viewshed.compute());
      }
      if (['mesh', 'dem', 'auto'].includes(first)) {
        viewshed.setOptions({ source: first });
        if (!viewshed.describe().observer)
          return print(
            `Viewshed heights: ${first}. Run "viewshed" to place an observer.`,
            'ok',
          );
        return viewshedLine(await viewshed.compute());
      }
      let at = null;
      let heights = args;
      if (first?.includes(',')) {
        const [lat, lon] = first.split(',').map(Number);
        if (!Number.isFinite(lat) || !Number.isFinite(lon))
          return print('Observer as lat,lon, e.g. 44.8402,-93.3666', 'err');
        at = [lon, lat];
        heights = rest;
      }
      const [eyeText, targetText] = heights;
      const eye = eyeText != null ? parseHeightRange(eyeText) : undefined;
      const targetM = targetText != null ? parseHeightM(targetText) : undefined;
      if (eye === null || targetM === null)
        return print('Eye like 1.7, 10m, 30ft or a band like 1-2.5m', 'err');
      const opts = { lowM: eye?.lowM, highM: eye?.highM, targetM };
      if (at) {
        print('Tracing sight lines…', 'dim');
        return viewshedLine(await viewshed.compute({ at, ...opts }));
      }
      print('Click the observer spot inside the boundary. Esc cancels.', 'dim');
      const state = await viewshed.pickObserver(opts);
      return state ? viewshedLine(state) : print('Cancelled', 'dim');
    },
    dossier([n]) {
      const list = buildings?.list().filter((r) => r.kind === 'building') ?? [];
      const record = list[intArg(n, 0, 1, list.length || 1) - 1];
      if (!record)
        return print('Usage: dossier <n> (see "buildings list")', 'err');
      buildings.pick(record.id);
      print(`Opened dossier for ${record.tags.name || record.id}`, 'ok');
    },
    async plane([first, ...rest]) {
      if (!aircraft) return print('Aircraft details are not available', 'err');
      const action = String(first ?? '').toLowerCase();
      if (action === 'exit') {
        return aircraft.exitCockpit()
          ? print('Left the cockpit view', 'ok')
          : print('Not in the cockpit view', 'dim');
      }
      const infoOnly = action === 'info';
      const query = (infoOnly ? rest : [first, ...rest])
        .filter(Boolean)
        .join(' ');
      const target = aircraft.find(query);
      if (!target)
        return print(
          query
            ? `No aircraft matching "${query}" in the Flights or Military layers`
            : 'Follow a plane first, or name one: plane <callsign|tail|hex>',
          'err',
        );
      const label = `${target.id.toUpperCase()} (${target.layerId})`;
      if (infoOnly) {
        aircraft.openDetails(target);
        return print(`Opened details for ${label}`, 'ok');
      }
      const result = await aircraft.flyIn(target);
      print(
        result.ok
          ? `In the cockpit of ${label}; details open`
          : `Opened details for ${label}; cockpit unavailable: ${result.error}`,
        result.ok ? 'ok' : 'err',
      );
    },
    panels([action]) {
      if (String(action).toLowerCase() !== 'close')
        return print('Usage: panels close', 'err');
      panels?.closeAll();
      print('Closed all pop-out panels', 'ok');
    },
    async layer([name, value]) {
      const id = LAYER_ALIASES[String(name ?? '').toLowerCase()] ?? name;
      if (!id) return print('Usage: layer osm on|off', 'err');
      await setLayer(id, switchArg(value), name);
    },
    async turbines([arg]) {
      const on = switchArg(arg);
      if (on !== null) return setLayer(TURBINES_ID, on);
      const near = String(arg ?? '').toLowerCase() === 'near';
      if (arg !== undefined && !near)
        return print('Usage: turbines [on|off|near]', 'err');
      const dm = getDataManager();
      const layer = dm?.layers?.get?.(TURBINES_ID)?.module;
      if (!layer) return print('Wind turbine layer unavailable', 'err');
      if (!dm.isEffectivelyEnabled(TURBINES_ID))
        await setLayer(TURBINES_ID, true);
      const line = print('Loading USWTDB turbines in view…', 'dim');
      await layer.update?.();
      const view = layer.getView?.();
      const error = layer.getStats?.().error;
      if (!view) {
        line.textContent = error || 'No wind turbine data yet';
        line.className = 'fc-err';
        return;
      }
      line.className = 'fc-ok';
      if (!near) {
        line.textContent = describeSummary(view);
        return;
      }
      const at = viewer?.camera?.positionCartographic;
      const hit =
        at &&
        nearestTurbine(
          view.turbines,
          (at.longitude * 180) / Math.PI,
          (at.latitude * 180) / Math.PI,
        );
      line.textContent = hit
        ? `${hit.km.toFixed(1)} km: ${describeTurbine(hit.turbine)}`
        : 'No turbines in view';
    },
    async goto(_args, raw) {
      if (!raw) return print('Usage: goto <place | lat, lon>', 'err');
      if (!goTo) return print('Place search is not available', 'err');
      await goTo(raw);
      print(`Flying to ${raw}`, 'ok');
    },
    async phone([action = 'status', id]) {
      if (!phone) return print('The phone remote is not available', 'err');
      const describeDevices = (devices) =>
        devices.length
          ? devices
              .map(
                (d) =>
                  `${d.id}  ${d.name}  (paired ${new Date(d.pairedAt).toLocaleTimeString()})`,
              )
              .join('\n')
          : 'No phones paired';
      switch (action.toLowerCase()) {
        case 'pair': {
          const state = await phone.startPairing();
          print(
            `Pairing code ${state.pairing.code} (expires in ${formatCountdown(state.pairing.expiresAt)})`,
            'ok',
          );
          return print(
            state.lanReady && state.urls.length
              ? `On the phone, open ${state.urls.join(' or ')}`
              : `${state.hint}${state.urls.length ? ` Then open ${state.urls[0]} on the phone.` : ''}`,
            state.lanReady && state.urls.length ? 'ok' : 'err',
          );
        }
        case 'devices':
          return print(describeDevices((await phone.refresh()).devices), 'dim');
        case 'revoke': {
          if (!id) return print('Usage: phone revoke <id|all>', 'err');
          const state = await phone.revoke(id);
          return print(`Revoked. ${describeDevices(state.devices)}`, 'ok');
        }
        default: {
          const state = await phone.refresh();
          const { bridgeOn } = phone.describe();
          return print(
            `${state.devices.length} phone(s) paired · ${bridgeOn ? 'taking phone commands' : 'not taking phone commands'}` +
              (state.lanReady
                ? ` · ${state.urls.join(' or ')}`
                : ` · ${state.hint}`),
            'dim',
          );
        }
      }
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

/** Ground point under the middle of the screen, in degrees, or null. */
function viewCenter(viewer) {
  const canvas = viewer?.scene?.canvas;
  if (!canvas) return null;
  const ellipsoid = viewer.scene.globe?.ellipsoid;
  const hit = viewer.camera.pickEllipsoid(
    { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 },
    ellipsoid,
  );
  if (!hit || !ellipsoid) return null;
  const c = ellipsoid.cartesianToCartographic(hit);
  if (!c) return null;
  return {
    lon: (c.longitude * 180) / Math.PI,
    lat: (c.latitude * 180) / Math.PI,
  };
}

/**
 * Run Features Code lines without the console, collecting what they print.
 * The phone bridge uses this; it never offers `js` and never picks files.
 */
export function createCapturedRunner(deps) {
  let lines = [];
  const print = (text, tone = '') => {
    // Commands rewrite a line they printed (progress -> result); keep the
    // object so the final text is what gets reported.
    const line = {
      textContent: String(text),
      className: tone ? `fc-${tone}` : '',
    };
    lines.push(line);
    return line;
  };
  const { run } = createFeatureCommands({
    getViewCenter: () => viewCenter(deps.viewer),
    ...deps,
    print,
    clearOutput: () => {},
    pickFile: async () => null,
    allowEval: false,
  });
  return async (line) => {
    lines = [];
    const ok = await run(line);
    return {
      ok,
      lines: lines.map((l) => ({
        text: l.textContent,
        tone: String(l.className).replace(/^fc-/, ''),
      })),
    };
  };
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
  aircraft,
  phone,
  goTo,
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
    aircraft,
    openPaste: panels
      ? () =>
          openCoordinatePaste({
            panels,
            boundary: site.boundary,
            orbit: site.orbit,
          })
      : null,
    getViewCenter: () => viewCenter(viewer),
    allowEval: Boolean(import.meta.env?.DEV),
    phone,
    goTo,
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
