/**
 * Aircraft pop-out: live flight details, the airframe (adsbdb), and the
 * model's history and notable events (Wikipedia / Wikidata via
 * /api/aircraft/trivia, plus hand-checked notes from aircraftTypes.js).
 */
import {
  aircraftLabel,
  airframeRows,
  flightRows,
  modelFactRows,
  resolveModel,
  sourceLinks,
  triviaQuery,
} from '../services/aircraftInfo.js';

const REFRESH_MS = 2000;

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
const safeUrl = (u) => (/^https:\/\//i.test(String(u ?? '')) ? u : null);

const dl = (rows) =>
  `<dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
const linkList = (links) =>
  `<ul class="dossier-links">${links
    .filter((l) => safeUrl(l.href))
    .map(
      (l) =>
        `<li><a href="${esc(l.href)}" target="_blank" rel="noopener noreferrer">${esc(l.label)}</a></li>`,
    )
    .join('')}</ul>`;

/** Shared per-hex / per-query lookups, so reopening a panel is instant. */
const memo = new Map();
function cachedJson(url, fetchImpl) {
  if (!memo.has(url)) {
    memo.set(
      url,
      fetchImpl(url)
        .then(async (r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .catch((error) => {
          memo.delete(url);
          throw error;
        }),
    );
    while (memo.size > 300) memo.delete(memo.keys().next().value);
  }
  return memo.get(url);
}

function renderModel(el, model, trivia) {
  const m = trivia?.model;
  const facts = modelFactRows(m?.facts);
  const thumb = safeUrl(m?.thumbnail);
  const notes = model.notes;
  const mentions = trivia?.mentions ?? [];
  const parts = [];
  if (m) {
    parts.push(
      `<p class="aircraft-model-title"><strong>${esc(m.title)}</strong>${m.description ? ` · ${esc(m.description)}` : ''}</p>`,
    );
    if (thumb)
      parts.push(
        `<img class="aircraft-thumb" src="${esc(thumb)}" alt="${esc(m.title)}" loading="lazy" referrerpolicy="no-referrer" />`,
      );
    if (facts.length) parts.push(dl(facts));
    if (m.extract)
      parts.push(`<p class="aircraft-extract">${esc(m.extract)}</p>`);
  } else if (!trivia) {
    parts.push('<p class="dossier-note">Looking up the model…</p>');
  } else {
    parts.push(
      `<p class="dossier-note">No model history found${model.code ? ` for ${esc(model.code)}` : ''}.</p>`,
    );
  }
  if (notes.length)
    parts.push(
      `<h5>Notable events</h5><ul class="aircraft-notes">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`,
    );
  if (mentions.length)
    parts.push(
      `<h5>This airframe on Wikipedia</h5><ul class="aircraft-notes">${mentions
        .filter((x) => safeUrl(x.url))
        .map(
          (x) =>
            `<li><a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.title)}</a>${x.snippet ? `<br /><small>${esc(x.snippet)}</small>` : ''}</li>`,
        )
        .join('')}</ul>`,
    );
  const sources = [];
  if (safeUrl(m?.url)) sources.push({ label: 'Wikipedia', href: m.url });
  if (/^Q\d+$/.test(m?.wikidata ?? ''))
    sources.push({
      label: 'Wikidata',
      href: `https://www.wikidata.org/wiki/${m.wikidata}`,
    });
  if (sources.length)
    parts.push(
      `<p class="dossier-note">Model facts from ${sources
        .map(
          (s) =>
            `<a href="${esc(s.href)}" target="_blank" rel="noopener noreferrer">${esc(s.label)}</a>`,
        )
        .join(' and ')}.</p>`,
    );
  if (trivia?.errors?.length)
    parts.push(
      `<p class="dossier-note">Partly unavailable: ${esc(trivia.errors.join(', '))}.</p>`,
    );
  el.innerHTML = parts.join('');
}

/**
 * Open (or focus) the pop-out for one aircraft.
 * @param {{ panels: object, target: {layerId:string, id:string},
 *   describe: (target:object) => object|null, onCockpit: () => Promise<object>,
 *   fetchImpl?: Function }} deps
 */
