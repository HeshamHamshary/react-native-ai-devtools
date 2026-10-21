import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerMessage } from 'react-native-agent-devtools-protocol';
import { Approvals } from './security/approvals.ts';
import { startServer, type RunningServer, type ServerOptions } from './server.ts';
import { FakeDevice } from './testing/FakeDevice.ts';
import type { DeviceSession } from './transport/devices.ts';

let server: RunningServer;
let base: string;
const logs: string[] = [];

/** Every test server keeps its token and pairings in a throwaway directory. */
const options = (extra: Partial<ServerOptions> = {}): ServerOptions => ({
  port: 0,
  lan: false,
  repoRoots: [],
  allowEdits: false,
  agent: true,
  mcp: true,
  log: () => {},
  stateDir: mkdtempSync(join(tmpdir(), 'rnad-state-')),
  env: {},
  ...extra,
});

before(async () => {
  server = await startServer(options({ log: (l) => logs.push(l), agentAvailable: { available: false, reason: 'no credentials (test)' } }));
  base = `127.0.0.1:${server.port}`;
});

after(async () => {
  await server.close();
});

async function connect(): Promise<FakeDevice> {
  const d = new FakeDevice(`ws://${base}`);
  await d.opened();
  d.hello();
  await d.next('welcome');
  return d;
}

const authed = (token = server.token) => ({ authorization: `Bearer ${token}` });

