import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';

const FILE = 'server-token';
const VALID = /^[A-Za-z0-9_-]{32,}$/;

/**
 * Secret that local clients present as `Authorization: Bearer <token>`: the CLI, the
 * Claude Code bridge and MCP over HTTP. Loopback alone is not an identity (other OS
 * users and sandboxed processes can reach 127.0.0.1); reading this 0600 file is.
 * Stable across restarts so a Claude Code MCP config that includes it keeps working.
 */
export function loadServerToken(dir: string): string {
  const existing = readServerToken(dir);
  if (existing) {
    chmodSync(join(dir, FILE), 0o600);
    return existing;
  }
  const token = randomBytes(32).toString('base64url');
  writeFileSync(join(dir, FILE), `${token}\n`, { mode: 0o600 });
  return token;
}

/** For clients: the current token, without creating one. */
export function readServerToken(dir: string): string | undefined {
  const file = join(dir, FILE);
  if (!existsSync(file)) return undefined;
  const token = readFileSync(file, 'utf8').trim();
  return VALID.test(token) ? token : undefined;
}

/** Forget the token; the next server start creates a new one. */
export function rotateServerToken(dir: string): void {
  rmSync(join(dir, FILE), { force: true });
}

export function bearerOk(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  const m = typeof header === 'string' ? /^Bearer\s+(\S+)$/i.exec(header) : null;
  if (!m?.[1]) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
