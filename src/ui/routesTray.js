/**
 * ROUTES: dock popdown for camera-aware routing. Plan a route that keeps
 * mapped ALPR cameras from reading the plate (by where each camera faces),
 * see it on the globe next to the usual route, read the steps, and re-run
 * recent trips. Features Code `route` runs the same service.
 */
import { VIEW_DEFAULTS } from '../services/routing/cameraView.js';

const MODE_WORDS = { car: 'Car', bike: 'Bike', walk: 'Walk' };

const placeText = (label, at) =>
  label || (at ? `${at[1].toFixed(5)}, ${at[0].toFixed(5)}` : '');

export function mountRoutesTray({ routes, dock, onOpenFeaturesCode } = {}) {
  const host = dock ?? document.getElementById('command-dock');
  const item = document.createElement('div');
  item.id = 'routes-tray';
  item.className = 'site-tray-dock routes-tray-dock';
  item.innerHTML = `
    <button id="routes-tray-toggle" class="site-tray-toggle" type="button"
      aria-expanded="false" aria-controls="routes-tray-panel" title="Routes that avoid ALPR cameras">
      <svg class="routes-tray-glyph" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"
        fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="5" r="2.2"/>
        <path d="M8.2 19H15a3.5 3.5 0 0 0 0-7H9a3.5 3.5 0 0 1 0-7h6.8"/>
      </svg>
      <span class="site-tray-label">ROUTES</span>
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
  panel.id = 'routes-tray-panel';
  panel.className = 'site-tray-panel routes-tray-panel';
  panel.setAttribute('aria-label', 'Routes');
  panel.hidden = true;
  panel.innerHTML = `
    <header class="site-tray-head">
      <span>ROUTES</span>
      <button type="button" class="site-tray-close" aria-label="Close routes">×</button>
    </header>
    <div class="site-tray-body">
      <section class="site-tray-section">
        <label class="routes-tray-field"><span>From</span>
          <input data-rt="from" type="text" spellcheck="false" autocomplete="off"
            value="here" placeholder="here, a place, or lat, lon" />
          <button type="button" data-rt="pick-from" title="Click the map to set the start">Pick</button>
        </label>
        <label class="routes-tray-field"><span>To</span>
          <input data-rt="to" type="text" spellcheck="false" autocomplete="off"
            placeholder="a place, or lat, lon" />
          <button type="button" data-rt="pick-to" title="Click the map to set the destination">Pick</button>
        </label>
        <div class="site-tray-row">
          <label class="site-tray-select">Mode
            <select data-rt="mode">
              <option value="car" selected>Car</option>
              <option value="bike">Bike</option>
              <option value="walk">Walk</option>
            </select>
          </label>
          <label class="site-tray-switch">
            <input type="checkbox" data-rt="avoid" checked />
            <span>Avoid cameras</span>
          </label>
        </div>
        <div class="site-tray-row">
          <button type="button" data-rt="plan" class="routes-tray-go">Route</button>
          <button type="button" data-rt="zoom" disabled>Zoom to</button>
          <button type="button" data-rt="steps" disabled>Steps</button>
          <button type="button" data-rt="clear" disabled>Clear</button>
        </div>
        <p class="site-tray-status" data-rt="status"></p>
        <p class="site-tray-status" data-rt="cameras"></p>
        <ol class="routes-tray-steps" data-rt="step-list" hidden></ol>
      </section>
      <section class="site-tray-section" data-rt="recent-box" hidden>
        <h3>Recent</h3>
        <ul class="routes-tray-recent" data-rt="recent"></ul>
      </section>
      <p class="site-tray-note">A camera counts when it can read your plate: within
        ${VIEW_DEFAULTS.rangeM} m and ±${VIEW_DEFAULTS.halfAngleDeg}° of the way it faces in OpenStreetMap
        (all round when no facing is mapped). No distance limit. Dashed line = usual route.</p>
      <p class="site-tray-foot">Same actions in <button type="button" class="site-tray-link" data-rt="open-fc">Features Code</button> · type <code>route</code></p>
    </div>`;
  document.body.appendChild(panel);
  const $ = (key) => panel.querySelector(`[data-rt="${key}"]`);

  const say = (key, text, tone = '') => {
    const el = $(key);
    el.textContent = text;
    el.dataset.tone = tone;
  };

  function renderSteps() {
    $('step-list').replaceChildren(
      ...routes.steps().map((m) => {
        const li = document.createElement('li');
        li.textContent = m.instruction;
        return li;
      }),
    );
  }

  function renderRecent(list) {
    $('recent-box').hidden = !list.length;
    $('recent').replaceChildren(
      ...list.map((h, i) => {
        const li = document.createElement('li');
        const go = document.createElement('button');
        go.type = 'button';
        go.className = 'routes-tray-trip';
        go.textContent = `${placeText(h.fromLabel, h.from)} → ${placeText(h.toLabel, h.to)}`;
        const small = document.createElement('small');
        small.textContent = `${MODE_WORDS[h.mode] ?? h.mode}${h.avoid ? '' : ' · direct'} · ${h.summary}`;
        go.append(small);
        go.addEventListener('click', () => {
          $('from').value = placeText(
            h.fromLabel === 'Map view' ? null : h.fromLabel,
            h.from,
          );
          $('to').value = placeText(h.toLabel, h.to);
          $('mode').value = h.mode;
          $('avoid').checked = h.avoid;
          planNow({ from: h.from, to: h.to });
        });
        const forget = document.createElement('button');
        forget.type = 'button';
        forget.className = 'routes-tray-forget';
        forget.textContent = '×';
        forget.setAttribute('aria-label', 'Forget this trip');
        forget.addEventListener('click', () => routes.forget(i));
        li.append(go, forget);
        return li;
      }),
    );
  }

  function sync(state = routes.describe()) {
    const r = state.route;
    for (const key of ['zoom', 'steps', 'clear']) $(key).disabled = !r;
    $('plan').disabled = state.busy;
    $('plan').textContent = state.busy ? 'Routing…' : 'Route';
    if (r && !state.busy) {
      say(
        'status',
        `${state.summary} · ${MODE_WORDS[r.mode]}${r.avoid ? '' : ' · direct'}`,
        'ok',
      );
      say('cameras', r.message, r.passed.length ? 'err' : 'ok');
      if (!$('step-list').hidden) renderSteps();
    } else if (!r && !state.busy) {
      say('cameras', '');
      $('step-list').hidden = true;
    }
    renderRecent(state.history);
  }

  async function planNow(override = {}) {
    const from = override.from ?? $('from').value.trim();
    const to = override.to ?? $('to').value.trim();
    if (!to) return say('status', 'Type or pick a destination', 'err');
    say('cameras', '');
    try {
      await routes.plan({
        from: from || 'here',
        to,
        mode: $('mode').value,
        avoid: $('avoid').checked,
        onProgress: (stage, done, total) =>
          say('status', total ? `${stage}… ${done}/${total}` : `${stage}…`),
      });
    } catch (error) {
      say('status', error?.message || String(error), 'err');
    }
  }

  const pick = (key) => async () => {
    say('status', 'Click the map (Esc cancels)');
    const at = await routes.pickPoint();
    if (!at) return say('status', '');
    $(key).value = `${at[1].toFixed(5)}, ${at[0].toFixed(5)}`;
    say('status', '');
  };

  $('plan').addEventListener('click', () => planNow());
  $('pick-from').addEventListener('click', pick('from'));
  $('pick-to').addEventListener('click', pick('to'));
  for (const key of ['from', 'to'])
    $(key).addEventListener('keydown', (event) => {
      if (event.key === 'Enter') planNow();
    });
  $('zoom').addEventListener('click', () => routes.zoom().catch(() => {}));
  $('steps').addEventListener('click', () => {
    const list = $('step-list');
    list.hidden = !list.hidden;
    if (!list.hidden) renderSteps();
  });
  $('clear').addEventListener('click', () => {
    routes.clear();
    say('status', '');
  });
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
      sync();
      place();
      $('to').focus();
    }
  };
  toggle.addEventListener('click', () => setOpen(panel.hidden));
  panel.querySelector('.site-tray-close').addEventListener('click', () => {
    setOpen(false);
    toggle.focus();
  });
  panel.addEventListener('keydown', (event) => {
    event.stopPropagation(); // keep app shortcuts out while typing places
    if (event.key === 'Escape') {
      setOpen(false);
      toggle.focus();
    }
  });
  panel.addEventListener('keyup', (event) => event.stopPropagation());
  panel.addEventListener('keypress', (event) => event.stopPropagation());
  const onResize = () => !panel.hidden && place();
  window.addEventListener('resize', onResize);
  const off = routes.onChange((_reason, state) => {
    if (!panel.hidden) sync(state);
  });

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
