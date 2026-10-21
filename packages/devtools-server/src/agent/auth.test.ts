import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentAvailability, authDecision } from './AgentSession.ts';

test('agent requires explicitly configured credentials in the environment', () => {
  assert.equal(agentAvailability({}).available, false);
  assert.equal(agentAvailability({ ANTHROPIC_API_KEY: 'x' }).available, true);
  assert.equal(agentAvailability({ CLAUDE_CODE_USE_BEDROCK: '1' }).available, true);
  assert.equal(agentAvailability({ CLAUDE_CODE_USE_BEDROCK: '0' }).available, false);
});

test('authDecision accepts API keys and cloud providers only', () => {
  assert.ok(authDecision({ apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' }).ok);
  assert.ok(authDecision({ apiKeySource: 'apiKeyHelper' }).ok);
  assert.ok(authDecision({ apiProvider: 'bedrock' }).ok);
  assert.ok(authDecision({ apiProvider: 'vertex' }).ok);
});

test('authDecision refuses claude.ai / OAuth logins and unknown sources (fail closed)', () => {
  const oauth = authDecision({ apiKeySource: 'oauth', subscriptionType: 'max', apiProvider: 'firstParty' });
  assert.equal(oauth.ok, false);
  assert.match(oauth.reason ?? '', /subscription login/);
  assert.equal(authDecision({ tokenSource: 'claude.ai', apiProvider: 'firstParty' }).ok, false);
  assert.equal(authDecision({ apiKeySource: '/login managed key' }).ok, false);
  assert.equal(authDecision({ apiKeySource: 'none' }).ok, false);
  assert.equal(authDecision({}).ok, false);
  assert.equal(authDecision(undefined).ok, false);
});
