import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUDGET_PROFILES,
  attachSceneBudgets,
  budgetLine,
  createResourceBudgets,
  parseBudgetValue,
  resolveWorkers,
} from './resourceBudgets.js';

function memory() {
  const map = new Map();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, v),
  };
}

test('defaults to the high profile, using every core but one', () => {
  const b = createResourceBudgets({ storage: memory(), cores: 16 }).get();
  assert.equal(b.profile, 'high');
  assert.equal(b.cpuWorkers, 15);
  assert.equal(b.hybrid, true);
  assert.ok(b.tilesetCacheMB > BUDGET_PROFILES.balanced.tilesetCacheMB);
  assert.ok(b.gpuWorkScale > BUDGET_PROFILES.balanced.gpuWorkScale);
});

test('worker counts per profile', () => {
  assert.equal(resolveWorkers('light', 16), 2);
  assert.equal(resolveWorkers('balanced', 16), 8);
  assert.equal(resolveWorkers('high', 16), 15);
  assert.equal(resolveWorkers('max', 16), 16);
  assert.equal(resolveWorkers('high', 1), 1);
});

test('profiles and overrides persist, and a profile switch clears overrides', () => {
  const storage = memory();
  const a = createResourceBudgets({ storage, cores: 8 });
  const seen = [];
  a.onChange((b) => seen.push(b.profile));
  a.setProfile('max');
  a.set('cache', '6 GB');
  a.set('workers', '3');
  a.set('hybrid', 'off');
  const b = createResourceBudgets({ storage, cores: 8 }).get();
  assert.equal(b.profile, 'max');
  assert.equal(b.tilesetCacheMB, 6144);
  assert.equal(b.cpuWorkers, 3);
  assert.equal(b.hybrid, false);
  assert.deepEqual([...b.overridden].sort(), [
    'cpuWorkers',
    'hybrid',
    'tilesetCacheMB',
  ]);
  assert.match(budgetLine(b), /max \(custom\) · 3 of 8 CPU threads/);
  a.setProfile('light');
  assert.equal(a.get().overridden.length, 0);
  assert.equal(seen.length, 5);
});

test('values clamp to their limits; bad names and values throw', () => {
  const a = createResourceBudgets({ storage: memory(), cores: 4 });
  assert.equal(a.set('workers', '500').cpuWorkers, 64);
  assert.equal(a.set('grids', '1').gridCacheMB, 16);
  assert.equal(a.set('observers', '20k').maxObservers, 20_000);
  assert.equal(a.set('workers', 'auto').cpuWorkers, 3);
  assert.throws(() => a.set('warp', '9'), /Unknown budget/);
  assert.throws(() => a.set('cache', 'lots'), /Bad value/);
  assert.throws(() => a.setProfile('ludicrous'), /Unknown profile/);
  assert.equal(parseBudgetValue('tilesetCacheMB', '1.5gb'), 1536);
  assert.equal(parseBudgetValue('pointCellsGpu', '4M'), 4e6);
  assert.equal(parseBudgetValue('tilesetCacheMB', '4 tb'), null);
});

test('unreadable storage falls back to defaults', () => {
  const storage = {
    getItem: () => '{not json',
    setItem: () => {
      throw new Error('full');
    },
  };
  const a = createResourceBudgets({ storage, cores: 4 });
  assert.equal(a.get().profile, 'high');
  assert.equal(a.setProfile('light').profile, 'light');
});

test('scene budgets resize tileset caches now and on later changes', () => {
  const budgets = createResourceBudgets({ storage: memory(), cores: 4 });
  const tileset = { cacheBytes: 1, maximumCacheOverflowBytes: 1 };
  const other = { show: true };
  let added = null;
  const scene = {
    primitives: {
      length: 2,
      get: (i) => [tileset, other][i],
      primitiveAdded: {
        addEventListener(fn) {
          added = fn;
          return () => (added = null);
        },
      },
    },
    globe: { tileCacheSize: 100 },
  };
  const detach = attachSceneBudgets(scene, budgets);
  const MB = 1024 * 1024;
  assert.equal(tileset.cacheBytes, BUDGET_PROFILES.high.tilesetCacheMB * MB);
  assert.equal(scene.globe.tileCacheSize, BUDGET_PROFILES.high.globeTileCache);
  assert.equal('cacheBytes' in other, false);
  budgets.set('cache', '8 GB');
  assert.equal(tileset.cacheBytes, 8192 * MB);
  const late = { cacheBytes: 0, maximumCacheOverflowBytes: 0 };
  added(late);
  assert.equal(late.cacheBytes, 8192 * MB);
  detach();
  assert.equal(added, null);
  budgets.set('cache', '1 GB');
  assert.equal(tileset.cacheBytes, 8192 * MB);
});
