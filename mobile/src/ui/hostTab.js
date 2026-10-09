import { h, toast } from './dom.js';
import { cleanUrl } from '../lib/settings.js';
import { fetchBytes, httpJson } from '../lib/platform.js';
import { createHostLink, isPrivateHost, loadLink, saveLink } from '../lib/hostLink.js';

/**
 * Host tab: pair this phone with the OMNI host (the desktop's PHONE › Pair a
 * phone code) and keep the host address that camera data goes through.
 * Pairing works on the same network today; the secure handoff for other
 * networks comes later.
 */
export function mountHost(root, services) {
  const link = createHostLink({ http: httpJson });
  let paired = loadLink();

  const hostInput = h('input', {
    type: 'url',
    inputmode: 'url',
    placeholder: '192.168.1.20:4173',
    value: services.settings.hostUrl,
    'aria-label': 'Host address',
    autocapitalize: 'off',
    autocorrect: 'off',
  });
  const codeInput = h('input', { type: 'text', inputmode: 'numeric', maxlength: 7, placeholder: '6-digit code', 'aria-label': 'Pairing code', autocomplete: 'one-time-code' });
  const nameInput = h('input', { type: 'text', value: 'OMNI Portal', maxlength: 40, 'aria-label': 'Phone name' });
  const pairButton = h('button.primary', { text: 'Pair', onclick: pair });
  const status = h('p.muted');
  const pairedBox = h('div');
  const warning = h('p.warn', { hidden: true });

  function readHost() {
    const v = cleanUrl(hostInput.value);
    if (!v) {
      toast('Enter the address from PHONE on the computer, like 192.168.1.20:4173.');
      return null;
    }
    hostInput.value = v;
    if (v !== services.settings.hostUrl) services.updateSettings({ hostUrl: v });
    showWarning(v);
    return v;
  }

  function showWarning(v) {
    const plainPublic = v.startsWith('http://') && !isPrivateHost(v);
    warning.hidden = !plainPublic;
    warning.textContent = plainPublic ? 'This address is plain http on the open internet. Pair only on your own network until the secure connection is ready.' : '';
  }

  async function pair() {
    const host = readHost();
    if (!host) return;
    pairButton.disabled = true;
    status.textContent = 'Pairing…';
    try {
      paired = await link.pair(host, codeInput.value, nameInput.value);
      saveLink(paired);
      codeInput.value = '';
      status.textContent = 'Paired.';
      render();
      check();
    } catch (error) {
      status.textContent = explain(error);
    } finally {
      pairButton.disabled = false;
    }
  }

  async function check() {
    if (!paired) {
      const host = readHost();
      if (!host) return;
      status.textContent = 'Checking…';
      try {
        const res = await fetchBytes(`${host}/api/alpr/us.json`);
        status.textContent = res.status >= 200 && res.status < 300 ? 'The host answers. Enter the code from the computer to pair.' : `The host answered HTTP ${res.status}.`;
      } catch (error) {
        status.textContent = explain(error);
      }
      return;
    }
    status.textContent = 'Checking…';
    try {
      const s = await link.status(paired);
      if (!s.paired) {
        status.textContent = `${s.error} (The computer forgets phones when its server restarts.)`;
        paired = null;
        saveLink(null);
        render();
        return;
      }
      status.textContent = s.desktopOnline ? 'Connected. The desktop app is open.' : 'Connected to the host. The desktop app is not open right now.';
    } catch (error) {
      status.textContent = explain(error);
    }
  }

  function forget() {
    paired = null;
    saveLink(null);
    status.textContent = 'This phone forgot the pairing. Revoke it on the computer under PHONE too.';
    render();
  }

  function render() {
    pairedBox.replaceChildren(
      paired
        ? h(
            'div.list',
            {},
            h('div', {}, h('strong', { text: `Paired as ${paired.device?.name || 'this phone'}` }), h('small.muted', { text: ` · ${paired.hostUrl} · since ${new Date(paired.pairedAt).toLocaleString()}` })),
            h('div.row', {}, h('button', { text: 'Check connection', onclick: check }), h('button.danger', { text: 'Forget', onclick: forget })),
          )
        : h(
            'div.pair-form',
            {},
            h('ol.howto', {}, [
              'On the computer, start OMNI with npm run dev:lan.',
              'Press PHONE in the dock, then Pair a phone.',
              'Type the address it shows (the /phone/ part is optional) and the 6-digit code here.',
            ].map((t) => h('li', { text: t }))),
            h('label.field', {}, h('span', { text: 'Pairing code' }), codeInput),
            h('label.field', {}, h('span', { text: 'Name for this phone' }), nameInput),
            h('div.row', {}, pairButton, h('button', { text: 'Check address', onclick: check })),
          ),
    );
  }

  root.append(
    h(
      'div.page',
      {},
      h('h1', { text: 'OMNI host' }),
      h('p', { text: 'Pair this phone with your OMNI computer. On the same Wi-Fi, use the address PHONE shows. Away from home, put both on a private network such as Tailscale and use the computer\'s 100.x address; the built-in secure connection comes in a later update.' }),
      h('label.field', {}, h('span', { text: 'Host address' }), hostInput),
      warning,
      pairedBox,
      status,
    ),
  );
  hostInput.addEventListener('change', readHost);
  if (services.settings.hostUrl) showWarning(services.settings.hostUrl);
  render();
  return { shown: () => paired && check() };
}

function explain(error) {
  const msg = String(error?.message || error);
  if (/cleartext/i.test(msg)) return 'This app build blocks plain http. Install the newer build of the app.';
  if (/timed? ?out|failed to connect|unreachable|ECONNREFUSED|could not connect|network/i.test(msg))
    return `Can't reach the computer at that address. Check the phone is on the same Wi-Fi (or Tailscale is on, on both), the server runs with npm run dev:lan, and Windows allowed Node.js on private networks. (${msg})`;
  return msg;
}