export function openAircraftPanel({
  panels,
  target,
  describe,
  onCockpit,
  fetchImpl = (...a) => fetch(...a),
}) {
  if (!panels || !target) return null;
  const key = `aircraft:${target.layerId}:${target.id}`;
  const existing = panels.get(key);
  if (existing) {
    existing.focus();
    return existing;
  }
  let info = describe(target);
  let lost = false;
  let adsbdb = null;
  let timer = null;
  let lastJson = '';
  let els = null;

  const titleFor = (i) => aircraftLabel(i, target.id.toUpperCase());
  const subtitleFor = (i, a) =>
    [a?.typeName || i?.typeName || i?.typeCode, i?.airline || i?.operator]
      .filter(Boolean)
      .join(' · ');

  function paintFlight() {
    if (!els) return;
    els.flight.innerHTML =
      (lost || !info
        ? '<p class="dossier-note">Signal lost: the aircraft is no longer in the feed. Showing its last known state.</p>'
        : '') + (info ? dl(flightRows(info, target.layerId)) : '');
    els.links.innerHTML = linkList(
      sourceLinks({
        ...info,
        icao24: target.id,
        registration: info?.registration || adsbdb?.registration,
      }),
    );
  }

  function paintAirframe() {
    if (!els) return;
    const rows = airframeRows(info, adsbdb);
    const photo = safeUrl(adsbdb?.photoUrl);
    els.airframe.innerHTML =
      (rows.length
        ? dl(rows)
        : '<p class="dossier-note">No airframe record yet.</p>') +
      (photo
        ? `<img class="aircraft-thumb" src="${esc(photo)}" alt="Photo of ${esc(titleFor(info))}" loading="lazy" referrerpolicy="no-referrer" />`
        : '');
  }

  async function loadModel() {
    const model = resolveModel(info, adsbdb);
    renderModel(els.model, model, null);
    const query = triviaQuery(
      model,
      info?.registration || adsbdb?.registration,
    );
    if (!query) return renderModel(els.model, model, { model: null });
    try {
      const trivia = await cachedJson(
        `/api/aircraft/trivia?${query}`,
        fetchImpl,
      );
      renderModel(els.model, model, trivia);
    } catch {
      renderModel(els.model, model, {
        model: null,
        errors: ['model lookup failed'],
      });
    }
  }

  async function loadAirframe() {
    if (/^[0-9a-f]{6}$/i.test(target.id)) {
      try {
        const data = await cachedJson(
          `/api/adsbdb/type/${target.id.toLowerCase()}`,
          fetchImpl,
        );
        adsbdb = data?.found ? data : null;
      } catch {
        adsbdb = null;
      }
    }
    paintAirframe();
    paintFlight();
    panel.update({ subtitle: subtitleFor(info, adsbdb) });
    await loadModel();
  }

  const panel = panels.open({
    key,
    kind: 'aircraft',
    title: titleFor(info),
    subtitle: subtitleFor(info, null),
    render(body) {
      body.innerHTML = `
        <div class="dossier-actions">
          <button type="button" data-ac="cockpit">Cockpit view</button>
          <button type="button" data-ac="copy">Copy details</button>
        </div>
        <section class="dossier-section"><h4>Flight <small>live</small></h4><div data-ac="flight"></div></section>
        <section class="dossier-section"><h4>Airframe</h4><div data-ac="airframe"></div></section>
        <section class="dossier-section"><h4>Model history</h4><div data-ac="model"></div></section>
        <section class="dossier-section"><h4>Check next</h4><div data-ac="links"></div></section>`;
      const $ = (name) => body.querySelector(`[data-ac="${name}"]`);
      els = {
        flight: $('flight'),
        airframe: $('airframe'),
        model: $('model'),
        links: $('links'),
      };
      $('cockpit').addEventListener('click', async () => {
        const result = await onCockpit?.();
        panel.update({
          note: result?.ok
            ? ''
            : `Cockpit view unavailable: ${result?.error || 'unknown reason'}`,
        });
      });
      $('copy').addEventListener('click', () => {
        const text = JSON.stringify(
          { target, flight: info, airframe: adsbdb },
          null,
          2,
        );
        navigator.clipboard?.writeText(text).catch(() => {});
      });
    },
    onClose: () => clearInterval(timer),
  });

  paintFlight();
  paintAirframe();
  void loadAirframe();
  timer = setInterval(() => {
    const next = describe(target);
    const json = JSON.stringify(next);
    if (json === lastJson) return;
    lastJson = json;
    lost = !next;
    if (next) info = next;
    paintFlight();
  }, REFRESH_MS);
  return panel;
}
