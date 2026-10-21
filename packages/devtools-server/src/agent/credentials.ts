import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AccountInfo, Settings } from '@anthropic-ai/claude-agent-sdk';

/**
 * How the in-app agent authenticates. Always an explicit choice (`--auth`, or the
 * Console sign-in started from the app); never inferred from whatever credentials
 * happen to be in the developer's shell.
 */
export type AuthMode = 'console' | 'api-key' | 'bedrock' | 'vertex' | 'foundry';

export const AUTH_MODES: readonly AuthMode[] = ['console', 'api-key', 'bedrock', 'vertex', 'foundry'];

export const isAuthMode = (v: unknown): v is AuthMode => typeof v === 'string' && (AUTH_MODES as readonly string[]).includes(v);

const CLOUD: Partial<Record<AuthMode, { flag: string; label: string }>> = {
  bedrock: { flag: 'CLAUDE_CODE_USE_BEDROCK', label: 'Amazon Bedrock' },
  vertex: { flag: 'CLAUDE_CODE_USE_VERTEX', label: 'Google Vertex AI' },
  foundry: { flag: 'CLAUDE_CODE_USE_FOUNDRY', label: 'Microsoft Foundry' },
};

const LABEL: Record<AuthMode, string> = {
  console: 'Anthropic Console sign-in',
  'api-key': 'ANTHROPIC_API_KEY',
  bedrock: 'Amazon Bedrock',
  vertex: 'Google Vertex AI',
  foundry: 'Microsoft Foundry',
};

export const authLabel = (mode: AuthMode): string => LABEL[mode];

/** Everything the tool keeps on the developer's machine lives here (mode 0700). */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'react-native-agent-devtools');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Claude Code config directory used only by the in-app agent. Because it is not the
 * developer's own ~/.claude, the agent never inherits their personal login, settings,
 * plugins or hooks. The only login it can hold is the Console sign-in started from
 * the app, and its user settings pin sign-in to the Console.
 */
export function agentConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = join(stateDir(env), 'claude');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const settings = join(dir, 'settings.json');
  if (!existsSync(settings)) writeFileSync(settings, `${JSON.stringify({ forceLoginMethod: 'console' }, null, 2)}\n`, { mode: 0o600 });
  return dir;
}

/**
 * Variables that select or carry credentials for Claude Code. All of them are removed
 * from the agent's environment, then only the ones the chosen mode needs are put back.
 * Matching by prefix keeps this safe when Claude Code adds new credential variables.
 */
const AMBIENT_AUTH = /^(ANTHROPIC_|CLAUDE|AWS_BEARER_TOKEN_)/;
const MODEL_VARS = /^ANTHROPIC_(MODEL|SMALL_FAST_MODEL|SMALL_FAST_MODEL_AWS_REGION|DEFAULT_[A-Z]+_MODEL)$/;
const MODE_VARS: Record<AuthMode, RegExp[]> = {
  console: [],
  'api-key': [],
  bedrock: [/^CLAUDE_CODE_USE_BEDROCK$/, /^ANTHROPIC_BEDROCK_/, /^AWS_BEARER_TOKEN_BEDROCK$/, MODEL_VARS],
  vertex: [/^CLAUDE_CODE_USE_VERTEX$/, /^ANTHROPIC_VERTEX_/, MODEL_VARS],
  foundry: [/^CLAUDE_CODE_USE_FOUNDRY$/, /^ANTHROPIC_FOUNDRY_/, MODEL_VARS],
};

/** The key reaches the agent under this name and only through the apiKeyHelper below. */
export const AGENT_API_KEY_ENV = 'RNAD_AGENT_API_KEY';

/** Environment for every Claude Code process the server starts (sessions, sign-in, status). */
export function agentEnv(mode: AuthMode, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string' || k === AGENT_API_KEY_ENV) continue;
    if (AMBIENT_AUTH.test(k) && !MODE_VARS[mode].some((re) => re.test(k))) continue;
    out[k] = v;
  }
  if (mode === 'api-key' && env.ANTHROPIC_API_KEY) out[AGENT_API_KEY_ENV] = env.ANTHROPIC_API_KEY;
  const dir = agentConfigDir(env);
  out.CLAUDE_CONFIG_DIR = dir;
  // `ant auth login` profiles are another credential source: point it at an empty directory.
  out.ANTHROPIC_CONFIG_DIR = join(dir, 'anthropic-profiles');
  // No telemetry, error reporting or auto-update traffic from the agent's process.
  out.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  return out;
}

