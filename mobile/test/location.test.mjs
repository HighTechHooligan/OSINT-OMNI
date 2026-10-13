import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocationSource, LocationOffError } from '../src/lib/location.js';

function setup({ gpsFails = false } = {}) {
  let settings = { manualLocation: null };
  const gpsCalls = [];
  const gps = {
    current: async () => {
      gpsCalls.push('current');
      if (gpsFails) throw new Error('Location permission denied');
      return [-97.74, 30.27];
    },
    watch: async (cb) => {
      gpsCalls.push('watch');
      cb({ lonLat: [-97.74, 30.27] });
      return () => gpsCalls.push('stop');
    },
  };
  const location = createLocationSource({
    settings: () => settings,
    updateSettings: (patch) => (settings = { ...settings, ...patch }),
    gps,
    now: () => 1,
  });
  return { location, gpsCalls, settings: () => settings };
}

test('a location set by hand replaces the GPS and never asks it', async () => {
  const { location, gpsCalls, settings } = setup({ gpsFails: true });
  const changes = [];
  location.onChange((m) => changes.push(m));
  location.set([-93.26, 44.97], 'Minneapolis');
  assert.deepEqual(await location.current(), [-93.26, 44.97]);
  const seen = [];
  const stop = await location.watch((p) => seen.push(p));
  stop();
  assert.deepEqual(seen, [{ lonLat: [-93.26, 44.97], accuracy: 0, heading: null, manual: true }]);
  assert.deepEqual(gpsCalls, [], 'GPS was never asked');
  assert.equal(settings().manualLocation.label, 'Minneapolis');
  assert.equal(changes.length, 1);
  assert.throws(() => location.set([0, 120]), /not a place/);
});

test('without a set location it uses GPS, and a denied GPS says how to set one', async () => {
  assert.deepEqual(await setup().location.current(), [-97.74, 30.27]);
  const { location } = setup({ gpsFails: true });
  await assert.rejects(location.current(), (e) => e instanceof LocationOffError && /Set my location here/.test(e.message));
  location.set([-93.26, 44.97]);
  location.clear();
  assert.equal(location.manual(), null);
});
