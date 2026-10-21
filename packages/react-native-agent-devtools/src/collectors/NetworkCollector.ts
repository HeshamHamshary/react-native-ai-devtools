import type { NetworkEntry } from 'react-native-agent-devtools-protocol';
import { redactBody, redactUrl } from 'react-native-agent-devtools-protocol';
import { RingBuffer } from '../utils/RingBuffer';
import { clock } from '../utils/misc';

export interface NetworkOptions {
  /** Capture request/response bodies (redacted, truncated). Off by default. */
  captureBodies?: boolean;
  maxBodyBytes?: number;
  capacity?: number;
  /** Return true to skip a URL entirely (e.g. analytics). */
  ignore?: (url: string) => boolean;
}

interface XhrMeta {
  method: string;
  url: string;
}

type XhrLike = {
  status: number;
  responseType: string;
  responseText?: string;
  _response?: unknown;
  getResponseHeader(name: string): string | null;
  addEventListener(type: string, fn: (e?: { type?: string }) => void): void;
  __rnad?: XhrMeta;
};

// Dev-server housekeeping traffic is not app traffic.
const DEV_SERVER_PATH = /\/(symbolicate|open-stack-frame|open-url|status|message|inspector|logs|reload)(\?|$)/;

/**
 * Records XMLHttpRequest traffic (React Native's `fetch` is implemented on top of
 * XMLHttpRequest, so both are covered). Native-originated requests (image loading,
 * native SDKs, WebViews) are NOT visible to this collector.
 */
export class NetworkCollector {
  readonly buffer: RingBuffer<NetworkEntry>;
  private nextId = 1;
  private installed = false;
  private origOpen?: (...a: unknown[]) => unknown;
  private origSend?: (...a: unknown[]) => unknown;
  private pending = new Map<number, NetworkEntry>();

  constructor(
    private readonly opts: NetworkOptions = {},
    private readonly routeOf: () => string | undefined = () => undefined,
  ) {
    this.buffer = new RingBuffer(opts.capacity ?? 300);
  }

  install(): void {
    if (this.installed) return;
    const XHR = (globalThis as unknown as { XMLHttpRequest?: { prototype: Record<string, unknown> } }).XMLHttpRequest;
    if (!XHR) return;
    this.installed = true;
    const proto = XHR.prototype;
    const collector = this;
    this.origOpen = proto.open as (...a: unknown[]) => unknown;
    this.origSend = proto.send as (...a: unknown[]) => unknown;
    const origOpen = this.origOpen;
    const origSend = this.origSend;

    proto.open = function open(this: XhrLike, method: unknown, url: unknown, ...rest: unknown[]) {
      this.__rnad = { method: String(method).toUpperCase(), url: String(url) };
      return origOpen.call(this, method, url, ...rest);
    };

    proto.send = function send(this: XhrLike, body?: unknown) {
      try {
        collector.track(this, body);
      } catch {
        // never break the request
      }
      return origSend.call(this, body);
    };
  }

  uninstall(): void {
    if (!this.installed) return;
    const XHR = (globalThis as unknown as { XMLHttpRequest?: { prototype: Record<string, unknown> } }).XMLHttpRequest;
    if (XHR) {
      XHR.prototype.open = this.origOpen;
      XHR.prototype.send = this.origSend;
    }
    this.installed = false;
  }

  private track(xhr: XhrLike, body: unknown): void {
    const meta = xhr.__rnad;
    if (!meta) return;
    if (DEV_SERVER_PATH.test(meta.url) && /:(8081|19000|19001)\//.test(meta.url)) return;
    if (this.opts.ignore?.(meta.url)) return;

    const maxBody = this.opts.maxBodyBytes ?? 4_096;
    const started = clock();
    const route = this.routeOf();
    const entry: NetworkEntry = {
      id: this.nextId++,
      ts: Date.now(),
      method: meta.method,
      url: redactUrl(meta.url),
      pending: true,
      ...(route ? { route } : {}),
      ...(typeof body === 'string' ? { requestBytes: body.length } : {}),
      ...(this.opts.captureBodies && typeof body === 'string' && body ? { requestBody: redactBody(body, maxBody) } : {}),
    };
    this.buffer.push(entry);
    this.pending.set(entry.id, entry);

    let failure: string | undefined;
    const mark = (reason: string) => () => {
      failure = reason;
    };
    xhr.addEventListener('error', mark('network error'));
    xhr.addEventListener('timeout', mark('timeout'));
    xhr.addEventListener('abort', mark('aborted'));
    xhr.addEventListener('loadend', () => {
      this.pending.delete(entry.id);
      delete entry.pending;
      entry.durationMs = Math.round(clock() - started);
      entry.status = xhr.status;
      entry.ok = xhr.status >= 200 && xhr.status < 400 && !failure;
      if (failure || xhr.status === 0) entry.error = failure ?? 'request failed (status 0)';
      const len = xhr.getResponseHeader('content-length');
      const type = xhr.getResponseHeader('content-type');
      if (len) entry.responseBytes = Number(len);
      if (type) entry.responseType = type.split(';')[0];
      if (this.opts.captureBodies) {
        try {
          const text = xhr.responseType === '' || xhr.responseType === 'text' ? xhr.responseText : undefined;
          if (typeof text === 'string' && text) entry.responseBody = redactBody(text, maxBody);
        } catch {
          // responseText throws for non-text responses
        }
      }
    });
  }

  /** Requests started after `sinceTs` (epoch ms) that are still in flight. */
  inflightSince(sinceTs: number): number {
    let n = 0;
    for (const e of this.pending.values()) if (e.ts >= sinceTs) n++;
    return n;
  }

  query(opts: { failuresOnly?: boolean; limit?: number; urlContains?: string; sinceId?: number } = {}): NetworkEntry[] {
    const needle = opts.urlContains?.toLowerCase();
    return this.buffer.toArray(
      (e) =>
        (!opts.failuresOnly || (!e.pending && e.ok === false)) &&
        (!needle || e.url.toLowerCase().includes(needle)) &&
        (opts.sinceId === undefined || e.id > opts.sinceId),
      opts.limit ?? 30,
    );
  }

  get lastId(): number {
    return this.nextId - 1;
  }
}
