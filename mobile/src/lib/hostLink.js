/**
 * The phone's link to an OMNI host: pair with the six-digit code the desktop
 * shows under PHONE › Pair a phone (the same /remote/pair exchange the phone
 * web page uses, see docs/PHONE-REMOTE.md on the phone-remote branch), then
 * call /remote/api/* with the bearer token it returns.
 *
 * This is the LAN handshake only. The host keeps tokens in memory, so a host
 * restart unpairs the phone, and on plain http the token crosses the network
 * unencrypted. The secure handoff for use away from home replaces both.
 */
const KEY = 'omni-portal.hostLink';

export function loadLink(storage = globalThis.localStorage) {
  try {
    return JSON.parse(storage?.getItem(KEY) || 'null');
  } catch {
    return null;
  }
}

export function saveLink(link, storage = globalThis.localStorage) {
  try {
    if (link) storage?.setItem(KEY, JSON.stringify(link));
    else storage?.removeItem(KEY);
  } catch {
    /* storage unavailable: the link lasts this session */
  }
}

/** True for addresses that only exist on a home or office network. */
export function isPrivateHost(url) {
  let host;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  if (host.includes(':')) return host === '::1' || /^(fe80:|fc|fd)/i.test(host);
  if (host === 'localhost' || host.endsWith('.local') || !host.includes('.')) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  return false;
}

/**
 * @param {(req: {method:string, url:string, headers?:object, body?:object}) =>
 *   Promise<{status:number, data:any}>} http JSON request over native HTTP
 */
export function createHostLink({ http, now = Date.now }) {
  const call = async (method, url, { token, body } = {}) => {
    const headers = { Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await http({ method, url, headers, body });
    let data = res.data;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        data = { error: data.slice(0, 200) };
      }
    }
    return { status: res.status, data: data || {} };
  };

  return {
    /** Trade the code on the computer screen for a token. */
    async pair(hostUrl, code, name) {
      const digits = String(code || '').replace(/\D/g, '');
      if (digits.length !== 6) throw new Error('The code is the 6 digits shown on the computer.');
      const { status, data } = await call('POST', `${hostUrl}/remote/pair`, {
        body: { code: digits, name: String(name || 'OMNI Portal').slice(0, 40) },
      });
      if (status === 404)
        throw new Error('That address answered, but it has no phone pairing. Run the build with the phone remote (PHONE in the dock).');
      if (status !== 200 || !data.ok || !data.token)
        throw new Error(data.error || `Pairing failed (HTTP ${status})`);
      return { hostUrl, token: data.token, device: data.device || null, pairedAt: now() };
    },
    /** Whether the host still accepts this phone, and whether its desktop app is open. */
    async status(link) {
      const { status, data } = await call('GET', `${link.hostUrl}/remote/api/status`, { token: link.token });
      if (status === 401) return { paired: false, error: data.error || 'This phone is no longer paired.' };
      if (status !== 200) throw new Error(data.error || `Host answered HTTP ${status}`);
      return { paired: true, desktopOnline: Boolean(data.desktopOnline), device: data.device || link.device };
    },
  };
}
