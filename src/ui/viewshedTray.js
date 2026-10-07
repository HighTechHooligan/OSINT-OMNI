/**
 * VIEWSHED: its own dock tab. Pick what the observer is (a point, a route
 * such as a walking path or a drive, an area such as a park, or a radius
 * circle) with the same click tools as SITE, set the eye band (default
 * 0–2.5 m) and how far to look (reach, default 1 km), and orbit the result.
 * Every section (or the whole tab) pops out into a movable panel. Features
 * Code `viewshed …` runs the same service.
 */
import { parseLength, SNAP_STEPS_DEG } from '../services/surveyGeometry.js';
import { dedicatedGpuAdvice } from '../services/viewshedGpu.js';
import { parseHeightM, parseHeightRange } from '../services/viewshedMath.js';
import { parseShapeText } from '../services/viewshedShapes.js';

const fmtArea = (m2) =>
  m2 >= 1e6
    ? `${(m2 / 1e6).toFixed(2)} km²`
    : m2 >= 40_469
      ? `${(m2 / 4046.86).toFixed(1)} ac`
      : `${Math.round(m2).toLocaleString()} m²`;
const fmtLen = (m) =>
  m >= 1000
    ? `${(m / 1000).toFixed(2)} km (${(m / 1609.344).toFixed(2)} mi)`
    : `${Math.round(m)} m`;
const fmtM = (m) => `${Math.round(m * 10) / 10} m`;
const fmtSec = (ms) =>
  ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;

/** One line about the observer shape. */
export function shapeLine(shape) {
  if (!shape) return 'No observer yet: pick a point, a route or an area';
  if (shape.kind === 'point') return 'Point observer';
  if (shape.kind === 'line')
    return `Route · ${fmtLen(shape.lengthM)} · ${shape.points} points`;
  return shape.radiusM
    ? `Radius circle · ${shape.radiusM} m · ${fmtArea(shape.areaM2)}`
    : `Area · ${fmtArea(shape.areaM2)} · ${shape.points - 1} corners`;
}

/** The result as one status line. */
export function resultLine(r) {
  const eyes = r.banded
    ? `${r.lowPct}% seen from ${fmtM(r.lowM)}, ${r.highPct}% from ${fmtM(r.highM)}`
    : `${r.highPct}% visible from ${fmtM(r.highM)}`;
  const area = r.banded
    ? `${fmtArea(r.bothM2)} + ${fmtArea(r.highOnlyM2)} more from the high eye, ${fmtArea(r.hiddenM2)} hidden`
    : `${fmtArea(r.bothM2)} seen, ${fmtArea(r.hiddenM2)} hidden`;
  const who =
    r.kind === 'point'
      ? `farthest ${r.farthestHighM} m`
      : `${r.observers} observers ${r.spacingM} m apart`;
  const heights = r.heightsCached
    ? 'heights ready'
    : `heights ${fmtSec(r.heightsMs)}`;
  return `${eyes} · ${area} within ${fmtLen(r.reachM)} · ${who} · ${r.sourceLabel}, ${r.cellM} m cells (${r.cells.toLocaleString()}) · ${heights}, sight lines ${fmtSec(r.computeMs)} on ${r.engine}`;
}

