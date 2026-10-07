import * as Cesium from 'cesium';
import { governorRequestRender } from '../../renderGovernor.js';
import {
  AIRSPACE_MAX_SPAN_DEG,
  airspaceAt,
  airspaceColor,
  bboxKey,
  bboxSpan,
  describeRow,
  ftToM,
  isBackgroundClassE,
  laancColor,
  quantizeBbox,
  tileAround,
} from './records.js';
import { createAirspaceSource } from './source.js';
export * from './records.js';
export { createAirspaceSource } from './source.js';

export const AIRSPACE_LAYER_ID = 'airspace';
export const AIRSPACE_OVERLAY_SOURCE_ID = 'airspace';
const PICK_PREFIX = 'airspace:';
const VIEWPORT_KINDS = ['class', 'sua', 'laanc'];
const TFR_REFRESH_MS = 5 * 60e3;
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
const LEVEL_ACCENT = { stop: '#ff3b30', auth: '#ff9f0a', ok: '#34c759' };
const DEFAULT_PARAMS = Object.freeze({
  tfr: true,
  class: true,
  sua: true,
  laanc: false,
  volumes: false,
});

const css = (c) => Cesium.Color.fromCssColorString(c);
const ringPositions = (ring) =>
  ring.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat));
const heightRef = (ref) =>
  ref === 'AGL'
    ? Cesium.HeightReference.RELATIVE_TO_GROUND
    : Cesium.HeightReference.NONE;

/**
 * FAA airspace on the globe: TFRs (national, 5-minute refresh), Class
 * B/C/D/E, Special Use Airspace and the LAANC grid (viewport-loaded).
 * Flat by default; "3D" extrudes class/SUA volumes and LAANC ceilings.
 * Clicking any airspace shows everything stacked over that point with a
 * Part 107 advisory; `checkAt` is the same query for Features Code.
 */
