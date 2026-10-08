import { h, toast } from './dom.js';
import { httpJson } from '../lib/platform.js';
import { createHostLink, loadLink, UnpairedError } from '../lib/hostLink.js';

/**
 * Computer tab: drive the OMNI desktop from the phone. Everything the desktop
 * does is reachable two ways, as on the computer: Features Code commands (the
 * command line, `help` lists them all) and the tool catalog. Works wherever
 * the phone can reach the host: same Wi-Fi, or from anywhere over a private
 * network such as Tailscale until the secure handoff lands.
 */
const QUICK = [
  ['Screen', 'snap'],
  ['Help', 'help'],
  ['Zoom to site', 'zoom'],
  ['Orbit', 'go'],
  ['Stop camera', 'stop'],
  ['Contours on', 'contours on'],
  ['Contours off', 'contours off'],
  ['Canopy', 'canopy'],
  ['OSM streets', 'layer osm'],
  ['Routes', 'route'],
  ['What is loaded', 'site'],
  ['Hyland preset', 'preset hyland'],
];

export function mountComputer(root, services, { openHost }) {
  const link = createHostLink({ http: httpJson });
  const status = h('p.muted');
  const log = h('div.log');
  const lineInput = h('input', { type: 'text', placeholder: 'Features Code, e.g. goto Austin', 'aria-label': 'Command', autocapitalize: 'off', autocorrect: 'off', enterkeyhint: 'send' });
  const history = [];
  let historyAt = -1;
  let liveTimer = null;
  const liveToggle = h('input', { type: 'checkbox', onchange: (e) => setLive(e.target.checked) });
  const screen = h('img.screen', { alt: 'The computer screen', hidden: true });
  const toolsBox = h('div.tools');
  const unpaired = h('div.unpaired', {}, h('p', { text: 'Pair this phone with your computer first.' }), h('button.primary', { text: 'Go to Host', onclick: () => openHost() }));

  root.append(
    h(
      'div.page',
      {},
      h('h1', { text: 'Computer' }),
      status,
      unpaired,
      h(
        'section.computer',
        {},
        h('div.row', {}, h('label.switch', {}, liveToggle, h('span', { text: 'Live screen (every 5 s)' })), h('button', { text: 'Refresh screen', onclick: () => send('snap') })),
        screen,
        h('div.quick', {}, QUICK.map(([text, line]) => h('button', { text, onclick: () => send(line) }))),
        h(
          'form.cmd',
          {
            onsubmit: (e) => {
              e.preventDefault();
              const line = lineInput.value.trim();
              if (!line) return;
              history.unshift(line);
              historyAt = -1;
              lineInput.value = '';
              send(line);
            },
          },
          lineInput,
          h('button.primary', { type: 'submit', text: 'Run' }),
        ),
        log,
        h('details', { ontoggle: (e) => e.target.open && loadTools() }, h('summary', { text: 'Tools' }), toolsBox),
      ),
    ),
  );
  lineInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' && history[historyAt + 1]) lineInput.value = history[++historyAt];
    if (e.key === 'ArrowDown') lineInput.value = historyAt > 0 ? history[--historyAt] : ((historyAt = -1), '');
  });

  const paired = () => loadLink();

  async function refreshStatus() {
    const p = paired();
    unpaired.hidden = Boolean(p);
    root.querySelector('section.computer').hidden = !p;
    if (!p) return void (status.textContent = '');
    try {
      const s = await link.status(p);
      if (!s.paired) throw new UnpairedError(s.error);
      status.textContent = s.desktopOnline ? `Connected to ${p.hostUrl}. The desktop app is open.` : `Connected to ${p.hostUrl}, but the desktop app isn't open; commands wait until it is.`;
    } catch (error) {
      status.textContent = error instanceof UnpairedError ? `${error.message}` : `Can't reach ${p.hostUrl}: ${error.message}`;
    }
  }

  async function send(line, { quiet = false } = {}) {
    const p = paired();
    if (!p) return openHost();
    const state = h('div.muted', { text: 'Sending…' });
    const out = h('div');
    const entry = h('div.entry', {}, h('div.cmdline', { text: `> ${line}` }), state, out);
    if (!quiet) log.prepend(entry);
    try {
      const c = await link.command(p, line, {
        onStatus: (s) => (state.textContent = s === 'running' ? 'Running on the computer…' : 'Waiting for the desktop app to open…'),
      });
      state.remove();
      if (c.image) {
        screen.src = c.image;
        screen.hidden = false;
      }
      for (const l of c.lines || []) out.append(h('div', { class: l.tone ? `tone-${l.tone}` : '', text: l.text }));
      if (!c.lines?.length && !c.image) out.append(h('div.tone-ok', { text: c.status === 'failed' ? 'Failed' : 'Done' }));
    } catch (error) {
      if (quiet) throw error;
      state.className = 'tone-err';
      state.textContent = error.message;
      if (error instanceof UnpairedError) refreshStatus();
    }
  }

  function setLive(on) {
    clearInterval(liveTimer);
    liveTimer = null;
    if (!on) return;
    let busy = false;
    const tick = async () => {
      if (busy || root.hidden) return;
      busy = true;
      try {
        await send('snap', { quiet: true });
      } catch (error) {
        liveToggle.checked = false;
        setLive(false);
        toast(`Live screen stopped: ${error.message}`);
      } finally {
        busy = false;
      }
    };
    tick();
    liveTimer = setInterval(tick, 5000);
  }

  let toolsLoaded = false;
  async function loadTools() {
    if (toolsLoaded) return;
    const p = paired();
    if (!p) return;
    toolsBox.replaceChildren(h('p.muted', { text: 'Loading tools…' }));
    try {
      const tools = await link.tools(p);
      toolsLoaded = true;
      toolsBox.replaceChildren(...tools.map((t) => toolCard(p, t)));
    } catch (error) {
      toolsBox.replaceChildren(h('p.warn', { text: error.message }));
    }
  }

  function toolCard(p, tool) {
    const props = tool.inputSchema?.properties || {};
    const required = new Set(tool.inputSchema?.required || []);
    const fields = Object.entries(props).map(([key, schema]) => {
      const label = `${key}${required.has(key) ? ' *' : ''}`;
      let input;
      if (Array.isArray(schema.enum)) input = h('select', { name: key }, h('option', { value: '', text: '—' }), schema.enum.map((v) => h('option', { value: String(v), text: String(v) })));
      else if (schema.type === 'boolean') input = h('input', { type: 'checkbox', name: key });
      else input = h('input', { type: schema.type === 'number' || schema.type === 'integer' ? 'number' : 'text', name: key, step: 'any', placeholder: schema.description?.slice(0, 60) || '' });
      return h('label.field', {}, h('span', { text: label }), input);
    });
    const result = h('pre.tool-out', { hidden: true });
    const run = h('button.primary', { text: 'Run' });
    const form = h('form.tool', {}, ...fields, run, result);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const args = {};
      for (const [key, schema] of Object.entries(props)) {
        const el = form.elements[key];
        if (!el) continue;
        if (schema.type === 'boolean') args[key] = el.checked;
        else if (el.value !== '') args[key] = schema.type === 'number' || schema.type === 'integer' ? Number(el.value) : schema.type === 'array' || schema.type === 'object' ? safeJson(el.value) : el.value;
      }
      run.disabled = true;
      result.hidden = false;
      result.textContent = 'Running on the computer…';
      try {
        const r = await link.runTool(p, tool.name, args);
        result.textContent = r.summary || r.text || JSON.stringify(r.result ?? r, null, 2);
      } catch (error) {
        result.textContent = error.message;
      } finally {
        run.disabled = false;
      }
    });
    return h('details.tool-card', {}, h('summary', {}, h('strong', { text: tool.title || tool.name }), h('small.muted', { text: ` ${tool.description || ''}`.slice(0, 140) })), form);
  }

  return {
    shown() {
      refreshStatus();
      if (liveToggle.checked) setLive(true);
    },
    hidden() {
      clearInterval(liveTimer);
    },
    send,
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