export function mountViewshedTray({
  viewshed,
  orbit,
  boundary,
  dock,
  onOpenFeaturesCode,
  panels = null,
} = {}) {
  const host = dock ?? document.getElementById('command-dock');
  const item = document.createElement('div');
  item.id = 'viewshed-tray';
  item.className = 'site-tray-dock';
  item.innerHTML = `
    <button id="viewshed-tray-toggle" class="site-tray-toggle" type="button"
      aria-expanded="false" aria-controls="viewshed-tray-panel" title="Viewshed from a point, a route or an area">
      <span class="site-tray-glyph" aria-hidden="true">◉</span>
      <span class="site-tray-label">VIEWSHED</span>
    </button>`;
  const siteItem = host?.querySelector('#site-tray');
  const locationBar = host?.querySelector('#location-bar');
  if (siteItem) siteItem.after(item);
  else if (host && locationBar) host.insertBefore(item, locationBar);
  else if (host) host.prepend(item);
  else {
    item.classList.add('site-tray-floating');
    document.body.appendChild(item);
  }
  const toggle = item.querySelector('button');

  const panel = document.createElement('section');
  panel.id = 'viewshed-tray-panel';
  panel.className = 'site-tray-panel';
  panel.setAttribute('aria-label', 'Viewshed tools');
  panel.hidden = true;
  panel.innerHTML = `
    <header class="site-tray-head">
      <span>VIEWSHED</span>
      <button type="button" class="site-tray-pop" data-vs="pop-all" title="Pop the whole VIEWSHED panel out into a movable window" aria-label="Pop out viewshed tools">⧉</button>
      <button type="button" class="site-tray-close" aria-label="Close viewshed tools">×</button>
    </header>
    <div class="site-tray-body">
      <section class="site-tray-section" aria-labelledby="vt-shape-h">
        <h3 id="vt-shape-h">Observer <small>point, route or area</small></h3>
        <p class="site-tray-status" data-vs="shape-status"></p>
        <div class="site-tray-row">
          <button type="button" data-vs="point" title="Click one observer spot">Point</button>
          <button type="button" data-vs="line" title="Click along a walking path or a drive; double-click or Enter to finish">Route</button>
          <button type="button" data-vs="area" title="Click the corners of a park or any area; double-click or Enter to finish">Area</button>
          <button type="button" data-vs="finish" hidden>Finish</button>
        </div>
        <div class="site-tray-row">
          <button type="button" data-vs="circle" title="Click a centre; type a radius or click the edge">Radius circle</button>
          <input type="text" class="site-tray-input" data-vs="radius" inputmode="decimal"
            placeholder="radius: 150 m, 500 ft" aria-label="Circle radius" size="12" />
          <label class="site-tray-select">Snap
            <select data-vs="snap" aria-label="Angle snap while drawing">
              ${SNAP_STEPS_DEG.map((d) => `<option value="${d}"${d === 15 ? ' selected' : ''}>${d ? `${d}°` : 'Off'}</option>`).join('')}
            </select>
          </label>
        </div>
        <div class="site-tray-row">
          <button type="button" data-vs="use-site" disabled title="Use the SITE boundary (an imported park KML, say) as the observer area">Use SITE boundary</button>
        </div>
        <div class="site-tray-row">
          <textarea class="site-tray-input vt-coords" data-vs="coords" rows="2"
            placeholder="Paste a route or area: lat, lon per line, pairs separated by ;, or KML"
            aria-label="Route or area coordinates"></textarea>
        </div>
        <div class="site-tray-row">
          <button type="button" data-vs="paste-line">Paste as route</button>
          <button type="button" data-vs="paste-area">Paste as area</button>
        </div>
      </section>

      <section class="site-tray-section" aria-labelledby="vt-settings-h">
        <h3 id="vt-settings-h">Viewshed <small>what can be seen</small></h3>
        <div class="site-tray-row">
          <label class="site-tray-select">Eye
            <input type="text" class="site-tray-input" data-vs="eye" value="0-2.5 m" size="8"
              aria-label="Observer eye height or range (m or ft)" title="One height (1.7 m) or a band (0-2.5 m): with a band, green is seen even from the low eye, amber only from the high eye. ft works too" />
          </label>
          <label class="site-tray-select">Target
            <input type="text" class="site-tray-input" data-vs="target" value="0 m" size="6"
              aria-label="Target height (m or ft)" title="Height above the ground that must be visible: 0 = the ground, 1.7 m = a person" />
          </label>
          <label class="site-tray-select">Reach
            <input type="text" class="site-tray-input" data-vs="reach" value="1 km" size="7"
              aria-label="How far to look from the observer (up to 5 km)" title="How far each observer looks: 1 km either side of a route by default, up to 5 km" />
          </label>
        </div>
        <div class="site-tray-row">
          <label class="site-tray-select">Heights
            <select data-vs="source" aria-label="Height model">
              <option value="auto" selected>Auto</option>
              <option value="mesh">3D mesh (buildings, trees)</option>
              <option value="dem">Bare earth (USGS 3DEP)</option>
            </select>
          </label>
          <label class="site-tray-select">Compute on
            <select data-vs="gpu" aria-label="Which processor runs the sight lines">
              <option value="dedicated" selected>Dedicated GPU</option>
              <option value="integrated">Integrated GPU</option>
              <option value="cpu">CPU (all cores)</option>
            </select>
          </label>
          <label class="site-tray-switch">
            <input type="checkbox" data-vs="clip" /> Inside SITE boundary only
          </label>
        </div>
        <div class="site-tray-row">
          <button type="button" data-vs="run" disabled>Compute</button>
          <button type="button" data-vs="clear" disabled>Clear</button>
        </div>
        <p class="site-tray-status" data-vs="status"></p>
        <p class="site-tray-note site-tray-warn" data-vs="gpu-warn" role="note" hidden></p>
        <p class="site-tray-legend" aria-hidden="true">
          <span class="lg-vs-seen">seen from low eye</span><span class="lg-vs-high">only from high eye</span><span class="lg-vs-hidden">hidden</span><span class="lg-vs-edge-hi">high-eye edge</span><span class="lg-vs-edge-lo">low-eye edge</span>
        </p>
      </section>

      <section class="site-tray-section" aria-labelledby="vt-orbit-h">
        <h3 id="vt-orbit-h">Orbit <small>around the observer and its reach</small></h3>
        <div class="site-tray-row">
          <button type="button" data-vs="orbit" disabled>Orbit</button>
          <button type="button" data-vs="stop">Stop</button>
          <label class="site-tray-select">Frames
            <select data-vs="frames">
              <option value="72">72</option>
              <option value="144" selected>144</option>
              <option value="288">288</option>
            </select>
          </label>
          <button type="button" data-vs="record" disabled>Record GIF</button>
        </div>
        <p class="site-tray-status" data-vs="orbit-status"></p>
      </section>
      <p class="site-tray-foot">Same actions in <button type="button" class="site-tray-link" data-vs="open-fc">Features Code</button> · type <code>help</code></p>
    </div>`;
  document.body.appendChild(panel);
  // Cache controls up front: a section may live in a pop-out panel (or
  // another window) later, outside this tab's DOM.
  const controls = new Map(
    [...panel.querySelectorAll('[data-vs]')].map((el) => [el.dataset.vs, el]),
  );
  const $ = (key) => controls.get(key);
  const trayBody = panel.querySelector('.site-tray-body');

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

  const options = () => {
    const eye = parseHeightRange($('eye').value);
    const targetM = parseHeightM($('target').value);
    const reachM = parseLength($('reach').value);
    if (!eye || targetM == null)
      throw new Error(
        'Eye like 1.7 m or a band like 0-2.5 m; target like 0 or 1.7 m',
      );
    if (reachM == null) throw new Error('Reach like 1 km, 500 m or 0.5 mi');
    return {
      lowM: eye.lowM,
      highM: eye.highM,
      targetM,
      reachM,
      source: $('source').value,
      gpu: $('gpu').value,
      clip: $('clip').checked,
    };
  };

  function sync(state = viewshed.describe()) {
    const drawing = Boolean(state.picking);
    for (const key of ['point', 'line', 'area', 'circle'])
      $(key).setAttribute('aria-pressed', String(state.picking === key));
    $('finish').hidden = !(
      state.picking === 'line' || state.picking === 'area'
    );
    $('circle').textContent =
      state.picking === 'circle' ? 'Cancel' : 'Radius circle';
    $('use-site').disabled = !state.hasSite || drawing;
    $('clip').disabled = !state.hasSite && !state.clip;
    $('run').disabled = !state.shape || state.loading || drawing;
    $('clear').disabled = !state.shape && !drawing;
    $('orbit').disabled = !state.shape;
    $('record').disabled = !state.shape;
    if (document.activeElement !== $('source'))
      $('source').value = state.source;
    if (state.gpu) $('gpu').value = state.gpu;
    $('clip').checked = state.clip;
    const advice =
      state.gpu === 'dedicated' || state.gpuKind === 'software'
        ? dedicatedGpuAdvice(
            state.gpuKind,
            state.renderer,
            navigator.userAgentData?.platform || navigator.platform,
          )
        : null;
    $('gpu-warn').hidden = !advice;
    $('gpu-warn').textContent = advice ?? '';
    if (drawing) say('shape-status', state.progress || 'Drawing…');
    else say('shape-status', shapeLine(state.shape), state.shape ? 'ok' : '');
    if (state.loading)
      return say('status', state.progress || 'Computing viewshed…');
    if (state.error) return say('status', state.error, 'err');
    if (!state.result)
      return say(
        'status',
        state.shape
          ? 'Press Compute'
          : 'Pick an observer above; it computes as soon as the shape is done',
      );
    say('status', resultLine(state.result), 'ok');
  }

  // ---- observer shape ----
  const draw = (kind) =>
    guard('status', async () => {
      const state = viewshed.describe();
      if (state.picking === kind) return viewshed.stopPicking();
      let radiusM = null;
      if (kind === 'circle') {
        const typed = $('radius').value.trim();
        radiusM = typed ? parseLength(typed) : null;
        if (typed && radiusM == null)
          throw new Error('Radius like 150, 150 m, 500 ft or 0.5 km');
      }
      await viewshed.pickShape(kind, { radiusM, ...options() });
    });
  for (const kind of ['point', 'line', 'area', 'circle'])
    $(kind).addEventListener('click', draw(kind));
  $('finish').addEventListener('click', () => viewshed.finishPicking());
  $('snap').value = String(boundary?.snapDeg ?? 15);
  $('snap').addEventListener('change', () => {
    if (boundary) boundary.snapDeg = $('snap').value;
  });
  $('use-site').addEventListener(
    'click',
    guard('status', () => viewshed.useSiteBoundary(options())),
  );
  for (const kind of ['line', 'area'])
    $(`paste-${kind}`).addEventListener(
      'click',
      guard('status', async () => {
        const shape = parseShapeText($('coords').value, kind);
        await viewshed.compute({ ...options(), shape });
      }),
    );

  // ---- settings ----
  $('run').addEventListener(
    'click',
    guard('status', () => viewshed.compute(options())),
  );
  $('clear').addEventListener('click', () => viewshed.clear());
  const rerun = guard('status', async () => {
    const opts = options();
    if (viewshed.describe().shape) await viewshed.compute(opts);
    else viewshed.setOptions(opts);
  });
  for (const key of ['eye', 'target', 'reach', 'source', 'gpu', 'clip'])
    $(key).addEventListener('change', rerun);

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
        title: 'Viewshed',
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

  // ---- pop-outs: any section, or the whole tab, into a movable panel ----
  const sectionTitle = (section) =>
    section.querySelector('h3')?.firstChild?.textContent?.trim() || 'VIEWSHED';
  function popOut(node, key, title) {
    if (!panels) return null;
    if (panels.get?.(key)) return panels.get(key).focus?.();
    const home = document.createComment(`viewshed-tray:${key}`);
    node.replaceWith(home);
    node.classList.add('site-tray-popped');
    return panels.open({
      key,
      title,
      subtitle: 'VIEWSHED',
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
        if (inPanel) return panels.get?.(`vs-${h3.id}`)?.close?.();
        popOut(section, `vs-${h3.id}`, sectionTitle(section));
      });
      h3.appendChild(btn);
    }
    $('pop-all').addEventListener('click', () => {
      popOut(trayBody, 'vs-all', 'VIEWSHED');
      setOpen(false);
    });
  } else $('pop-all').hidden = true;

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
      sync();
      place();
    }
  };
  toggle.addEventListener('click', () => {
    // With the whole tab popped out, the dock button brings that panel up.
    const popped = panels?.get?.('vs-all');
    if (popped) return popped.focus();
    setOpen(panel.hidden);
  });
  panel.querySelector('.site-tray-close').addEventListener('click', () => {
    setOpen(false);
    toggle.focus();
  });
  panel.addEventListener('keydown', (event) => {
    event.stopPropagation(); // keep app shortcuts out while using the tab
    if (event.key === 'Escape') {
      setOpen(false);
      toggle.focus();
    }
  });
  const onResize = () => !panel.hidden && place();
  window.addEventListener('resize', onResize);
  const off = viewshed.onChange((state) => sync(state));

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    destroy() {
      off();
      window.removeEventListener('resize', onResize);
      item.remove();
      panel.remove();
    },
  };
}