export function createAirspaceLayer({
  source = createAirspaceSource(),
  overlayHost = null,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
  openExternal = null,
  registerCredit = null,
} = {}) {
  let viewer = null;
  let enabled = false;
  let clickHandler = null;
  let rowControlsListener = null;
  let card = null;
  const params = { ...DEFAULT_PARAMS };
  /** kind → {rows, key, status, error, partial, fetchedAt, ds, request} */
  const kinds = new Map(
    ['tfr', ...VIEWPORT_KINDS].map((kind) => [
      kind,
      {
        rows: [],
        key: null,
        status: 'idle',
        error: null,
        partial: false,
        fetchedAt: 0,
        ds: null,
        request: null,
        errorAt: 0,
      },
    ]),
  );

  const notify = () => {
    try {
      rowControlsListener?.();
    } catch {
      // A panel listener must never break the layer.
    }
  };

  function allRows() {
    const out = [];
    for (const state of kinds.values()) out.push(...state.rows);
    return out;
  }

  // ---------- rendering ----------

  function entitiesFor(row) {
    const color = css(airspaceColor(row));
    const background = isBackgroundClassE(row);
    const entities = [];
    row.polygons.forEach(([outer, ...holes], index) => {
      const id = `${PICK_PREFIX}${row.id}:${index}`;
      const hierarchy = new Cesium.PolygonHierarchy(
        ringPositions(outer),
        holes.map((h) => new Cesium.PolygonHierarchy(ringPositions(h))),
      );
      const polygon = { hierarchy };
      let fillAlpha = 0.15;
      if (row.kind === 'tfr') fillAlpha = 0.28;
      if (row.kind === 'laanc') fillAlpha = 0.32;
      if (background) fillAlpha = 0;
      const volumes =
        params.volumes &&
        !background &&
        ((row.kind === 'laanc' && row.ceilingFt > 0) ||
          ((row.kind === 'class' || row.kind === 'sua') &&
            row.lower?.known &&
            row.upper?.known));
      if (volumes && row.kind === 'laanc') {
        Object.assign(polygon, {
          height: 0,
          heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
          extrudedHeight: ftToM(row.ceilingFt),
          extrudedHeightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
        });
        fillAlpha = 0.18;
      } else if (volumes) {
        Object.assign(polygon, {
          height: ftToM(row.lower.ft),
          heightReference: heightRef(row.lower.ref),
          extrudedHeight: ftToM(row.upper.ft),
          extrudedHeightReference: heightRef(row.upper.ref),
        });
        fillAlpha = 0.1;
      }
      polygon.material = new Cesium.ColorMaterialProperty(
        color.withAlpha(fillAlpha),
      );
      const entity = { id, polygon };
      if (row.kind !== 'laanc')
        entity.polyline = {
          positions: ringPositions(outer),
          clampToGround: true,
          width: background ? 1 : 2,
          material: new Cesium.ColorMaterialProperty(
            color.withAlpha(background ? 0.45 : 0.9),
          ),
        };
      entities.push(new Cesium.Entity(entity));
    });
    return entities;
  }

  function render(kind) {
    const state = kinds.get(kind);
    if (!state.ds) return;
    const next = [];
    for (const row of state.rows) next.push(...entitiesFor(row));
    state.ds.entities.suspendEvents();
    state.ds.entities.removeAll();
    for (const entity of next) state.ds.entities.add(entity);
    state.ds.entities.resumeEvents();
    state.ds.show = enabled && params[kind];
    governorRequestRender(AIRSPACE_LAYER_ID);
  }

  function syncShown() {
    for (const [kind, state] of kinds)
      if (state.ds) state.ds.show = enabled && params[kind];
    governorRequestRender(AIRSPACE_LAYER_ID);
  }

  // ---------- loading ----------

  function viewBbox() {
    const rect = viewer?.camera.computeViewRectangle(
      viewer.scene.globe.ellipsoid,
    );
    if (!rect) return null;
    return quantizeBbox({
      west: Cesium.Math.toDegrees(rect.west),
      south: Cesium.Math.toDegrees(rect.south),
      east: Cesium.Math.toDegrees(rect.east),
      north: Cesium.Math.toDegrees(rect.north),
    });
  }

  async function load(kind, key, fetcher) {
    const state = kinds.get(kind);
    state.request?.abort();
    const controller = new AbortController();
    state.request = controller;
    state.status = 'loading';
    notify();
    try {
      const result = await fetcher(controller.signal);
      if (controller.signal.aborted || !enabled) return false;
      state.rows = result.rows;
      state.partial = result.partial;
      state.key = key;
      state.fetchedAt = Date.now();
      state.error = null;
      state.status = result.stale ? 'stale' : 'ready';
      render(kind);
      return true;
    } catch (error) {
      if (controller.signal.aborted) return false;
      state.error = error?.message || 'FAA airspace unavailable';
      state.status = 'error';
      state.errorAt = Date.now();
      // Retry this view after a short backoff rather than never.
      state.key = null;
      return false;
    } finally {
      if (state.request === controller) state.request = null;
      notify();
    }
  }

  // ---------- selection card ----------

  function clearCard() {
    card = null;
    overlayHost?.setEntries(AIRSPACE_OVERLAY_SOURCE_ID, [], CARD_HOST_OPTIONS);
  }

  function showCard(lon, lat, result) {
    if (!overlayHost) return;
    const tfr = result.hits.find((r) => r.kind === 'tfr');
    const link = tfr?.url && openExternal ? tfr.url : null;
    const lines = result.hits.slice(0, 6).map(describeRow);
    if (result.hits.length > 6) lines.push(`+${result.hits.length - 6} more`);
    const entry = {
      id: 'airspace-card',
      selected: true,
      interactive: Boolean(link),
      ...(link
        ? { accessibilityLabel: `Open TFR ${tfr.notamId} on tfr.faa.gov` }
        : {}),
      title: `AIRSPACE · ${lat.toFixed(4)}, ${lon.toFixed(4)}`,
      details: [
        ...(lines.length ? lines : ['No charted airspace loaded here']),
        ...result.notes,
        ...(link ? ['tfr.faa.gov ↗ · click card to open'] : []),
      ],
      accent: LEVEL_ACCENT[result.level],
      priority: Number.MAX_SAFE_INTEGER,
      gapPx: 15,
      verticalOnly: true,
      placement: 'above',
      position: Cesium.Cartesian3.fromDegrees(lon, lat),
    };
    if (link) entry.activate = () => (openExternal(link), true);
    card = { link };
    overlayHost.setVisible?.(AIRSPACE_OVERLAY_SOURCE_ID, true);
    overlayHost.setEntries(
      AIRSPACE_OVERLAY_SOURCE_ID,
      [entry],
      CARD_HOST_OPTIONS,
    );
  }

  function groundDegrees(screen) {
    let cartesian = null;
    if (viewer.scene.pickPositionSupported)
      cartesian = viewer.scene.pickPosition(screen);
    cartesian ??= viewer.camera.pickEllipsoid(
      screen,
      viewer.scene.globe.ellipsoid,
    );
    if (!cartesian) return null;
    const c = Cesium.Cartographic.fromCartesian(cartesian);
    return c
      ? {
          lon: Cesium.Math.toDegrees(c.longitude),
          lat: Cesium.Math.toDegrees(c.latitude),
        }
      : null;
  }

  function installClickHandler() {
    if (clickHandler || !viewer || !screenSpaceEventHandlerFactory || !picking)
      return;
    clickHandler = screenSpaceEventHandlerFactory(viewer);
    clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const cardHit = overlayHost?.hitTest?.(
        click.position?.x,
        click.position?.y,
        {
          sourceId: AIRSPACE_OVERLAY_SOURCE_ID,
        },
      );
      if (cardHit && card) {
        if (card.link && openExternal) openExternal(card.link);
        return;
      }
      const picked = viewer.scene.pick(click.position);
      const pickId = picked ? picking.resolvePickId(picked) : null;
      if (typeof pickId === 'string' && pickId.startsWith(PICK_PREFIX)) {
        const at = groundDegrees(click.position);
        if (at)
          showCard(at.lon, at.lat, airspaceAt(visibleRows(), at.lon, at.lat));
        return;
      }
      if (pickId && picking.isOwnedByOtherLayer?.(AIRSPACE_LAYER_ID, pickId))
        return;
      if (card) clearCard();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClickHandler() {
    clickHandler?.destroy();
    clickHandler = null;
  }

  const visibleRows = () =>
    [...kinds].flatMap(([kind, state]) => (params[kind] ? state.rows : []));

  // ---------- public layer ----------

  const layer = {
    id: AIRSPACE_LAYER_ID,
    name: 'FAA Airspace',
    icon: '✈',
    source: 'FAA (TFR · ADDS · UAS Facility Map)',
    updateInterval: 3000,

    init(v) {
      if (viewer) throw new Error('Airspace layer is already initialized');
      viewer = v;
      for (const [kind, state] of kinds) {
        state.ds = new Cesium.CustomDataSource(`airspace-${kind}`);
        state.ds.show = false;
        viewer.dataSources.add(state.ds);
      }
    },

    enable() {
      enabled = true;
      registerCredit?.(viewer);
      overlayHost?.setVisible?.(AIRSPACE_OVERLAY_SOURCE_ID, true);
      installClickHandler();
      syncShown();
      notify();
    },

    disable() {
      enabled = false;
      for (const state of kinds.values()) {
        state.request?.abort();
        state.request = null;
      }
      removeClickHandler();
      clearCard();
      overlayHost?.setVisible?.(AIRSPACE_OVERLAY_SOURCE_ID, false);
      syncShown();
      notify();
    },

    async update() {
      if (!enabled || !viewer) return false;
      const jobs = [];
      const tfr = kinds.get('tfr');
      if (
        params.tfr &&
        !tfr.request &&
        Date.now() - tfr.fetchedAt >
          (tfr.status === 'error' ? 30e3 : TFR_REFRESH_MS)
      ) {
        tfr.fetchedAt = Date.now();
        jobs.push(load('tfr', 'tfr', (signal) => source.getTfrs({ signal })));
      }
      const bbox = viewBbox();
      for (const kind of VIEWPORT_KINDS) {
        const state = kinds.get(kind);
        if (!params[kind]) continue;
        if (!bbox || bboxSpan(bbox) > AIRSPACE_MAX_SPAN_DEG[kind]) {
          if (state.status !== 'zoom-in') {
            state.status = 'zoom-in';
            notify();
          }
          continue;
        }
        const key = bboxKey(bbox);
        if (key === state.key || state.request) continue;
        if (state.status === 'error' && Date.now() - state.errorAt < 30e3)
          continue;
        jobs.push(
          load(kind, key, (signal) => source.getArea(kind, bbox, { signal })),
        );
      }
      if (!jobs.length) return false;
      const results = await Promise.all(jobs);
      return results.some(Boolean);
    },

    /**
     * Everything over one point (all kinds, regardless of what is shown),
     * fetched for the small tile around it. Shows the card when enabled.
     */
    async checkAt(lon, lat, { signal, showCard: show = true } = {}) {
      if (!Number.isFinite(lon) || !Number.isFinite(lat))
        throw new Error('Need a point to check');
      const tile = tileAround(lon, lat);
      const [tfrs, ...areas] = await Promise.all([
        kinds.get('tfr').rows.length
          ? { rows: kinds.get('tfr').rows }
          : source.getTfrs({ signal }),
        ...VIEWPORT_KINDS.map((kind) => source.getArea(kind, tile, { signal })),
      ]);
      const rows = [tfrs, ...areas].flatMap((r) => r.rows);
      const result = airspaceAt(rows, lon, lat);
      if (show && enabled) showCard(lon, lat, result);
      return result;
    },

    setParams(next = {}) {
      let restyle = false;
      for (const key of Object.keys(DEFAULT_PARAMS)) {
        if (typeof next[key] !== 'boolean' || next[key] === params[key])
          continue;
        params[key] = next[key];
        if (key === 'volumes') restyle = true;
        if (key !== 'volumes' && !next[key]) kinds.get(key).status = 'idle';
      }
      if (restyle) for (const kind of kinds.keys()) render(kind);
      syncShown();
      notify();
      if (enabled) queueMicrotask(() => void layer.update());
    },

    getParams() {
      return { ...params };
    },

    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    getRowControls() {
      const toggle = (key, label, title) => ({
        id: key,
        label,
        title,
        active: params[key],
        params: { [key]: !params[key] },
      });
      const laancCount = kinds.get('laanc').rows.length;
      return {
        chips: [
          toggle(
            'tfr',
            'TFR',
            'Temporary flight restrictions (national, 5-min refresh)',
          ),
          toggle('class', 'CLASS', 'Class B / C / D / E airspace'),
          toggle('sua', 'SUA', 'Prohibited, restricted, warning, alert, MOA'),
          toggle(
            'laanc',
            'LAANC',
            'UAS Facility Map grid: max authorizable ft AGL',
          ),
          toggle(
            'volumes',
            '3D',
            'Extrude airspace floors/ceilings and LAANC ceilings',
          ),
          {
            id: 'check',
            label: 'CHECK CENTER',
            title: 'Everything over the point at the center of the screen',
            disabled: !enabled || !viewer,
            onClick: () => {
              const canvas = viewer?.scene.canvas;
              if (!canvas) return;
              const at = groundDegrees(
                new Cesium.Cartesian2(
                  canvas.clientWidth / 2,
                  canvas.clientHeight / 2,
                ),
              );
              if (at) void layer.checkAt(at.lon, at.lat).catch(() => {});
            },
          },
        ],
        legend: [
          {
            label: 'TFR',
            color: airspaceColor({ kind: 'tfr' }),
            count: kinds.get('tfr').rows.length,
            blurb:
              'FAA open data, advisory only — confirm in B4UFLY or your LAANC app. TFR altitudes: read the NOTAM.',
          },
          {
            label: 'Class B',
            color: airspaceColor({ kind: 'class', cls: 'B' }),
          },
          {
            label: 'Class C',
            color: airspaceColor({ kind: 'class', cls: 'C' }),
          },
          {
            label: 'Class D',
            color: airspaceColor({ kind: 'class', cls: 'D' }),
          },
          {
            label: 'Class E',
            color: airspaceColor({ kind: 'class', cls: 'E' }),
          },
          {
            label: 'Restricted / prohibited',
            color: airspaceColor({ kind: 'sua', suaType: 'R' }),
          },
          {
            label: 'MOA / warning / alert',
            color: airspaceColor({ kind: 'sua', suaType: 'MOA' }),
          },
          ...(params.laanc
            ? [
                {
                  label: 'LAANC 0 ft',
                  color: laancColor(0),
                  count: laancCount,
                },
                { label: 'LAANC 100–200 ft', color: laancColor(200) },
                { label: 'LAANC 400 ft', color: laancColor(400) },
              ]
            : []),
        ],
      };
    },

    getStats() {
      let count = 0;
      let error = null;
      let loading = false;
      const zoom = [];
      for (const [kind, state] of kinds) {
        if (!params[kind]) continue;
        count += state.rows.length;
        error ||= state.error;
        loading ||= state.status === 'loading';
        if (state.status === 'zoom-in') zoom.push(kind.toUpperCase());
      }
      const lastUpdate =
        Math.max(0, ...[...kinds.values()].map((s) => s.fetchedAt)) || null;
      return {
        count,
        lastUpdate,
        error,
        loading,
        status: loading ? 'loading' : error ? 'error' : 'ready',
        hint: zoom.length
          ? `Zoom in to load ${zoom.join(' / ')} airspace`
          : null,
      };
    },

    /** Facts (no geometry) for the analyst query engine. */
    getAnalystRecords(maxCount = 2000) {
      if (!enabled) return [];
      return visibleRows()
        .slice(0, Math.max(1, Math.floor(maxCount) || 2000))
        .map(({ polygons, lower, upper, ...facts }) => ({
          ...facts,
          floor: lower?.label ?? null,
          ceiling: upper?.label ?? null,
          summary: describeRow({ ...facts, lower, upper }),
        }));
    },

    destroy(v = viewer) {
      for (const state of kinds.values()) {
        state.request?.abort();
        state.request = null;
        if (state.ds) v?.dataSources.remove(state.ds, true);
        state.ds = null;
        state.rows = [];
      }
      removeClickHandler();
      if (overlayHost) overlayHost.clearSource?.(AIRSPACE_OVERLAY_SOURCE_ID);
      viewer = null;
      enabled = false;
      rowControlsListener = null;
    },
  };
  return layer;
}
