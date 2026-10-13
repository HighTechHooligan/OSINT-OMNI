import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPhoneLink,
  formatCountdown,
  refuseFromPhone,
} from './phoneLink.js';
import { createCapturedRunner } from '../ui/featuresCode.js';

const json = (status, body) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

test('the bridge runs a phone command, reports it, and stops when the server has no remote', async () => {
  const posted = [];
  const replies = [
    json(200, { command: { id: 'c1', line: 'zoom', from: 'Sam' } }),
    json(204),
    json(404, { error: 'none' }),
  ];
  let stopped;
  const done = new Promise((resolve) => (stopped = resolve));
  const link = createPhoneLink({
    runCommand: async (line) => ({
      ok: true,
      lines: [{ text: `ran ${line}`, tone: 'ok' }],
    }),
    fetchImpl: async (url, init = {}) => {
      if (url === '/remote/desk/result') {
        posted.push(JSON.parse(init.body));
        return json(200, { ok: true });
      }
      return replies.shift() ?? json(404, {});
    },
  });
  link.onChange(({ bridgeOn, available }) => {
    if (!bridgeOn && !available) stopped();
  });
  assert.equal(link.startBridge(), true);
  await done;
  assert.deepEqual(posted, [
    { id: 'c1', ok: true, lines: [{ text: 'ran zoom', tone: 'ok' }] },
  ]);
  assert.equal(link.describe().lastActivity.line, 'zoom');
  assert.equal(
    link.startBridge(),
    false,
    'stays off once the server has no remote',
  );
});

test('phones cannot run keyboard-only commands or start a boundary drawing', async () => {
  assert.match(refuseFromPhone('js 1'), /keyboard/);
  assert.match(refuseFromPhone('Phone revoke all'), /keyboard/);
  assert.match(refuseFromPhone('boundary draw'), /mouse/);
  assert.equal(refuseFromPhone('boundary export'), null);
  const link = createPhoneLink({
    runCommand: async () => assert.fail('must not run'),
  });
  const result = await link.execute({ line: 'js alert(1)' });
  assert.equal(result.ok, false);
  const snap = await createPhoneLink({
    runCommand: async () => assert.fail('must not run'),
    snapshot: () => 'data:image/jpeg;base64,AAAA',
  }).execute({ line: 'snap' });
  assert.equal(snap.image, 'data:image/jpeg;base64,AAAA');
});

test('captured Features Code runs report final printed lines and never offer js', async () => {
  const run = createCapturedRunner({
    site: {
      boundary: { describe: () => null },
      orbit: {},
      contours: {},
    },
    goTo: async () => {},
  });
  assert.deepEqual(await run('site'), {
    ok: true,
    lines: [{ text: 'Nothing loaded', tone: 'dim' }],
  });
  assert.deepEqual(await run('goto Hyland Hills'), {
    ok: true,
    lines: [{ text: 'Flying to Hyland Hills', tone: 'ok' }],
  });
  const js = await run('js 1+1');
  assert.equal(js.ok, false);
  assert.match(js.lines[0].text, /Unknown command "js"/);
});

test('pairing countdowns read as minutes and seconds', () => {
  assert.equal(formatCountdown(65_000, 0), '1:05');
  assert.equal(formatCountdown(0, 10_000), '0:00');
});
