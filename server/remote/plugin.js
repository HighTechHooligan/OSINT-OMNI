/**
 * Phone remote: a phone on the same network drives the desktop app running
 * on this computer, while this computer runs the tools and caches their
 * answers.
 *
 *   /phone/            the phone web app (static files in ./phone)
 *   /remote/pair       phone trades the code shown on the computer for a token
 *   /remote/api/*      phone API, bearer token required
 *   /remote/desk/*     the desktop app's side: start pairing, list and revoke
 *                      phones, take queued commands, report results. Local
 *                      requests only, with the same gate as /mcp.
 *
 * Reaching it from a phone needs the documented LAN opt-in (HOST=0.0.0.0).
 * The phone API is refused while launcher sharing is on, so a public share
 * link never exposes it. See docs/PHONE-REMOTE.md.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { isSharingEnabled } from '../../src/keySetupCore.mjs';
import { composeCatalog, coreTools } from '../../src/tools/index.js';
import { isLocalMcpRequest } from '../mcp/plugin.js';
import { createLocalToolServices } from '../mcp/services.js';
import { createRemoteHub, createResultCache, stableKey } from './hub.js';

const PHONE_DIR = new URL('./phone/', import.meta.url);
const PHONE_FILES = Object.freeze({
  'index.html': 'text/html; charset=utf-8',
  'phone.js': 'text/javascript; charset=utf-8',
  'phone.css': 'text/css; charset=utf-8',
  'manifest.webmanifest': 'application/manifest+json',
  'icon.svg': 'image/svg+xml',
});
/** Tools that only make sense inside the desktop app or an MCP client. */
const PHONE_HIDDEN_TOOLS = new Set([
  'panel_request',
  'show_in_gods_eye_view',
  'get_hud_caption',
]);
const MAX_BODY_BYTES = 2 * 1024 * 1024; // room for a screen snapshot
const DESK_WAIT_MS = 25 * 1000;
const FEEDBACK_FILE = path.join(
  process.cwd(),
  '.gev-cache',
  'phone-feedback.jsonl',
);

/**
 * The app's theme tokens (the `:root` block of foundation.css), so the phone
 * uses the same accent without copying colors.
 */
export async function readAccentTokens(
  file = new URL('../../src/ui/styles/foundation.css', import.meta.url),
) {
  const css = await readFile(file, 'utf8');
  return /:root\s*\{[\s\S]*?\n\}/.exec(css)?.[0] ?? '';
}

