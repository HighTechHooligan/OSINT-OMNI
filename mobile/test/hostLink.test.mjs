import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostLink, isPrivateHost, loadLink, saveLink } from '../src/lib/hostLink.js';
import { cleanUrl } from '../src/lib/settings.js';

/** A fake desktop speaking the /remote protocol from the phone-remote branch. */
function fakeHost() {
  const tokens = new Set();
  let code = '482913';
  const http = async ({ method, url, headers, body }) => {
    const path = new URL(url).pathname;
    if (path === '/remote/pair' && method === 'POST') {
      assert.equal(headers['Content-Type'], 'application/json');
      if (body.code !== code) return { status: 403, data: { ok: false, error: 'That code does not match' } };
      code = null;
      tokens.add('tok');
      return { status: 200, data: { ok: true, token: 'tok', device: { id: 'd1', name: body.name } } };
    }
    if (path === '/remote/api/status') {
      if (!tokens.has(/^Bearer (\S+)$/.exec(headers.Authorization || '')?.[1])) return { status: 401, data: JSON.stringify({ error: 'This phone is not paired. Pair it again from the computer.' }) };
      return { status: 200, data: { device: { id: 'd1' }, desktopOnline: true } };
    }
    return { status: 404, data: { error: 'Unknown remote route' } };
  };
  return { http, restart: () => tokens.clear() };
}

test('pairing trades the code for a token, and status uses it', async () => {
  const host = fakeHost();
  const link = createHostLink({ http: host.http, now: () => 5 });
  await assert.rejects(link.pair('http://192.168.1.20:4173', '12345', 'Pixel'), /6 digits/);
  await assert.rejects(link.pair('http://192.168.1.20:4173', '000 000', 'Pixel'), /does not match/);
  const paired = await link.pair('http://192.168.1.20:4173', '482 913', 'Pixel');
  assert.deepEqual(paired, { hostUrl: 'http://192.168.1.20:4173', token: 'tok', device: { id: 'd1', name: 'Pixel' }, pairedAt: 5 });
  assert.deepEqual(await link.status(paired), { paired: true, desktopOnline: true, device: { id: 'd1' } });
  host.restart();
  const after = await link.status(paired);
  assert.equal(after.paired, false);
  assert.match(after.error, /not paired/);
});

test('a server without the phone remote says so', async () => {
  const link = createHostLink({ http: async () => ({ status: 404, data: 'Not Found' }) });
  await assert.rejects(link.pair('http://10.0.0.2:4173', '123456'), /no phone pairing/);
});

test('private addresses are recognised', () => {
  for (const u of ['http://192.168.1.20:4173', 'http://10.1.2.3', 'http://172.20.0.5', 'http://desktop.local:4173', 'http://mypc:4173', 'http://100.101.1.2', 'http://[fd00::1]:4173'])
    assert.equal(isPrivateHost(u), true, u);
  for (const u of ['http://8.8.8.8', 'https://omni.example.net', 'http://172.32.0.1', 'http://[2001:db8::1]'])
    assert.equal(isPrivateHost(u), false, u);
});

test('the address from the PHONE panel works as typed', () => {
  assert.equal(cleanUrl('http://192.168.1.20:4173/phone/'), 'http://192.168.1.20:4173');
  assert.equal(cleanUrl('192.168.1.20:4173'), 'http://192.168.1.20:4173');
  assert.equal(cleanUrl('192.168.1.20:4173/phone'), 'http://192.168.1.20:4173');
  assert.equal(cleanUrl('omni.example.net'), 'https://omni.example.net');
});

test('the pairing is remembered and forgotten', () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  saveLink({ hostUrl: 'http://10.0.0.2', token: 't' }, storage);
  assert.equal(loadLink(storage).token, 't');
  saveLink(null, storage);
  assert.equal(loadLink(storage), null);
});
