import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { networkInterfaces } from 'node:os';
import { startServer, type RunningServer } from './server.ts';
import { FakeDevice } from './testing/FakeDevice.ts';

let server: RunningServer;
let base: string;
const logs: string[] = [];

before(async () => {
  server = await startServer({
    port: 0,
    lan: false,
    repoRoots: [],
    allowEdits: false,
    agent: true,
    mcp: true,
    loadProjectSettings: false,
    log: (l) => logs.push(l),
    agentAvailable: { available: false, reason: 'no credentials (test)' },
  });
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

const rpc = async (method: string, params: unknown = {}, timeoutMs?: number) =>
  (await (
    await fetch(`http://${base}/api/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
  const bad = await (await fetch(`http://${base}/api/rpc`, { method: 'POST', body: JSON.stringify({ method: 'eval' }) })).json();
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
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
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
  const lan = await startServer({
    port: 0,
    lan: true,
    repoRoots: [],
    allowEdits: false,
    agent: false,
    mcp: false,
    loadProjectSettings: false,
    log: () => {},
    agentAvailable: { available: false },
  });
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
    const res = await fetch(`http://${lanIp}:${lan.port}/api/devices`);
    assert.equal(res.status, 403);
    b.close();
  } finally {
    await lan.close();
  }
});

test('"Set up Claude" runs Anthropic sign-in on the computer and enables the agent live', async () => {
  const savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  let loggedIn = false;
  let starts = 0;
  let finish: (r: { ok: boolean; reason?: string }) => void = () => {};
  const s = await startServer({
    port: 0,
    lan: false,
    repoRoots: [],
    allowEdits: false,
    agent: true,
    mcp: false,
    loadProjectSettings: false,
    log: () => {},
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
    verifyAuth: async () => (loggedIn ? { ok: true, source: '/login managed key' } : { ok: false, source: 'none', reason: 'no login' }),
    sessionFactory: () => undefined,
  });
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
    assert.equal(s.agent().source, '/login managed key');
    assert.equal(d.inbox.filter((m) => m.type === 'setup.status').length, 0, 'no failure from the cancelled attempt');
    d.close();
  } finally {
    if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
    await s.close();
  }
});
