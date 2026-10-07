/**
 * Aircraft model history and airframe mentions for the aircraft pop-out.
 *
 *   GET /api/aircraft/trivia?article=<Wikipedia title>&name=<type name>&reg=<tail>
 *
 * - `article` (or, without one, a Wikipedia search for `name`) gives the
 *   model's Wikipedia summary, and its Wikidata item gives first flight,
 *   service entry, retirement and number built.
 * - `reg` searches Wikipedia for articles that mention that registration
 *   (accidents, incidents, notable airframes); only hits whose text really
 *   contains the registration are kept.
 *
 * Free public APIs, so answers are cached in memory for a day and identical
 * requests in flight share one upstream call.
 */
const TTL_MS = 24 * 3600_000;
const MAX_ENTRIES = 500;
const TIMEOUT_MS = 8000;
export const AIRCRAFT_TRIVIA_USER_AGENT =
  'osint-omni/0.2 (+https://github.com/HighTechHooligan/OSINT-OMNI)';

const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const WIKI_SUMMARY = 'https://en.wikipedia.org/api/rest_v1/page/summary/';
const WIKIDATA_ENTITY = 'https://www.wikidata.org/wiki/Special:EntityData/';

/** Wikidata properties shown as model facts. */
export const TRIVIA_PROPERTIES = Object.freeze({
  firstFlight: 'P606',
  introduced: 'P729',
  retired: 'P730',
  numberBuilt: 'P1092',
});

/** Validate query parameters; returns null when nothing usable was sent. */
export function parseTriviaQuery(search) {
  const params = new URLSearchParams(search || '');
  const clean = (v, max) =>
    String(v ?? '')
      .replace(/[\u0000-\u001f]/g, '')
      .trim()
      .slice(0, max);
  const article = clean(params.get('article'), 120);
  const name = clean(params.get('name'), 80);
  const reg = clean(params.get('reg'), 12).toUpperCase();
  const out = {
    article: article || null,
    name: name || null,
    reg: /^[A-Z0-9][A-Z0-9-]{1,10}$/.test(reg) ? reg : null,
  };
  return out.article || out.name || out.reg ? out : null;
}

/** Wikidata time value ("+2009-12-15T00:00:00Z", precision 11) → date text. */
export function formatWikidataTime(value) {
  const match = /^([+-])(\d{1,})-(\d{2})-(\d{2})/.exec(value?.time ?? '');
  if (!match) return null;
  const [, sign, year, month, day] = match;
  const y = `${sign === '-' ? '-' : ''}${Number(year)}`;
  const precision = Number(value.precision ?? 11);
  if (precision <= 9 || month === '00') return y;
  if (precision === 10 || day === '00') return `${y}-${month}`;
  return `${y}-${month}-${day}`;
}

/** Pull the model facts out of a Wikidata entity document. */
export function parseWikidataFacts(entity) {
  const claims = entity?.claims ?? {};
  const first = (pid) =>
    (claims[pid] ?? []).find(
      (c) => c?.rank !== 'deprecated' && c?.mainsnak?.datavalue,
    )?.mainsnak.datavalue;
  const facts = {};
  for (const [key, pid] of Object.entries(TRIVIA_PROPERTIES)) {
    const dv = first(pid);
    if (!dv) continue;
    if (dv.type === 'time') {
      const text = formatWikidataTime(dv.value);
      if (text) facts[key] = text;
    } else if (dv.type === 'quantity') {
      const n = Number(dv.value?.amount);
      if (Number.isFinite(n)) facts[key] = n;
    }
  }
  return facts;
}

