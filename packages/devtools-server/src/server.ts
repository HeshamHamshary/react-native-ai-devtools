import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientMessage, ServerInfo } from 'react-native-agent-devtools-protocol';
import { MAX_MESSAGE_BYTES, encode, isRpcMethod, parseClientMessage, redactText } from 'react-native-agent-devtools-protocol';
import { AgentSession, agentAvailability } from './agent/AgentSession.ts';
import { Pairing, checkRequestOrigin, isLoopback } from './security/auth.ts';
import { RepoAccess } from './security/repoAccess.ts';
import { DeviceRegistry, DeviceSession, RpcError } from './transport/devices.ts';
import { createMcpHandler } from './transport/mcpEndpoint.ts';

export const SERVER_VERSION = '0.1.0';

export interface ServerOptions {
  port: number;
  /** Listen on all interfaces and require pairing for non-loopback devices. */
  lan: boolean;
  repoRoots: string[];
  allowEdits: boolean;
  model?: string;
  /** Run the in-app chat agent (requires model credentials). */
  agent: boolean;
  /** Expose /mcp for Claude Code. */
  mcp: boolean;
  loadProjectSettings: boolean;
  log: (line: string) => void;
  /** For tests: override credential detection. */
  agentAvailable?: { available: boolean; reason?: string };
}

export interface RunningServer {
  port: number;
  devices: DeviceRegistry;
  pairing: Pairing;
  close(): Promise<void>;
}

const HELLO_TIMEOUT_MS = 5_000;

