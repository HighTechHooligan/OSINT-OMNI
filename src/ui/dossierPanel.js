/**
 * Dossier pop-out for a building, road or park picked in building mode.
 * Opens in the shared pop-out panel manager (several at once), fills in the
 * address from /api/reverse-geocode, and shows the planned AI web research
 * (stubbed until the private AI host is connected; see tools/locationResearch).
 */
import { buildDossier } from '../services/dossierModel.js';

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );

/** Address lookups shared by every open dossier, keyed by ~1 m cell. */
const lookups = new Map();

function reverseLookup([lon, lat], fetchImpl) {
  const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
  if (!lookups.has(key)) {
    const p = fetchImpl(
      `/api/reverse-geocode?lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}`,
    )
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()).result ?? null;
      })
      .catch((error) => {
        lookups.delete(key);
        throw error;
      });
    lookups.set(key, p);
    while (lookups.size > 200) lookups.delete(lookups.keys().next().value);
  }
  return lookups.get(key);
}

function renderDossier(body, dossier, { research }) {
  const sections = dossier.sections
    .map(
      (s) => `
      <section class="dossier-section">
        <h4>${esc(s.title)}</h4>
        <dl>${s.rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      </section>`,
    )
    .join('');
  const links = dossier.links
    .map(
      (l) =>
        `<li><a href="${esc(l.href)}" target="_blank" rel="noopener noreferrer">${esc(l.label)}</a></li>`,
    )
    .join('');
  const plan = dossier.research
    .map(
      (step) =>
        `<li><span>${esc(step.topic)}</span><code>${esc(step.query)}</code></li>`,
    )
    .join('');
  body.innerHTML = `
    <div class="dossier-actions">
      <button type="button" data-dz="fly">Fly to</button>
      <button type="button" data-dz="copy-coords">Copy coordinates</button>
      <button type="button" data-dz="copy-json">Copy dossier</button>
    </div>
    ${sections}
    <section class="dossier-section">
      <h4>Sources</h4>
      <ul class="dossier-links">${links}</ul>
    </section>
    <section class="dossier-section dossier-research">
      <h4>Web research <small>AI</small></h4>
      <button type="button" data-dz="research" ${research.available ? '' : 'disabled'}>Research this ${esc(dossier.kind)}</button>
      <p class="dossier-note">${
        research.available
          ? 'Runs the searches below through the connected AI host.'
          : 'Coming with the private AI host: a web crawler will run these searches and add cited findings here.'
      }</p>
      <ol class="dossier-plan">${plan}</ol>
      <div class="dossier-results" data-dz="results"></div>
    </section>`;
}

/**
 * @param {{ panels: object, record: object, buildings: object,
 *   fetchImpl?: Function, research: object }} deps
 */
export function openDossier({
  panels,
  record,
  buildings,
  fetchImpl = (...a) => fetch(...a),
  research,
}) {
  let reverse = null;
  let addressState = 'loading';
  let dossier = buildDossier(record, { addressState });
  const panel = panels.open({
    key: `dossier:${record.id}`,
    kind: record.kind,
    title: dossier.title,
    subtitle: dossier.subtitle,
    render: (body) => paint(body),
    onClose: () => {
      if (buildings.describe().selectedId === record.id) buildings.select(null);
    },
  });

  function paint(body = panel?.body) {
    if (!body) return;
    renderDossier(body, dossier, { research });
    const btn = (k) => body.querySelector(`[data-dz="${k}"]`);
    btn('fly').addEventListener('click', () => {
      buildings.select(record.id);
      buildings.flyTo(record);
    });
    const copy = async (text, el) => {
      try {
        await (
          el.ownerDocument.defaultView ?? window
        ).navigator.clipboard.writeText(text);
        el.textContent = 'Copied';
      } catch {
        el.textContent = 'Copy failed';
      }
      setTimeout(() => paint(), 1200);
    };
    btn('copy-coords').addEventListener('click', (e) =>
      copy(
        `${record.center[1].toFixed(6)}, ${record.center[0].toFixed(6)}`,
        e.currentTarget,
      ),
    );
    btn('copy-json').addEventListener('click', (e) =>
      copy(
        JSON.stringify({ ...dossier, osm: record.tags }, null, 2),
        e.currentTarget,
      ),
    );
    btn('research').addEventListener('click', async (e) => {
      const out = body.querySelector('[data-dz="results"]');
      e.currentTarget.disabled = true;
      out.textContent = 'Researching…';
      try {
        const result = await research.research(dossier);
        out.innerHTML = result.results.length
          ? `<ul>${result.results
              .map(
                (r) =>
                  `<li><a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.title || r.url)}</a> <small>${esc(r.topic)}</small><p>${esc(r.snippet || '')}</p></li>`,
              )
              .join('')}</ul>`
          : esc(result.reason || 'Nothing found.');
      } catch (error) {
        out.textContent = error?.message || String(error);
      }
    });
  }

  const refresh = () => {
    dossier = buildDossier(record, { reverse, addressState });
    panel.update({ title: dossier.title, subtitle: dossier.subtitle });
    paint();
  };
  reverseLookup(record.center, fetchImpl).then(
    (result) => {
      reverse = result;
      addressState = null;
      refresh();
    },
    () => {
      addressState = 'error';
      refresh();
    },
  );
  return panel;
}
