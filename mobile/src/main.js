import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import { createServices } from './services.js';
import { mountMaps } from './ui/mapsTab.js';
import { mountRoutes } from './ui/routesTab.js';
import { mountComputer } from './ui/computerTab.js';
import { mountHost } from './ui/hostTab.js';

// No top-level await: Capacitor's lazily loaded web plugins import this
// bundle back, and a pending top-level await would deadlock that cycle.
start();

async function start() {
  const services = await createServices();
  const el = (name) => document.getElementById(`tab-${name}`);
  const tabs = {};
  tabs.maps = mountMaps(el('maps'), services);
  tabs.routes = mountRoutes(el('routes'), services, {
    openOnMap: (record, origin = 'cache') => {
      show('maps');
      tabs.maps.showRecord(record, origin);
    },
  });
  tabs.computer = mountComputer(el('computer'), services, { openHost: () => show('host') });
  tabs.host = mountHost(el('host'), services);

  function show(name) {
    for (const b of document.querySelectorAll('.tabbar [data-tab]'))
      b.setAttribute('aria-selected', String(b.dataset.tab === name));
    for (const [key, tab] of Object.entries(tabs)) {
      const active = key === name;
      const wasHidden = el(key).hidden;
      el(key).hidden = !active;
      el(key).classList.toggle('active', active);
      if (active && wasHidden) tab.shown?.();
      if (!active && !wasHidden) tab.hidden?.();
    }
  }
  for (const button of document.querySelectorAll('.tabbar [data-tab]'))
    button.addEventListener('click', () => show(button.dataset.tab));
}
