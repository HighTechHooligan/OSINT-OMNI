import { countTiles, fillTemplate, tilesInBbox } from './tiles.js';
import { tilesNearLine } from '../../../src/services/routing/routeGeo.js';

/**
 * Basemap plumbing. Every URL in the style is prefixed with `omni://` so the
 * map loads it through the phone's tile cache (see tileCache.js). The default
 * basemap is OpenFreeMap: OpenStreetMap vector tiles, free, no key, and it
 * permits caching. Google and Apple map tiles can't be stored offline under
 * their terms, so they aren't offered as sources.
 */
export const SCHEME = 'omni://';
export const DEFAULT_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
/** Vector basemaps stop at z14; the map overzooms past it with no new data. */
export const REGION_MAX_ZOOM = 14;
export const REGION_TILE_LIMIT = 12000;
/** Typical compressed vector tile size, for download estimates. */
export const AVG_TILE_BYTES = 28 * 1024;
const GLYPH_RANGES = ['0-255', '256-511', '8192-8447'];

export const wrap = (url) =>
  typeof url === 'string' && /^https?:\/\//.test(url) ? SCHEME + url : url;
export const unwrap = (url) => (url.startsWith(SCHEME) ? url.slice(SCHEME.length) : url);

/** Resolve a style-relative URL against the style's own address. */
const absolute = (url, base) => {
  try {
    return new URL(url, base).href.replace(/%7B/gi, '{').replace(/%7D/gi, '}');
  } catch {
    return url;
  }
};

export function rewriteStyle(style, styleUrl) {
  const out = structuredClone(style);
  for (const source of Object.values(out.sources || {})) {
    if (source.url) source.url = wrap(absolute(source.url, styleUrl));
    if (Array.isArray(source.tiles))
      source.tiles = source.tiles.map((t) => wrap(absolute(t, styleUrl)));
  }
  if (out.glyphs) out.glyphs = wrap(absolute(out.glyphs, styleUrl));
  if (typeof out.sprite === 'string') out.sprite = wrap(absolute(out.sprite, styleUrl));
  else if (Array.isArray(out.sprite))
    out.sprite = out.sprite.map((s) => ({ ...s, url: wrap(absolute(s.url, styleUrl)) }));
  return out;
}

export function rewriteTileJson(json, tileJsonUrl) {
  if (!json || !Array.isArray(json.tiles)) return json;
  return { ...json, tiles: json.tiles.map((t) => wrap(absolute(t, tileJsonUrl))) };
}

/** Font stacks named literally in the style's symbol layers. */
export function fontStacks(style) {
  const stacks = new Set();
  for (const layer of style.layers || []) {
    const font = layer.layout?.['text-font'];
    if (Array.isArray(font) && font.every((f) => typeof f === 'string'))
      stacks.add(font.join(','));
    else if (Array.isArray(font)) {
      // Expressions like ["literal", [...]] or ["step", ..., ["literal", [...]]].
      JSON.stringify(font, (_k, v) => {
        if (Array.isArray(v) && v[0] === 'literal' && Array.isArray(v[1])) stacks.add(v[1].join(','));
        return v;
      });
    }
  }
  return [...stacks];
}

/**
 * Everything to fetch so a bbox works offline: vector tiles from every source
 * (z0..maxZoom), glyph ranges for each font, and the sprite sheets.
 * @param {object} style raw (unwrapped) style
 * @param {Record<string, object>} tileJsons raw TileJSON per source id (for url sources)
 */
export function planRegion({ style, styleUrl, tileJsons = {}, bbox, maxZoom = REGION_MAX_ZOOM }) {
  const sources = styleSources(style, styleUrl, tileJsons, maxZoom);
  const tileCount = sources.reduce((n, s) => n + countTiles(bbox, s.minzoom, s.maxzoom), 0);
  const extras = styleExtras(style, styleUrl);
  return {
    sources,
    tileCount,
    extras,
    estimateBytes: tileCount * AVG_TILE_BYTES,
    *urls() {
      yield* extras;
      for (const s of sources)
        for (const t of tilesInBbox(bbox, s.minzoom, s.maxzoom)) yield fillTemplate(s.template, t);
    },
  };
}

/**
 * Map tiles along a route (within padM of it, zoom minZoom..maxZoom), so a
 * saved route's map works with no signal however long the route is.
 */
export function planLine({ style, styleUrl, tileJsons = {}, line, padM = 600, minZoom = 6, maxZoom = REGION_MAX_ZOOM }) {
  const sources = styleSources(style, styleUrl, tileJsons, maxZoom);
  const tiles = [];
  for (const s of sources)
    for (let z = Math.max(minZoom, s.minzoom); z <= s.maxzoom; z++)
      for (const t of tilesNearLine(line, z, padM)) tiles.push(fillTemplate(s.template, t));
  const extras = styleExtras(style, styleUrl);
  return { tileCount: tiles.length, extras, estimateBytes: tiles.length * AVG_TILE_BYTES, urls: () => [...extras, ...tiles][Symbol.iterator]() };
}

function styleSources(style, styleUrl, tileJsons, maxZoom) {
  const sources = [];
  for (const [id, source] of Object.entries(style.sources || {})) {
    if (source.type !== 'vector' && source.type !== 'raster') continue;
    const meta = source.url ? tileJsons[id] : source;
    const base = source.url ? absolute(source.url, styleUrl) : styleUrl;
    if (!meta?.tiles?.length) continue;
    sources.push({
      id,
      template: absolute(meta.tiles[0], base),
      minzoom: meta.minzoom ?? 0,
      maxzoom: Math.min(meta.maxzoom ?? maxZoom, maxZoom),
    });
  }
  return sources;
}

function styleExtras(style, styleUrl) {
  const extras = [];
  if (style.glyphs) {
    const glyphs = absolute(style.glyphs, styleUrl);
    for (const stack of fontStacks(style))
      for (const range of GLYPH_RANGES)
        extras.push(glyphs.replace('{fontstack}', stack).replace('{range}', range));
  }
  const sprites =
    typeof style.sprite === 'string'
      ? [style.sprite]
      : Array.isArray(style.sprite)
        ? style.sprite.map((s) => s.url)
        : [];
  for (const sprite of sprites) {
    const base = absolute(sprite, styleUrl);
    for (const suffix of ['.json', '.png', '@2x.json', '@2x.png']) extras.push(base + suffix);
  }
  return extras;
}

/** Load the basemap style and its TileJSONs through the phone cache. */
export async function loadBasemap(tiles, styleUrl, { region = null } = {}) {
  const json = async (url) => JSON.parse(new TextDecoder().decode(await tiles.get(url, { category: 'style', region })));
  const style = await json(styleUrl);
  const tileJsons = {};
  for (const [id, source] of Object.entries(style.sources || {}))
    if (source.url) tileJsons[id] = await json(new URL(source.url, styleUrl).href);
  return { style, tileJsons };
}
