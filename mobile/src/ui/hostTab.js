import { h, toast } from './dom.js';
import { cleanUrl } from '../lib/settings.js';
import { fetchBytes } from '../lib/platform.js';

/**
 * Host tab: where the phone will connect to the OMNI host from another
 * network. Secure handoff (pairing, keys, tunnel) is designed separately;
 * today this only stores the host address, checks it answers, and sends
 * camera data through the host's cached proxy when set.
 */
export function mountHost(root, services) {
  const input = h('input', { type: 'url', placeholder: 'https://omni.example.net', value: services.settings.hostUrl, 'aria-label': 'Host address' });
  const status = h('p.muted', { text: services.settings.hostUrl ? 'Not checked yet.' : 'No host set. Cameras come straight from the public extract.' });

  async function save() {
    const v = cleanUrl(input.value);
    if (v == null) return toast('Enter an http(s) address.');
    services.updateSettings({ hostUrl: v });
    status.textContent = v ? 'Saved. Checking…' : 'Host cleared.';
    if (v) check();
  }

  async function check() {
    const host = services.settings.hostUrl;
    if (!host) return;
    try {
      const res = await Promise.race([
        fetchBytes(`${host}/api/alpr/us.json`),
        new Promise((_, reject) => setTimeout(() => reject(new Error('no answer in 6 s')), 6000)),
      ]);
      const ok = res.status >= 200 && res.status < 300;
      status.textContent = ok ? 'Host answered. Camera data now comes through it.' : `Host answered with HTTP ${res.status}.`;
    } catch (error) {
      status.textContent = `Can't reach the host: ${error.message}`;
    }
  }

  root.append(
    h(
      'div.page',
      {},
      h('h1', { text: 'OMNI host' }),
      h('p', { text: 'This phone will be the portal to your OMNI host from any network. Secure pairing and the encrypted connection come in a later update.' }),
      h('label.field', {}, h('span', { text: 'Host address' }), input),
      h('div.row', {}, h('button.primary', { text: 'Save', onclick: save }), h('button', { text: 'Check', onclick: check })),
      status,
      h('h3', { text: 'Pairing' }),
      h('p.muted', { text: 'Coming with secure handoff: pair with the six-digit code from PHONE on the desktop, then reach the host away from home.' }),
      h('input', { type: 'text', inputmode: 'numeric', placeholder: '6-digit code', disabled: true, 'aria-label': 'Pairing code' }),
    ),
  );
  return { shown() {} };
}
