import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeBinary, claudeCodeSignIn } from './account.ts';
import { verifyAgentAuth } from './AgentSession.ts';
import { AGENT_API_KEY_ENV, AUTH_MODES, agentEnv, agentSettings, authDecision, chooseAuthMode } from './credentials.ts';

test('credentials are only ever chosen explicitly', () => {
  assert.deepEqual(chooseAuthMode(undefined, {}, false), { notices: [] });
  assert.equal(chooseAuthMode(undefined, {}, true).mode, 'console', 'a Console sign-in completed for this tool');

  // An API key that happens to be in the shell is reported, never adopted.
  const ambient = chooseAuthMode(undefined, { ANTHROPIC_API_KEY: 'sk-ant-x' }, false);
  assert.equal(ambient.mode, undefined);
  assert.match(ambient.notices.join('\n'), /ANTHROPIC_API_KEY is set .* not used/);
  assert.equal(chooseAuthMode(undefined, { ANTHROPIC_API_KEY: 'sk-ant-x' }, true).mode, 'console');

  assert.equal(chooseAuthMode('api-key', { ANTHROPIC_API_KEY: 'k' }, true).mode, 'api-key');
  assert.match(chooseAuthMode('api-key', {}, false).error ?? '', /needs ANTHROPIC_API_KEY/);
  assert.match(chooseAuthMode('bedrock', {}, false).error ?? '', /CLAUDE_CODE_USE_BEDROCK=1/);
  assert.equal(chooseAuthMode('bedrock', { CLAUDE_CODE_USE_BEDROCK: '1' }, false).mode, 'bedrock');
  assert.match(
    chooseAuthMode('vertex', { CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1' }, false).notices.join('\n'),
    /CLAUDE_CODE_USE_BEDROCK=1 is set but not used/,
  );
  assert.match(chooseAuthMode('oauth', {}, true).error ?? '', /unknown --auth/);
});

test('the credential source must match the chosen mode exactly (ambiguity fails closed)', () => {
  assert.ok(authDecision({ apiKeySource: '/login managed key', apiProvider: 'firstParty', organization: 'Example' }, 'console').ok);
  assert.deepEqual(authDecision({ apiKeySource: 'apiKeyHelper', tokenSource: 'apiKeyHelper', apiProvider: 'firstParty' }, 'api-key'), {
    ok: true,
    source: 'ANTHROPIC_API_KEY',
  });
  assert.ok(authDecision({ apiProvider: 'bedrock' }, 'bedrock').ok);
  assert.ok(authDecision({ apiProvider: 'vertex' }, 'vertex').ok);

  assert.match(authDecision({ apiKeySource: 'apiKeyHelper' }, 'console').reason ?? '', /expected Anthropic Console sign-in .* "apiKeyHelper"/);
  assert.equal(authDecision({ apiKeySource: '/login managed key' }, 'api-key').ok, false);
  assert.equal(authDecision({ apiKeySource: 'ANTHROPIC_API_KEY' }, 'api-key').ok, false, 'only the key handed over through the helper');
  assert.equal(authDecision({ apiProvider: 'vertex' }, 'bedrock').ok, false);
  assert.equal(authDecision({ apiKeySource: '/login managed key', apiProvider: 'gateway' }, 'console').ok, false);
});

test('claude.ai subscription logins and unknown sources are refused in every mode', () => {
  for (const mode of AUTH_MODES) {
    const sub = authDecision({ apiKeySource: '/login managed key', subscriptionType: 'team', apiProvider: 'firstParty' }, mode);
    assert.equal(sub.ok, false, mode);
    assert.match(sub.reason ?? '', /subscription login/);
    assert.equal(authDecision({ tokenSource: 'claude.ai', apiProvider: 'firstParty' }, mode).ok, false);
    assert.equal(authDecision({ tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN' }, mode).ok, false);
    assert.equal(authDecision({ apiKeySource: 'none' }, mode).ok, false);
    assert.equal(authDecision({}, mode).ok, false);
    assert.equal(authDecision(undefined, mode).ok, false);
  }
});

test("the agent's environment carries no ambient credentials, only what the chosen mode needs", () => {
  const xdg = mkdtempSync(join(tmpdir(), 'rnad-xdg-'));
  const ambient = {
    XDG_CONFIG_HOME: xdg,
    HOME: homedir(),
    PATH: '/usr/bin',
    AWS_PROFILE: 'dev',
    ANTHROPIC_API_KEY: 'sk-ant-api03-ambient',
    ANTHROPIC_AUTH_TOKEN: 't',
    ANTHROPIC_BASE_URL: 'https://proxy.example',
    ANTHROPIC_PROFILE: 'work',
    ANTHROPIC_IDENTITY_TOKEN: 'id',
    ANTHROPIC_MODEL: 'm',
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x',
    CLAUDE_CODE_SESSION_ACCESS_TOKEN: 's',
    CLAUDE_CODE_USE_GATEWAY: '1',
    CLAUDE_CODE_USE_BEDROCK: '1',
    ANTHROPIC_BEDROCK_BASE_URL: 'https://bedrock.example',
    AWS_BEARER_TOKEN_BEDROCK: 'b',
    CLAUDE_CODE_USE_VERTEX: '1',
    ANTHROPIC_VERTEX_PROJECT_ID: 'p',
    CLAUDE_CONFIG_DIR: join(homedir(), '.claude'),
    CLAUDECODE: '1',
  };
  const OURS = ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_CONFIG_DIR', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'];
  const credentialish = (env: Record<string, string>) =>
    Object.keys(env)
      .filter((k) => /^(ANTHROPIC_|CLAUDE|AWS_BEARER)/.test(k) && !OURS.includes(k))
      .sort();

  const consoleEnv = agentEnv('console', ambient);
  assert.deepEqual(credentialish(consoleEnv), []);
  assert.equal(consoleEnv.CLAUDE_CONFIG_DIR, join(xdg, 'react-native-agent-devtools', 'claude'), 'never the developer’s ~/.claude');
  assert.equal(consoleEnv.ANTHROPIC_CONFIG_DIR, join(consoleEnv.CLAUDE_CONFIG_DIR, 'anthropic-profiles'));
  assert.equal(consoleEnv.PATH, '/usr/bin');
  assert.equal(consoleEnv.AWS_PROFILE, 'dev');
  assert.equal(consoleEnv[AGENT_API_KEY_ENV], undefined);

  const keyEnv = agentEnv('api-key', ambient);
  assert.deepEqual(credentialish(keyEnv), []);
  assert.equal(keyEnv[AGENT_API_KEY_ENV], 'sk-ant-api03-ambient');

  assert.deepEqual(credentialish(agentEnv('bedrock', ambient)), ['ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_MODEL', 'AWS_BEARER_TOKEN_BEDROCK', 'CLAUDE_CODE_USE_BEDROCK']);
  assert.deepEqual(credentialish(agentEnv('vertex', ambient)), ['ANTHROPIC_MODEL', 'ANTHROPIC_VERTEX_PROJECT_ID', 'CLAUDE_CODE_USE_VERTEX']);

  assert.deepEqual(JSON.parse(readFileSync(join(consoleEnv.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8')), { forceLoginMethod: 'console' });
  assert.equal(agentSettings('api-key').apiKeyHelper, `printf '%s' "$${AGENT_API_KEY_ENV}"`);
  assert.equal(agentSettings('console').apiKeyHelper, undefined);
  assert.ok(agentSettings('console').permissions?.deny?.includes('Read(**/.env)'));
});

const realBinary = { skip: !claudeBinary() && 'bundled Claude Code binary not installed' };

/** Run with a throwaway config home and only the given credential variables. */
async function isolated<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (/^(ANTHROPIC_|CLAUDE|AWS_BEARER_TOKEN_)/.test(k)) delete process.env[k];
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'rnad-xdg-'));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

test('a fresh agent config dir is signed out, even when the developer is logged in to Claude Code', realBinary, async () => {
  // The real `claude auth status --json` (local, no model call).
  await isolated({}, async () => assert.deepEqual(await claudeCodeSignIn.status(), { loggedIn: false }));
});

test('regression for the credential incident: a shell API key is never used implicitly and no stored login stands in', realBinary, async () => {
  // The incident: ANTHROPIC_API_KEY was set, Claude Code ignored it (it was never approved)
  // and used the developer's stored login instead. Asked with the real Claude Code binary
  // and no prompt (accountInfo only, no model call): which credentials WOULD the agent use?
  await isolated({ ANTHROPIC_API_KEY: `sk-ant-api03-${'x'.repeat(90)}` }, async () => {
    const consoleMode = await verifyAgentAuth('console');
    assert.equal(consoleMode.ok, false);
    assert.match(consoleMode.reason ?? '', /expected Anthropic Console sign-in .* "none"/);
    assert.deepEqual(await verifyAgentAuth('api-key'), { ok: true, source: 'ANTHROPIC_API_KEY' });
  });
});