const rpc = async (method: string, params: unknown = {}, timeoutMs?: number) =>
  (await (
    await fetch(`http://${base}/api/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authed() },
      body: JSON.stringify({ method, params, ...(timeoutMs ? { timeoutMs } : {}) }),
    })
  ).json()) as { ok: boolean; result?: unknown; deviceMs?: number; rttMs?: number; error?: { code: string } };

test('hello → welcome with server info', async () => {
  const d = new FakeDevice(`ws://${base}`);
  await d.opened();
  d.hello();
  const w = await d.next('welcome');
  assert.equal(w.server.agent.available, false);
  assert.equal(w.server.network, 'loopback');
  assert.equal(w.server.repoAccess, 'none');
  assert.equal(w.deviceToken, undefined, 'no token needed on loopback');
  d.close();
});

test('first message must be a valid hello', async () => {
  const d = new FakeDevice(`ws://${base}`);
  await d.opened();
  const closed = d.closed();
  d.send({ type: 'chat.send', id: 'x', text: 'hi' });
  assert.equal(await closed, 4001);

  const d2 = new FakeDevice(`ws://${base}`);
  await d2.opened();
  const closed2 = d2.closed();
  d2.send({ type: 'hello', protocol: 999, device: {}, capabilities: {} });
  assert.equal(await closed2, 4002);
});

test('browser origins cannot open the device socket', async () => {
  const d = new FakeDevice(`ws://${base}`, { Origin: 'https://evil.example' });
  await assert.rejects(d.opened(), /HTTP 403/);
});

test('/api/rpc forwards to the device and reports timing', async () => {
  const d = await connect();
  d.handlers.getScreen = () => ({ text: 'screen: Login' });
  const r = await rpc('getScreen');
  assert.equal(r.ok, true);
  assert.deepEqual(r.result, { text: 'screen: Login' });
  assert.equal(r.deviceMs, 3);
  assert.ok(typeof r.rttMs === 'number');
  const bad = await (await fetch(`http://${base}/api/rpc`, { method: 'POST', headers: authed(), body: JSON.stringify({ method: 'eval' }) })).json();
  assert.match((bad as { error: string }).error, /unknown method/);
  d.close();
});

test('device errors and timeouts become structured errors', async () => {
  const d = await connect();
  d.handlers.tap = () => {
    throw new Error('No element matches "Pay"');
  };
  const err = await rpc('tap', { target: 'Pay' });
  assert.equal(err.ok, false);
  assert.equal(err.error?.code, 'NOT_FOUND');
  // no handler registered for getUI -> device never answers
  const t = await rpc('getUI', {}, 300);
  assert.equal(t.ok, false);
  assert.equal(t.error?.code, 'TIMEOUT');
  d.close();
});

test('chat without model credentials reports AGENT_UNAVAILABLE', async () => {
  const d = await connect();
  d.send({ type: 'chat.send', id: 'm1', text: 'What screen am I on?' });
  const e = await d.next('chat.error');
  assert.equal(e.code, 'AGENT_UNAVAILABLE');
  assert.match(e.message, /no credentials/);
  d.close();
});

test('MCP endpoint lists mobile tools and calls the device', async () => {
  const d = await connect();
  d.handlers.getScreen = () => ({ text: 'screen: Home · title="SkyTrips"' });
  const post = async (body: unknown) => {
    const res = await fetch(`http://${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...authed() },
      body: JSON.stringify(body),
    });
    return (await res.json()) as { result?: { tools?: { name: string }[]; content?: { type: string; text: string }[] } };
  };
  await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const names = list.result?.tools?.map((t) => t.name) ?? [];
  for (const n of ['mobile_get_ui', 'mobile_tap', 'mobile_type', 'mobile_execute_sequence', 'mobile_screenshot', 'mobile_get_logs', 'mobile_get_network']) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
  const call = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'mobile_get_screen', arguments: {} } });
  assert.match(call.result?.content?.[0]?.text ?? '', /SkyTrips/);
  d.close();
});

test('device disconnect cancels pending RPCs', async () => {
  const d = await connect();
  const pending = rpc('getUI', {}, 5_000);
  setTimeout(() => d.close(), 100);
  const r = await pending;
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, 'CANCELLED');
});

const lanIp = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

test('LAN mode requires pairing for non-loopback devices', { skip: !lanIp && 'no LAN interface' }, async () => {
  const lan = await startServer(options({ lan: true, agent: false, mcp: false, agentAvailable: { available: false } }));
  try {
    const url = `ws://${lanIp}:${lan.port}`;
    const a = new FakeDevice(url);
    await a.opened();
    a.hello();
    assert.equal((await a.next('auth.required')).pairing, true);
    a.hello({ pairingCode: 'WRONG123' });
    assert.match((await a.next('auth.required')).reason, /invalid/);
    a.hello({ pairingCode: lan.pairing.currentCode });
    const w = await a.next('welcome');
    assert.ok(w.deviceToken, 'token issued after pairing');
    assert.equal(w.server.network, 'lan');
    a.close();

    const b = new FakeDevice(url);
    await b.opened();
    b.hello({ token: w.deviceToken });
    const w2 = await b.next('welcome');
    assert.equal(w2.deviceToken, undefined, 'existing token accepted without re-pairing');

    // Control APIs stay loopback-only even in LAN mode.
    const res = await fetch(`http://${lanIp}:${lan.port}/api/devices`, { headers: authed(lan.token) });
    assert.equal(res.status, 403);
    b.close();
  } finally {
    await lan.close();
  }
});

test('"Set up Claude" runs Anthropic sign-in on the computer and enables the agent live', async () => {
  let loggedIn = false;
  let starts = 0;
  let finish: (r: { ok: boolean; reason?: string }) => void = () => {};
  const verified: string[] = [];
  const s = await startServer(
    options({
    mcp: false,
    signIn: {
      status: async () => ({ loggedIn }),
      start: () => {
        starts++;
        let resolve!: (r: { ok: boolean; reason?: string }) => void;
        const done = new Promise<{ ok: boolean; reason?: string }>((r) => (resolve = r));
        finish = resolve;
        return { done, cancel: () => resolve({ ok: false, reason: 'Sign-in cancelled.' }) };
      },
    },
    verifyAuth: async (mode) => {
      verified.push(mode);
      return loggedIn ? { ok: true, source: 'Anthropic Console sign-in' } : { ok: false, source: 'none', reason: 'no login' };
    },
    sessionFactory: () => undefined,
    }),
  );
  try {
    const d = new FakeDevice(`ws://127.0.0.1:${s.port}`);
    await d.opened();
    d.hello();
    const w = await d.next('welcome');
    assert.equal(w.server.agent.available, false);
    assert.equal(w.server.agent.setup, true);
    assert.match(w.server.agent.reason ?? '', /Not signed in/);

    // A sign-in that doesn't complete is reported, and the button can be used again.
    d.send({ type: 'setup.open' });
    assert.equal((await d.next('setup.status')).state, 'waiting');
    finish({ ok: false, reason: 'Sign-in did not complete.' });
    const failed = await d.next('setup.status');
    assert.deepEqual([failed.state, failed.message], ['failed', 'Sign-in did not complete.']);

    // Tapping again while waiting restarts sign-in; the superseded attempt stays silent.
    d.send({ type: 'setup.open' });
    await d.next('setup.status');
    d.send({ type: 'setup.open' });
    assert.equal((await d.next('setup.status')).state, 'waiting');
    assert.equal(starts, 3);

    loggedIn = true;
    finish({ ok: true });
    const w2 = await d.next('welcome');
    assert.equal(w2.server.agent.available, true, 'connected device is enabled without reconnecting');
    assert.equal(w2.server.agent.credentials, 'Anthropic Console sign-in');
    assert.deepEqual(verified, ['console'], 'credentials checked only once signed in, and only for the Console sign-in');
    assert.equal(d.inbox.filter((m) => m.type === 'setup.status').length, 0, 'no failure from the cancelled attempt');
    d.close();
  } finally {
    await s.close();
  }
});

test('local control APIs require the server token; /health reveals nothing else', async () => {
  const health = (await (await fetch(`http://${base}/health`)).json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(health).sort(), ['ok', 'version']);
  for (const [path, method] of [['/api/devices', 'GET'], ['/api/rpc', 'POST'], ['/mcp', 'POST'], ['/api/channel/arm', 'POST'], ['/api/pairing', 'GET']]) {
    assert.equal((await fetch(`http://${base}${path}`, { method })).status, 401, `${path} without a token`);
    assert.equal((await fetch(`http://${base}${path}`, { method, headers: authed('x'.repeat(43)) })).status, 401, `${path} with a wrong token`);
  }
  assert.equal((await fetch(`http://${base}/api/devices`, { headers: authed() })).status, 200);
});

test('the server token is stable across restarts and readable only by the developer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rnad-state-'));
  const a = await startServer(options({ stateDir: dir, mcp: false, agentAvailable: { available: false } }));
  await a.close();
  const b = await startServer(options({ stateDir: dir, mcp: false, agentAvailable: { available: false } }));
  await b.close();
  assert.equal(a.token, b.token);
  assert.ok(a.token.length >= 43);
  assert.equal(statSync(join(dir, 'server-token')).mode & 0o777, 0o600);
});

