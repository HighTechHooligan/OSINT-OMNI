/**
 * Location research (STUB): the seam for a future AI web-crawler lookup on a
 * building, road or park dossier.
 *
 * Today nothing here touches the network. `planLocationResearch` turns a
 * dossier into the searches an agent should run, and the dossier panel shows
 * them as "planned" so the person can see what the agent will look for.
 *
 * When the private AI host lands, supply a `crawl` function that runs one
 * query and returns `{ title, url, snippet }[]` (a self-hosted search API,
 * a crawler, or an MCP tool). `createLocationResearch({ crawl })` then runs
 * the plan, de-duplicates hits by URL, and hands the results back for the
 * agent to summarize into the dossier. To expose it to the agent as a tool,
 * wrap `research` with `defineTool` (see ./catalog.js) and add it to the
 * catalog in ./index.js; keep results as cited links, never as unsourced
 * claims about a place.
 */

const clean = (value) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();

/** Topics per dossier kind; each becomes one query with the place's name. */
export const RESEARCH_TOPICS = Object.freeze({
  building: [
    'property records owner parcel',
    'building permits',
    'history built year',
    'business tenants',
    'news',
  ],
  road: ['road construction project', 'traffic crash reports', 'news'],
  park: ['park history', 'events permits', 'news'],
});

/**
 * The searches an agent would run for a dossier.
 * @param {{ kind:'building'|'road'|'park', name?:string|null,
 *   address?:string|null, locality?:string|null, lat?:number, lon?:number }} dossier
 * @returns {{ topic:string, query:string }[]}
 */
export function planLocationResearch(dossier = {}) {
  const topics = RESEARCH_TOPICS[dossier.kind] ?? RESEARCH_TOPICS.building;
  const anchor =
    clean(dossier.address) ||
    [clean(dossier.name), clean(dossier.locality)].filter(Boolean).join(', ') ||
    (Number.isFinite(dossier.lat) && Number.isFinite(dossier.lon)
      ? `${dossier.lat.toFixed(5)}, ${dossier.lon.toFixed(5)}`
      : '');
  if (!anchor) return [];
  const named =
    dossier.name && dossier.address && !dossier.address.includes(dossier.name)
      ? `"${clean(dossier.name)}" `
      : '';
  return topics.map((topic) => ({
    topic,
    query: `${named}"${anchor}" ${topic}`,
  }));
}

/**
 * Research runner. Without a `crawl` function it reports that AI research is
 * not connected yet and returns the plan only.
 */
export function createLocationResearch({ crawl = null, maxResults = 20 } = {}) {
  return {
    available: typeof crawl === 'function',
    async research(dossier, { signal } = {}) {
      const plan = planLocationResearch(dossier);
      if (typeof crawl !== 'function')
        return {
          status: 'unavailable',
          reason: 'AI web research arrives with the private AI host.',
          plan,
          results: [],
        };
      const seen = new Set();
      const results = [];
      for (const step of plan) {
        signal?.throwIfAborted();
        for (const hit of (await crawl(step.query, { signal })) ?? []) {
          if (!hit?.url || seen.has(hit.url)) continue;
          seen.add(hit.url);
          results.push({ ...hit, topic: step.topic });
          if (results.length >= maxResults)
            return { status: 'ok', plan, results };
        }
      }
      return { status: 'ok', plan, results };
    },
  };
}
