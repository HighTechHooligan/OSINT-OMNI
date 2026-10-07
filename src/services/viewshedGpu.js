/**
 * GPU viewshed: the same sight-line walk as viewshedMath.computeViewshedBand,
 * run as a WebGL2 fragment shader, one fragment per grid cell. Heights go up
 * as an R32F texture; the BAND code for every cell comes back in one
 * readPixels. A million cells take well under a second on a laptop GPU,
 * where the CPU needs several seconds.
 *
 * Uses its own small WebGL2 context, separate from Cesium's. Returns null
 * from createGpuViewshed() where WebGL2 is unavailable; callers fall back to
 * the CPU workers.
 */
import { BAND, curveFactor } from './viewshedMath.js';

const VERT = `#version 300 es
in vec2 pos;
void main() { gl_Position = vec4(pos, 0.0, 1.0); }`;

// Mirrors computeViewshedBand: nearest-cell steps along the longer axis.
const FRAG = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D heights; // R32F; NaN = no data
uniform highp usampler2D mask;   // R8UI; 0 = not judged
uniform ivec2 size;
uniform ivec2 observer;
uniform vec2 cell;               // metres per column, row
uniform float eyeLo;
uniform float eyeHi;
uniform float targetM;
uniform float curve;
out vec4 code;

float h(ivec2 p) { return texelFetch(heights, p, 0).r; }

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float hp = h(p);
  if (texelFetch(mask, p, 0).r == 0u || isnan(hp)) { code = vec4(0.0); return; }
  ivec2 dlt = p - observer;
  float dist = length(vec2(dlt) * cell);
  if (dist == 0.0) { code = vec4(${BAND.BOTH}.0 / 255.0); return; }
  int steps = max(abs(dlt.x), abs(dlt.y));
  float maxLo = -1e30;
  float maxHi = -1e30;
  for (int s = 1; s < 8192; s++) {
    if (s >= steps) break;
    float t = float(s) / float(steps);
    ivec2 q = ivec2(floor(vec2(observer) + vec2(dlt) * t + 0.5));
    float sh = h(q);
    if (isnan(sh)) continue;
    float d = dist * t;
    float z = sh - d * d * curve;
    maxLo = max(maxLo, (z - eyeLo) / d);
    maxHi = max(maxHi, (z - eyeHi) / d);
  }
  float tz = hp + targetM - dist * dist * curve;
  float v = (tz - eyeLo) / dist >= maxLo ? ${BAND.BOTH}.0
          : (tz - eyeHi) / dist >= maxHi ? ${BAND.HIGH_ONLY}.0
          : ${BAND.HIDDEN}.0;
  code = vec4(v / 255.0);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
    throw new Error(gl.getShaderInfoLog(shader) || 'shader compile failed');
  return shader;
}

/**
 * Readable GPU name: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11
 * vs_5_0 ps_5_0, D3D11)" → "NVIDIA GeForce RTX 3080".
 */
export function shortRendererName(raw) {
  let name = String(raw || 'WebGL2');
  const angle = /^ANGLE \((.*)\)$/.exec(name);
  if (angle) name = angle[1].split(', ')[1] ?? angle[1];
  return (
    name
      .replace(/\s+(Direct3D|OpenGL|Vulkan|Metal).*$/i, '')
      .replace(/\s*\(0x[0-9a-f]+\)/gi, '')
      .trim()
      .slice(0, 48) || 'WebGL2'
  );
}

/**
 * What kind of GPU a renderer name is: 'dedicated', 'integrated',
 * 'unified' (Apple silicon), 'software' (no GPU at all) or 'unknown'. Laptops with two GPUs report the
 * integrated one when the OS hands the browser the power-saving GPU.
 */
export function gpuClass(name) {
  const n = String(name || '');
  if (/swiftshader|llvmpipe|softpipe|basic render|software/i.test(n))
    return 'software';
  if (/apple m\d|apple gpu/i.test(n)) return 'unified'; // one GPU, nothing to pick
  if (/\barc\b/i.test(n)) return 'dedicated'; // Intel Arc cards
  if (
    /intel|iris|uhd|\bhd graphics|radeon\(tm\) graphics|radeon graphics|vega \d+ graphics|radeon \d{3}m\b|mali|adreno|powervr/i.test(
      n,
    )
  )
    return 'integrated';
  if (/nvidia|geforce|quadro|rtx|gtx|radeon|firepro/i.test(n))
    return 'dedicated';
  return 'unknown';
}

/**
 * What to tell the user when the viewshed did not get the dedicated GPU.
 * A page can only ask for one (powerPreference); the OS decides which GPU
 * the whole browser runs on, so the fix is an OS setting and a restart.
 * @returns {string|null} null when there is nothing to fix
 */