test('a simulator can pair voluntarily; pairings persist as hashes and can be revoked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rnad-state-'));
  const s1 = await startServer(options({ stateDir: dir, mcp: false, agentAvailable: { available: false } }));
  let token: string | undefined;
  try {
    const plain = new FakeDevice(`ws://127.0.0.1:${s1.port}`);
    await plain.opened();
    plain.hello();
    assert.equal((await plain.next('welcome')).trusted, false, 'loopback without pairing: connected but not trusted');
    plain.close();

    const d = new FakeDevice(`ws://127.0.0.1:${s1.port}`);
    await d.opened();
    d.hello({ pairingCode: s1.pairing.currentCode });
    const w = await d.next('welcome');
    assert.equal(w.trusted, true);
    token = w.deviceToken;
    assert.ok(token);
    d.close();
  } finally {
    await s1.close();
  }
  const store = readFileSync(join(dir, 'paired-devices.json'), 'utf8');
  assert.ok(!store.includes(token!), 'only a hash of the device token is stored');
  assert.equal(statSync(join(dir, 'paired-devices.json')).mode & 0o777, 0o600);

  const s2 = await startServer(options({ stateDir: dir, mcp: false, agentAvailable: { available: false } }));
  try {
    const again = new FakeDevice(`ws://127.0.0.1:${s2.port}`);
    await again.opened();
    again.hello({ token });
    assert.equal((await again.next('welcome')).trusted, true, 'still paired after a server restart (e.g. app reload)');

    const dropped = again.closed();
    const revoked = await fetch(`http://127.0.0.1:${s2.port}/api/pairing/revoke`, { method: 'POST', headers: authed(s2.token) });
    assert.equal(revoked.status, 200);
    assert.equal(await dropped, 4004, 'connected paired apps are disconnected so revocation applies immediately');
    const after = new FakeDevice(`ws://127.0.0.1:${s2.port}`);
    await after.opened();
    after.hello({ token });
    assert.equal((await after.next('welcome')).trusted, false, 'a revoked token no longer grants trust');
    after.close();
  } finally {
    await s2.close();
  }
});

