import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIMITS,
  PROTOCOL_VERSION,
  parseClientMessage,
  parseServerMessage,
  parseTarget,
  redactBody,
  redactText,
  redactUrl,
  redactValue,
  validateAction,
  validateSequence,
} from './index.ts';

const device = {
  platform: 'ios',
  osVersion: '26.0',
  libraryVersion: '0.1.0',
  window: { width: 402, height: 874, scale: 3 },
};

test('hello requires matching protocol version and device info', () => {
  const ok = parseClientMessage(JSON.stringify({ type: 'hello', protocol: PROTOCOL_VERSION, device, capabilities: {} }));
  assert.equal(ok.ok, true);
  const badVersion = parseClientMessage(JSON.stringify({ type: 'hello', protocol: 999, device, capabilities: {} }));
  assert.equal(badVersion.ok, false);
  const badDevice = parseClientMessage(
    JSON.stringify({ type: 'hello', protocol: PROTOCOL_VERSION, device: { platform: 'web' }, capabilities: {} }),
  );
  assert.equal(badDevice.ok, false);
});

test('client messages reject malformed input', () => {
  assert.equal(parseClientMessage('not json').ok, false);
  assert.equal(parseClientMessage(JSON.stringify([1, 2])).ok, false);
  assert.equal(parseClientMessage(JSON.stringify({ type: 'nope' })).ok, false);
  assert.equal(parseClientMessage(JSON.stringify({ type: 'chat.send', id: 'a', text: '' })).ok, false);
  assert.equal(parseClientMessage(JSON.stringify({ type: 'chat.send', id: 'a', text: 'x'.repeat(9000) })).ok, false);
  assert.equal(parseClientMessage(JSON.stringify({ type: 'rpc.result', id: 'r1', ok: false })).ok, false);
  assert.equal(parseClientMessage(42).ok, false);
});

test('chat.send strips unknown fields', () => {
  const r = parseClientMessage(JSON.stringify({ type: 'chat.send', id: 'm1', text: 'hi', evil: true }));
  assert.ok(r.ok);
  assert.deepEqual(r.msg, { type: 'chat.send', id: 'm1', text: 'hi' });
});

test('rpc.result carries ok/error variants', () => {
  const ok = parseClientMessage(JSON.stringify({ type: 'rpc.result', id: 'r1', ok: true, result: { a: 1 }, deviceMs: 4 }));
  assert.ok(ok.ok && ok.msg.type === 'rpc.result' && ok.msg.ok);
  const err = parseClientMessage(
    JSON.stringify({ type: 'rpc.result', id: 'r1', ok: false, error: { code: 'NOT_FOUND', message: 'x' } }),
  );
  assert.ok(err.ok && err.msg.type === 'rpc.result' && !err.msg.ok);
});

test('server rpc.call only allows known methods', () => {
  assert.equal(parseServerMessage(JSON.stringify({ type: 'rpc.call', id: '1', method: 'tap', params: {} })).ok, true);
  assert.equal(parseServerMessage(JSON.stringify({ type: 'rpc.call', id: '1', method: 'eval', params: {} })).ok, false);
});

test('setup.status is validated and stripped', () => {
  const ok = parseServerMessage(JSON.stringify({ type: 'setup.status', state: 'failed', message: 'Sign-in timed out.', extra: 1 }));
  assert.deepEqual(ok, { ok: true, msg: { type: 'setup.status', state: 'failed', message: 'Sign-in timed out.' } });
  assert.equal(parseServerMessage(JSON.stringify({ type: 'setup.status', state: 'done' })).ok, false);
  assert.equal(parseServerMessage(JSON.stringify({ type: 'setup.status', state: 'waiting', message: 'x'.repeat(501) })).ok, false);
});

test('parseTarget understands compact strings', () => {
  assert.deepEqual(parseTarget('e12'), { ref: 'e12' });
  assert.deepEqual(parseTarget('@E3'), { ref: 'e3' });
  assert.deepEqual(parseTarget('#login-button'), { testID: 'login-button' });
  assert.deepEqual(parseTarget('text=Log in'), { text: 'Log in' });
  assert.deepEqual(parseTarget('label: "Email"'), { label: 'Email' });
  assert.deepEqual(parseTarget('role=button'), { role: 'button' });
  assert.equal(parseTarget('role=spaceship'), null);
  assert.deepEqual(parseTarget('Continue'), { text: 'Continue' });
  assert.equal(parseTarget(''), null);
  assert.equal(parseTarget({}), null);
  assert.deepEqual(parseTarget({ role: 'textbox', index: 1 }), { role: 'textbox', index: 1 });
});

test('validateAction normalizes and bounds actions', () => {
  const tap = validateAction({ type: 'tap', target: '#go', expect: { route: 'Home', timeoutMs: 999_999 } });
  assert.ok(tap.ok);
  assert.deepEqual(tap.value, { type: 'tap', target: { testID: 'go' }, expect: { route: 'Home', timeoutMs: LIMITS.maxWaitMs } });
  const type = validateAction({ type: 'type', target: 'e1', text: 'hello' });
  assert.ok(type.ok && type.value.type === 'type' && type.value.replace === true);
  assert.equal(validateAction({ type: 'type', target: 'e1' }).ok, false);
  assert.equal(validateAction({ type: 'scroll', direction: 'sideways' }).ok, false);
  assert.equal(validateAction({ type: 'tap' }).ok, false);
  assert.equal(validateAction({ type: 'tap', target: 'e1', mode: 'teleport' }).ok, false);
  assert.equal(validateAction({ type: 'exec', code: 'rm -rf /' }).ok, false);
  const sleep = validateAction({ type: 'sleep', ms: 60_000 });
  assert.ok(sleep.ok && sleep.value.type === 'sleep' && sleep.value.ms === LIMITS.maxSleepMs);
  const wait = validateAction({ type: 'waitFor', route: 'Home' });
  assert.ok(wait.ok && wait.value.type === 'waitFor' && wait.value.condition.route === 'Home');
  assert.equal(validateAction({ type: 'waitFor' }).ok, false);
});

