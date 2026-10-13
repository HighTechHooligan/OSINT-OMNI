/**
 * Drone-inspection pricing for the buildings selected in building mode.
 * Holds the editable rates (remembered in localStorage) and turns the
 * current selection into a quote: roof, wall and total surface per
 * building, a price per building and the sum. The SITE tray and the
 * Features Code `price` command both call this; the math is in surfaceMath.
 */

import {
  DEFAULT_RATES,
  normalizeRates,
  quoteBuildings,
  quoteCsv,
} from './surfaceMath.js';

const STORAGE_KEY = 'omni.inspectionRates.v1';

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function createInspectionPricing({
  buildings,
  storage = defaultStorage(),
} = {}) {
  if (!buildings) throw new TypeError('Pricing needs building mode');
  let rates = load();
  const listeners = new Set();
  const emit = () => {
    const q = quote();
    listeners.forEach((fn) => fn(q));
  };

  function load() {
    try {
      const raw = storage?.getItem(STORAGE_KEY);
      return normalizeRates(raw ? JSON.parse(raw) : {});
    } catch {
      return normalizeRates({});
    }
  }

  function save() {
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify(rates));
    } catch {
      // private window or blocked storage: rates last for this session
    }
  }

  /** Merge new rates over the current ones (invalid values are ignored). */
  function setRates(next = {}) {
    rates = normalizeRates({ ...rates, ...next }, rates);
    save();
    emit();
    return { ...rates };
  }

  function resetRates() {
    rates = normalizeRates({ ...DEFAULT_RATES });
    save();
    emit();
    return { ...rates };
  }

  /** The quote for the current selection (buildings only). */
  function quote() {
    return quoteBuildings(buildings.selected(), rates);
  }

  const off = buildings.onChange(() => emit());

  return {
    quote,
    csv: () => quoteCsv(quote()),
    rates: () => ({ ...rates }),
    setRates,
    resetRates,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    destroy() {
      off?.();
      listeners.clear();
    },
  };
}
