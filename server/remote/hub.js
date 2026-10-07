/**
 * Phone remote hub: pairing, device tokens, the command queue the desktop
 * app drains, and the result cache for tools the phone runs on this computer.
 *
 * Pure state with injected clock and randomness, so every rule here is unit
 * tested without a server. The HTTP plugin (./plugin.js) owns transport and
 * request gating.
 */

import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';

/** How long a pairing code shown on the computer stays valid. */
export const PAIR_CODE_TTL_MS = 5 * 60 * 1000;
/** Wrong guesses allowed before the code shown on the computer is burned. */
export const PAIR_MAX_ATTEMPTS = 5;
/** The desktop counts as online if it asked for work this recently. */
export const DESK_ONLINE_MS = 40 * 1000;
/** Commands the phone may queue, and results kept for it to read back. */
const MAX_PENDING = 20;
const MAX_KEPT = 50;
const MAX_LINE = 300;
const MAX_NAME = 40;
const MAX_DEVICES = 12;

const hashToken = (token) =>
  createHash('sha256').update(String(token)).digest('hex');

/** Commands only the person at the keyboard may run. */
const DESK_ONLY = new Set(['js', 'phone']);

/** Trim and bound a device name typed on the phone. */
export function cleanDeviceName(name) {
  const text = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, MAX_NAME);
  return text || 'Phone';
}

/** Why a phone may not send this command line, or null when it may. */
export function refusePhoneCommand(line) {
  const text = String(line ?? '').trim();
  if (!text) return 'Type a command';
  if (text.length > MAX_LINE) return 'Command is too long';
  const name = text.split(/\s+/, 1)[0].toLowerCase();
  if (DESK_ONLY.has(name))
    return `"${name}" only runs from the keyboard on the computer`;
  return null;
}

