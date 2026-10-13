import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aircraftTriviaProxy,
  createAircraftTrivia,
  filterRegistrationMentions,
  formatWikidataTime,
  parseTriviaQuery,
  parseWikidataFacts,
} from '../../server/providers/aircraft/trivia.js';

const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

function fakeUpstream() {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), ua: init?.headers?.['User-Agent'] });
    const u = new URL(url);
    if (u.pathname.startsWith('/api/rest_v1/page/summary/'))
      return json({
        title: 'Airbus A380',
        description: 'Wide-body airliner',
        extract: 'The Airbus A380 is a large wide-body airliner.',
        content_urls: {
          desktop: { page: 'https://en.wikipedia.org/wiki/Airbus_A380' },
        },
        wikibase_item: 'Q5830',
      });
    if (u.pathname.startsWith('/wiki/Special:EntityData/'))
      return json({
        entities: {
          Q5830: {
            claims: {
              P606: [
                {
                  rank: 'normal',
                  mainsnak: {
                    datavalue: {
                      type: 'time',
                      value: { time: '+2005-04-27T00:00:00Z', precision: 11 },
                    },
                  },
                },
              ],
              P729: [
                {
                  rank: 'normal',
                  mainsnak: {
                    datavalue: {
                      type: 'time',
                      value: { time: '+2007-10-00T00:00:00Z', precision: 10 },
                    },
                  },
                },
              ],
              P1092: [
                {
                  rank: 'normal',
                  mainsnak: {
                    datavalue: { type: 'quantity', value: { amount: '+254' } },
                  },
                },
              ],
            },
          },
        },
      });
    if (u.pathname === '/w/api.php') {
      const q = u.searchParams.get('srsearch');
      if (q.startsWith('"'))
        return json({
          query: {
            search: [
              {
                title: 'Qantas Flight 32',
                snippet:
                  'the aircraft, registered <span>VH-OQA</span>, suffered',
              },
              { title: 'Unrelated', snippet: 'VH-OQAB is a different tail' },
            ],
          },
        });
      return json({ query: { search: [{ title: 'Airbus A380' }] } });
    }
    return json({}, 404);
  };
  return { seen, fetchImpl };
}

test('query parsing rejects junk and keeps what is usable', () => {
  assert.equal(parseTriviaQuery(''), null);
  assert.equal(parseTriviaQuery('reg=%3Cscript%3E'), null);
  assert.deepEqual(parseTriviaQuery('article=Airbus%20A380&reg=vh-oqa'), {
    article: 'Airbus A380',
    name: null,
    reg: 'VH-OQA',
  });
});

test('wikidata facts keep their precision', () => {
  assert.equal(
    formatWikidataTime({ time: '+1967-04-09T00:00:00Z', precision: 11 }),
    '1967-04-09',
  );
  assert.equal(
    formatWikidataTime({ time: '+1955-00-00T00:00:00Z', precision: 9 }),
    '1955',
  );
  assert.deepEqual(parseWikidataFacts({ claims: {} }), {});
});

test('registration mentions must really name the tail', () => {
  const kept = filterRegistrationMentions(
    [
      { title: 'Qantas Flight 32', snippet: 'registered VH-OQA, the' },
      { title: 'Other', snippet: 'VH-OQAB' },
    ],
    'VH-OQA',
  );
  assert.deepEqual(
    kept.map((k) => k.title),
    ['Qantas Flight 32'],
  );
  assert.equal(kept[0].url, 'https://en.wikipedia.org/wiki/Qantas_Flight_32');
  assert.deepEqual(
    filterRegistrationMentions([{ title: 'x', snippet: 'N1' }], 'N1'),
    [],
  );
});

test('lookup combines summary, facts and mentions, and caches', async () => {
  const { seen, fetchImpl } = fakeUpstream();
  const trivia = createAircraftTrivia({ fetchImpl });
  const out = await trivia.lookup({ article: 'Airbus A380', reg: 'VH-OQA' });
  assert.equal(out.model.title, 'Airbus A380');
  assert.deepEqual(out.model.facts, {
    firstFlight: '2005-04-27',
    introduced: '2007-10',
    numberBuilt: 254,
  });
  assert.deepEqual(
    out.mentions.map((m) => m.title),
    ['Qantas Flight 32'],
  );
  assert.deepEqual(out.errors, []);
  assert.ok(seen.every((s) => /osint-omni/.test(s.ua)));
  const calls = seen.length;
  await trivia.lookup({ article: 'Airbus A380', reg: 'VH-OQA' });
  assert.equal(seen.length, calls, 'second lookup is served from cache');
});

test('a name without an article searches for the article', async () => {
  const { seen, fetchImpl } = fakeUpstream();
  const out = await createAircraftTrivia({ fetchImpl }).lookup({
    name: 'Airbus A380-841',
  });
  assert.equal(out.model.title, 'Airbus A380');
  assert.match(seen[0].url, /srsearch=Airbus\+A380-841\+aircraft/);
});

test('upstream failure is reported, not thrown', async () => {
  const trivia = createAircraftTrivia({
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });
  const out = await trivia.lookup({ article: 'Boeing 777', reg: 'N12345' });
  assert.equal(out.model, null);
  assert.deepEqual(out.errors, [
    'model lookup failed',
    'registration search failed',
  ]);
});

test('the route validates and answers JSON', async () => {
  let handler;
  const { fetchImpl } = fakeUpstream();
  aircraftTriviaProxy({ fetchImpl }).configureServer({
    middlewares: { use: (_p, h) => (handler = h) },
  });
  const call = async (url, method = 'GET') => {
    let status, body;
    await handler(
      { url, method },
      {
        writeHead: (s) => (status = s),
        end: (b) => (body = b),
      },
    );
    return { status, body: JSON.parse(body) };
  };
  assert.equal((await call('/')).status, 400);
  assert.equal((await call('/?article=x', 'POST')).status, 405);
  const ok = await call('/?article=Airbus%20A380');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.model.title, 'Airbus A380');
});
