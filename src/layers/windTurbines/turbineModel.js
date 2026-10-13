/**
 * One simple wind turbine model, generated once as an embedded glTF.
 *
 * Units are "hub heights": the tower base is at the origin and the hub sits
 * at y = 1 (glTF is Y-up), so an instance scaled by its hub height in metres
 * is the right size. The rotor is its own node ("rotor") with a blade length
 * of ROTOR_RADIUS_RATIO hub heights; scale that node to match a turbine's
 * real rotor diameter. Every instance shares this one small buffer.
 */
export const ROTOR_RADIUS_RATIO = 0.62;
export const ROTOR_NODE = 'rotor';
const HUB_Z = 0.075;

/** Push the two triangles of quad a-b-c-d (counter-clockwise). */
function quad(out, a, b, c, d) {
  out.push(a, b, c, a, c, d);
}

/** Tapered tube along +Y from y0 to y1. */
function tube(out, r0, r1, y0, y1, segments = 14) {
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const p = (r, a, y) => [Math.cos(a) * r, y, Math.sin(a) * r];
    quad(out, p(r0, a0, y0), p(r0, a1, y0), p(r1, a1, y1), p(r1, a0, y1));
  }
}

/** Axis-aligned box from its centre and half sizes. */
function box(out, [cx, cy, cz], [hx, hy, hz]) {
  const v = (sx, sy, sz) => [cx + sx * hx, cy + sy * hy, cz + sz * hz];
  quad(out, v(-1, -1, 1), v(1, -1, 1), v(1, 1, 1), v(-1, 1, 1));
  quad(out, v(1, -1, -1), v(-1, -1, -1), v(-1, 1, -1), v(1, 1, -1));
  quad(out, v(1, -1, 1), v(1, -1, -1), v(1, 1, -1), v(1, 1, 1));
  quad(out, v(-1, -1, -1), v(-1, -1, 1), v(-1, 1, 1), v(-1, 1, -1));
  quad(out, v(-1, 1, 1), v(1, 1, 1), v(1, 1, -1), v(-1, 1, -1));
  quad(out, v(-1, -1, -1), v(1, -1, -1), v(1, -1, 1), v(-1, -1, 1));
}

/** Three tapered blades in the XY plane around the rotor node's origin. */
function blades(out) {
  const root = 0.03;
  const tip = ROTOR_RADIUS_RATIO;
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + Math.PI / 2;
    const along = [Math.cos(a), Math.sin(a)];
    const side = [-along[1], along[0]];
    const at = (d, w, z) => [
      along[0] * d + side[0] * w,
      along[1] * d + side[1] * w,
      z,
    ];
    const wr = 0.028;
    const wt = 0.008;
    const t = 0.006;
    // Front and back faces plus the two long edges.
    quad(
      out,
      at(root, -wr, t),
      at(tip, -wt, t),
      at(tip, wt, t),
      at(root, wr, t),
    );
    quad(
      out,
      at(root, wr, -t),
      at(tip, wt, -t),
      at(tip, -wt, -t),
      at(root, -wr, -t),
    );
    quad(
      out,
      at(root, wr, t),
      at(tip, wt, t),
      at(tip, wt, -t),
      at(root, wr, -t),
    );
    quad(
      out,
      at(root, -wr, -t),
      at(tip, -wt, -t),
      at(tip, -wt, t),
      at(root, -wr, t),
    );
  }
  box(out, [0, 0, 0], [0.03, 0.03, 0.03]);
}

/** Flat-shaded positions + normals for a triangle list. */
function flatten(triangles) {
  const positions = new Float32Array(triangles.length * 3);
  const normals = new Float32Array(triangles.length * 3);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < triangles.length; i += 3) {
    const [a, b, c] = [triangles[i], triangles[i + 1], triangles[i + 2]];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [
      u[1] * v[2] - u[2] * v[1],
      u[2] * v[0] - u[0] * v[2],
      u[0] * v[1] - u[1] * v[0],
    ];
    const len = Math.hypot(...n) || 1;
    for (let j = 0; j < 3; j++) {
      const p = triangles[i + j];
      positions.set(p, (i + j) * 3);
      normals.set(
        n.map((x) => x / len),
        (i + j) * 3,
      );
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], p[k]);
        max[k] = Math.max(max[k], p[k]);
      }
    }
  }
  return { positions, normals, count: triangles.length, min, max };
}

