import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateFlow, type Flow } from 'react-native-agent-devtools-protocol';
import { startServer } from '../server.ts';
import { FakeDevice } from '../testing/FakeDevice.ts';
import { toMaestro } from './maestro.ts';
import { resolveSecrets } from './runner.ts';

const ok = (action: string, extra: Record<string, unknown> = {}) => ({ ok: true, action, durationMs: 5, ...extra });

async function setup() {
  const stateDir = mkdtempSync(join(tmpdir(), 'rnad-state-'));
  const s = await startServer({ port: 0, lan: false, repoRoots: [], allowEdits: false, agent: false, mcp: false, log: () => {}, stateDir, env: {} });
  const d = new FakeDevice(`ws://127.0.0.1:${s.port}`);
  await d.opened();
  d.send({
    type: 'hello',
    protocol: 1,
    device: { platform: 'ios', osVersion: '26', libraryVersion: '1', window: { width: 400, height: 800, scale: 3 }, bundleId: 'com.example.app' },
    capabilities: {},
    instance: 'install-1',
  });
  await d.next('welcome');
  const tool = async (name: string, args: Record<string, unknown> = {}) =>
    (await (await fetch(`http://127.0.0.1:${s.port}/api/tool`, { method: 'POST', headers: { authorization: `Bearer ${s.token}` }, body: JSON.stringify({ name, args }) })).json()) as {
      content: { text: string }[];
      isError?: boolean;
    };
  return { s, d, tool, stateDir };
}