function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const log = opts.log;
  const devices = new DeviceRegistry();
  const pairing = new Pairing();
  const repo = new RepoAccess(opts.repoRoots);
  const availability = opts.agentAvailable ?? (opts.agent ? agentAvailability() : { available: false, reason: 'agent disabled (--no-agent)' });
  const sessions = new Map<string, AgentSession>();
  const approvals = new Map<string, (ok: boolean) => void>();
  const mcp = opts.mcp ? createMcpHandler(devices, SERVER_VERSION) : undefined;

  const approve = (device: DeviceSession, title: string, detail: string): Promise<boolean> =>
    new Promise((resolve) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        approvals.delete(id);
        resolve(false);
      }, 120_000);
      approvals.set(id, (ok) => {
        clearTimeout(timer);
        resolve(ok);
      });
      device.send({ type: 'approval.request', id, title, detail, risk: 'high' });
    });

  const serverInfo = (session?: AgentSession): ServerInfo => ({
    version: SERVER_VERSION,
    agent: { available: availability.available, ...(availability.reason ? { reason: availability.reason } : {}), ...(session?.modelName ?? opts.model ? { model: session?.modelName ?? opts.model } : {}) },
    repoAccess: repo.enabled ? (opts.allowEdits ? 'read-write' : 'read') : 'none',
    network: opts.lan ? 'lan' : 'loopback',
  });

  const newSession = (device: DeviceSession): AgentSession | undefined => {
    if (!availability.available) return undefined;
    const s = new AgentSession(device, {
      model: opts.model,
      repo,
      allowEdits: opts.allowEdits,
      loadProjectSettings: opts.loadProjectSettings,
      log,
      approve,
    });
    s.start();
    return s;
  };

  // ---------------------------------------------------------------- HTTP
  const http: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const origin = checkRequestOrigin(req, opts.lan);
    if (!origin.ok) return json(res, 403, { error: origin.reason });
    if (url.pathname === '/health') {
      return json(res, 200, { ok: true, version: SERVER_VERSION, devices: devices.list().length, agent: availability.available });
    }
    // Everything below controls the app: loopback only, even in LAN mode.
    if (!isLoopback(req.socket.remoteAddress)) return json(res, 403, { error: 'loopback only' });
    try {
      if (url.pathname === '/mcp' && mcp) {
        const raw = req.method === 'POST' ? await readBody(req, 2_000_000) : '';
        await mcp(req, res, raw ? JSON.parse(raw) : undefined);
        return;
      }
      if (url.pathname === '/api/devices' && req.method === 'GET') {
        return json(res, 200, devices.list().map((d) => ({ id: d.id, label: d.label, info: d.info, remote: d.remote, stats: d.stats })));
      }
      if (url.pathname === '/api/rpc' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req)) as { method?: unknown; params?: Record<string, unknown>; device?: string; timeoutMs?: number };
        if (!isRpcMethod(body.method)) return json(res, 400, { error: `unknown method ${String(body.method)}` });
        const device = body.device ? devices.get(body.device) : devices.active();
        if (!device) return json(res, 409, { error: 'no device connected' });
        try {
          const r = await device.rpc(body.method, body.params ?? {}, Math.min(body.timeoutMs ?? 30_000, 90_000));
          return json(res, 200, { ok: true, ...r });
        } catch (e) {
          return json(res, 200, { ok: false, error: { code: e instanceof RpcError ? e.code : 'INTERNAL', message: String((e as Error).message) } });
        }
      }
      json(res, 404, { error: 'not found' });
    } catch (e) {
      log(`http error: ${String(e)}`);
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
    }
  });

  // ------------------------------------------------------------ WebSocket
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  http.on('upgrade', (req, socket, head) => {
    const origin = checkRequestOrigin(req, opts.lan);
    if (!origin.ok) {
      log(`rejected websocket: ${origin.reason}`);
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onSocket(ws, req));
  });

  const onSocket = (ws: WebSocket, req: IncomingMessage) => {
    const remote = !isLoopback(req.socket.remoteAddress);
    const addr = req.socket.remoteAddress ?? '?';
    let device: DeviceSession | undefined;
    const helloTimer = setTimeout(() => ws.close(4000, 'hello timeout'), HELLO_TIMEOUT_MS);
    const send = (m: Parameters<DeviceSession['send']>[0]) => ws.readyState === ws.OPEN && ws.send(encode(m));

    ws.on('message', async (data, isBinary) => {
      if (isBinary) return;
      const parsed = parseClientMessage(data.toString('utf8'));
      if (!parsed.ok) {
        log(`invalid message from ${addr}: ${parsed.error}`);
        if (!device) ws.close(4002, parsed.error.slice(0, 100));
        return;
      }
      const msg: ClientMessage = parsed.msg;
      if (!device) {
        if (msg.type !== 'hello') return ws.close(4001, 'expected hello');
        clearTimeout(helloTimer);
        let issued: string | undefined;
        if (remote) {
          if (!opts.lan) return ws.close(4003, 'remote connections disabled');
          if (!pairing.verifyToken(msg.auth?.token)) {
            if (!msg.auth?.pairingCode) {
              send({ type: 'auth.required', reason: 'Enter the pairing code shown in the server terminal.', pairing: true });
              return;
            }
            const r = pairing.redeem(msg.auth.pairingCode);
            if (!r.ok) {
              log(`pairing failed from ${addr}: ${r.reason}`);
              send({ type: 'auth.required', reason: r.reason, pairing: true });
              return;
            }
            issued = r.token;
            log(`paired device at ${addr}; new pairing code: ${pairing.currentCode}`);
          }
        }
        device = new DeviceSession(ws, msg.device, msg.capabilities, remote);
        devices.add(device);
        const session = newSession(device);
        if (session) sessions.set(device.id, session);
        log(`device connected: ${device.label}${remote ? ` from ${addr}` : ''}`);
        device.send({ type: 'welcome', sessionId: device.id, ...(issued ? { deviceToken: issued } : {}), server: serverInfo(session) });
        return;
      }

      switch (msg.type) {
        case 'rpc.result':
          device.handleResult(msg.id, msg.ok, msg.ok ? msg.result : msg.error, msg.deviceMs);
          return;
        case 'chat.send': {
          const session = sessions.get(device.id);
          if (!session) {
            device.send({ type: 'chat.error', message: availability.reason ?? 'Agent unavailable', code: 'AGENT_UNAVAILABLE' });
            return;
          }
          if (session.busy) {
            device.send({ type: 'chat.error', message: 'The agent is still working on the previous message. Stop it first.', code: 'BUSY' });
            return;
          }
          log(`chat ← ${device.label}: ${redactText(msg.text).slice(0, 120)}`);
          await session.send(msg.text, msg.id);
          return;
        }
        case 'chat.cancel':
          log('chat cancelled by user');
          await sessions.get(device.id)?.interrupt();
          return;
        case 'chat.reset': {
          sessions.get(device.id)?.close();
          sessions.delete(device.id);
          const s = newSession(device);
          if (s) sessions.set(device.id, s);
          return;
        }
        case 'approval.response':
          approvals.get(msg.id)?.(msg.approved);
          approvals.delete(msg.id);
          return;
        case 'ping':
          device.send({ type: 'pong', ts: msg.ts });
          return;
        case 'hello':
          return;
      }
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (!device) return;
      log(`device disconnected: ${device.label}`);
      sessions.get(device.id)?.close();
      sessions.delete(device.id);
      device.close();
    });
    ws.on('error', (e) => log(`socket error: ${e.message}`));
  };

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(opts.port, opts.lan ? '0.0.0.0' : '127.0.0.1', () => resolve());
  });
  const address = http.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;

  return {
    port,
    devices,
    pairing,
    close: async () => {
      sessions.forEach((s) => s.close());
      wss.clients.forEach((c) => c.terminate());
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}
