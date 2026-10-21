import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { Pairing, checkRequestOrigin, isLoopback } from './auth.ts';
import { RepoAccess } from './repoAccess.ts';

test('pairing codes are single-use and yield verifiable tokens', () => {
  const p = new Pairing();
  const code = p.currentCode;
  assert.match(code, /^[A-HJ-NP-Z2-9]{8}$/);
  const r = p.redeem(code.toLowerCase());
  assert.ok(r.ok);
  assert.ok(p.verifyToken(r.token));
  assert.equal(p.redeem(code).ok, false, 'code cannot be reused');
  assert.equal(p.verifyToken('nope'), false);
  assert.equal(p.verifyToken(undefined), false);
});

test('pairing locks out after repeated failures and rotates the code', () => {
  let now = 1_000;
  const p = new Pairing({ maxFailures: 3, lockoutMs: 10_000 }, () => now);
  const code = p.currentCode;
  for (let i = 0; i < 3; i++) assert.equal(p.redeem('WRONGCODE').ok, false);
  const locked = p.redeem(code);
  assert.ok(!locked.ok && /too many/.test(locked.reason));
  now += 11_000;
  assert.notEqual(p.currentCode, code, 'code rotated after lockout');
  assert.ok(p.redeem(p.currentCode).ok);
});

test('pairing codes and tokens expire', () => {
  let now = 0;
  const p = new Pairing({ codeTtlMs: 1_000, tokenTtlMs: 5_000 }, () => now);
  const code = p.currentCode;
  now = 2_000;
  assert.equal(p.redeem(code).ok, false);
  const r = p.redeem(p.currentCode);
  assert.ok(r.ok);
  now += 6_000;
  assert.equal(p.verifyToken(r.token), false);
});

const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;

test('origin/host checks reject browsers and DNS rebinding', () => {
  assert.ok(checkRequestOrigin(req({ host: '127.0.0.1:8765' }), false).ok);
  assert.ok(checkRequestOrigin(req({ host: 'localhost:8765', origin: 'http://localhost:8765' }), false).ok);
  assert.ok(checkRequestOrigin(req({ host: '10.0.2.2:8765' }), false).ok, 'android emulator host alias');
  assert.equal(checkRequestOrigin(req({ host: 'localhost:8765', origin: 'https://evil.example' }), false).ok, false);
  assert.equal(checkRequestOrigin(req({ host: 'localhost:8765', origin: 'null' }), false).ok, false);
  assert.equal(checkRequestOrigin(req({ host: 'evil.example:8765' }), false).ok, false);
  assert.equal(checkRequestOrigin(req({ host: '192.168.1.20:8765' }), false).ok, false, 'IP hosts only in LAN mode');
  assert.ok(checkRequestOrigin(req({ host: '192.168.1.20:8765' }), true).ok);
  assert.ok(isLoopback('::ffff:127.0.0.1') && isLoopback('::1') && !isLoopback('192.168.1.2'));
});

test('repo access allows the root, blocks escapes, symlinks and secrets', () => {
  const root = mkdtempSync(join(tmpdir(), 'rnad-repo-'));
  const outside = mkdtempSync(join(tmpdir(), 'rnad-outside-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'App.tsx'), 'export {}');
  writeFileSync(join(root, '.env'), 'API_KEY=x');
  writeFileSync(join(outside, 'secret.txt'), 'x');
  symlinkSync(outside, join(root, 'link'));
  const repo = new RepoAccess([root]);

  assert.ok(repo.check('Read', { file_path: join(root, 'src', 'App.tsx') }).allow);
  assert.ok(repo.check('Read', { file_path: 'src/App.tsx' }).allow, 'relative to the first root');
  assert.ok(repo.check('Grep', { pattern: 'useState' }).allow, 'defaults to the root');
  assert.equal(repo.check('Read', { file_path: join(outside, 'secret.txt') }).allow, false);
  assert.equal(repo.check('Read', { file_path: join(root, '..', 'etc') }).allow, false);
  assert.equal(repo.check('Read', { file_path: join(root, 'link', 'secret.txt') }).allow, false, 'symlink escape');
  assert.equal(repo.check('Read', { file_path: join(root, '.env') }).allow, false, 'secret file');
  assert.equal(repo.check('Read', { file_path: join(root, 'ios', 'key.p8') }).allow, false);
  assert.equal(repo.check('Glob', { pattern: '../**/*' }).allow, false);
  assert.equal(new RepoAccess([]).check('Read', { file_path: join(root, 'src', 'App.tsx') }).allow, false, 'disabled without roots');
});