export function dedicatedGpuAdvice(kind, renderer, platform = '') {
  if (kind === 'software')
    return `The browser has no GPU access (${renderer}), so sight lines run in software. Turn on "Use graphics acceleration when available" in the browser settings and restart it.`;
  if (kind !== 'integrated') return null;
  const lead = `Running on the integrated GPU (${renderer}). The browser picks one GPU for every page, and the operating system decides which.`;
  if (/win/i.test(platform))
    return `${lead} On Windows: Settings > System > Display > Graphics, find your browser (or "Add desktop app" and pick chrome.exe / msedge.exe / firefox.exe), Options > High performance > Save, then close every browser window and reopen it. NVIDIA Control Panel > Manage 3D settings > Program Settings does the same.`;
  if (/mac/i.test(platform))
    return `${lead} On a Mac with two GPUs: System Settings > Battery > Options, turn off automatic graphics switching, then restart the browser.`;
  if (/linux/i.test(platform))
    return `${lead} On Linux: start the browser with DRI_PRIME=1 (AMD/Intel) or prime-run (NVIDIA).`;
  return `${lead} Set the browser to High performance in your system's graphics settings, then restart it.`;
}

/**
 * @param {{ powerPreference?: 'high-performance'|'low-power'|'default' }} [options]
 *   'high-performance' asks the browser for the dedicated GPU on machines
 *   with two; 'low-power' asks for the integrated one. The browser and OS
 *   have the final say, so `renderer` reports the GPU actually used.
 */
export function createGpuViewshed({
  doc = globalThis.document,
  powerPreference = 'high-performance',
} = {}) {
  let canvas;
  try {
    canvas =
      typeof OffscreenCanvas === 'function'
        ? new OffscreenCanvas(1, 1)
        : doc?.createElement('canvas');
  } catch {
    return null;
  }
  const gl = canvas?.getContext?.('webgl2', {
    antialias: false,
    depth: false,
    preserveDrawingBuffer: true,
    powerPreference,
  });
  if (!gl) return null;
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = shortRendererName(
    (info && gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) ||
      gl.getParameter(gl.RENDERER),
  );
  let program;
  try {
    program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(program) || 'link failed');
  } catch {
    return null;
  }
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW,
  );
  const loc = (name) => gl.getUniformLocation(program, name);
  const maxSide = Math.min(8192, gl.getParameter(gl.MAX_TEXTURE_SIZE));

  function texture(unit, internal, format, type, w, h, data) {
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
    for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER])
      gl.texParameteri(gl.TEXTURE_2D, k, gl.NEAREST);
    return tex;
  }

  /**
   * Same inputs as computeViewshedBand (rows ignored). Row 0 of the grid is
   * texture row 0, so no flipping is needed on the way in or out.
   */
  function compute({
    heights,
    width,
    height,
    cellXM,
    cellYM,
    observer,
    lowM,
    highM = lowM,
    targetM = 0,
    refraction,
    mask = null,
  }) {
    if (width > maxSide || height > maxSide)
      throw new RangeError(`grid larger than ${maxSide} px`);
    const oc = Math.round(observer.col);
    const or = Math.round(observer.row);
    const ground = heights[or * width + oc];
    if (!Number.isFinite(ground))
      throw new RangeError('No height under the observer');
    canvas.width = width;
    canvas.height = height;
    gl.viewport(0, 0, width, height);
    const h32 =
      heights instanceof Float32Array ? heights : Float32Array.from(heights);
    const m8 = mask
      ? Uint8Array.from(mask, (v) => (v ? 1 : 0))
      : new Uint8Array(width * height).fill(1);
    const hTex = texture(0, gl.R32F, gl.RED, gl.FLOAT, width, height, h32);
    const mTex = texture(
      1,
      gl.R8UI,
      gl.RED_INTEGER,
      gl.UNSIGNED_BYTE,
      width,
      height,
      m8,
    );
    // Render into an RGBA8 texture so the result never depends on the
    // canvas's own (possibly premultiplied) framebuffer.
    const outTex = texture(
      2,
      gl.RGBA8,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      width,
      height,
      null,
    );
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      outTex,
      0,
    );
    gl.useProgram(program);
    gl.uniform1i(loc('heights'), 0);
    gl.uniform1i(loc('mask'), 1);
    gl.uniform2i(loc('size'), width, height);
    gl.uniform2i(loc('observer'), oc, or);
    gl.uniform2f(loc('cell'), cellXM, cellYM);
    gl.uniform1f(loc('eyeLo'), ground + lowM);
    gl.uniform1f(loc('eyeHi'), ground + highM);
    gl.uniform1f(loc('targetM'), targetM);
    gl.uniform1f(loc('curve'), curveFactor(refraction));
    const posLoc = gl.getAttribLocation(program, 'pos');
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    // Draw in bands of rows: each draw stays short, so a slow GPU never
    // trips the driver's watchdog on a big grid.
    gl.enable(gl.SCISSOR_TEST);
    const band = Math.max(1, Math.floor(262_144 / width));
    for (let y = 0; y < height; y += band) {
      gl.scissor(0, y, width, Math.min(band, height - y));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.disable(gl.SCISSOR_TEST);
    const rgba = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    for (const t of [hTex, mTex, outTex]) gl.deleteTexture(t);
    const codes = new Uint8Array(width * height);
    for (let i = 0; i < codes.length; i++) codes[i] = rgba[i * 4];
    return codes;
  }

  return {
    maxSide,
    renderer,
    powerPreference,
    compute,
    destroy() {
      gl.deleteProgram(program);
      gl.deleteBuffer(quad);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