/** Read rules Claude Code also applies to Grep/Glob: a second line of defense behind RepoAccess. */
const SECRET_READ_DENY = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p8',
  '*.p12',
  '*.pfx',
  '*.keystore',
  '*.jks',
  '*.mobileprovision',
  '.npmrc',
  '.netrc',
  '.git-credentials',
  'credentials.json',
  'google-services.json',
  'GoogleService-Info.plist',
  'local.properties',
].map((p) => `Read(**/${p})`);

/** Flag settings for the agent's Claude Code process (highest precedence after policy). */
export function agentSettings(mode: AuthMode): Settings {
  return {
    // Claude Code ignores an ANTHROPIC_API_KEY it has not been told to trust; a helper is
    // the documented way to hand a key to a non-interactive session.
    ...(mode === 'api-key' ? { apiKeyHelper: `printf '%s' "$${AGENT_API_KEY_ENV}"` } : {}),
    permissions: { deny: SECRET_READ_DENY },
  };
}

export interface AuthChoice {
  mode?: AuthMode;
  /** The explicit choice cannot work (e.g. --auth api-key without a key). */
  error?: string;
  /** Credentials found in the environment that are deliberately not used. */
  notices: string[];
}

/**
 * Decide which credentials the agent may use. `explicit` comes from --auth / RNAD_AUTH;
 * without it the only candidate is a Console sign-in the developer completed for this
 * tool. Ambient credentials are reported, never adopted.
 */
export function chooseAuthMode(explicit: string | undefined, env: NodeJS.ProcessEnv, signedIn: boolean): AuthChoice {
  const notices: string[] = [];
  const mode = explicit?.trim() || undefined;
  if (mode !== undefined && !isAuthMode(mode)) return { error: `unknown --auth "${mode}" (use ${AUTH_MODES.join(', ')})`, notices };
  if (mode !== 'api-key' && env.ANTHROPIC_API_KEY) notices.push('ANTHROPIC_API_KEY is set in this environment but not used. Pass --auth api-key to use it.');
  for (const [m, c] of Object.entries(CLOUD)) {
    if (mode !== m && env[c.flag] === '1') notices.push(`${c.flag}=1 is set but not used. Pass --auth ${m} to use ${c.label}.`);
  }
  if (mode === 'api-key' && !env.ANTHROPIC_API_KEY) return { mode, error: '--auth api-key needs ANTHROPIC_API_KEY in the server\'s environment.', notices };
  const cloud = mode ? CLOUD[mode] : undefined;
  if (cloud && env[cloud.flag] !== '1') return { mode, error: `--auth ${mode} needs ${cloud.flag}=1 and ${cloud.label} credentials in the server's environment.`, notices };
  if (mode) return { mode, notices };
  return signedIn ? { mode: 'console', notices } : { notices };
}

/**
 * The agent may run only on the exact credential source the developer chose. A
 * claude.ai subscription login is never acceptable (Anthropic's terms do not allow
 * products built on the Agent SDK to use it), and anything else, including a
 * different API credential than the chosen one, fails closed as ambiguous.
 */
export function authDecision(info: AccountInfo | undefined, mode: AuthMode): { ok: boolean; source: string; reason?: string } {
  if (!info) return { ok: false, source: 'unknown', reason: 'could not determine which credentials the agent would use' };
  const provider = info.apiProvider ?? 'firstParty';
  const source = provider !== 'firstParty' ? provider : (info.apiKeySource ?? info.tokenSource ?? 'none');
  if (info.subscriptionType) {
    return {
      ok: false,
      source,
      reason: `the agent would use a claude.ai ${info.subscriptionType} subscription login. The in-app chat never runs on a personal subscription; use ${AUTH_MODES.map((m) => `--auth ${m}`).join(', ')}.`,
    };
  }
  const ok = CLOUD[mode]
    ? provider === mode
    : provider === 'firstParty' && info.apiKeySource === (mode === 'console' ? '/login managed key' : 'apiKeyHelper');
  if (ok) return { ok: true, source: LABEL[mode] };
  return {
    ok: false,
    source,
    reason: `expected ${LABEL[mode]} (--auth ${mode}), but the agent would authenticate with "${source}". Refusing to start rather than guess which credentials to use.`,
  };
}