test('--require-pairing makes simulators pair too', async () => {
  const s = await startServer(options({ requirePairing: true, mcp: false, agentAvailable: { available: false } }));
  try {
    const d = new FakeDevice(`ws://127.0.0.1:${s.port}`);
    await d.opened();
    d.hello();
    assert.equal((await d.next('auth.required')).pairing, true);
    d.hello({ pairingCode: s.pairing.currentCode });
    assert.equal((await d.next('welcome')).trusted, true);
    d.close();
  } finally {
    await s.close();
  }
});

test('approvals are only requested from paired devices', async () => {
  const fake = (trusted: boolean) => {
    const sent: ServerMessage[] = [];
    return { device: { trusted, send: (m: ServerMessage) => sent.push(m) } as unknown as DeviceSession, sent };
  };
  const approvals = new Approvals(1_000);

  const stranger = fake(false);
  assert.equal(await approvals.ask(stranger.device, 'Claude Code wants to use Bash', 'rm -rf build'), undefined);
  assert.equal(await approvals.approve(stranger.device, 'Allow code edit?', 'The agent wants to edit src/App.tsx.'), false);
  assert.deepEqual(stranger.sent.map((m) => m.type), ['chat.notice'], 'told why, never asked');
  assert.match((stranger.sent[0] as { text: string }).text, /Declined automatically: The agent wants to edit src\/App\.tsx\..*Pair this app/);

  const paired = fake(true);
  const pending = approvals.approve(paired.device, 'Allow code edit?', 'The agent wants to edit src/App.tsx.');
  const req = paired.sent.find((m) => m.type === 'approval.request') as Extract<ServerMessage, { type: 'approval.request' }>;
  assert.ok(req);
  approvals.answer(req.id, true);
  assert.equal(await pending, true);
});

test('agent credentials are never adopted from the environment without --auth', async () => {
  const verified: string[] = [];
  const verifyAuth = async (mode: string) => {
    verified.push(mode);
    return { ok: true, source: 'ANTHROPIC_API_KEY' };
  };
  const signIn = { status: async () => ({ loggedIn: false }), start: () => ({ done: new Promise<never>(() => {}), cancel() {} }) };
  const env = { ANTHROPIC_API_KEY: 'sk-ant-api03-not-chosen' };
  const implicit = await startServer(options({ mcp: false, env, signIn, verifyAuth, sessionFactory: () => undefined }));
  try {
    assert.equal(implicit.agent().available, false);
    assert.match(implicit.agent().reason ?? '', /Not signed in/);
    assert.match(implicit.authNotices.join('\n'), /ANTHROPIC_API_KEY is set .* --auth api-key/);
    assert.deepEqual(verified, [], 'the agent was never even started with it');
  } finally {
    await implicit.close();
  }
  const explicit = await startServer(options({ mcp: false, env, auth: 'api-key', signIn, verifyAuth, sessionFactory: () => undefined }));
  try {
    assert.equal(explicit.agent().available, true);
    assert.deepEqual(verified, ['api-key']);
  } finally {
    await explicit.close();
  }
  const missing = await startServer(options({ mcp: false, env: {}, auth: 'api-key', signIn, verifyAuth, sessionFactory: () => undefined }));
  try {
    assert.match(missing.agent().reason ?? '', /needs ANTHROPIC_API_KEY/);
  } finally {
    await missing.close();
  }
});

