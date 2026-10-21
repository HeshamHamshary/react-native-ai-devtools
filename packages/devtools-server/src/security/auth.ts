import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import type { IncomingMessage } from 'node:http';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

export interface PairingOptions {
  codeTtlMs?: number;
  tokenTtlMs?: number;
  maxFailures?: number;
  lockoutMs?: number;
  /** Keep issued device tokens (SHA-256 hashes only) here so pairings survive restarts. */
  storeFile?: string;
}

interface StoredToken {
  expires: number;
  created: number;
  label?: string;
}

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Short-lived pairing codes exchanged for device tokens. Required for connections
 * that do not come from the loopback interface (physical devices over LAN), and for
 * any device that should be able to approve edits or Claude Code permissions.
 */
export class Pairing {
  private code = '';
  private codeExpires = 0;
  /** Keyed by token hash; the raw token exists only on the device. */
  private tokens = new Map<string, StoredToken>();
  private readonly storeFile?: string;
  private failures = 0;
  private lockedUntil = 0;
  private readonly codeTtl: number;
  private readonly tokenTtl: number;
  private readonly maxFailures: number;
  private readonly lockoutMs: number;

  private readonly clock: () => number;

  constructor(opts: PairingOptions = {}, clock: () => number = Date.now) {
    this.clock = clock;
    this.codeTtl = opts.codeTtlMs ?? 10 * 60_000;
    this.tokenTtl = opts.tokenTtlMs ?? 30 * 24 * 60 * 60_000;
    this.maxFailures = opts.maxFailures ?? 5;
    this.lockoutMs = opts.lockoutMs ?? 60_000;
    this.storeFile = opts.storeFile;
    this.load();
    this.rotate();
  }

  private load(): void {
    if (!this.storeFile || !existsSync(this.storeFile)) return;
    try {
      const data = JSON.parse(readFileSync(this.storeFile, 'utf8')) as { tokens?: Record<string, StoredToken> };
      const now = this.clock();
      for (const [hash, t] of Object.entries(data.tokens ?? {})) {
        if (/^[0-9a-f]{64}$/.test(hash) && typeof t?.expires === 'number' && t.expires > now) this.tokens.set(hash, t);
      }
    } catch {
      // unreadable store: every device pairs again
    }
  }

  private save(): void {
    if (!this.storeFile) return;
    const tmp = `${this.storeFile}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ tokens: Object.fromEntries(this.tokens) }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.storeFile);
  }

  rotate(): string {
    let c = '';
    for (let i = 0; i < 8; i++) c += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    this.code = c;
    this.codeExpires = this.clock() + this.codeTtl;
    return c;
  }

  get currentCode(): string {
    if (this.clock() > this.codeExpires) this.rotate();
    return this.code;
  }

  get codeExpiresAt(): number {
    return this.codeExpires;
  }

  /** Exchange a pairing code for a device token. Codes are single-use. */
  redeem(code: string, label?: string): { ok: true; token: string } | { ok: false; reason: string } {
    const now = this.clock();
    if (now < this.lockedUntil) return { ok: false, reason: 'too many failed attempts; try again shortly' };
    const normalized = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (now > this.codeExpires || !safeEqual(normalized, this.code)) {
      this.failures++;
      if (this.failures >= this.maxFailures) {
        this.failures = 0;
        this.lockedUntil = now + this.lockoutMs;
        this.rotate();
      }
      return { ok: false, reason: now > this.codeExpires ? 'pairing code expired' : 'invalid pairing code' };
    }
    this.failures = 0;
    this.rotate();
    const token = randomBytes(24).toString('base64url');
    this.tokens.set(hashToken(token), { expires: now + this.tokenTtl, created: now, ...(label ? { label: label.slice(0, 80) } : {}) });
    this.save();
    return { ok: true, token };
  }

  verifyToken(token: string | undefined): boolean {
    if (!token) return false;
    const hash = hashToken(token);
    const t = this.tokens.get(hash);
    if (!t) return false;
    if (this.clock() > t.expires) {
      this.tokens.delete(hash);
      this.save();
      return false;
    }
    return true;
  }

  /** Paired devices (labels and dates only). */
  list(): { label?: string; created: number; expires: number }[] {
    return [...this.tokens.values()].map(({ label, created, expires }) => ({ label, created, expires }));
  }

  revokeAll(): void {
    this.tokens.clear();
    this.save();
    this.rotate();
  }
}

export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.');
}

const IP_LITERAL = /^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:.]+\])$/i;

/**
 * Defends the local server against browsers (cross-site WebSocket / fetch) and DNS
 * rebinding. React Native clients either send no Origin or an Origin equal to the
 * URL they connect to; browsers always send the page's origin.
 */
export function checkRequestOrigin(req: IncomingMessage, lan: boolean): { ok: true } | { ok: false; reason: string } {
  const host = (req.headers.host ?? '').toLowerCase();
  const hostname_ = host.replace(/:\d+$/, '');
  const allowedNames = new Set(['localhost', '127.0.0.1', '[::1]', '10.0.2.2', '10.0.3.2']);
  if (lan) {
    allowedNames.add(hostname().toLowerCase());
    allowedNames.add(`${hostname().toLowerCase()}.local`);
  }
  const hostOk = allowedNames.has(hostname_) || (lan && IP_LITERAL.test(hostname_));
  if (!hostOk) return { ok: false, reason: `host "${host}" not allowed` };
  const origin = req.headers.origin;
  if (origin === undefined) return { ok: true };
  const o = String(origin).toLowerCase();
  if (o === `http://${host}` || o === `https://${host}` || o === `ws://${host}`) return { ok: true };
  return { ok: false, reason: `cross-origin request from ${origin} rejected` };
}
