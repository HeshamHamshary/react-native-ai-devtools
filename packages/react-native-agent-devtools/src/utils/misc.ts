export const now = (): number => Date.now();

/** High-resolution monotonic clock in ms when available (Hermes exposes performance.now). */
const perf = (globalThis as { performance?: { now?: () => number } }).performance;
export const clock: () => number = perf && typeof perf.now === 'function' ? () => perf.now!() : () => Date.now();

export const round = (n: number): number => Math.round(n);

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError());
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new CancelledError());
    };
    signal?.addEventListener?.('abort', onAbort);
  });
}

export class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

let idCounter = 0;
export const nextId = (prefix: string): string => `${prefix}${Date.now().toString(36)}${(idCounter++).toString(36)}`;

/** FNV-1a 32-bit, incremental: hash(prev, segment). Used for stable element fingerprints. */
export function fnv1a(seed: number, s: string): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export const FNV_SEED = 0x811c9dc5;

export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Safe stringification for console arguments (cycles, errors, functions, depth limits). */
export function stringifyArg(value: unknown, depth = 0): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (depth > 2) return Array.isArray(value) ? '[Array]' : '[Object]';
  try {
    const seen = new WeakSet<object>();
    return JSON.stringify(value, (_k, v: unknown) => {
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[Circular]';
        seen.add(v);
      }
      if (typeof v === 'function') return `[Function ${(v as { name?: string }).name || 'anonymous'}]`;
      if (typeof v === 'bigint') return `${v.toString()}n`;
      return v;
    });
  } catch {
    return Object.prototype.toString.call(value);
  }
}
