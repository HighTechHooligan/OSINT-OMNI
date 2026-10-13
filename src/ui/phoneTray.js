/**
 * PHONE: dock popdown for the phone remote — pair a phone, see and revoke
 * paired phones, and watch what they ask this computer to do. Features Code
 * has the same actions as `phone ...`; both call the phoneLink service.
 * Styles reuse the SITE tray's (src/ui/styles/site-tray.css).
 */
import { formatCountdown } from '../services/phoneLink.js';

const ago = (t) => {
  if (!t) return 'never';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(t).toLocaleTimeString();
};

export function mountPhoneTray({ phone, dock } = {}) {
  const host = dock ?? document.getElementById('command-dock');
  const item = document.createElement('div');
  item.id = 'phone-tray';
  item.className = 'site-tray-dock';
  item.innerHTML = `
    <button id="phone-tray-toggle" class="site-tray-toggle" type="button"
      aria-expanded="false" aria-controls="phone-tray-panel" title="Drive this app from a phone">
      <span class="site-tray-glyph" aria-hidden="true">▯</span>
      <span class="site-tray-label">PHONE</span>
    </button>`;
  const locationBar = host?.querySelector('#location-bar');
  if (host && locationBar) host.insertBefore(item, locationBar);
  else if (host) host.prepend(item);
  else {
    item.classList.add('site-tray-floating');
    document.body.appendChild(item);
  }
  const toggle = item.querySelector('button');

  const panel = document.createElement('section');
  panel.id = 'phone-tray-panel';
  panel.className = 'site-tray-panel';
  panel.setAttribute('aria-label', 'Phone remote');
  panel.hidden = true;
  panel.innerHTML = `
    <header class="site-tray-head">
      <span>PHONE</span>
      <button type="button" class="site-tray-close" aria-label="Close phone remote">×</button>
    </header>
    <div class="site-tray-body">
      <section class="site-tray-section" aria-labelledby="pt-pair-h">
        <h3 id="pt-pair-h">Pair a phone <small>same Wi-Fi as this computer</small></h3>
        <div class="site-tray-row">
          <button type="button" data-pt="pair">Pair a phone</button>
        </div>
        <p class="site-tray-status" data-pt="code" aria-live="polite"></p>
        <p class="site-tray-status" data-pt="urls"></p>
      </section>
      <section class="site-tray-section" aria-labelledby="pt-dev-h">
        <h3 id="pt-dev-h">Paired phones</h3>
        <div data-pt="devices"></div>
        <p class="site-tray-status" data-pt="bridge"></p>
      </section>
      <section class="site-tray-section" aria-labelledby="pt-log-h">
        <h3 id="pt-log-h">From the phones</h3>
        <div data-pt="recent"></div>
        <p class="site-tray-status" data-pt="cache"></p>
      </section>
      <p class="site-tray-foot">Same actions in Features Code: <code>phone pair</code>, <code>phone devices</code>, <code>phone revoke &lt;id|all&gt;</code></p>
    </div>`;
  document.body.appendChild(panel);
  const $ = (key) => panel.querySelector(`[data-pt="${key}"]`);
  const say = (key, text, tone = '') => {
    $(key).textContent = text;
    $(key).dataset.tone = tone;
  };

  const row = (text, button) => {
    const line = document.createElement('div');
    line.className = 'site-tray-row';
    const span = document.createElement('span');
    span.textContent = text;
    line.append(span);
    if (button) line.append(button);
    return line;
  };

  function render(
    { state, bridgeOn, available, lastActivity } = phone.describe(),
  ) {
    if (!available) {
      say(
        'code',
        'This server has no phone remote. Run the dev or preview server.',
        'err',
      );
      return;
    }
    const pairing = state?.pairing;
    say(
      'code',
      pairing
        ? `Code: ${pairing.code.replace(/(\d{3})(\d{3})/, '$1 $2')} · expires in ${formatCountdown(pairing.expiresAt)}`
        : '',
      'ok',
    );
    if (state)
      say(
        'urls',
        state.lanReady && state.urls.length
          ? `On the phone, open ${state.urls[0]}` +
              (state.urls.length > 1
                ? ` (if that fails: ${state.urls.slice(1).join(', ')})`
                : '')
          : `${state.hint}${state.urls.length ? ` Then open ${state.urls[0]} on the phone.` : ''}`,
        state.lanReady && state.urls.length ? 'ok' : 'err',
      );
    const devices = state?.devices ?? [];
    $('devices').replaceChildren(
      ...(devices.length
        ? devices.map((d) => {
            const revoke = document.createElement('button');
            revoke.type = 'button';
            revoke.textContent = 'Revoke';
            revoke.addEventListener(
              'click',
              guard(() => phone.revoke(d.id)),
            );
            return row(
              `${d.name} (${d.id}) · seen ${ago(d.lastSeenAt)}`,
              revoke,
            );
          })
        : [row('No phones paired')]),
    );
    say(
      'bridge',
      bridgeOn
        ? 'This app is taking commands from paired phones.'
        : 'Not taking phone commands.',
    );
    const recent = state?.recent ?? [];
    $('recent').replaceChildren(
      ...(recent.length
        ? recent.map((c) => row(`${c.from}: ${c.line} · ${c.status}`))
        : [
            row(
              lastActivity
                ? `${lastActivity.from}: ${lastActivity.line}`
                : 'Nothing yet',
            ),
          ]),
    );
    if (state)
      say(
        'cache',
        `Cached answers: ${state.cache.entries} · reused ${state.cache.hits} · readability notes this session: ${state.feedbackCount}`,
      );
  }

  const guard = (fn) => async () => {
    try {
      await fn();
    } catch (error) {
      say('code', error?.message || String(error), 'err');
    }
  };

  $('pair').addEventListener(
    'click',
    guard(() => phone.startPairing()),
  );

  let timer = null;
  const setOpen = (open) => {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    item.classList.toggle('open', open);
    clearInterval(timer);
    if (open) {
      place();
      guard(() => phone.refresh())();
      // Keep the countdown and phone list current while open.
      timer = setInterval(() => {
        guard(() => phone.refresh())();
      }, 2000);
    }
  };
  const place = () => {
    const rect = toggle.getBoundingClientRect();
    const left = Math.max(
      16,
      Math.min(rect.left, window.innerWidth - panel.offsetWidth - 16),
    );
    panel.style.left = `${left}px`;
    panel.style.bottom = `${Math.max(16, window.innerHeight - rect.top + 10)}px`;
  };
  toggle.addEventListener('click', () => setOpen(panel.hidden));
  panel.querySelector('.site-tray-close').addEventListener('click', () => {
    setOpen(false);
    toggle.focus();
  });
  panel.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      setOpen(false);
      toggle.focus();
    }
  });
  const onResize = () => !panel.hidden && place();
  window.addEventListener('resize', onResize);
  const off = phone.onChange((snapshot) => render(snapshot));
  render();

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    destroy() {
      clearInterval(timer);
      off();
      window.removeEventListener('resize', onResize);
      item.remove();
      panel.remove();
    },
  };
}
