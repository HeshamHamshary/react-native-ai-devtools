import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startServer, type RunningServer } from '../server.ts';
import { FakeDevice } from '../testing/FakeDevice.ts';
import { atLeast, launchClaudeCode, parseVersion } from './launch.ts';

// Everything here is local: a fake app, and a fake "Claude Code" (an MCP client)
// that starts the real bridge over stdio. Nothing talks to Anthropic.

const CLI = fileURLToPath(new URL('../cli.ts', import.meta.url));

async function until<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 5_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

let server: RunningServer;
let base: string;
/** The bridge finds the server token under $XDG_CONFIG_HOME, like it would in ~/.config. */
const xdg = mkdtempSync(join(tmpdir(), 'rnad-xdg-'));
const stateDir = join(xdg, 'react-native-agent-devtools');
mkdirSync(stateDir);

before(async () => {
  server = await startServer({ port: 0, lan: false, repoRoots: [], allowEdits: false, agent: false, mcp: false, log: () => {}, stateDir, env: {} });
  base = `127.0.0.1:${server.port}`;
});

function startBridge(command: 'channel' | 'mcp', extraEnv: Record<string, string> = {}) {
  const client = new Client({ name: 'fake-claude-code', version: '0.0.0' }, { capabilities: {} });
  const env = { ...(process.env as Record<string, string>), XDG_CONFIG_HOME: xdg, ...extraEnv };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--conditions=react-native-agent-devtools-source', CLI, command, '--port', String(server.port)],
    env,
    stderr: 'ignore',
  });
  return { client, connect: () => client.connect(transport) };
}

const authed = { authorization: '' };

after(async () => {
  await server.close();
});

test('the bridge speaks the channel contract and routes the app chat through Claude Code', async () => {
  const d = new FakeDevice(`ws://${base}`);
  await d.opened();
  d.hello({ pairingCode: server.pairing.currentCode });
  const first = await d.next('welcome');
  assert.equal(first.server.agent.available, false);
  assert.equal(first.trusted, true, 'paired, so it may answer Claude Code permission prompts');
  d.handlers.getScreen = () => ({ text: 'Login screen: email field e3, password field e4, Log in button e5' });
  d.handlers.tap = () => ({ ok: true, mode: 'semantic', durationMs: 5, changes: {} });

  const notes: { method: string; params?: Record<string, unknown> }[] = [];
  const { client, connect } = startBridge('channel', { RNAD_CHANNEL_CHAT: '1' });
  client.fallbackNotificationHandler = async (n) => {
    notes.push(n as never);
  };
  await connect();
  try {
    // Capabilities and tools Claude Code looks for.
    const caps = client.getServerCapabilities();
    assert.deepEqual(caps?.experimental?.['claude/channel'], {});
    assert.deepEqual(caps?.experimental?.['claude/channel/permission'], {});
    assert.match(client.getInstructions() ?? '', /reply tool/);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(tools.includes('reply') && tools.includes('mobile_get_screen') && tools.includes('mobile_tap'));

    // Connecting switches the app chat to Claude Code without the app reconnecting.
    const w = await d.next('welcome');
    assert.equal(w.server.agent.available, true);
    assert.equal(w.server.agent.via, 'claude-code');

    // App message -> channel event with an app_state snapshot and a chat_id.
    d.send({ type: 'chat.send', id: 'u1', text: 'What screen am I on?' });
    assert.equal((await d.next('chat.status')).state, 'thinking');
    const event = await until(() => notes.find((n) => n.method === 'notifications/claude/channel'));
    const meta = event.params?.meta as Record<string, string>;
    assert.equal(meta.chat_id, 'u1');
    assert.equal(meta.platform, 'ios');
    assert.match(String(event.params?.content), /<app_state[\s\S]*Login screen[\s\S]*<\/app_state>\s+What screen am I on\?$/);

    // A picked element rides along with the message.
    d.send({ type: 'chat.send', id: 'u1b', text: 'Why?', context: { selection: 'e5 button "Log in"' } });
    // (the first turn is still open; this one is refused as busy)
    assert.equal((await d.next('chat.error')).code, 'BUSY');

    // Tool calls run on the device that asked and show up as tool rows.
    const shot = await client.callTool({ name: 'mobile_get_screen', arguments: {} });
    assert.match(JSON.stringify(shot.content), /Login screen/);
    assert.equal((await d.next('chat.tool')).phase, 'start');
    assert.equal((await d.next('chat.tool')).phase, 'end');

    // reply -> the answer in the app, and the turn ends.
    const sent = await client.callTool({ name: 'reply', arguments: { chat_id: 'u1', text: "You're on the **Login** screen." } });
    assert.equal(sent.isError, undefined);
    assert.equal((await d.next('chat.text')).text, "You're on the **Login** screen.");
    const done = await d.next('chat.done');
    assert.equal(done.ok, true);
    assert.equal(done.stats?.toolCalls, 1);

    // Claude Code's permission prompt -> approved on the device -> verdict back.
    await client.notification({
      method: 'notifications/claude/channel/permission_request',
      params: { request_id: 'abcde', tool_name: 'Bash', description: 'List files', input_preview: '{"command":"ls"}' },
    } as never);
    const ask = await d.next('approval.request');
    assert.match(ask.title, /Claude Code wants to use Bash/);
    d.send({ type: 'approval.response', id: ask.id, approved: true });
    const verdict = await until(() => notes.find((n) => n.method === 'notifications/claude/channel/permission'));
    assert.deepEqual(verdict.params, { request_id: 'abcde', behavior: 'allow' });

    // Stop: Claude Code is told, the turn ends, and app control is refused until the next message.
    d.send({ type: 'chat.send', id: 'u2', text: 'Log in with test@example.com' });
    await until(() => notes.filter((n) => n.method === 'notifications/claude/channel').length === 2);
    d.send({ type: 'chat.cancel' });
    assert.match((await d.next('chat.done')).error ?? '', /Stopped/);
    const stopNote = await until(() => notes.find((n) => (n.params?.meta as { kind?: string } | undefined)?.kind === 'stop'));
    assert.match(String(stopNote.params?.content), /pressed Stop/);
    const refused = await client.callTool({ name: 'mobile_tap', arguments: { target: 'e5' } });
    assert.equal(refused.isError, true);
    assert.match(JSON.stringify(refused.content), /pressed Stop/);
    const read = await client.callTool({ name: 'mobile_get_screen', arguments: {} });
    assert.notEqual(read.isError, true, 'reading the screen still works after Stop');
  } finally {
    await client.close();
  }

  // Claude Code exiting hands the chat back.
  const w3 = await d.next('welcome');
  assert.equal(w3.server.agent.via, undefined);
  assert.equal(w3.server.agent.available, false);
  d.close();
});