export function createRemoteHub({
  now = () => Date.now(),
  randomBytes = nodeRandomBytes,
} = {}) {
  /** tokenHash -> device */
  const devices = new Map();
  let pairing = null; // { code, expiresAt, attempts }
  const pending = []; // queued command ids, oldest first
  const commands = new Map(); // id -> command record
  let waiters = []; // desktop long-polls waiting for a command
  let deskSeenAt = 0;
  let commandSeq = 0;
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => fn());

  const publicDevice = (d) => ({
    id: d.id,
    name: d.name,
    pairedAt: d.pairedAt,
    lastSeenAt: d.lastSeenAt,
  });

  function startPairing() {
    // Six digits, read off the computer screen and typed on the phone.
    const n = randomBytes(4).readUInt32BE(0) % 1_000_000;
    pairing = {
      code: String(n).padStart(6, '0'),
      expiresAt: now() + PAIR_CODE_TTL_MS,
      attempts: 0,
    };
    return { code: pairing.code, expiresAt: pairing.expiresAt };
  }

  function pairingState() {
    if (!pairing || pairing.expiresAt <= now()) return null;
    return { code: pairing.code, expiresAt: pairing.expiresAt };
  }

  /** Trade the code on the computer screen for a device token. */
  function pair(code, name) {
    if (!pairing || pairing.expiresAt <= now()) {
      pairing = null;
      return {
        ok: false,
        error: 'No pairing code is active. Start one on the computer.',
      };
    }
    if (String(code ?? '').replace(/\s+/g, '') !== pairing.code) {
      pairing.attempts += 1;
      if (pairing.attempts >= PAIR_MAX_ATTEMPTS) {
        pairing = null;
        return {
          ok: false,
          error: 'Too many wrong codes. Start a new code on the computer.',
        };
      }
      return { ok: false, error: 'That code does not match' };
    }
    pairing = null; // single use
    if (devices.size >= MAX_DEVICES) {
      // Forget the device seen longest ago to make room.
      const oldest = [...devices.entries()].sort(
        (a, b) => a[1].lastSeenAt - b[1].lastSeenAt,
      )[0];
      devices.delete(oldest[0]);
    }
    const token = randomBytes(32).toString('base64url');
    const device = {
      id: randomBytes(6).toString('hex'),
      name: cleanDeviceName(name),
      pairedAt: now(),
      lastSeenAt: now(),
    };
    devices.set(hashToken(token), device);
    emit();
    return { ok: true, token, device: publicDevice(device) };
  }

  /** The device a bearer token belongs to, or null. */
  function authenticate(token) {
    if (!token) return null;
    const device = devices.get(hashToken(token));
    if (!device) return null;
    device.lastSeenAt = now();
    return publicDevice(device);
  }

  function revoke(id) {
    let removed = 0;
    for (const [key, device] of devices) {
      if (id === 'all' || device.id === id) {
        devices.delete(key);
        removed += 1;
      }
    }
    if (removed) emit();
    return removed;
  }

  const listDevices = () => [...devices.values()].map(publicDevice);

  // ---- command queue: phone -> desktop app ----

  function prune() {
    const done = [...commands.values()].filter(
      (c) => c.status === 'done' || c.status === 'failed',
    );
    for (const c of done.slice(0, Math.max(0, commands.size - MAX_KEPT)))
      commands.delete(c.id);
  }

  function enqueue(device, line) {
    const refusal = refusePhoneCommand(line);
    if (refusal) return { ok: false, error: refusal };
    if (pending.length >= MAX_PENDING)
      return {
        ok: false,
        error: 'The computer has too many commands waiting',
      };
    const id = `c${++commandSeq}`;
    const command = {
      id,
      line: String(line).trim(),
      from: device?.name ?? 'Phone',
      status: 'queued',
      queuedAt: now(),
      lines: [],
      image: null,
    };
    commands.set(id, command);
    prune();
    const waiter = waiters.shift();
    if (waiter) handOut(command, waiter);
    else pending.push(id);
    emit();
    return { ok: true, command: publicCommand(command) };
  }

  function handOut(command, resolve) {
    command.status = 'running';
    command.startedAt = now();
    resolve({ id: command.id, line: command.line, from: command.from });
  }

  /**
   * The desktop app asks for its next command. Resolves with one, or null
   * once `waitMs` passes or `signal` aborts.
   */
  function nextCommand({ waitMs = 25_000, signal } = {}) {
    deskSeenAt = now();
    while (pending.length) {
      const command = commands.get(pending.shift());
      if (command?.status === 'queued') {
        let out;
        handOut(command, (c) => (out = c));
        return Promise.resolve(out);
      }
    }
    return new Promise((resolve) => {
      let timer = null;
      const finish = (value) => {
        clearTimeout(timer);
        waiters = waiters.filter((w) => w !== take);
        signal?.removeEventListener('abort', onAbort);
        deskSeenAt = now();
        resolve(value);
      };
      const take = (command) => finish(command);
      const onAbort = () => finish(null);
      timer = setTimeout(() => finish(null), waitMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      waiters.push(take);
    });
  }

  /** The desktop app reports what a command printed. */
  function complete(id, { ok = true, lines = [], image = null } = {}) {
    const command = commands.get(id);
    if (!command || command.status !== 'running') return false;
    command.status = ok ? 'done' : 'failed';
    command.finishedAt = now();
    command.lines = (Array.isArray(lines) ? lines : [])
      .slice(0, 60)
      .map((l) => ({
        text: String(l?.text ?? l ?? '').slice(0, 4000),
        tone: ['ok', 'err', 'dim', 'in'].includes(l?.tone) ? l.tone : '',
      }));
    command.image =
      typeof image === 'string' && /^data:image\/(jpeg|png);base64,/.test(image)
        ? image
        : null;
    deskSeenAt = now();
    emit();
    return true;
  }

  const publicCommand = (c) => ({
    id: c.id,
    line: c.line,
    from: c.from,
    status: c.status,
    queuedAt: c.queuedAt,
    finishedAt: c.finishedAt ?? null,
    lines: c.lines,
    image: c.image,
  });

  const getCommand = (id) => {
    const c = commands.get(id);
    return c ? publicCommand(c) : null;
  };

  const recentCommands = (limit = 10) =>
    [...commands.values()]
      .slice(-limit)
      .reverse()
      .map(({ image, ...c }) => ({ ...publicCommand(c), image: null }));

  return {
    startPairing,
    pairingState,
    pair,
    authenticate,
    revoke,
    listDevices,
    enqueue,
    nextCommand,
    complete,
    getCommand,
    recentCommands,
    deskOnline: () => now() - deskSeenAt < DESK_ONLINE_MS,
    deskSeenAt: () => deskSeenAt || null,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** Stable JSON so `{a,b}` and `{b,a}` share a cache entry. */
export function stableKey(value) {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableKey(value[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/**
 * The computer's cache for tool answers the phone asks for. Live feeds go
 * stale fast, so entries are short-lived; concurrent identical asks share one
 * run.
 */
export function createResultCache({
  ttlMs = 60_000,
  max = 200,
  now = () => Date.now(),
} = {}) {
  const entries = new Map(); // key -> { at, value } | { promise }
  let hits = 0;
  let misses = 0;

  async function get(key, produce) {
    const entry = entries.get(key);
    if (entry?.promise) {
      hits += 1;
      const value = await entry.promise;
      return { value, cached: true, ageMs: 0 };
    }
    if (entry && now() - entry.at < ttlMs) {
      hits += 1;
      // Refresh recency.
      entries.delete(key);
      entries.set(key, entry);
      return { value: entry.value, cached: true, ageMs: now() - entry.at };
    }
    misses += 1;
    const promise = produce();
    entries.set(key, { promise });
    try {
      const value = await promise;
      entries.delete(key);
      entries.set(key, { at: now(), value });
      while (entries.size > max) entries.delete(entries.keys().next().value);
      return { value, cached: false, ageMs: 0 };
    } catch (error) {
      entries.delete(key); // never cache failures
      throw error;
    }
  }

  return {
    get,
    stats: () => ({ entries: entries.size, hits, misses, ttlMs }),
    clear: () => entries.clear(),
  };
}
