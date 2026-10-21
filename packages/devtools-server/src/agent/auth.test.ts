import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { authDecision } from './AgentSession.ts';
import { agentEnv, claudeBinary, claudeCodeSignIn, hasEnvCredentials } from './account.ts';

test('environment credentials are an API key or an explicit cloud provider', () => {
  assert.equal(hasEnvCredentials({}), false);
  assert.equal(hasEnvCredentials({ ANTHROPIC_API_KEY: 'x' }), true);
  assert.equal(hasEnvCredentials({ CLAUDE_CODE_USE_BEDROCK: '1' }), true);
  assert.equal(hasEnvCredentials({ CLAUDE_CODE_USE_BEDROCK: '0' }), false);
});

test('authDecision accepts API keys, the Console sign-in key and cloud providers', () => {
  assert.ok(authDecision({ apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' }).ok);
  assert.ok(authDecision({ apiKeySource: 'apiKeyHelper' }).ok);
  assert.ok(authDecision({ apiKeySource: '/login managed key', apiProvider: 'firstParty', organization: 'Example Org' }).ok);
  assert.ok(authDecision({ apiProvider: 'bedrock' }).ok);
  assert.ok(authDecision({ apiProvider: 'vertex' }).ok);
});

test('authDecision refuses claude.ai subscription logins and unknown sources (fail closed)', () => {
  const oauth = authDecision({ apiKeySource: 'oauth', subscriptionType: 'max', apiProvider: 'firstParty' });
  assert.equal(oauth.ok, false);
  assert.match(oauth.reason ?? '', /subscription login/);
  assert.equal(authDecision({ subscriptionType: 'pro', apiProvider: 'firstParty' }).ok, false);
  assert.equal(authDecision({ apiKeySource: '/login managed key', subscriptionType: 'team' }).ok, false);
  assert.equal(authDecision({ tokenSource: 'claude.ai', apiProvider: 'firstParty' }).ok, false);
  assert.equal(authDecision({ tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN', apiProvider: 'firstParty' }).ok, false);
  assert.equal(authDecision({ apiProvider: 'firstParty' }).ok, false, 'e.g. an `ant` profile: not reported, so refused');
  assert.equal(authDecision({ apiKeySource: 'none' }).ok, false);
  assert.equal(authDecision({}).ok, false);
  assert.equal(authDecision(undefined).ok, false);
});

test('agent processes never see the personal Claude Code config or subscription tokens', () => {
  const xdg = mkdtempSync(join(tmpdir(), 'rnad-xdg-'));
  const env = agentEnv({ XDG_CONFIG_HOME: xdg, HOME: homedir(), CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x', ANTHROPIC_PROFILE: 'work', PATH: '/usr/bin' });
  assert.equal(env.CLAUDE_CONFIG_DIR, join(xdg, 'react-native-agent-devtools', 'claude'));
  assert.notEqual(env.CLAUDE_CONFIG_DIR, join(homedir(), '.claude'));
  assert.equal(env.ANTHROPIC_CONFIG_DIR, join(env.CLAUDE_CONFIG_DIR, 'anthropic-profiles'));
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_PROFILE, undefined);
  assert.equal(env.PATH, '/usr/bin');
});

test('a fresh agent config dir is signed out, even when the developer is logged in to Claude Code', { skip: !claudeBinary() && 'bundled Claude Code binary not installed' }, async () => {
  const keys = ['XDG_CONFIG_HOME', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;
  const saved = keys.map((k) => process.env[k]);
  keys.forEach((k) => delete process.env[k]);
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'rnad-xdg-'));
  try {
    // Runs the real `claude auth status --json` (local, no network, no model call).
    assert.deepEqual(await claudeCodeSignIn.status(), { loggedIn: false });
  } finally {
    keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
  }
});
