import test from 'node:test';
import assert from 'node:assert/strict';
import { createInspectionPricing } from './inspectionPricing.js';

function fakeBuildings(records) {
  let selected = [];
  const listeners = new Set();
  return {
    selected: () => records.filter((r) => selected.includes(r.id)),
    select(ids) {
      selected = ids;
      listeners.forEach((fn) => fn());
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

const record = (id) => ({
  id,
  kind: 'building',
  tags: { 'roof:shape': 'flat' },
  center: [0, 0],
  measure: { areaM2: 100, perimeterM: 40, lengthM: 10, widthM: 10 },
  height: { heightM: 5, source: 'osm-height' },
});

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v),
  };
}

test('quotes the current selection and follows selection changes', () => {
  const buildings = fakeBuildings([record('a'), record('b')]);
  const pricing = createInspectionPricing({
    buildings,
    storage: memoryStorage(),
  });
  pricing.setRates({ unit: 'm2', roof: 1, wall: 1 });
  assert.equal(pricing.quote().totals.count, 0);
  let seen = null;
  pricing.onChange((q) => (seen = q));
  buildings.select(['a', 'b']);
  assert.equal(seen.totals.count, 2);
  assert.equal(seen.totals.price, 2 * (100 + 200));
});

test('rates persist through storage and ignore invalid input', () => {
  const storage = memoryStorage();
  const buildings = fakeBuildings([]);
  createInspectionPricing({ buildings, storage }).setRates({
    roof: 0.4,
    wall: 'oops',
  });
  const again = createInspectionPricing({ buildings, storage });
  assert.equal(again.rates().roof, 0.4);
  assert.equal(again.rates().wall, 0.15);
});