/** This computer's IPv4 LAN addresses. */
export function lanAddresses(interfaces = networkInterfaces()) {
  return Object.values(interfaces)
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

/** Whether the server listens beyond loopback, so a phone can reach it. */
export function listensOnLan(address) {
  const host = typeof address === 'object' ? address?.address : null;
  return Boolean(host) && !['127.0.0.1', '::1', 'localhost'].includes(host);
}

/** The tool catalog the phone sees, with answers cached on this computer. */
export function createPhoneCatalog({ apiBase, cache, fetchImpl }) {
  const cacheQueries = (call, next) => {
    // Nested calls (a brief calling weather) share the outer call's entry.
    if (call.tool.kind !== 'query' || call.parent) return next(call);
    return cache
      .get(`${call.tool.name}:${stableKey(call.args)}`, () => next(call))
      .then(({ value, cached, ageMs }) => ({
        ...value,
        cache: { hit: cached, ageSeconds: Math.round(ageMs / 1000) },
      }));
  };
  return composeCatalog({
    tools: coreTools.filter((t) => !PHONE_HIDDEN_TOOLS.has(t.name)),
    services: createLocalToolServices({ apiBase, fetchImpl }),
    interceptors: [cacheQueries],
  });
}

/** The request handler, separated from Vite so tests can drive it. */
export function createRemoteHandler({
  hub = createRemoteHub(),
  cache = createResultCache(),
  env = process.env,
  catalogFor = (apiBase) => createPhoneCatalog({ apiBase, cache }),
  boundAddress = () => null,
  addresses = lanAddresses,
  feedbackFile = FEEDBACK_FILE,
  readPhoneFile = (name) => readFile(new URL(name, PHONE_DIR)),
  readTokens = readAccentTokens,
  deskWaitMs = DESK_WAIT_MS,
} = {}) {
  const catalogs = new Map();
  const catalogAt = (apiBase) => {
    if (!catalogs.has(apiBase)) catalogs.set(apiBase, catalogFor(apiBase));
    return catalogs.get(apiBase);
  };
  let feedbackCount = 0;

  const isLocal = (req) =>
    isLocalMcpRequest({
      remoteAddress: req.socket?.remoteAddress,
      localPort: req.socket?.localPort,
      host: req.headers.host || '',
      origin: req.headers.origin,
      headers: req.headers,
      env,
    });
  const protocolOf = (req) => (req.socket?.encrypted ? 'https' : 'http');
  // Tools fetch this server's own /api routes over loopback.
  const selfBase = (req) =>
    `${protocolOf(req)}://localhost:${req.socket?.localPort ?? 4173}`;

  function phoneUrls(req) {
    const port = req.socket?.localPort ?? 4173;
    const lan = listensOnLan(boundAddress());
    return {
      lanReady: lan,
      urls: lan
        ? addresses().map((ip) => `${protocolOf(req)}://${ip}:${port}/phone/`)
        : [],
      hint: lan
        ? null
        : 'This server only listens on this computer. Restart it with HOST=0.0.0.0 so a phone on the same Wi-Fi can reach it.',
    };
  }

  async function servePhone(req, res, name) {
    const file = name || 'index.html';
    if (file === 'tokens.css') {
      res.writeHead(200, {
        'Content-Type': 'text/css; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      return res.end(await readTokens());
    }
    if (!Object.hasOwn(PHONE_FILES, file)) return send(res, 404, 'Not found');
    try {
      const body = await readPhoneFile(file);
      res.writeHead(200, {
        'Content-Type': PHONE_FILES[file],
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(body);
    } catch {
      send(res, 404, 'Not found');
    }
  }

  async function desk(req, res, route) {
    if (!isLocal(req))
      return json(res, 403, {
        error: 'Only the desktop app on this computer may use this',
      });
    if (
      req.method === 'POST' &&
      !/^application\/json\b/i.test(req.headers['content-type'] || '')
    )
      return json(res, 415, { error: 'Content-Type must be application/json' });
    const state = () => ({
      pairing: hub.pairingState(),
      devices: hub.listDevices(),
      recent: hub.recentCommands(8),
      cache: cache.stats(),
      feedbackCount,
      ...phoneUrls(req),
    });
    if (route === 'state' && req.method === 'GET')
      return json(res, 200, state());
    if (route === 'pair' && req.method === 'POST') {
      hub.startPairing();
      return json(res, 200, state());
    }
    if (route === 'revoke' && req.method === 'POST') {
      const { id } = await readJson(req);
      hub.revoke(String(id ?? ''));
      return json(res, 200, state());
    }
    if (route === 'next' && req.method === 'GET') {
      const gone = new AbortController();
      const onClose = () => gone.abort();
      res.on('close', onClose);
      const command = await hub.nextCommand({
        waitMs: deskWaitMs,
        signal: gone.signal,
      });
      res.off('close', onClose);
      if (gone.signal.aborted) return;
      if (!command) {
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        return res.end();
      }
      return json(res, 200, { command });
    }
    if (route === 'result' && req.method === 'POST') {
      const body = await readJson(req);
      return json(res, 200, {
        ok: hub.complete(String(body.id ?? ''), body),
      });
    }
    return json(res, 404, { error: 'Unknown desktop route' });
  }

  async function phoneApi(req, res, route) {
    const token = /^Bearer\s+(\S+)$/i.exec(
      req.headers.authorization || '',
    )?.[1];
    const device = hub.authenticate(token);
    if (!device)
      return json(res, 401, {
        error: 'This phone is not paired. Pair it again from the computer.',
      });
    if (
      req.method === 'POST' &&
      !/^application\/json\b/i.test(req.headers['content-type'] || '')
    )
      return json(res, 415, { error: 'Content-Type must be application/json' });

    if (route === 'status' && req.method === 'GET')
      return json(res, 200, {
        device,
        desktopOnline: hub.deskOnline(),
        desktopSeenAt: hub.deskSeenAt(),
        cache: cache.stats(),
      });

    if (route === 'tools' && req.method === 'GET')
      return json(res, 200, {
        tools: catalogAt(selfBase(req))
          .list()
          .map(({ name, title, description, inputSchema, kind }) => ({
            name,
            title,
            description,
            inputSchema,
            kind,
          })),
      });

    const toolMatch = /^tools\/([a-z][a-z0-9_]{0,63})$/.exec(route);
    if (toolMatch && req.method === 'POST') {
      const args = await readJson(req);
      const gone = new AbortController();
      const onClose = () => {
        if (!res.writableFinished) gone.abort();
      };
      res.on('close', onClose);
      try {
        const result = await catalogAt(selfBase(req)).call(toolMatch[1], args, {
          signal: gone.signal,
        });
        return json(res, 200, { ok: true, ...result });
      } catch (error) {
        if (gone.signal.aborted) return;
        // The phone gets a plain message; the reason stays on this computer.
        if (error?.name !== 'ToolError')
          console.warn(
            `[phone-remote] ${toolMatch[1]} failed:`,
            error?.message,
          );
        return json(res, error?.name === 'ToolError' ? 422 : 500, {
          ok: false,
          code: error?.code ?? 'failed',
          error:
            error?.name === 'ToolError'
              ? error.message
              : "The computer could not get this right now. The reason is in the computer's terminal.",
          retryAfterSeconds: error?.retryAfterSeconds ?? null,
        });
      } finally {
        res.off('close', onClose);
      }
    }

    if (route === 'commands' && req.method === 'POST') {
      const { line } = await readJson(req);
      const queued = hub.enqueue(device, line);
      if (!queued.ok) return json(res, 400, queued);
      return json(res, 202, {
        ...queued,
        desktopOnline: hub.deskOnline(),
      });
    }
    const commandMatch = /^commands\/(c\d+)$/.exec(route);
    if (commandMatch && req.method === 'GET') {
      const command = hub.getCommand(commandMatch[1]);
      return command
        ? json(res, 200, { command })
        : json(res, 404, { error: 'No such command' });
    }

    if (route === 'feedback' && req.method === 'POST') {
      const body = await readJson(req);
      const rating = ['clear', 'unclear'].includes(body.rating)
        ? body.rating
        : null;
      if (!rating)
        return json(res, 400, { error: 'rating must be clear or unclear' });
      const entry = {
        at: new Date().toISOString(),
        device: device.name,
        screen: String(body.screen ?? '').slice(0, 80),
        about: String(body.about ?? '').slice(0, 120),
        rating,
        note: String(body.note ?? '').slice(0, 1000),
        textSize: Number(body.textSize) || null,
      };
      await mkdir(path.dirname(feedbackFile), { recursive: true });
      await appendFile(feedbackFile, `${JSON.stringify(entry)}\n`);
      feedbackCount += 1;
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: 'Unknown phone route' });
  }

  return async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://local');
    const { pathname } = url;
    try {
      if (pathname === '/phone') {
        res.writeHead(302, { Location: '/phone/' });
        return res.end();
      }
      if (pathname.startsWith('/phone/') && req.method === 'GET')
        return await servePhone(req, res, pathname.slice('/phone/'.length));
      if (!pathname.startsWith('/remote/')) return false;
      const route = pathname.slice('/remote/'.length);
      if (route.startsWith('desk/'))
        return await desk(req, res, route.slice('desk/'.length));
      // Everything a phone reaches is off while sharing could expose it.
      if (isSharingEnabled(env))
        return json(res, 403, {
          error: 'The phone remote is off while sharing is on',
        });
      if (route === 'pair' && req.method === 'POST') {
        if (!/^application\/json\b/i.test(req.headers['content-type'] || ''))
          return json(res, 415, {
            error: 'Content-Type must be application/json',
          });
        const { code, name } = await readJson(req);
        const result = hub.pair(code, name);
        return json(res, result.ok ? 200 : 403, result);
      }
      if (route.startsWith('api/'))
        return await phoneApi(req, res, route.slice('api/'.length));
      return json(res, 404, { error: 'Unknown remote route' });
    } catch (error) {
      if (res.headersSent) return res.destroy();
      const status = [400, 408, 413].includes(error?.status)
        ? error.status
        : 500;
      return json(res, status, {
        error: status === 500 ? 'Remote request failed' : error.message,
      });
    }
  };
}

/** Vite plugin mounting the phone app and its API on dev and preview. */
export function phoneRemotePlugin(options = {}) {
  const install = (server) => {
    const handle = createRemoteHandler({
      boundAddress: () => server.httpServer?.address?.() ?? null,
      ...options,
    });
    server.middlewares.use(async (req, res, next) => {
      const handled = await handle(req, res);
      if (handled === false) next();
    });
  };
  return {
    name: 'phone-remote',
    configureServer: install,
    configurePreviewServer: install,
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(
      () =>
        reject(Object.assign(new Error('Request timed out'), { status: 408 })),
      30_000,
    );
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        clearTimeout(timer);
        reject(Object.assign(new Error('Request too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        const value = JSON.parse(text);
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new Error('not an object');
        resolve(value);
      } catch {
        reject(
          Object.assign(new Error('Body must be a JSON object'), {
            status: 400,
          }),
        );
      }
    });
    req.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function send(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}
