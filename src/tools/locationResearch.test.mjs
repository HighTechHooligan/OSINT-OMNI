import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLocationResearch,
  planLocationResearch,
} from './locationResearch.js';

test('plan uses the address, or name + locality, or coordinates', () => {
  const byAddress = planLocationResearch({
    kind: 'building',
    name: 'Normandale Tower',
    address: '7600 Normandale Blvd, Bloomington, MN',
  });
  assert.equal(byAddress.length, 5);
  assert.match(byAddress[0].query, /^"Normandale Tower" "7600 Normandale/);
  const road = planLocationResearch({
    kind: 'road',
    name: 'Elm St',
    locality: 'Edina',
  });
  assert.match(road[0].query, /"Elm St, Edina"/);
  const bare = planLocationResearch({ kind: 'park', lat: 44.85, lon: -93.3 });
  assert.match(bare[0].query, /44\.85000, -93\.30000/);
  assert.deepEqual(planLocationResearch({ kind: 'park' }), []);
});

test('without a crawler the stub reports unavailable and returns the plan', async () => {
  const out = await createLocationResearch().research({
    kind: 'park',
    name: 'Green',
    locality: 'X',
  });
  assert.equal(out.status, 'unavailable');
  assert.equal(out.plan.length, 3);
  assert.deepEqual(out.results, []);
});

test('with a crawler, hits are tagged by topic and de-duplicated', async () => {
  const research = createLocationResearch({
    crawl: async (q) => [
      { url: 'https://a.example', title: 'A', snippet: q },
      { url: 'https://b.example', title: 'B', snippet: q },
    ],
  });
  const out = await research.research({
    kind: 'road',
    name: 'Elm',
    locality: 'Y',
  });
  assert.equal(out.status, 'ok');
  assert.equal(out.results.length, 2);
  assert.equal(out.results[0].topic, 'road construction project');
});