function base64(bytes) {
  if (typeof Buffer !== 'undefined')
    return Buffer.from(bytes).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** The glTF 2.0 document (JSON, buffer embedded as a data URI). */
export function buildTurbineGltf() {
  const body = [];
  tube(body, 0.034, 0.02, 0, 0.985);
  box(body, [0, 1, 0.0], [0.026, 0.028, 0.07]);
  const rotor = [];
  blades(rotor);
  const meshes = [flatten(body), flatten(rotor)];
  const chunks = meshes.flatMap((m) => [m.positions, m.normals]);
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const bytes = new Uint8Array(total);
  const bufferViews = [];
  const accessors = [];
  let offset = 0;
  chunks.forEach((chunk, i) => {
    bytes.set(new Uint8Array(chunk.buffer), offset);
    bufferViews.push({
      buffer: 0,
      byteOffset: offset,
      byteLength: chunk.byteLength,
      target: 34962,
    });
    const mesh = meshes[Math.floor(i / 2)];
    accessors.push({
      bufferView: i,
      componentType: 5126,
      count: mesh.count,
      type: 'VEC3',
      ...(i % 2 === 0 ? { min: mesh.min, max: mesh.max } : {}),
    });
    offset += chunk.byteLength;
  });
  const primitive = (m) => ({
    attributes: { POSITION: m * 2, NORMAL: m * 2 + 1 },
    material: 0,
  });
  return {
    asset: { version: '2.0', generator: 'OSINT OMNI wind turbine' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: 'turbine', mesh: 0, children: [1] },
      { name: ROTOR_NODE, mesh: 1, translation: [0, 1, HUB_Z] },
    ],
    meshes: [
      { name: 'tower', primitives: [primitive(0)] },
      { name: 'blades', primitives: [primitive(1)] },
    ],
    materials: [
      {
        name: 'paint',
        doubleSided: true,
        pbrMetallicRoughness: {
          baseColorFactor: [0.93, 0.94, 0.95, 1],
          metallicFactor: 0,
          roughnessFactor: 0.55,
        },
      },
    ],
    accessors,
    bufferViews,
    buffers: [
      {
        byteLength: total,
        uri: `data:application/octet-stream;base64,${base64(bytes)}`,
      },
    ],
  };
}

let cachedUri = null;
/** The model as one data URI, built on first use. */
export function turbineModelUri() {
  cachedUri ??= `data:model/gltf+json;base64,${base64(
    new TextEncoder().encode(JSON.stringify(buildTurbineGltf())),
  )}`;
  return cachedUri;
}

/**
 * Model scale (hub height in metres) and rotor node scale for one turbine.
 * Missing hub heights are estimated from tip height and rotor, else 80 m.
 */
export function turbineScale(t) {
  let hub = Number.isFinite(t?.hubM) && t.hubM > 0 ? t.hubM : null;
  const rotor = Number.isFinite(t?.rotorM) && t.rotorM > 0 ? t.rotorM : null;
  if (!hub && Number.isFinite(t?.tipM) && t.tipM > 0)
    hub = rotor ? t.tipM - rotor / 2 : t.tipM * 0.68;
  if (!hub || hub < 10) hub = 80;
  const rotorScale = rotor ? rotor / 2 / hub / ROTOR_RADIUS_RATIO : 1;
  return {
    hubM: Math.round(hub * 10) / 10,
    rotorScale: Math.min(2.5, Math.max(0.3, rotorScale)),
    estimated: !(Number.isFinite(t?.hubM) && t.hubM > 0),
  };
}

/** Stable pseudo-random heading (radians) per turbine id. */
export function turbineHeading(id) {
  let h = 2166136261;
  for (const ch of String(id)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ((h >>> 0) / 4294967296) * Math.PI * 2;
}
