#!/usr/bin/env node
import { existsSync, statSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { SERVER_VERSION, startServer } from './server.ts';

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  orange: (s: string) => `\x1b[38;5;173m${s}\x1b[0m`,
};

const HELP = `react-native-agent-devtools-server ${SERVER_VERSION}

Usage:
  react-native-agent-devtools-server [start] [options]   Run the bridge (default)
  react-native-agent-devtools-server call <method> [json-params] [--device ios|android|<id>]
                                                         Invoke a device RPC on the connected app
  react-native-agent-devtools-server bench [--iterations N] [--port N]
                                                         Measure device-side latency (no model)
  react-native-agent-devtools-server devices [--port N]  List connected apps

Options:
  --port <n>             Port (default 8765)
  --lan                  Listen on all interfaces for physical devices (pairing code required)
  --repo <path>          Let the agent read this source tree (secrets excluded). Repeatable.
  --allow-edits          Allow Edit/Write inside --repo roots, each approved on the device
  --model <id>           Model for the in-app agent (default: SDK default)
  --no-agent             Disable the in-app chat agent (MCP and RPC still work)
  --no-mcp               Disable the /mcp endpoint for Claude Code
  --load-project-settings  Load CLAUDE.md / .claude settings from the repo
  --demo-agent           Scripted replies (labelled, no model) for UI development
  -h, --help

The in-app chat uses the Claude Agent SDK and needs ANTHROPIC_API_KEY (or Bedrock/Vertex
credentials) in this process's environment. To drive the app from Claude Code instead:
  claude mcp add --transport http rn-agent http://127.0.0.1:8765/mcp
`;

function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i): i is NonNullable<typeof i> => !!i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

let deviceSelector: string | undefined;

