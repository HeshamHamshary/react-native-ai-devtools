import type { LogEntry, LogLevel } from 'react-native-agent-devtools-protocol';
import { redactText } from 'react-native-agent-devtools-protocol';
import { RingBuffer } from '../utils/RingBuffer';
import { stringifyArg, truncate } from '../utils/misc';

type ConsoleFn = (...args: unknown[]) => void;
type GlobalHandler = (error: unknown, isFatal?: boolean) => void;

interface ErrorUtilsLike {
  getGlobalHandler(): GlobalHandler | undefined;
  setGlobalHandler(handler: GlobalHandler): void;
}

const LEVELS: LogLevel[] = ['debug', 'log', 'info', 'warn', 'error'];
const MAX_MESSAGE = 2_000;
const MAX_STACK = 1_500;

/**
 * Captures console output and uncaught JS errors into a bounded ring buffer.
 * Existing behavior is preserved: original console methods and the previous
 * global error handler are always called (we chain, never replace).
 */
export class LogCollector {
  readonly buffer: RingBuffer<LogEntry>;
  private nextId = 1;
  private originals: Partial<Record<LogLevel, ConsoleFn>> = {};
  private previousHandler?: GlobalHandler;
  private installed = false;
  private reentrant = false;
  private listeners = new Set<(e: LogEntry) => void>();

  constructor(
    capacity = 500,
    private readonly routeOf: () => string | undefined = () => undefined,
  ) {
    this.buffer = new RingBuffer(capacity);
  }

  install(): void {
    if (this.installed) return;
    this.installed = true;
    const c = console as unknown as Record<LogLevel, ConsoleFn>;
    for (const level of LEVELS) {
      const original = c[level];
      if (typeof original !== 'function') continue;
      this.originals[level] = original;
      const collector = this;
      c[level] = function patched(this: unknown, ...args: unknown[]) {
        collector.capture(level, args);
        return original.apply(this, args);
      };
    }
    const EU = (globalThis as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils;
    if (EU?.getGlobalHandler && EU.setGlobalHandler) {
      this.previousHandler = EU.getGlobalHandler();
      const prev = this.previousHandler;
      EU.setGlobalHandler((error: unknown, isFatal?: boolean) => {
        try {
          this.addError(error, 'global-error', isFatal === true);
        } catch {
          // never interfere with the app's own error handling
        }
        prev?.(error, isFatal);
      });
    }
  }

  uninstall(): void {
    if (!this.installed) return;
    const c = console as unknown as Record<LogLevel, ConsoleFn>;
    for (const level of LEVELS) {
      const o = this.originals[level];
      if (o) c[level] = o;
    }
    const EU = (globalThis as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils;
    if (EU && this.previousHandler) EU.setGlobalHandler(this.previousHandler);
    this.installed = false;
  }

  onEntry(fn: (e: LogEntry) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private capture(level: LogLevel, args: unknown[]): void {
    if (this.reentrant) return;
    this.reentrant = true;
    try {
      const err = args.find((a): a is Error => a instanceof Error);
      const message = args.map((a) => stringifyArg(a)).join(' ');
      const source = /unhandled promise rejection/i.test(message) ? 'promise' : 'console';
      this.add({
        level,
        message,
        source,
        ...(err?.stack ? { stack: err.stack } : {}),
      });
    } catch {
      // logging must never throw into app code
    } finally {
      this.reentrant = false;
    }
  }

  addError(error: unknown, source: LogEntry['source'], fatal = false): void {
    const e = error instanceof Error ? error : new Error(stringifyArg(error));
    this.add({
      level: 'error',
      message: `${e.name}: ${e.message}`,
      source,
      fatal,
      ...(e.stack ? { stack: e.stack } : {}),
    });
  }

  add(entry: Omit<LogEntry, 'id' | 'ts' | 'route'>): void {
    const message = truncate(redactText(entry.message), MAX_MESSAGE);
    const last = this.buffer.last();
    if (last && last.message === message && last.level === entry.level && last.source === entry.source) {
      last.repeat = (last.repeat ?? 1) + 1;
      last.ts = Date.now();
      return;
    }
    const route = this.routeOf();
    const full: LogEntry = {
      id: this.nextId++,
      ts: Date.now(),
      level: entry.level,
      message,
      source: entry.source,
      ...(entry.fatal ? { fatal: true } : {}),
      ...(entry.stack ? { stack: truncate(redactText(entry.stack), MAX_STACK) } : {}),
      ...(route ? { route } : {}),
    };
    this.buffer.push(full);
    this.listeners.forEach((l) => l(full));
  }

  query(opts: { levels?: LogLevel[]; limit?: number; sinceId?: number; errorsOnly?: boolean } = {}): LogEntry[] {
    const levels = opts.errorsOnly ? new Set<LogLevel>(['error']) : opts.levels ? new Set(opts.levels) : undefined;
    return this.buffer.toArray(
      (e) => (!levels || levels.has(e.level)) && (opts.sinceId === undefined || e.id > opts.sinceId),
      opts.limit ?? 50,
    );
  }

  get lastId(): number {
    return this.nextId - 1;
  }
}
