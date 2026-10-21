import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import type { CapabilityMap, DeviceInfo, RpcMethod, ServerMessage, ToolError } from 'react-native-agent-devtools-protocol';
import { encode } from 'react-native-agent-devtools-protocol';

export class RpcError extends Error {
  readonly code: ToolError['code'];

  constructor(code: ToolError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

interface Pending {
  resolve: (v: RpcResult) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  t0: number;
  method: RpcMethod;
}

export interface RpcResult<T = unknown> {
  result: T;
  /** Device-side execution time. */
  deviceMs: number;
  /** Server-observed round trip (includes transport + device). */
  rttMs: number;
}

/** One connected app instance. */
export class DeviceSession extends EventEmitter {
  readonly id = randomUUID();
  readonly connectedAt = Date.now();
  private pending = new Map<string, Pending>();
  private seq = 0;
  stats = { calls: 0, rttMs: 0, deviceMs: 0 };

  private readonly ws: WebSocket;
  readonly info: DeviceInfo;
  readonly capabilities: CapabilityMap;
  readonly remote: boolean;
  /** Paired with a code from the server terminal: may approve edits and Claude Code permissions. */
  readonly trusted: boolean;

  constructor(ws: WebSocket, info: DeviceInfo, capabilities: CapabilityMap, remote: boolean, trusted = false) {
    super();
    this.ws = ws;
    this.info = info;
    this.capabilities = capabilities;
    this.remote = remote;
    this.trusted = trusted;
  }

  get label(): string {
    const i = this.info;
    return `${i.appName || 'app'} on ${i.platform} ${i.osVersion}${i.model ? ` (${i.model}${i.isEmulator ? ', emulator' : ''})` : ''}`;
  }

  get open(): boolean {
    return this.ws.readyState === this.ws.OPEN;
  }

  /** Stable id of the app install (from hello), used to resume its conversation. */
  instance?: string;

  send(msg: ServerMessage): void {
    if (this.open) this.ws.send(encode(msg));
    if (msg.type.startsWith('chat.')) this.emit('sent', msg);
  }

  rpc<T = unknown>(method: RpcMethod, params: Record<string, unknown> = {}, timeoutMs = 30_000, signal?: AbortSignal): Promise<RpcResult<T>> {
    if (!this.open) return Promise.reject(new RpcError('NO_DEVICE', 'Device disconnected'));
    const id = `r${++this.seq}`;
    return new Promise<RpcResult<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.send({ type: 'rpc.cancel', id });
        reject(new RpcError('TIMEOUT', `Device did not answer ${method} within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: RpcResult) => void, reject, timer, t0: performance.now(), method });
      signal?.addEventListener('abort', () => {
        if (!this.pending.has(id)) return;
        clearTimeout(timer);
        this.pending.delete(id);
        this.send({ type: 'rpc.cancel', id });
        reject(new RpcError('CANCELLED', `${method} cancelled`));
      });
      this.send({ type: 'rpc.call', id, method, params, timeoutMs });
    });
  }

  handleResult(id: string, ok: boolean, payload: unknown, deviceMs = 0): void {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    const rttMs = Math.round(performance.now() - p.t0);
    this.stats.calls++;
    this.stats.rttMs += rttMs;
    this.stats.deviceMs += deviceMs;
    if (ok) p.resolve({ result: payload, deviceMs, rttMs });
    else {
      const err = payload as ToolError;
      p.reject(new RpcError(err.code, err.message));
    }
  }

  cancelAll(): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.send({ type: 'rpc.cancel', id });
      p.reject(new RpcError('CANCELLED', `${p.method} cancelled`));
    }
    this.pending.clear();
  }

  close(): void {
    this.cancelAll();
    this.emit('close');
  }

  /** Close the socket (the app reconnects and starts over, e.g. after its pairing was revoked). */
  disconnect(code: number, reason: string): void {
    this.ws.close(code, reason);
  }
}

export class DeviceRegistry extends EventEmitter {
  private devices = new Map<string, DeviceSession>();
  private focused?: string;

  add(d: DeviceSession): void {
    this.devices.set(d.id, d);
    d.once('close', () => {
      this.devices.delete(d.id);
      this.emit('change');
    });
    this.emit('change');
  }

  list(): DeviceSession[] {
    return [...this.devices.values()];
  }

  /** The device the developer last chatted from, else the most recently connected one (what MCP tools act on by default). */
  active(): DeviceSession | undefined {
    const focused = this.focused ? this.devices.get(this.focused) : undefined;
    if (focused) return focused;
    const all = this.list();
    return all[all.length - 1];
  }

  focus(id: string): void {
    this.focused = id;
  }

  get(id: string): DeviceSession | undefined {
    return this.devices.get(id);
  }

  /** Select by id, or by platform ('ios' | 'android': most recent of that platform). */
  find(selector: string | undefined): DeviceSession | undefined {
    if (!selector) return this.active();
    const byId = this.devices.get(selector);
    if (byId) return byId;
    return this.list()
      .filter((d) => d.info.platform === selector)
      .pop();
  }
}
