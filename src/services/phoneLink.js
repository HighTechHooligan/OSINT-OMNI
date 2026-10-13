/**
 * Phone link: the desktop side of the phone remote (server/remote/).
 *
 * Pairs phones (the server shows a one-time code), lists and revokes them,
 * and runs the bridge: a long-poll that takes the Features Code lines a
 * paired phone sends and runs them here, then reports what they printed.
 * The PHONE dock popdown and the `phone` Features Code command both call
 * this service.
 */

/** Commands a phone may never run here, whatever the server allows. */
export const PHONE_REFUSED_COMMANDS = Object.freeze(['js', 'phone']);
/** Width of the screen snapshot sent to a phone. */
const SNAP_WIDTH = 960;

/** Why the bridge refuses this line from a phone, or null. */
export function refuseFromPhone(line) {
  const [name = '', action = ''] = String(line ?? '')
    .trim()
    .toLowerCase()
    .split(/\s+/);
  if (PHONE_REFUSED_COMMANDS.includes(name))
    return `"${name}" only runs from the keyboard on the computer`;
  // Drawing waits for clicks on the computer and would hold up the phone.
  if (name === 'boundary' && action === 'draw')
    return 'Drawing a boundary needs the mouse on the computer';
  return null;
}

/** A JPEG data URL of what the globe shows now, at most SNAP_WIDTH wide. */
export function captureView(viewer, { width = SNAP_WIDTH } = {}) {
  // Read the frame in the same task it is drawn, before the buffer clears.
  viewer.render();
  const source = viewer.scene.canvas;
  const scale = Math.min(1, width / source.width);
  const out = document.createElement('canvas');
  out.width = Math.round(source.width * scale);
  out.height = Math.round(source.height * scale);
  out.getContext('2d').drawImage(source, 0, 0, out.width, out.height);
  return out.toDataURL('image/jpeg', 0.72);
}

/**
 * @param {{ runCommand: (line: string) => Promise<{ok: boolean, lines: object[]}>,
 *   snapshot?: () => string, fetchImpl?: Function, retryMs?: number }} deps
 */
export function createPhoneLink({
  runCommand,
  snapshot = null,
  fetchImpl = (...args) => globalThis.fetch(...args),
  retryMs = 5000,
}) {
  const listeners = new Set();
  let state = null;
  let bridge = null; // { controller }
  let available = true;
  let lastActivity = null;

  const emit = () =>
    listeners.forEach((fn) =>
      fn({ state, bridgeOn: Boolean(bridge), available, lastActivity }),
    );

  async function call(path, body) {
    const response = await fetchImpl(`/remote/desk/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (response.status === 404)
      throw new Error(
        'This server has no phone remote (run the dev or preview server)',
      );
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(data.error || `Phone remote answered ${response.status}`);
    state = data;
    emit();
    return data;
  }

  /** Run one command from a phone and describe the result. */
  async function execute({ line }) {
    const refusal = refuseFromPhone(line);
    if (refusal) return { ok: false, lines: [{ text: refusal, tone: 'err' }] };
    if (/^snap$/i.test(line.trim())) {
      if (!snapshot)
        return {
          ok: false,
          lines: [{ text: 'Snapshots are not available', tone: 'err' }],
        };
      return {
        ok: true,
        lines: [{ text: 'Screen captured', tone: 'ok' }],
        image: snapshot(),
      };
    }
    return runCommand(line);
  }

  async function loop(controller) {
    const { signal } = controller;
    while (!signal.aborted) {
      let response;
      try {
        response = await fetchImpl('/remote/desk/next', {
          signal,
          cache: 'no-store',
        });
      } catch {
        if (signal.aborted) return;
        await wait(retryMs, signal);
        continue;
      }
      // A static build or another server: nothing to bridge to.
      if (response.status === 404 || response.status === 403) {
        available = false;
        stopBridge();
        return;
      }
      if (response.status !== 200) {
        if (response.status !== 204) await wait(retryMs, signal);
        continue;
      }
      const { command } = await response.json().catch(() => ({}));
      if (!command?.id) continue;
      let result;
      try {
        result = await execute(command);
      } catch (error) {
        result = {
          ok: false,
          lines: [{ text: error?.message || String(error), tone: 'err' }],
        };
      }
      lastActivity = { ...command, ok: result.ok, at: Date.now() };
      emit();
      try {
        await fetchImpl('/remote/desk/result', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: command.id, ...result }),
        });
      } catch {
        // The phone times out on its own; keep serving.
      }
    }
  }

  function startBridge() {
    if (bridge || !available) return false;
    bridge = { controller: new AbortController() };
    loop(bridge.controller);
    emit();
    return true;
  }

  function stopBridge() {
    if (!bridge) return;
    bridge.controller.abort();
    bridge = null;
    emit();
  }

  return {
    refresh: () => call('state'),
    startPairing: () => call('pair', {}),
    revoke: (id) => call('revoke', { id }),
    startBridge,
    stopBridge,
    execute,
    describe: () => ({
      state,
      bridgeOn: Boolean(bridge),
      available,
      lastActivity,
    }),
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    destroy() {
      stopBridge();
      listeners.clear();
    },
  };
}

function wait(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** "4:59" until a pairing code expires. */
export function formatCountdown(expiresAt, now = Date.now()) {
  const s = Math.max(0, Math.round((expiresAt - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