const stripHtml = (s) =>
  String(s ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

const wikiUrl = (title) =>
  `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;

/** Keep only search hits whose snippet or title really names the tail. */
export function filterRegistrationMentions(results, reg) {
  if (!reg) return [];
  const loose = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const target = loose(reg);
  // A short tail like "N1" would match far too much; require 4+ characters.
  if (target.length < 4) return [];
  const word = new RegExp(
    `(^|[^A-Z0-9])${reg.replace(/[-]/g, '-?')}([^A-Z0-9]|$)`,
    'i',
  );
  return (results ?? [])
    .map((r) => ({
      title: String(r?.title ?? ''),
      snippet: stripHtml(r?.snippet),
    }))
    .filter((r) => r.title && (word.test(r.snippet) || word.test(r.title)))
    .slice(0, 5)
    .map((r) => ({ ...r, url: wikiUrl(r.title) }));
}

export function createAircraftTrivia({
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  const cache = new Map();
  const inflight = new Map();

  async function getJson(url) {
    const res = await fetchImpl(url, {
      headers: {
        'User-Agent': AIRCRAFT_TRIVIA_USER_AGENT,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function searchTitle(text, limit = 1) {
    const url = `${WIKI_API}?${new URLSearchParams({
      action: 'query',
      list: 'search',
      srsearch: text,
      srlimit: String(limit),
      format: 'json',
      origin: '*',
    })}`;
    return (await getJson(url))?.query?.search ?? [];
  }

  async function model({ article, name }) {
    let title = article;
    if (!title && name) {
      const [hit] = await searchTitle(`${name} aircraft`);
      title = hit?.title ?? null;
    }
    if (!title) return null;
    const summary = await getJson(
      `${WIKI_SUMMARY}${encodeURIComponent(title.replace(/ /g, '_'))}`,
    );
    if (!summary?.title) return null;
    const out = {
      title: summary.title,
      description: summary.description || null,
      extract: summary.extract || null,
      url: summary.content_urls?.desktop?.page || wikiUrl(summary.title),
      thumbnail: summary.thumbnail?.source || null,
      wikidata: summary.wikibase_item || null,
      facts: {},
    };
    if (/^Q\d+$/.test(out.wikidata ?? '')) {
      try {
        const doc = await getJson(`${WIKIDATA_ENTITY}${out.wikidata}.json`);
        out.facts = parseWikidataFacts(doc?.entities?.[out.wikidata]);
      } catch {
        // facts are optional; the summary still stands
      }
    }
    return out;
  }

  async function mentions(reg) {
    if (!reg) return [];
    return filterRegistrationMentions(await searchTitle(`"${reg}"`, 8), reg);
  }

  function cached(key, load) {
    const hit = cache.get(key);
    if (hit && now() - hit.at < TTL_MS) return Promise.resolve(hit.data);
    if (!inflight.has(key)) {
      inflight.set(
        key,
        load()
          .then((data) => {
            cache.set(key, { at: now(), data });
            while (cache.size > MAX_ENTRIES)
              cache.delete(cache.keys().next().value);
            return data;
          })
          .finally(() => inflight.delete(key)),
      );
    }
    return inflight.get(key);
  }

  /** Look up one query; failures of either half are reported, not thrown. */
  async function lookup({ article = null, name = null, reg = null }) {
    const errors = [];
    const [modelResult, mentionResult] = await Promise.allSettled([
      article || name
        ? cached(`model:${article ?? ''}|${name ?? ''}`, () =>
            model({ article, name }),
          )
        : Promise.resolve(null),
      reg ? cached(`reg:${reg}`, () => mentions(reg)) : Promise.resolve([]),
    ]);
    if (modelResult.status === 'rejected') errors.push('model lookup failed');
    if (mentionResult.status === 'rejected')
      errors.push('registration search failed');
    return {
      model: modelResult.status === 'fulfilled' ? modelResult.value : null,
      mentions: mentionResult.status === 'fulfilled' ? mentionResult.value : [],
      errors,
    };
  }

  return { lookup };
}

export function aircraftTriviaProxy({ fetchImpl } = {}) {
  const trivia = createAircraftTrivia(fetchImpl ? { fetchImpl } : {});
  const install = (server) => {
    server.middlewares.use('/api/aircraft/trivia', async (req, res) => {
      const send = (status, obj) => {
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(obj));
      };
      if (req.method && req.method !== 'GET')
        return send(405, { error: 'method not allowed' });
      const query = parseTriviaQuery(String(req.url || '').split('?')[1]);
      if (!query) return send(400, { error: 'article, name or reg required' });
      try {
        return send(200, await trivia.lookup(query));
      } catch {
        console.error('[aircraft-trivia] request failed');
        return send(500, { error: 'aircraft trivia error' });
      }
    });
  };
  return {
    name: 'aircraft-trivia',
    configureServer: install,
    configurePreviewServer: install,
  };
}