test('validateSequence enforces limits', () => {
  assert.equal(validateSequence({ actions: [] }).ok, false);
  const tooMany = Array.from({ length: LIMITS.maxSequenceActions + 1 }, () => ({ type: 'back' }));
  assert.equal(validateSequence({ actions: tooMany }).ok, false);
  const r = validateSequence({ actions: [{ type: 'back' }], options: { timeoutMs: 10 ** 9 } });
  assert.ok(r.ok && r.value.options.timeoutMs === LIMITS.maxSequenceMs);
  const bad = validateSequence({ actions: [{ type: 'back' }, { type: 'tap' }] });
  assert.ok(!bad.ok && bad.error.includes('actions[1]'));
});

test('redactText removes tokens, card numbers, emails and key/value secrets', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const s = redactText(
    `Authorization: Bearer abcdef123456789 token=${jwt} password="hunter2" card 4111 1111 1111 1111 user jane@example.com order 123456`,
  );
  assert.ok(!s.includes('hunter2'));
  assert.ok(!s.includes('abcdef123456789'));
  assert.ok(!s.includes('4111 1111 1111 1111'));
  assert.ok(!s.includes('jane@example.com'));
  assert.ok(!s.includes('eyJhbGci'));
  assert.ok(s.includes('order 123456'), 'non-sensitive numbers survive');
});

test('redactText removes well-known API key formats, even short test keys', () => {
  const s = redactText('using sk-ant-api03-AbC123xyz and sk-ant-dummy-invalid-key, github ghp_0123456789abcdefghijABCDEFGHIJ, aws AKIAABCDEFGHIJKLMNOP');
  for (const leaked of ['sk-ant-api03', 'sk-ant-dummy', 'ghp_0123', 'AKIAABCD']) assert.ok(!s.includes(leaked), leaked);
  assert.ok(s.includes('using'));
});

test('chat.send context and chat.config are validated', () => {
  const ok = parseClientMessage(JSON.stringify({ type: 'chat.send', id: 'a', text: 'Why?', context: { selection: 'e5 button', extra: 1 } }));
  assert.ok(ok.ok && ok.msg.type === 'chat.send');
  assert.deepEqual(ok.ok && ok.msg, { type: 'chat.send', id: 'a', text: 'Why?', context: { selection: 'e5 button' } });
  assert.equal(parseClientMessage(JSON.stringify({ type: 'chat.send', id: 'a', text: 'x', context: { selection: 5 } })).ok, false);
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: 'chat.config', model: 'claude-sonnet-5-5' })), { ok: true, msg: { type: 'chat.config', model: 'claude-sonnet-5-5' } });
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: 'chat.config' })), { ok: true, msg: { type: 'chat.config' } });
  assert.equal(parseClientMessage(JSON.stringify({ type: 'chat.config', model: 'x; rm -rf /' })).ok, false);
});

test('chat.notice and welcome.trusted are validated', () => {
  const n = parseServerMessage(JSON.stringify({ type: 'chat.notice', text: 'Approve in your terminal', level: 'bogus', extra: 1 }));
  assert.ok(n.ok);
  assert.deepEqual(n.ok && n.msg, { type: 'chat.notice', text: 'Approve in your terminal', level: 'info' });
  assert.equal(parseServerMessage(JSON.stringify({ type: 'chat.notice', text: '' })).ok, false);
  const w = parseServerMessage(JSON.stringify({ type: 'welcome', sessionId: 's', trusted: true, server: { version: '1', agent: { available: false }, repoAccess: 'none', network: 'loopback' } }));
  assert.ok(w.ok && w.msg.type === 'welcome' && w.msg.trusted === true);
});

test('redactUrl strips userinfo, secrets in query, emails in path and fragments', () => {
  const u = redactUrl('https://bob:pw@api.example.com/users/jane%40example.com/orders?page=2&access_token=abc123&q=shoes#id_token=xyz');
  assert.equal(u, 'https://api.example.com/users/<email>/orders?page=2&access_token=[REDACTED]&q=shoes#…');
  assert.equal(redactUrl('/relative/path?apiKey=1'), '/relative/path?apiKey=[REDACTED]');
});

test('redactValue removes sensitive keys deeply and bounds size', () => {
  const v = redactValue({ user: { email: 'a@b.co', password: 'x', profile: { sessionId: 's' } }, items: Array(100).fill(1) }) as {
    user: { email: string; password: string; profile: { sessionId: string } };
    items: unknown[];
  };
  assert.equal(v.user.password, '[REDACTED]');
  assert.equal(v.user.profile.sessionId, '[REDACTED]');
  assert.equal(v.user.email, '<email>');
  assert.equal(v.items.length, 51);
});

test('redactBody handles JSON and form bodies', () => {
  assert.equal(redactBody('{"email":"a@b.co","password":"pw"}', 1000), '{"email":"<email>","password":"[REDACTED]"}');
  assert.equal(redactBody('user=bob&pwd=1234', 1000), 'user=bob&pwd=[REDACTED]');
  assert.equal(redactBody('x'.repeat(50), 10), 'xxxxxxxxxx…');
});
