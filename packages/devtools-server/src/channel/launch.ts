import { execFile, spawn } from 'node:child_process';
import { CHANNEL_SERVER_NAME, CHAT_ENV } from './bridge.ts';

/** Channel registration and permission relay behave as documented from this version on. */
export const MIN_CLAUDE_CODE = [2, 1, 234] as const;

export interface LaunchOptions {
  port: number;
  /** The server's local API token (from the token file). */
  token: string | undefined;
  /** Project directory Claude Code runs in (the bridge is registered for it, local scope). */
  cwd: string;
  /** Command that starts the bridge, e.g. [node, cli.js, 'channel', '--port', '8765']. */
  bridgeCommand: string[];
  /** Extra arguments passed through to `claude`. */
  claudeArgs: string[];
  log: (line: string) => void;
  /** For tests. */
  claudeBin?: string;
}

function run(bin: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { cwd, timeout: 30_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 127) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export function parseVersion(text: string): number[] | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

export function atLeast(v: readonly number[], min: readonly number[]): boolean {
  for (let i = 0; i < min.length; i++) {
    if ((v[i] ?? 0) !== min[i]) return (v[i] ?? 0) > min[i]!;
  }
  return true;
}

/**
 * Start the developer's own Claude Code with the app chat connected as a channel.
 * Everything model-related happens inside that Claude Code session, on its login.
 */
export async function launchClaudeCode(opts: LaunchOptions): Promise<number> {
  const bin = opts.claudeBin ?? 'claude';
  const { cwd, log } = opts;

  const versionOut = await run(bin, ['--version'], cwd);
  const version = versionOut.code === 0 ? parseVersion(versionOut.stdout) : undefined;
  if (!version) throw new Error('Claude Code (`claude`) was not found on your PATH. Install it first: https://code.claude.com/docs/en/quickstart');
  if (!atLeast(version, MIN_CLAUDE_CODE)) {
    throw new Error(`Claude Code ${version.join('.')} is too old for channels (needs ${MIN_CLAUDE_CODE.join('.')} or later). Update it with \`claude update\` and run this again.`);
  }

  const health = await fetch(`http://127.0.0.1:${opts.port}/health`).catch(() => undefined);
  if (!health?.ok) throw new Error(`The devtools server isn't running on port ${opts.port}. Start it first: react-native-agent-devtools-server`);

  // Register the bridge for this project (local scope: private to you, this directory only).
  const script = opts.bridgeCommand.find((a) => a.endsWith('.ts') || a.endsWith('.js'));
  const existing = await run(bin, ['mcp', 'get', CHANNEL_SERVER_NAME], cwd);
  const ours = existing.code === 0 && existing.stdout.includes('channel');
  if (existing.code === 0 && !ours) {
    throw new Error(
      `Claude Code already has an MCP server named "${CHANNEL_SERVER_NAME}" in this project (probably the HTTP endpoint). ` +
        `Remove it with \`claude mcp remove ${CHANNEL_SERVER_NAME}\` and run this again; the channel provides the same tools.`,
    );
  }
  const current = ours && (!script || existing.stdout.includes(script));
  if (!current) {
    if (ours) {
      await run(bin, ['mcp', 'remove', CHANNEL_SERVER_NAME, '-s', 'local'], cwd);
      log(`updating the "${CHANNEL_SERVER_NAME}" channel registration for this project`);
    }
    const added = await run(bin, ['mcp', 'add', CHANNEL_SERVER_NAME, '-s', 'local', '--', ...opts.bridgeCommand], cwd);
    if (added.code !== 0) throw new Error(`Could not register the channel with Claude Code: ${(added.stderr || added.stdout).trim()}`);
    log(`registered the "${CHANNEL_SERVER_NAME}" channel for ${cwd} (claude mcp add, local scope)`);
  }

  // Let the bridge this session starts claim the app chat (and only that one).
  const armed = await fetch(`http://127.0.0.1:${opts.port}/api/channel/arm`, {
    method: 'POST',
    headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
  }).catch(() => undefined);
  if (!armed?.ok) throw new Error(`The devtools server refused to connect the app chat (${armed ? `HTTP ${armed.status}` : 'unreachable'}). Restart it and run this again.`);

  log('starting Claude Code with the app chat connected. Confirm the development-channel prompt it shows.');
  const child = spawn(
    bin,
    ['--dangerously-load-development-channels', `server:${CHANNEL_SERVER_NAME}`, '--allowedTools', `mcp__${CHANNEL_SERVER_NAME}`, ...opts.claudeArgs],
    { cwd, stdio: 'inherit', env: { ...process.env, [CHAT_ENV]: '1' } },
  );
  return new Promise((resolve) => {
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}
