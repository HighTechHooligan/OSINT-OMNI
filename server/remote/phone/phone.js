/**
 * OMNI Phone: drives OSINT OMNI on a paired computer. Tools run on the
 * computer (which caches their answers); commands are Features Code lines the
 * desktop app runs. Everything is rendered with textContent, never as HTML.
 */

const STORE = 'omni-phone';
const load = () => {
  try {
    return JSON.parse(localStorage.getItem(STORE)) || {};
  } catch {
    return {};
  }
};
const save = (patch) => {
  const next = { ...load(), ...patch };
  try {
    localStorage.setItem(STORE, JSON.stringify(next));
  } catch {
    // Private mode: pairing lasts for this page only.
  }
  return next;
};
let prefs = load();

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children.flat(Infinity))
    if (child != null && child !== false)
      node.append(child instanceof Node ? child : String(child));
  return node;
};

// ---------------------------------------------------------------- API

class Unpaired extends Error {}

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`/remote/${path}`, {
    method,
    headers: {
      ...(prefs.token ? { Authorization: `Bearer ${prefs.token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    showPair('This phone is no longer paired. Pair it again.');
    throw new Unpaired(data.error);
  }
  if (!response.ok && !('ok' in data))
    throw new Error(data.error || `The computer answered ${response.status}`);
  return data;
}

const runTool = (name, args) =>
  api(`api/tools/${name}`, { method: 'POST', body: args });

// ---------------------------------------------------------------- pairing

function showPair(message = '') {
  prefs = save({ token: null });
  $('app').hidden = true;
  $('pair-screen').hidden = false;
  $('pair-error').textContent = message;
}

$('pair-name').value = prefs.name || '';
$('pair-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('pair-error').textContent = '';
  const name = $('pair-name').value.trim();
  try {
    const result = await api('pair', {
      method: 'POST',
      body: { code: $('pair-code').value, name },
    });
    if (!result.ok) throw new Error(result.error);
    prefs = save({ token: result.token, name: result.device.name });
    $('pair-code').value = '';
    start();
  } catch (error) {
    $('pair-error').textContent = error.message;
  }
});

$('unpair').addEventListener('click', () => showPair('Unpaired.'));

// ---------------------------------------------------------------- tabs

function go(tab) {
  for (const section of document.querySelectorAll('[data-tab]'))
    section.hidden = section.dataset.tab !== tab;
  for (const button of document.querySelectorAll('[data-go]')) {
    if (button.dataset.go === tab) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  if (tab === 'tools') loadTools();
  if (tab === 'settings') refreshStatus();
  window.scrollTo(0, 0);
}
for (const button of document.querySelectorAll('[data-go]'))
  button.addEventListener('click', () => go(button.dataset.go));

// ---------------------------------------------------------------- status

let statusTimer = null;
async function refreshStatus() {
  try {
    const status = await api('api/status');
    const pill = $('desk-pill');
    pill.textContent = status.desktopOnline
      ? 'Computer connected'
      : 'Computer app closed';
    pill.className = `pill ${status.desktopOnline ? 'on' : 'off'}`;
    $('settings-device').textContent =
      `Paired as "${status.device.name}" since ${new Date(status.device.pairedAt).toLocaleString()}.`;
    const c = status.cache;
    $('settings-cache').textContent =
      `Computer cache: ${c.entries} answers kept for ${Math.round(c.ttlMs / 1000)} s · ${c.hits} reused · ${c.misses} fetched.`;
  } catch (error) {
    if (error instanceof Unpaired) return;
    $('desk-pill').textContent = 'Computer unreachable';
    $('desk-pill').className = 'pill off';
  }
}

// ---------------------------------------------------------------- results

const label = (key) =>
  String(key)
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());

function formatValue(value) {
  if (value == null) return '–';
  if (typeof value === 'number')
    return Number.isInteger(value)
      ? value.toLocaleString()
      : value.toLocaleString(undefined, { maximumFractionDigits: 3 });
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value))
    return value.every((v) => v == null || typeof v !== 'object')
      ? value.map(formatValue).join(', ')
      : `${value.length} items`;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

const isPrimitive = (v) => v == null || typeof v !== 'object';
const isRowList = (v) =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.every((r) => r && !Array.isArray(r) && typeof r === 'object');

function table(rows) {
  const columns = [];
  for (const row of rows.slice(0, 10))
    for (const [key, value] of Object.entries(row))
      if (
        !columns.includes(key) &&
        columns.length < 6 &&
        (isPrimitive(value) ||
          (Array.isArray(value) && value.every(isPrimitive)))
      )
        columns.push(key);
  const shown = rows.slice(0, 15);
  return el(
    'div',
    { className: 'table-wrap' },
    el(
      'table',
      {},
      el(
        'thead',
        {},
        el(
          'tr',
          {},
          columns.map((c) => el('th', {}, label(c))),
        ),
      ),
      el(
        'tbody',
        {},
        shown.map((row) =>
          el(
            'tr',
            {},
            columns.map((c) => el('td', {}, formatValue(row[c]))),
          ),
        ),
      ),
    ),
    rows.length > shown.length
      ? el('p', { className: 'hint' }, `+${rows.length - shown.length} more`)
      : null,
  );
}

/** Readable details for a tool's data: facts first, then tables. */
function renderData(data) {
  const facts = [];
  const sections = [];
  const visit = (object, prefix = '') => {
    for (const [key, value] of Object.entries(object ?? {})) {
      if (key === 'view') continue;
      const name = prefix ? `${prefix} ${key}` : key;
      if (isRowList(value)) sections.push([name, value]);
      else if (value && typeof value === 'object' && !Array.isArray(value)) {
        if (!prefix) visit(value, key);
        else facts.push([name, value]);
      } else facts.push([name, value]);
    }
  };
  visit(data);
  return el(
    'div',
    {},
    facts.length
      ? el(
          'dl',
          { className: 'kv' },
          facts.map(([k, v]) => [
            el('dt', {}, label(k)),
            el('dd', {}, formatValue(v)),
          ]),
        )
      : null,
    sections.map(([k, rows]) =>
      el('div', {}, el('h4', {}, `${label(k)} (${rows.length})`), table(rows)),
    ),
    el(
      'details',
      {},
      el('summary', {}, 'Raw data'),
      el('pre', {}, JSON.stringify(data, null, 2)),
    ),
  );
}

/** A result card. `run` resolves to a tool response; the card fills in. */
function resultCard(title, run, { screen = 'job' } = {}) {
  const state = el('span', { className: 'state' }, 'Asking the computer…');
  const summary = el('p', { className: 'summary' }, '');
  const body = el('div');
  const card = el(
    'article',
    { className: 'card' },
    el('div', { className: 'card-head' }, el('h3', {}, title), state),
    summary,
    body,
  );
  const started = performance.now();
  run()
    .then((result) => {
      if (!result.ok) throw new Error(result.error || 'The tool failed');
      card.classList.add('ok');
      const secs = ((performance.now() - started) / 1000).toFixed(1);
      state.textContent = result.cache?.hit
        ? `cached ${result.cache.ageSeconds}s ago`
        : `fresh · ${secs}s`;
      summary.textContent = result.summary;
      for (const image of result.images ?? [])
        body.append(
          el('img', {
            src: `data:${image.mimeType};base64,${image.data}`,
            alt: `${title} image`,
          }),
        );
      body.append(
        el(
          'details',
          {},
          el('summary', {}, 'Details'),
          renderData(result.data),
        ),
      );
      card.append(rateRow(screen, title));
    })
    .catch((error) => {
      if (error instanceof Unpaired) return;
      card.classList.add('fail');
      state.textContent = 'failed';
      summary.textContent = error.message;
    });
  return card;
}

/** "Was this easy to read?" — saved on the computer for the test write-up. */
function rateRow(screen, about) {
  const buttons = ['clear', 'unclear'].map((rating) => {
    const button = el(
      'button',
      { type: 'button' },
      rating === 'clear' ? 'Easy to read' : 'Hard to read',
    );
    button.setAttribute('aria-pressed', 'false');
    return button;
  });
  const status = el('span');
  buttons.forEach((button, i) =>
    button.addEventListener('click', async () => {
      const rating = i === 0 ? 'clear' : 'unclear';
      const note =
        rating === 'unclear'
          ? (prompt('What was hard to read? (optional)') ?? '')
          : '';
      try {
        await api('api/feedback', {
          method: 'POST',
          body: {
            screen,
            about,
            rating,
            note: note || '',
            textSize: prefs.size ?? 100,
          },
        });
        buttons.forEach((b, j) =>
          b.setAttribute('aria-pressed', String(i === j)),
        );
        status.textContent = 'Saved on the computer';
      } catch (error) {
        status.textContent = error.message;
      }
    }),
  );
  return el(
    'div',
    { className: 'rate' },
    el('span', {}, 'Readability:'),
    buttons,
    status,
  );
}

// ---------------------------------------------------------------- job

/** "39.7, -105.0" -> { lat, lon }; anything else is a place name. */
function parseSite(text) {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text);
  if (m) {
    const lat = Number(m[1]);
    const lon = Number(m[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon };
  }
  return { place: text.trim() };
}

const JOB_CHECKS = [
  {
    title: 'Weather',
    tool: 'get_weather',
    args: ({ point }) => ({ location: point }),
  },
  {
    title: 'Wind (10 m)',
    tool: 'get_wind',
    args: ({ point }) => ({ location: point }),
  },
  {
    title: 'Aircraft nearby',
    tool: 'aircraft_in_area',
    args: ({ area }) => ({ area, limit: 15 }),
  },
  {
    title: 'Military installations',
    tool: 'find_military_installations',
    args: ({ area }) => ({ area, limit: 10 }),
  },
  {
    title: 'Ground elevation',
    tool: 'get_terrain_height',
    args: ({ point }) => (point.lat != null ? { points: [point] } : null),
  },
  {
    title: 'Active fires (24 h)',
    tool: 'get_active_fires',
    args: ({ area }) => ({ area, limit: 10 }),
  },
];

$('job-site').value = prefs.site || '';
$('job-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = $('job-site').value.trim();
  if (!text) return;
  prefs = save({ site: text });
  const point = parseSite(text);
  const radius = Number($('job-radius').value) || 3;
  const area = point.place
    ? { place: point.place }
    : { ...point, radius_km: radius };
  const results = $('job-results');
  results.replaceChildren();
  for (const check of JOB_CHECKS) {
    const args = check.args({ point, area });
    if (!args) continue;
    results.append(resultCard(check.title, () => runTool(check.tool, args)));
  }
});

$('job-show').addEventListener('click', () => {
  const text = $('job-site').value.trim();
  if (!text) return;
  go('desk');
  sendCommand(`goto ${text}`);
});

// ---------------------------------------------------------------- computer

const DESK_BUTTONS = [
  ['Load Hyland preset', 'preset hyland'],
  ['Zoom to site', 'zoom'],
  ['Zoom + orbit', 'go'],
  ['Stop camera', 'stop'],
  ['Contours on', 'contours on'],
  ['Contours off', 'contours off'],
  ['Canopy', 'canopy'],
  ['Elevation: sea level', 'elev asl'],
  ['Elevation: relative', 'elev relative'],
  ['OSM streets', 'layer osm'],
  ['What is loaded', 'site'],
  ['See the screen', 'snap'],
];
for (const [text, line] of DESK_BUTTONS) {
  const button = el('button', { type: 'button' }, text);
  button.addEventListener('click', () => sendCommand(line));
  $('desk-buttons').append(button);
}

$('desk-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const line = $('desk-line').value.trim();
  if (!line) return;
  $('desk-line').value = '';
  sendCommand(line);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendCommand(line) {
  const status = el('div', { className: 'fc-dim' }, 'Sending…');
  const output = el('div');
  const entry = el(
    'div',
    { className: 'entry' },
    el('div', { className: 'cmd' }, `> ${line}`),
    status,
    output,
  );
  $('desk-log').append(entry);
  try {
    const queued = await api('api/commands', {
      method: 'POST',
      body: { line },
    });
    if (!queued.ok) throw new Error(queued.error);
    status.textContent = queued.desktopOnline
      ? 'Running on the computer…'
      : 'Waiting for the desktop app to open on the computer…';
    // Long jobs (a GIF recording) can take minutes; back off as we wait.
    const until = Date.now() + 10 * 60 * 1000;
    for (
      let delay = 400;
      Date.now() < until;
      delay = Math.min(delay * 1.4, 3000)
    ) {
      await sleep(delay);
      const { command } = await api(`api/commands/${queued.command.id}`);
      if (command.status === 'running')
        status.textContent = 'Running on the computer…';
      if (command.status !== 'done' && command.status !== 'failed') continue;
      status.remove();
      for (const l of command.lines)
        output.append(
          el('div', { className: l.tone ? `fc-${l.tone}` : '' }, l.text),
        );
      if (command.image)
        output.append(
          el('img', { src: command.image, alt: 'The computer screen' }),
        );
      if (!command.lines.length && !command.image)
        output.append(el('div', { className: 'fc-ok' }, 'Done'));
      return;
    }
    status.textContent =
      'Still running on the computer. Check the computer screen.';
  } catch (error) {
    if (error instanceof Unpaired) return;
    status.className = 'fc-err';
    status.textContent = error.message;
  }
}

// ---------------------------------------------------------------- tools

let tools = null;
async function loadTools() {
  if (tools) return;
  try {
    ({ tools } = await api('api/tools'));
  } catch (error) {
    if (!(error instanceof Unpaired))
      $('tool-list').replaceChildren(
        el('li', { className: 'error' }, error.message),
      );
    return;
  }
  renderToolList();
}

function renderToolList() {
  const q = $('tool-filter').value.trim().toLowerCase();
  $('tool-list').replaceChildren(
    ...tools
      .filter(
        (t) =>
          !q ||
          `${t.name} ${t.title} ${t.description}`.toLowerCase().includes(q),
      )
      .map((tool) => {
        const button = el(
          'button',
          { type: 'button' },
          el('span', {}, tool.title),
          el('small', {}, tool.description),
        );
        button.addEventListener('click', () => openTool(tool));
        return el('li', {}, button);
      }),
  );
}
$('tool-filter').addEventListener('input', () => tools && renderToolList());

/** A starting argument object for a schema, using the job site if set. */
function exampleArgs(schema) {
  const point = prefs.site ? parseSite(prefs.site) : { place: 'Denver' };
  const out = {};
  for (const key of schema.required ?? []) {
    const prop = schema.properties?.[key] ?? {};
    if (key === 'area')
      out.area = point.place ? point : { ...point, radius_km: 3 };
    else if (key === 'location') out.location = point;
    else if (key === 'points')
      out.points = [point.lat != null ? point : { lat: 39.74, lon: -104.99 }];
    else if (prop.enum) out[key] = prop.enum[0];
    else if (prop.type === 'string') out[key] = '';
    else if (prop.type === 'number' || prop.type === 'integer')
      out[key] = prop.minimum ?? 0;
    else if (prop.type === 'boolean') out[key] = false;
  }
  return out;
}

let openToolName = null;
function openTool(tool) {
  openToolName = tool.name;
  $('tool-list').hidden = true;
  $('tool-filter').hidden = true;
  $('tool-detail').hidden = false;
  $('tool-title').textContent = tool.title;
  $('tool-desc').textContent = tool.description;
  $('tool-args').value = JSON.stringify(exampleArgs(tool.inputSchema), null, 2);
  $('tool-result').replaceChildren();
}
$('tool-back').addEventListener('click', () => {
  $('tool-detail').hidden = true;
  $('tool-list').hidden = false;
  $('tool-filter').hidden = false;
});
$('tool-run').addEventListener('click', () => {
  let args;
  try {
    args = JSON.parse($('tool-args').value || '{}');
  } catch {
    $('tool-result').replaceChildren(
      el('p', { className: 'error' }, 'Arguments must be valid JSON'),
    );
    return;
  }
  const title = $('tool-title').textContent;
  $('tool-result').prepend(
    resultCard(title, () => runTool(openToolName, args), { screen: 'tools' }),
  );
});

// ---------------------------------------------------------------- settings

function applyPrefs() {
  const size = prefs.size ?? 100;
  document.documentElement.style.setProperty('--fs', `${(18 * size) / 100}px`);
  document.documentElement.classList.toggle(
    'contrast',
    Boolean(prefs.contrast),
  );
  $('size').value = String(size);
  $('size-out').textContent = `${size}%`;
  $('contrast').checked = Boolean(prefs.contrast);
}
$('size').addEventListener('input', () => {
  prefs = save({ size: Number($('size').value) });
  applyPrefs();
});
$('contrast').addEventListener('change', () => {
  prefs = save({ contrast: $('contrast').checked });
  applyPrefs();
});

// ---------------------------------------------------------------- start

function start() {
  $('pair-screen').hidden = true;
  $('app').hidden = false;
  go('job');
  refreshStatus();
  clearInterval(statusTimer);
  statusTimer = setInterval(refreshStatus, 15_000);
}

applyPrefs();
if (prefs.token) start();
else showPair();
