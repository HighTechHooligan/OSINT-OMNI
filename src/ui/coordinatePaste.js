/**
 * Paste coordinates: a pop-out panel where a list of coordinates (CSV, TSV,
 * "lat, lon" lines) or KML is pasted and imported straight into the site
 * as a boundary and/or survey points, then the camera flies to it.
 */
import {
  looksLikeKml,
  parseCoordinateList,
} from '../services/surveyGeometry.js';

const MODES = Object.freeze([
  ['outline', 'Outline + points'],
  ['boundary', 'Boundary in order'],
  ['points', 'Add as points'],
]);

/**
 * @param {{ panels: object, boundary: object, orbit?: object,
 *   initialText?: string }} deps
 * @returns {object} the panel handle
 */
export function openCoordinatePaste({
  panels,
  boundary,
  orbit,
  initialText = '',
}) {
  let panelRef = null;
  const panel = panels.open({
    key: 'coordinate-paste',
    kind: 'survey',
    title: 'Paste coordinates',
    subtitle: 'CSV, "lat, lon" lines, or KML',
    render(body, handle) {
      panelRef = handle;
      body.innerHTML = `
        <p class="dossier-note">Paste a list and it is imported right away. Columns named lat/lon (any order) and a name/id column are read; without a header, lines are read as <code>lat, lon</code> unless the numbers say otherwise.</p>
        <textarea class="coord-paste-text" rows="9" spellcheck="false"
          placeholder="name,lat,lon&#10;GCP01,44.8402,-93.36662&#10;GCP02,44.84355,-93.3661&#10;&#10;or paste a KML Placemark / file"></textarea>
        <div class="coord-paste-row">
          <label>Order
            <select data-cp="order">
              <option value="auto" selected>Auto</option>
              <option value="latlon">lat, lon</option>
              <option value="lonlat">lon, lat</option>
            </select>
          </label>
          <label>Use as
            <select data-cp="mode">${MODES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
          </label>
        </div>
        <div class="dossier-actions">
          <button type="button" data-cp="import">Import</button>
          <button type="button" data-cp="clear">Clear text</button>
        </div>
        <p class="site-tray-status" data-cp="status" aria-live="polite"></p>`;
      wire(body);
    },
  });

  function wire(body) {
    const text = body.querySelector('.coord-paste-text');
    const $ = (k) => body.querySelector(`[data-cp="${k}"]`);
    const status = (msg, tone = '') => {
      $('status').textContent = msg;
      $('status').dataset.tone = tone;
    };
    const preview = () => {
      const value = text.value.trim();
      if (!value) return status('');
      if (looksLikeKml(value)) return status('KML detected');
      const p = parseCoordinateList(value, { order: $('order').value });
      status(
        `${p.points.length} coordinates (${p.order === 'latlon' ? 'lat, lon' : 'lon, lat'}${p.header ? ', header' : ''})${p.skipped ? ` · ${p.skipped} lines skipped` : ''}`,
      );
    };
    const run = async () => {
      const value = text.value.trim();
      if (!value) return status('Paste coordinates first', 'err');
      status('Importing…');
      try {
        const out = await boundary.importText(value, {
          mode: $('mode').value,
          order: $('order').value,
        });
        const s = out.site;
        status(
          `Imported ${out.kind === 'kml' ? 'KML' : `${out.count} coordinates`} → ${s.name} · ${s.areaAcres} ac · ${s.points} points${out.skipped ? ` · ${out.skipped} skipped` : ''}`,
          'ok',
        );
        panelRef?.update({ subtitle: s.name });
        await orbit?.zoom?.();
      } catch (error) {
        status(error?.message || String(error), 'err');
      }
    };
    text.addEventListener('input', preview);
    text.addEventListener('paste', () => setTimeout(run, 0));
    text.addEventListener('dragover', (e) => e.preventDefault());
    text.addEventListener('drop', async (e) => {
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      e.preventDefault();
      text.value = await file.text();
      run();
    });
    $('order').addEventListener('change', preview);
    $('import').addEventListener('click', run);
    $('clear').addEventListener('click', () => {
      text.value = '';
      preview();
      text.focus();
    });
    if (initialText) {
      text.value = initialText;
      run();
    } else text.focus();
  }

  if (
    initialText &&
    panel.body.querySelector('.coord-paste-text')?.value !== initialText
  ) {
    // Panel was already open: drop the new text in and import it.
    const text = panel.body.querySelector('.coord-paste-text');
    text.value = initialText;
    panel.body.querySelector('[data-cp="import"]').click();
  }
  return panel;
}
