import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { networkInterfaces } from 'node:os';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, type ServerMessage } from 'react-native-agent-devtools-protocol';
import { startServer, type RunningServer } from './server.ts';

/** Minimal fake device speaking the real protocol. */
class FakeDevice {
  ws: WebSocket;
  inbox: ServerMessage[] = [];
  private waiters: ((m: ServerMessage) => void)[] = [];
  handlers: Record<string, (params: unknown) => unknown> = {};

  constructor(url: string, headers: Record<string, string> = {}) {
    this.ws = new WebSocket(url, { headers });
    this.ws.on('message', (data) => {
      const m = JSON.parse(String(data)) as ServerMessage;
      if (m.type === 'rpc.call') {
        const h = this.handlers[m.method];
        if (h === undefined) return; // simulate an unresponsive device
        try {
          this.send({ type: 'rpc.result', id: m.id, ok: true, result: h(m.params), deviceMs: 3 });
        } catch (e) {
          this.send({ type: 'rpc.result', id: m.id, ok: false, error: { code: 'NOT_FOUND', message: String((e as Error).message) } });
        }
        return;
      }
      this.inbox.push(m);
      this.waiters.splice(0).forEach((w) => w(m));
    });
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
      this.ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
  }

  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }

  hello(auth?: { token?: string; pairingCode?: string }) {
    this.send({
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      device: { platform: 'ios', osVersion: '26.0', libraryVersion: '0.1.0', window: { width: 402, height: 874, scale: 3 }, appName: 'Test' },
      capabilities: { tap: { supported: true, mode: 'semantic' } },
      ...(auth ? { auth } : {}),
    });
  }

  async next<T extends ServerMessage['type']>(type: T, timeoutMs = 3_000): Promise<Extract<ServerMessage, { type: T }>> {
    const found = this.inbox.find((m) => m.type === type);
    if (found) {
      this.inbox.splice(this.inbox.indexOf(found), 1);
      return found as Extract<ServerMessage, { type: T }>;
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
      const w = (m: ServerMessage): void => {
        if (m.type !== type) {
          this.waiters.push(w);
          return;
        }
        clearTimeout(t);
        this.inbox.splice(this.inbox.indexOf(m), 1);
        resolve(m as Extract<ServerMessage, { type: T }>);
      };
      this.waiters.push(w);
    });
  }

  closed(): Promise<number> {
    return new Promise((r) => this.ws.once('close', (code) => r(code)));
  }

  close() {
    this.ws.close();
  }
}

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