test('an unpaired app is told to answer Claude Code permission prompts in the terminal', async () => {
  const d = new FakeDevice(`ws://${base}`);
  await d.opened();
  d.hello();
  assert.equal((await d.next('welcome')).trusted, false);
  const notes: { method: string; params?: Record<string, unknown> }[] = [];
  const { client, connect } = startBridge('channel', { RNAD_CHANNEL_CHAT: '1' });
  client.fallbackNotificationHandler = async (n) => {
    notes.push(n as never);
  };
  await connect();
  try {
    await d.next('welcome');
    d.handlers.getScreen = () => ({ text: 'Home' });
    d.send({ type: 'chat.send', id: 'u9', text: 'Run the tests' });
    await until(() => notes.find((n) => n.method === 'notifications/claude/channel'));
    await client.notification({
      method: 'notifications/claude/channel/permission_request',
      params: { request_id: 'fghij', tool_name: 'Bash', description: 'Run tests', input_preview: '{"command":"yarn test"}' },
    } as never);
    const notice = await d.next('chat.notice');
    assert.match(notice.text, /Claude Code is asking to use Bash .*Answer in your Claude Code terminal/);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(d.inbox.filter((m) => m.type === 'approval.request').length, 0, 'never asked on an unpaired device');
    assert.equal(notes.filter((n) => n.method === 'notifications/claude/channel/permission').length, 0, 'no verdict sent: the terminal prompt decides');
  } finally {
    await client.close();
  }
  await d.next('welcome');
  d.close();
});

test('`mcp` is a plain stdio MCP server: mobile tools, no channel', async () => {
  const d = new FakeDevice(`ws://${base}`);
  await d.opened();
  d.hello();
  await d.next('welcome');
  d.handlers.getScreen = () => ({ text: 'Settings screen' });
  const { client, connect } = startBridge('mcp');
  await connect();
  try {
    assert.equal(client.getServerCapabilities()?.experimental?.['claude/channel'], undefined);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(tools.includes('mobile_get_screen') && !tools.includes('reply'));
    const out = await until(async () => {
      const r = await client.callTool({ name: 'mobile_get_screen', arguments: {} });
      return /Settings screen/.test(JSON.stringify(r.content)) && r;
    });
    assert.ok(out);
  } finally {
    await client.close();
    d.close();
  }
});