async function rpc(port: number, method: string, params: unknown): Promise<{ ok: boolean; result?: unknown; deviceMs?: number; rttMs?: number; error?: { code: string; message: string } }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params, timeoutMs: 90_000, ...(deviceSelector ? { device: deviceSelector } : {}) }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as never;
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith('-') ? argv.shift()! : 'start';
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      port: { type: 'string', default: '8765' },
      lan: { type: 'boolean', default: false },
      repo: { type: 'string', multiple: true },
      'allow-edits': { type: 'boolean', default: false },
      model: { type: 'string' },
      'no-agent': { type: 'boolean', default: false },
      'no-mcp': { type: 'boolean', default: false },
      'load-project-settings': { type: 'boolean', default: false },
      'demo-agent': { type: 'boolean', default: false },
      iterations: { type: 'string', default: '20' },
      device: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  const port = Number(values.port);
  deviceSelector = values.device;

  if (command === 'call') {
    const [method, raw] = positionals;
    if (!method) throw new Error('usage: call <method> [json-params]');
    const r = await rpc(port, method, raw ? JSON.parse(raw) : {});
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    process.exitCode = r.ok ? 0 : 1;
    return;
  }

  if (command === 'devices') {
    const res = await fetch(`http://127.0.0.1:${port}/api/devices`);
    process.stdout.write(`${JSON.stringify(await res.json(), null, 2)}\n`);
    return;
  }

  if (command === 'bench') {
    const n = Number(values.iterations);
    const ops: [string, string, unknown][] = [
      ['getScreen', 'getScreen', {}],
      ['getUI', 'getUI', {}],
      ['screenshot', 'screenshot', { maxWidth: 720 }],
      ['getLogs', 'getLogs', { limit: 20 }],
    ];
    const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] ?? 0;
    process.stdout.write(`benchmarking ${n} iterations per op against the active device…\n`);
    const rows: string[] = [];
    for (const [label, method, params] of ops) {
      const dev: number[] = [];
      const rtt: number[] = [];
      const wall: number[] = [];
      let size = 0;
      for (let i = 0; i < n; i++) {
        const t0 = performance.now();
        const r = await rpc(port, method, params);
        wall.push(performance.now() - t0);
        if (!r.ok) throw new Error(`${method}: ${r.error?.message}`);
        dev.push(r.deviceMs ?? 0);
        rtt.push(r.rttMs ?? 0);
        size = JSON.stringify(r.result).length;
      }
      rows.push(
        `${label.padEnd(11)} device p50 ${String(Math.round(pct(dev, 50))).padStart(4)}ms p95 ${String(Math.round(pct(dev, 95))).padStart(4)}ms · ws round trip p50 ${String(Math.round(pct(rtt, 50))).padStart(4)}ms p95 ${String(Math.round(pct(rtt, 95))).padStart(4)}ms · payload ${(size / 1024).toFixed(1)}KB`,
      );
    }
    process.stdout.write(`${rows.join('\n')}\n`);
    return;
  }

  if (command !== 'start') throw new Error(`unknown command ${command}\n\n${HELP}`);

  const repoRoots = (values.repo ?? []).map((r) => resolve(r));
  for (const r of repoRoots) {
    if (!existsSync(r) || !statSync(r).isDirectory()) throw new Error(`--repo ${r} is not a directory`);
  }
  const log = (line: string) => process.stdout.write(`${c.dim(new Date().toISOString().slice(11, 19))} ${line}\n`);
  const server = await startServer({
    port,
    lan: values.lan === true,
    repoRoots,
    allowEdits: values['allow-edits'] === true,
    ...(values.model ? { model: values.model } : {}),
    agent: !values['no-agent'],
    mcp: !values['no-mcp'],
    loadProjectSettings: values['load-project-settings'] === true,
    demoAgent: values['demo-agent'] === true,
    log,
  });

  const avail = server.agent();
  const out: string[] = [
    '',
    `${c.orange('✦')} ${c.bold('react-native-agent-devtools-server')} ${c.dim(`v${SERVER_VERSION}`)}`,
    '',
    `  ${c.bold('listening')}    ws://${values.lan ? '0.0.0.0' : '127.0.0.1'}:${server.port} ${c.dim(values.lan ? '(all interfaces)' : '(loopback only)')}`,
    `  ${c.bold('simulators')}   iOS simulator and Android emulator connect automatically via the Metro host`,
    `               ${c.dim(`USB Android: adb reverse tcp:${server.port} tcp:${server.port}`)}`,
    `  ${c.bold('agent')}        ${avail.available ? c.green('ready') + c.dim(` (credentials: ${avail.source}${values.model ? `, model ${values.model}` : ''})`) : c.yellow(`not configured — open http://127.0.0.1:${server.port}/setup (or tap "Set up Claude" in the app)`)}`,
    `  ${c.bold('repo access')}  ${repoRoots.length ? `read${values['allow-edits'] ? ' + approved edits' : '-only'}: ${repoRoots.join(', ')} ${c.dim('(secret files always excluded)')}` : c.dim('disabled (use --repo <path>)')}`,
    `  ${c.bold('Claude Code')}  ${values['no-mcp'] ? c.dim('MCP disabled') : `claude mcp add --transport http rn-agent http://127.0.0.1:${server.port}/mcp`}`,
  ];
  if (values.lan) {
    out.push(
      '',
      c.yellow('  ⚠ LAN mode: the server is reachable from your network. Devices must pair; control APIs stay loopback-only.'),
      `  ${c.bold('pairing code')} ${c.orange(server.pairing.currentCode)} ${c.dim('(single use, rotates after pairing, expires in 10 min)')}`,
      `  ${c.bold('device URL')}   ${lanAddresses().map((a) => `ws://${a}:${server.port}`).join('  ') || '(no LAN address found)'}`,
    );
  }
  out.push('');
  process.stdout.write(out.join('\n') + '\n');

  const shutdown = async () => {
    log('shutting down');
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  process.stderr.write(`${c.red('error')} ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
