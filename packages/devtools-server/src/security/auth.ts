import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { hostname } from 'node:os';
import type { IncomingMessage } from 'node:http';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

export interface PairingOptions {
  codeTtlMs?: number;
  tokenTtlMs?: number;
  maxFailures?: number;
  lockoutMs?: number;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Short-lived pairing codes exchanged for device tokens. Used for any connection
 * that does not originate from the loopback interface (physical devices over LAN).
 */
export class Pairing {
  private code = '';
  private codeExpires = 0;
  private tokens = new Map<string, number>();
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
    this.tokenTtl = opts.tokenTtlMs ?? 12 * 60 * 60_000;
    this.maxFailures = opts.maxFailures ?? 5;
    this.lockoutMs = opts.lockoutMs ?? 60_000;
    this.rotate();
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
  redeem(code: string): { ok: true; token: string } | { ok: false; reason: string } {
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
    this.tokens.set(token, now + this.tokenTtl);
    return { ok: true, token };
  }

  verifyToken(token: string | undefined): boolean {
    if (!token) return false;
    const exp = this.tokens.get(token);
    if (exp === undefined) return false;
    if (this.clock() > exp) {
      this.tokens.delete(token);
      return false;
    }
    return true;
  }

  revokeAll(): void {
    this.tokens.clear();
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
