/**
 * Features Code: an in-app command line in the command dock, left of LOCATION.
 *
 * Commands call feature services directly, so features run with no AI
 * attached. The command table doubles as the tool surface a local agent can
 * call later; the `js` escape hatch is for the person at the keyboard only.
 */

export const FEATURES_CODE_HELP = `Commands
  preset hyland            load the Hyland Hills boundary + GCPs
  load                     pick a .kml or .kmz (first polygon/line = boundary)
  zoom                     fly to the loaded boundary
  orbit [sec]              live orbit, seconds per revolution (default 24)
  go                       zoom, then orbit
  stop                     stop orbiting and release the camera
  record [frames] [w] [h]  record the orbit as a GIF (default 144, 800x450)
  site                     show what is loaded
  clear                    remove the boundary from the map
  cls                      clear this console
  js <expression>          run JavaScript (dev only; viewer and orbit in scope)
Up/Down recalls history. Esc closes.`;

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

const describeSite = (s) =>
  `${s.name} · ${s.vertices} vertices · ${s.points} points · ~${s.acrossM} m across`;

/**
 * Build the command table. Dependencies are injected so it is testable
 * without a DOM or a globe.
 */
export function createFeatureCommands({
  orbit,
  print,
  clearOutput,
  pickFile,
  viewer,
  allowEval = false,
  recordTitle = 'DJI LIDAR L2+ORTHO',
}) {
  const commands = {
    help: () => print(FEATURES_CODE_HELP, 'dim'),
    cls: () => clearOutput(),
    async preset([key = 'hyland']) {
      print(`Loaded ${describeSite(await orbit.loadPreset(key))}`, 'ok');
    },
    async load() {
      const file = await pickFile();
      if (!file) return print('No file chosen', 'dim');
      const name = file.name.replace(/\.km[lz]$/i, '');
      print(`Loaded ${describeSite(await orbit.loadKml(file, name))}`, 'ok');
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
      const s = orbit.describe();
      print(s ? describeSite(s) : 'Nothing loaded', 'dim');
    },
    clear() {
      orbit.clear();
      print('Cleared', 'ok');
    },
  };
  if (allowEval) {
    commands.js = async (_args, raw) => {
      if (!raw) return print('Usage: js <expression>', 'dim');
      // Only text typed by the person at the keyboard reaches this.
      const fn = new Function(
        'viewer',
        'orbit',
        `return (async () => (${raw}))();`,
      );
      const result = await fn(viewer, orbit);
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
 * @param {{ viewer: object, orbit: object, dock?: HTMLElement|null }} options
 */
export function mountFeaturesCode({ viewer, orbit, dock } = {}) {
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
    orbit,
    print,
    clearOutput: () => out.replaceChildren(),
    pickFile,
    viewer,
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
