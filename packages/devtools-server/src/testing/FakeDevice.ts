import WebSocket from 'ws';
import { PROTOCOL_VERSION, type ServerMessage } from 'react-native-agent-devtools-protocol';

/** Minimal fake device speaking the real protocol. */
export class FakeDevice {
  ws: WebSocket;
  inbox: ServerMessage[] = [];
  private waiters: ((m: ServerMessage) => void)[] = [];
  handlers: Record<string, (params: unknown) => unknown> = {};

  constructor(url: string, headers: Record<string, string> = {}) {
    this.ws = new WebSocket(url, { headers });
    this.ws.on('message', (data) => {
      const m = JSON.parse(String(data)) as ServerMessage;
      if (m.type === 'rpc.call') {
        const h = this.handlers[m.method];
        if (h === undefined) return; // simulate an unresponsive device
        try {
          this.send({ type: 'rpc.result', id: m.id, ok: true, result: h(m.params), deviceMs: 3 });
        } catch (e) {
          this.send({ type: 'rpc.result', id: m.id, ok: false, error: { code: 'NOT_FOUND', message: String((e as Error).message) } });
        }
        return;
      }
      this.inbox.push(m);
      this.waiters.splice(0).forEach((w) => w(m));
    });
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
      this.ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
  }

  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }

  hello(auth?: { token?: string; pairingCode?: string }) {
    this.send({
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      device: { platform: 'ios', osVersion: '26.0', libraryVersion: '0.1.0', window: { width: 402, height: 874, scale: 3 }, appName: 'Test' },
      capabilities: { tap: { supported: true, mode: 'semantic' } },
      ...(auth ? { auth } : {}),
    });
  }

  async next<T extends ServerMessage['type']>(type: T, timeoutMs = 3_000): Promise<Extract<ServerMessage, { type: T }>> {
    const found = this.inbox.find((m) => m.type === type);
    if (found) {
      this.inbox.splice(this.inbox.indexOf(found), 1);
      return found as Extract<ServerMessage, { type: T }>;
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
      const w = (m: ServerMessage): void => {
        if (m.type !== type) {
          this.waiters.push(w);
          return;
        }
        clearTimeout(t);
        this.inbox.splice(this.inbox.indexOf(m), 1);
        resolve(m as Extract<ServerMessage, { type: T }>);
      };
      this.waiters.push(w);
    });
  }

  closed(): Promise<number> {
    return new Promise((r) => this.ws.once('close', (code) => r(code)));
  }

  close() {
    this.ws.close();
  }
}
