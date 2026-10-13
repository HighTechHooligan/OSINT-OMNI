import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROTOR_NODE,
  ROTOR_RADIUS_RATIO,
  buildTurbineGltf,
  turbineHeading,
  turbineModelUri,
  turbineScale,
} from './turbineModel.js';

test('the generated glTF is a valid two-node turbine with a hub at y = 1', () => {
  const gltf = buildTurbineGltf();
  assert.equal(gltf.asset.version, '2.0');
  assert.deepEqual(
    gltf.nodes.map((n) => n.name),
    ['turbine', ROTOR_NODE],
  );
  assert.equal(gltf.nodes[1].translation[1], 1);
  const [tower, blades] = [gltf.accessors[0], gltf.accessors[2]];
  assert.ok(tower.min[1] === 0 && tower.max[1] > 1);
  assert.ok(Math.abs(blades.max[1] - ROTOR_RADIUS_RATIO) < 0.01);
  for (const a of gltf.accessors) assert.equal(a.count % 3, 0);
  const declared = gltf.bufferViews.reduce((n, v) => n + v.byteLength, 0);
  assert.equal(declared, gltf.buffers[0].byteLength);
  const bytes = Buffer.from(gltf.buffers[0].uri.split(',')[1], 'base64');
  assert.equal(bytes.length, declared);
  assert.match(turbineModelUri(), /^data:model\/gltf\+json;base64,/);
});

test('instances scale to hub height and real rotor size', () => {
  const s = turbineScale({ hubM: 90, rotorM: 116 });
  assert.equal(s.hubM, 90);
  assert.equal(s.estimated, false);
  assert.ok(Math.abs(s.rotorScale * ROTOR_RADIUS_RATIO * 90 - 58) < 0.01);
  assert.equal(turbineScale({ tipM: 150, rotorM: 100 }).hubM, 100);
  assert.equal(turbineScale({}).hubM, 80);
  assert.equal(turbineScale({}).estimated, true);
  assert.equal(turbineHeading('42'), turbineHeading('42'));
  assert.notEqual(turbineHeading('42'), turbineHeading('43'));
});