test('secrets never reach logs or the device', async () => {
  const secret = `sk-ant-api03-${'S3cr3t'.repeat(15)}`;
  const lines: string[] = [];
  const wire: string[] = [];
  const s = await startServer(
    options({
      mcp: false,
      env: { ANTHROPIC_API_KEY: secret },
      auth: 'api-key',
      log: (l) => lines.push(l),
      verifyAuth: async () => ({ ok: true, source: 'ANTHROPIC_API_KEY' }),
      sessionFactory: () => ({ busy: false, modelName: undefined, send: async () => {}, interrupt: async () => {}, close() {} }) as never,
    }),
  );
  try {
    const d = new FakeDevice(`ws://127.0.0.1:${s.port}`);
    d.ws.on('message', (data) => wire.push(String(data)));
    await d.opened();
    d.hello();
    const w = await d.next('welcome');
    assert.equal(w.server.agent.credentials, 'ANTHROPIC_API_KEY', 'the source is named, the value is not');
    d.send({ type: 'chat.send', id: 'm1', text: `my key is ${secret}, password=hunter2` });
    await new Promise((r) => setTimeout(r, 100));
    d.close();
  } finally {
    await s.close();
  }
  const all = [...lines, ...wire, ...s.authNotices].join('\n');
  assert.ok(lines.some((l) => l.includes('chat ←')), 'the chat line was logged');
  assert.ok(!all.includes(secret.slice(0, 24)), 'API key never logged or sent');
  assert.ok(!all.includes('hunter2'));
});

test('the picked element travels with the message; the app can switch the model', async () => {
  const sent: { text: string; context?: { selection?: string } }[] = [];
  const s = await startServer(
    options({
      mcp: false,
      agentAvailable: { available: true },
      sessionFactory: () =>
        ({ busy: false, modelName: undefined, send: async (text: string, _id: string, context?: { selection?: string }) => void sent.push({ text, context }), interrupt: async () => {}, close() {} }) as never,
    }),
  );
  try {
    const d = new FakeDevice(`ws://127.0.0.1:${s.port}`);
    await d.opened();
    d.hello();
    await d.next('welcome');
    d.send({ type: 'chat.send', id: 'm1', text: "Why doesn't this work?", context: { selection: 'e5 button "Log in" <PrimaryButton>' } });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(sent[0], { text: "Why doesn't this work?", context: { selection: 'e5 button "Log in" <PrimaryButton>' } });

    d.send({ type: 'chat.config', model: 'sonnet' });
    assert.equal((await d.next('welcome')).server.agent.model, 'sonnet');
    d.send({ type: 'chat.config' });
    assert.equal((await d.next('welcome')).server.agent.model, undefined, 'back to the server default');
    d.close();
  } finally {
    await s.close();
  }
});

test('MCP exposes inspect and audit backed by the device', async () => {
  const d = await connect();
  d.handlers.inspect = (p) => ({ text: `inspected ${JSON.stringify(p)}` });
  d.handlers.audit = () => ({ text: 'audit of Login: 1 finding(s)' });
  const post = async (body: unknown) =>
    (await (
      await fetch(`http://${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...authed() },
        body: JSON.stringify(body),
      })
    ).json()) as { result?: { content?: { text: string }[] } };
  await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  const a = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'mobile_inspect', arguments: { target: '#login-submit' } } });
  assert.equal(a.result?.content?.[0]?.text, 'inspected {"target":"#login-submit"}');
  const sel = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'mobile_inspect', arguments: {} } });
  assert.equal(sel.result?.content?.[0]?.text, 'inspected {}', 'no target: the developer\'s selection');
  const pt = await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'mobile_inspect', arguments: { x: 10, y: 20 } } });
  assert.equal(pt.result?.content?.[0]?.text, 'inspected {"point":{"x":10,"y":20}}');
  const au = await post({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'mobile_audit_screen', arguments: {} } });
  assert.match(au.result?.content?.[0]?.text ?? '', /audit of Login/);
  d.close();
});
