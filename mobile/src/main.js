import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import { createServices } from './services.js';
import { mountMaps } from './ui/mapsTab.js';
import { mountHost } from './ui/hostTab.js';

// No top-level await: Capacitor's lazily loaded web plugins import this
// bundle back, and a pending top-level await would deadlock that cycle.
start();

async function start() {
  const services = await createServices();
  const tabs = {
    maps: mountMaps(document.getElementById('tab-maps'), services),
    host: mountHost(document.getElementById('tab-host'), services),
  };

  for (const button of document.querySelectorAll('.tabbar [data-tab]')) {
    button.addEventListener('click', () => {
      const name = button.dataset.tab;
      for (const b of document.querySelectorAll('.tabbar [data-tab]'))
        b.setAttribute('aria-selected', String(b === button));
      for (const [key, tab] of Object.entries(tabs)) {
        const el = document.getElementById(`tab-${key}`);
        el.hidden = key !== name;
        el.classList.toggle('active', key === name);
        if (key === name) tab.shown?.();
      }
    });
  }
}