test('the channel socket requires the server token', async () => {
  const status = await new Promise<number>((resolve) => {
    const ws = new WebSocket(`ws://${base}/channel`);
    ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.once('open', () => resolve(101));
  });
  assert.equal(status, 401);
});

test('a Claude Code session not started by the launcher only gets the tools', async () => {
  authed.authorization = `Bearer ${server.token}`;
  const ws = new WebSocket(`ws://${base}/channel`, { headers: authed });
  const inbox: Record<string, unknown>[] = [];
  ws.on('message', (data) => inbox.push(JSON.parse(String(data)) as Record<string, unknown>));
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ type: 'hello', chat: false }));
  assert.equal((await until(() => inbox.find((m) => m.type === 'welcome'))).chat, false);
  assert.equal(server.agent().via, undefined);
  ws.send(JSON.stringify({ type: 'reply', id: 'r1', chatId: 'u1', text: 'hi' }));
  const r = await until(() => inbox.find((m) => m.type === 'reply.result'));
  assert.equal(r.ok, false);
  ws.close();
});

test('a web page cannot open the channel socket', async () => {
  const ws = new WebSocket(`ws://${base}/channel`, { headers: { origin: 'https://evil.example' } });
  const status = await new Promise<number>((resolve) => {
    ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.once('open', () => resolve(101));
  });
  assert.equal(status, 403);
});

test('the launcher checks the version, registers the bridge and starts Claude Code with the channel flags', async () => {
  // A fake `claude` that records its arguments; the real one is never run.
  const dir = mkdtempSync(join(tmpdir(), 'rnad-fake-claude-'));
  const log = join(dir, 'calls.log');
  const fake = join(dir, 'claude');
  writeFileSync(
    fake,
    `#!/bin/sh\necho "$* | chat=$RNAD_CHANNEL_CHAT" >> "${log}"\ncase "$1" in\n  --version) echo "$FAKE_CLAUDE_VERSION (Claude Code)";;\n  mcp) [ "$2" = get ] && exit 1;;\nesac\nexit 0\n`,
  );
  chmodSync(fake, 0o755);
  const opts = { port: server.port, token: server.token, cwd: dir, bridgeCommand: ['/usr/bin/node', '/x/cli.js', 'channel', '--port', String(server.port)], claudeArgs: ['--model', 'sonnet'], log: () => {}, claudeBin: fake };

  process.env.FAKE_CLAUDE_VERSION = '2.1.71';
  await assert.rejects(launchClaudeCode(opts), /too old for channels/);

  process.env.FAKE_CLAUDE_VERSION = '2.1.306';
  assert.equal(await launchClaudeCode(opts), 0);
  const calls = readFileSync(log, 'utf8').trim().split('\n');
  assert.ok(calls.includes(`mcp add rn-agent -s local -- /usr/bin/node /x/cli.js channel --port ${server.port} | chat=`));
  assert.equal(calls.at(-1), '--dangerously-load-development-channels server:rn-agent --allowedTools mcp__rn-agent --model sonnet | chat=1');
  delete process.env.FAKE_CLAUDE_VERSION;

  // The launcher armed the server: the next bridge to say hello carries the chat.
  const ws = new WebSocket(`ws://${base}/channel`, { headers: { authorization: `Bearer ${server.token}` } });
  const inbox: Record<string, unknown>[] = [];
  ws.on('message', (data) => inbox.push(JSON.parse(String(data)) as Record<string, unknown>));
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ type: 'hello', chat: false }));
  assert.equal((await until(() => inbox.find((m) => m.type === 'welcome'))).chat, true);
  ws.close();
  await until(() => server.agent().via === undefined);
});

test('version comparison', () => {
  assert.deepEqual(parseVersion('2.1.306 (Claude Code)'), [2, 1, 306]);
  assert.ok(atLeast([2, 1, 306], [2, 1, 234]));
  assert.ok(atLeast([2, 1, 234], [2, 1, 234]));
  assert.ok(!atLeast([2, 1, 71], [2, 1, 234]));
  assert.ok(atLeast([3, 0, 0], [2, 1, 234]));
});
