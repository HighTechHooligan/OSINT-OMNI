import { h, toast } from './dom.js';
import { formatBytes } from '../lib/netMeter.js';
import { formatDistance, formatDuration, routeLengthM } from '../lib/nav.js';

/**
 * Routes tab: saved routes (kept until deleted, map pinned on the phone) and
 * recent ones. Open, rename, refresh, reverse, save or delete each one.
 */
export function mountRoutes(root, services, { openOnMap }) {
  const list = h('div.route-list');
  const filter = h('input', { type: 'search', placeholder: 'Find a saved route', 'aria-label': 'Find a route', oninput: () => render() });
  let sort = 'recent';
  const sortSelect = h(
    'select',
    { 'aria-label': 'Sort', onchange: (e) => ((sort = e.target.value), render()) },
    h('option', { value: 'recent', text: 'Newest first' }),
    h('option', { value: 'name', text: 'By name' }),
  );
  root.append(h('div.page', {}, h('h1', { text: 'Routes' }), h('div.row.toolbar', {}, filter, sortSelect), list));

  const units = () => services.settings.units;
  const camText = (r) => r.message || (r.cameras?.length ? `Passes ${r.cameras.length} mapped camera${r.cameras.length === 1 ? '' : 's'}` : 'No mapped cameras');
  const title = (r) => r.name || `${short(r.fromLabel)} → ${short(r.toLabel)}`;
  const busy = async (button, label, work) => {
    const old = button.textContent;
    button.disabled = true;
    button.textContent = label;
    try {
      return await work((stage, done, total) => (button.textContent = total ? `${done}/${total}` : label));
    } catch (error) {
      toast(error.message || String(error));
    } finally {
      button.disabled = false;
      button.textContent = old;
    }
  };

  function card(r) {
    const nameEl = h('strong', { text: title(r) });
    const meta = [
      `${formatDuration(r.route.time)} · ${formatDistance(routeLengthM(r.route), units())}`,
      { auto: 'Car', bicycle: 'Bike', pedestrian: 'Walk' }[r.costing] || r.costing,
      r.avoid ? 'avoiding cameras' : 'usual route',
    ].join(' · ');
    const offline = r.saved
      ? r.offline
        ? `Map on phone: ${formatBytes(r.offline.bytes)}${r.offline.failed ? ` (${r.offline.failed} tiles missing)` : ''}`
        : 'Saving the map along this route…'
      : `Recent · ${new Date(r.at).toLocaleString()}`;
    const actions = h('div.row');
    const add = (text, fn, cls = '') => {
      const b = h(`button${cls}`, { text });
      b.addEventListener('click', () => fn(b));
      actions.append(b);
    };
    add('Open', () => openOnMap(r));
    if (r.saved) {
      add('Rename', () => {
        const input = h('input', { type: 'text', value: title(r), 'aria-label': 'Route name', maxlength: 80 });
        const done = async () => {
          try {
            await services.savedRoutes.rename(r.id, input.value);
            render();
          } catch (error) {
            toast(error.message);
          }
        };
        input.addEventListener('keydown', (e) => e.key === 'Enter' && done());
        input.addEventListener('blur', done);
        nameEl.replaceWith(input);
        input.focus();
        input.select();
      });
    } else add('Save', (b) => busy(b, 'Saving…', async () => (await services.savedRoutes.save(r.id), render())), '.primary');
    add('Refresh', (b) => busy(b, 'Planning…', async (progress) => {
      if (!services.connection().online) throw new Error('Refreshing needs a signal.');
      await services.savedRoutes.refresh(r.id, { onProgress: progress });
      render();
      toast('Re-planned with current roads and cameras.');
    }));
    add('Reverse', (b) => busy(b, 'Planning…', async (progress) => openOnMap(await services.savedRoutes.reverse(r.id, { onProgress: progress }), 'network')));
    add(r.saved ? 'Delete' : 'Remove', async () => {
      if (r.saved && !confirm(`Delete "${title(r)}" and its offline map?`)) return;
      await services.savedRoutes.remove(r.id);
      render();
    }, '.danger');
    return h(
      'li.route-card',
      {},
      h('div', {}, nameEl, h('small.muted', { text: `${short(r.fromLabel)} → ${short(r.toLabel)}` }), h('small', { text: meta }), h('small', { class: r.cameras?.length ? 'warn' : 'ok-text', text: camText(r) }), h('small.muted', { text: offline })),
      actions,
    );
  }

  async function render() {
    const { saved, recent } = await services.savedRoutes.list();
    const q = filter.value.trim().toLowerCase();
    const match = (r) => !q || [title(r), r.fromLabel, r.toLabel].join(' ').toLowerCase().includes(q);
    const sorted = saved.filter(match).sort((a, b) => (sort === 'name' ? title(a).localeCompare(title(b)) : b.at - a.at));
    list.replaceChildren(
      h('h3', { text: `Saved (${saved.length})` }),
      sorted.length ? h('ul.list', {}, sorted.map(card)) : h('p.muted', { text: saved.length ? 'No saved route matches.' : 'Plan a route on Maps and press Save. Saved routes stay on the phone, with their map, until you delete them.' }),
      h('div.row.section-head', {}, h('h3', { text: `Recent (${recent.length})` }), recent.length ? h('button', { text: 'Clear recent', onclick: async () => (await services.savedRoutes.clearRecent(), render()) }) : null),
      recent.length ? h('ul.list', {}, recent.filter(match).map(card)) : h('p.muted', { text: 'Routes you plan show up here. The last 30 are kept.' }),
    );
  }

  render();
  return { shown: render };
}

const short = (label = '') => String(label).split(',')[0].trim() || 'Place';