test('recorded actions become a flow with stable selectors, route expectations and no secrets', async () => {
  const { s, d, tool, stateDir } = await setup();
  try {
    d.handlers.typeText = (p) => {
      const target = (p as { target: string }).target;
      return target === 'e3'
        ? ok('typeText', { mode: 'native', target: { ref: 'e3', role: 'textbox', label: 'Password', testID: 'login-password' }, detail: { secure: true, length: 11 } })
        : ok('typeText', { mode: 'native', target: { ref: 'e2', role: 'textbox', label: 'Email', testID: 'login-email' } });
    };
    d.handlers.tap = () => ok('tap', { mode: 'semantic', target: { ref: 'e5', role: 'button', label: 'Log in' }, changes: { screenChanged: true, routeBefore: 'Login', routeAfter: 'Home' } });
    d.handlers.waitFor = () => ok('waitFor');
    await tool('mobile_type', { target: 'e2', text: 'dev@example.com' });
    await tool('mobile_type', { target: 'e3', text: 'password123' });
    await tool('mobile_tap', { target: 'e5' });
    await tool('mobile_wait_for', { text: 'Booking details' });
    d.handlers.tap = () => ({ ok: false, action: 'tap', durationMs: 1, error: { code: 'NOT_FOUND', message: 'x' } });
    await tool('mobile_tap', { target: 'e99' }); // failures are not recorded

    const saved = await tool('mobile_save_flow', { name: 'Login flow!' });
    assert.match(saved.content[0]!.text, /Saved flow "Login-flow" \(4 steps, starts on Login\)/);
    assert.match(saved.content[0]!.text, /set RNAD_SECRET_LOGIN_PASSWORD when replaying/);
    const file = join(stateDir, 'flows', 'com.example.app', 'Login-flow.json');
    const flow = JSON.parse(readFileSync(file, 'utf8')) as Flow;
    assert.ok(!readFileSync(file, 'utf8').includes('password123'), 'secret text never written');
    assert.deepEqual(flow.steps, [
      { type: 'type', target: { testID: 'login-email' }, text: 'dev@example.com', replace: true },
      { type: 'type', target: { testID: 'login-password' }, text: '${RNAD_SECRET_LOGIN_PASSWORD}', replace: true },
      { type: 'tap', target: { role: 'button', label: 'Log in', exact: true }, expect: { route: 'Home' } },
      { type: 'waitFor', condition: { text: 'Booking details' } },
    ]);
    assert.ok(validateFlow(flow).ok);
    assert.match((await tool('mobile_list_flows')).content[0]!.text, /Login-flow \(4 steps/);
  } finally {
    d.close();
    await s.close();
  }
});

test('replay runs in-app steps as on-device sequences and stops with a screenshot on failure', async () => {
  const { s, d, tool, stateDir } = await setup();
  try {
    d.handlers.typeText = () => ok('typeText', { target: { ref: 'e2', role: 'textbox', testID: 'login-email' } });
    d.handlers.tap = () => ok('tap', { target: { ref: 'e5', role: 'button', testID: 'login-submit' }, changes: { screenChanged: true, routeBefore: 'Login', routeAfter: 'Home' } });
    await tool('mobile_type', { target: 'e2', text: 'dev@example.com' });
    await tool('mobile_tap', { target: 'e5' });
    await tool('mobile_save_flow', { name: 'login' });

    const sequences: unknown[] = [];
    d.handlers.runSequence = (p) => {
      sequences.push(p);
      const actions = (p as { actions: unknown[] }).actions;
      return { ok: true, completed: actions.length, total: actions.length, durationMs: 9, steps: actions.map((_, i) => ({ ...ok('x'), step: i })), finalScreen: 'Home' };
    };
    const passed = await tool('mobile_run_flow', { name: 'login' });
    assert.equal(passed.isError, undefined);
    assert.match(passed.content[0]!.text, /✓ flow "login": 2\/2 steps/);
    assert.equal(sequences.length, 1, 'one device round trip for consecutive in-app steps');
    assert.deepEqual((sequences[0] as { actions: { type: string }[] }).actions.map((a) => a.type), ['type', 'tap']);

    d.handlers.runSequence = () => ({ ok: false, completed: 1, total: 2, durationMs: 9, stopped: 'step 2', steps: [{ ...ok('type'), step: 0 }, { ok: false, action: 'tap', step: 1, durationMs: 1, error: { code: 'NOT_FOUND', message: 'No element matches #login-submit' } }], finalScreen: '' });
    d.handlers.screenshot = () => ({ data: Buffer.from('jpeg').toString('base64'), mimeType: 'image/jpeg', width: 1, height: 1, pointWidth: 1, pointHeight: 1, scale: 1, captureMs: 1, annotated: false });
    const failed = await tool('mobile_run_flow', { name: 'login' });
    assert.equal(failed.isError, true);
    assert.match(failed.content[0]!.text, /failure: step 2 \(tap #login-submit\): No element matches #login-submit/);
    assert.ok(existsSync(join(stateDir, 'flows', 'login.failure.jpg')));
  } finally {
    d.close();
    await s.close();
  }
});

test('secrets are filled from the environment at replay', () => {
  const flow: Flow = { version: 1, name: 'x', createdAt: '', steps: [{ type: 'type', target: { testID: 'pw' }, text: '${RNAD_SECRET_PW}', replace: true }] };
  assert.deepEqual(resolveSecrets(flow, {}).missing, ['RNAD_SECRET_PW']);
  const r = resolveSecrets(flow, { RNAD_SECRET_PW: 'hunter2' });
  assert.equal((r.steps[0] as { text: string }).text, 'hunter2');
});

test('validateFlow rejects malformed flows', () => {
  assert.equal(validateFlow({ version: 2, name: 'x', steps: [{ type: 'back' }] }).ok, false);
  assert.equal(validateFlow({ version: 1, name: 'x', steps: [] }).ok, false);
  assert.match((validateFlow({ version: 1, name: 'x', steps: [{ type: 'tap' }] }) as { error: string }).error, /steps\[0\]/);
  const v = validateFlow({ version: 1, name: 'ok', steps: [{ type: 'swipe', from: { x: 1, y: 2 }, to: { x: 3, y: 4 }, os: true }, { type: 'alert', button: 'OK' }, { type: 'tap', target: '#go', os: true }] });
  assert.ok(v.ok);
  assert.deepEqual(v.ok && v.value.steps[2], { type: 'tap', target: { testID: 'go' }, os: true });
});

test('Maestro export uses ids, escaped text, percentages and comments for what Maestro cannot express', () => {
  const flow: Flow = {
    version: 1,
    name: 'checkout',
    app: { bundleId: 'com.example.app', platform: 'ios', window: { width: 400, height: 800 } },
    startRoute: 'Cart',
    createdAt: '',
    steps: [
      { type: 'tap', target: { testID: 'pay' }, expect: { route: 'Receipt' } },
      { type: 'tap', target: { role: 'button', label: 'Total (1.50)', exact: true } },
      { type: 'type', target: { testID: 'card' }, text: '${RNAD_SECRET_CARD}', replace: true, submit: true },
      { type: 'swipe', from: { x: 200, y: 600 }, to: { x: 200, y: 200 }, durationMs: 300 },
      { type: 'scrollTo', target: { testID: 'terms' } },
      { type: 'back' },
      { type: 'alert', button: 'OK' },
      { type: 'assert', condition: { text: 'Thanks', gone: false } },
    ],
  };
  const y = toMaestro(flow);
  assert.match(y, /^appId: com\.example\.app\nname: "checkout"\n---/);
  assert.match(y, /- tapOn:\n {4}id: "pay"\n# expect route "Receipt"/);
  assert.match(y, /- tapOn:\n {4}text: "Total \\\\\(1\\\\\.50\\\\\)"/);
  assert.match(y, /- inputText: "\$\{RNAD_SECRET_CARD\}"\n- pressKey: Enter/);
  assert.match(y, /start: "50%,75%"\n {4}end: "50%,25%"/);
  assert.match(y, /- scrollUntilVisible:\n {4}element:\n {6}id: "terms"/);
  assert.match(y, /# back: iOS has no system back/);
  assert.match(y, /- assertVisible:\n {4}text: "\.\*Thanks\.\*"/);
});
