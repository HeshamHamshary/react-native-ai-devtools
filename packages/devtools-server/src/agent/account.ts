import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { redactText } from 'react-native-agent-devtools-protocol';

/**
 * Claude Code config directory used only by the in-app agent. Because it is not the
 * developer's own ~/.claude, the agent never inherits their personal claude.ai login,
 * settings or plugins. The only login it ever holds is the Anthropic Console sign-in
 * started from the app (`claude auth login --console`).
 */
export function agentConfigDir(env = process.env): string {
  const dir = join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'react-native-agent-devtools', 'claude');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Personal subscription tokens are never acceptable, and a selected `ant` profile would bypass the check. */
const STRIPPED_ENV = ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'ANTHROPIC_PROFILE'];

/** Environment for every Claude Code process the server starts (sessions, sign-in, status). */
export function agentEnv(env = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string' && !STRIPPED_ENV.includes(k)) out[k] = v;
  const dir = agentConfigDir(env);
  out.CLAUDE_CONFIG_DIR = dir;
  // Ignore `ant auth login` profiles too, so the credential source is always one we can check.
  out.ANTHROPIC_CONFIG_DIR = join(dir, 'anthropic-profiles');
  return out;
}

/** Credentials configured in the server's own environment take precedence over the sign-in. */
export function hasEnvCredentials(env = process.env): boolean {
  return !!env.ANTHROPIC_API_KEY || ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].some((k) => env[k] === '1');
}

/** The Claude Code binary bundled with the Agent SDK, so sign-in and sessions share one version. */
export function claudeBinary(): string | undefined {
  const req = createRequire(import.meta.resolve('@anthropic-ai/claude-agent-sdk'));
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  for (const pkg of [`claude-agent-sdk-${process.platform}-${process.arch}`, `claude-agent-sdk-${process.platform}-${process.arch}-musl`]) {
    try {
      const path = req.resolve(`@anthropic-ai/${pkg}/${exe}`);
      if (existsSync(path)) return path;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

export interface SignInResult {
  ok: boolean;
  reason?: string;
}

export interface SignInHandle {
  done: Promise<SignInResult>;
  cancel(): void;
}

export interface SignInBackend {
  /** Whether the agent's Claude Code config has a login (local check, no model call). */
  status(): Promise<{ loggedIn: boolean }>;
  /** Start Anthropic Console sign-in in the computer's default browser. */
  start(log: (line: string) => void): SignInHandle;
}

const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

/** Sign-in through Claude Code's documented `claude auth login --console` (API usage billing). */
export const claudeCodeSignIn: SignInBackend = {
  status() {
    const bin = claudeBinary();
    if (!bin) return Promise.resolve({ loggedIn: false });
    return new Promise((resolve) => {
      // Exits 1 when signed out; the JSON on stdout is authoritative either way.
      execFile(bin, ['auth', 'status', '--json'], { env: agentEnv(), timeout: 15_000 }, (_err, stdout) => {
        try {
          resolve({ loggedIn: (JSON.parse(stdout) as { loggedIn?: unknown }).loggedIn === true });
        } catch {
          resolve({ loggedIn: false });
        }
      });
    });
  },

  start(log) {
    const bin = claudeBinary();
    if (!bin) {
      return {
        done: Promise.resolve({ ok: false, reason: 'The Claude Code binary bundled with the Agent SDK is missing. Reinstall dependencies without --omit=optional.' }),
        cancel() {},
      };
    }
    // stdin stays open so the CLI keeps waiting for the browser callback.
    const child = spawn(bin, ['auth', 'login', '--console'], { env: agentEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      output = (output + text).slice(-4_000);
      // The CLI's own fallback URL ends in a code to paste, which only works interactively.
      if (/didn't open/i.test(text)) log("if no browser opened, run `react-native-agent-devtools-server login` in a terminal instead");
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    let cancelled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, SIGN_IN_TIMEOUT_MS);
    const done = new Promise<SignInResult>((resolve) => {
      child.on('error', (e) => resolve({ ok: false, reason: `Could not start sign-in: ${e.message}` }));
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) return resolve({ ok: true });
        if (cancelled) return resolve({ ok: false, reason: 'Sign-in cancelled.' });
        if (timedOut) return resolve({ ok: false, reason: 'Sign-in timed out. Tap Set up Claude to try again.' });
        const error = output.split('\n').reverse().find((l) => /error|fail|denied|invalid|not allowed/i.test(l));
        resolve({ ok: false, reason: error ? redactText(error.trim()).slice(0, 200) : 'Sign-in did not complete. Tap Set up Claude to try again.' });
      });
    });
    return {
      done,
      cancel() {
        cancelled = true;
        child.kill();
      },
    };
  },
};

/** Remove the agent's sign-in (`claude auth logout` in the agent's config dir). */
export function signOut(): Promise<boolean> {
  const bin = claudeBinary();
  if (!bin) return Promise.resolve(false);
  return new Promise((resolve) => execFile(bin, ['auth', 'logout'], { env: agentEnv(), timeout: 15_000 }, (err) => resolve(!err)));
}
