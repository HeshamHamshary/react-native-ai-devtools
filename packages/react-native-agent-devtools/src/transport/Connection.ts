import { Platform, TurboModuleRegistry } from 'react-native';
import type { ClientMessage, ServerMessage } from 'react-native-agent-devtools-protocol';
import { encode, parseServerMessage } from 'react-native-agent-devtools-protocol';

export type ConnectionState = 'connecting' | 'open' | 'closed';

export interface ConnectionHandlers {
  onState: (s: ConnectionState, detail?: string) => void;
  onMessage: (m: ServerMessage) => void;
  hello: () => ClientMessage;
}

/** The URL the JS bundle was loaded from (the Metro dev server in development). */
export function bundleURL(): string | undefined {
  try {
    const sourceCode = TurboModuleRegistry.get<{ getConstants(): { scriptURL?: string } } & import('react-native').TurboModule>('SourceCode');
    return sourceCode?.getConstants().scriptURL ?? undefined;
  } catch {
    return undefined;
  }
}

/** Derive the dev machine host from the Metro bundle URL the app was loaded from. */
export function defaultServerUrl(port = 8765): string {
  let host: string | undefined;
  const url = bundleURL();
  const m = url ? /^https?:\/\/([^/:]+)/.exec(url) : null;
  if (m?.[1]) host = m[1];
  host ??= Platform.OS === 'android' ? '10.0.2.2' : 'localhost';
  return `ws://${host}:${port}`;
}

/** Single persistent WebSocket with capped exponential backoff. */
export class Connection {
  private ws?: WebSocket;
  private stopped = true;
  private retry = 0;
  private timer?: ReturnType<typeof setTimeout>;
  bytesIn = 0;
  bytesOut = 0;

  constructor(
    private url: string,
    private readonly h: ConnectionHandlers,
  ) {}

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = undefined;
    this.h.onState('closed', 'disconnected');
  }

  setUrl(url: string): void {
    this.url = url;
    if (!this.stopped) {
      this.ws?.close();
    }
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(msg: ClientMessage): boolean {
    if (!this.isOpen) return false;
    const data = encode(msg);
    this.bytesOut += data.length;
    this.ws!.send(data);
    return true;
  }

  /** Reconnect immediately (e.g. after entering a pairing code). */
  reconnect(): void {
    this.retry = 0;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    if (!this.ws || this.stopped) {
      this.stopped = false;
      this.open();
    }
  }

  private open(): void {
    if (this.stopped) return;
    this.h.onState('connecting', this.url);
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this.h.onState('closed', String(e));
      this.schedule();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.h.onState('open');
      this.send(this.h.hello());
    };
    ws.onmessage = (ev: { data?: unknown }) => {
      if (typeof ev.data !== 'string') return;
      this.bytesIn += ev.data.length;
      const parsed = parseServerMessage(ev.data);
      if (parsed.ok) this.h.onMessage(parsed.msg);
    };
    ws.onerror = () => {
      // onclose follows; reconnect is scheduled there.
    };
    ws.onclose = (ev: { reason?: string; code?: number }) => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.h.onState('closed', ev.reason || `code ${ev.code ?? '?'}`);
      this.schedule();
    };
  }

  private schedule(): void {
    if (this.stopped) return;
    const delay = Math.min(5_000, 400 * 2 ** this.retry++);
    this.timer = setTimeout(() => this.open(), delay);
  }
}
