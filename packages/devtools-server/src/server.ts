import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientMessage, ServerInfo } from 'react-native-agent-devtools-protocol';
import { MAX_MESSAGE_BYTES, encode, isRpcMethod, parseClientMessage, redactText } from 'react-native-agent-devtools-protocol';
import { claudeCodeSignIn, type SignInBackend, type SignInHandle } from './agent/account.ts';
import { AgentSession, verifyAgentAuth } from './agent/AgentSession.ts';
import { chooseAuthMode, stateDir as defaultStateDir, type AuthMode } from './agent/credentials.ts';
import { DemoSession } from './agent/DemoSession.ts';
import { loadProjectInstructions } from './agent/prompt.ts';
import { ChannelChat, ChannelHub } from './channel/hub.ts';
import { Approvals } from './security/approvals.ts';
import { Pairing, checkRequestOrigin, isLoopback } from './security/auth.ts';
import { RepoAccess } from './security/repoAccess.ts';
import { bearerOk, loadServerToken } from './security/serverToken.ts';
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
  /**
   * Credentials for the in-app agent (`--auth`). Without it the only candidate is a
   * Console sign-in completed for this tool; ambient credentials are never adopted.
   */
  auth?: string;
  /** Expose /mcp for Claude Code. */
  mcp: boolean;
  /** Add the repo's CLAUDE.md text to the agent's instructions. */
  projectInstructions?: boolean;
  /** Require pairing for every device, including simulators on this computer. */
  requirePairing?: boolean;
  /** Where the server token and pairings are kept (default ~/.config/react-native-agent-devtools). */
  stateDir?: string;
  log: (line: string) => void;
  /** Scripted, clearly-labelled replies for UI development without credentials. */
  demoAgent?: boolean;
  /** For tests: replace Anthropic sign-in (defaults to `claude auth login --console`). */
  signIn?: SignInBackend;
  /** For tests: replace the credential-source check (spawns the Claude Code subprocess). */
  verifyAuth?: (mode: AuthMode) => Promise<{ ok: boolean; source: string; reason?: string }>;
  /** For tests: replace agent session creation. */
  sessionFactory?: (device: DeviceSession) => AgentSession | DemoSession | undefined;
  /** For tests: override credential detection. */
  agentAvailable?: { available: boolean; reason?: string };
  /** For tests: the environment credentials are chosen from (default process.env). */
  env?: NodeJS.ProcessEnv;
}

export interface RunningServer {
  port: number;
  /** Bearer token local clients must present (CLI, Claude Code bridge, MCP over HTTP). */
  token: string;
  devices: DeviceRegistry;
  pairing: Pairing;
  agent: () => Availability;
  /** Credentials found in the environment that are deliberately not used. */
  authNotices: string[];
  close(): Promise<void>;
}

const HELLO_TIMEOUT_MS = 5_000;

type Availability = { available: boolean; reason?: string; source?: string; via?: 'claude-code'; mode?: AuthMode };
type ChatSession = AgentSession | DemoSession | ChannelChat;

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

const UNAUTHORIZED = 'missing or invalid Authorization: Bearer token (see `react-native-agent-devtools-server token`)';

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const log = opts.log;
  const env = opts.env ?? process.env;
  const dir = opts.stateDir ?? defaultStateDir();
  const token = loadServerToken(dir);
  const devices = new DeviceRegistry();
  const pairing = new Pairing({ storeFile: join(dir, 'paired-devices.json') });
  const repo = new RepoAccess(opts.repoRoots);
  const instructions = opts.projectInstructions ? loadProjectInstructions(repo.roots) : undefined;
  const signIn = opts.signIn ?? claudeCodeSignIn;
  let pendingSignIn: SignInHandle | undefined;
  /** Set when the API rejects the credentials mid-session; cleared by a new sign-in. */
  let authRejected: string | undefined;
  let authNotices: string[] = [];
  const computeAvailability = async (): Promise<Availability> => {
    if (opts.demoAgent) return { available: true, source: 'demo agent (scripted, no model)' };
    if (hub.chatAvailable) return { available: true, source: 'your Claude Code session (channel)', via: 'claude-code' };
    if (opts.agentAvailable) return opts.agentAvailable;
    if (!opts.agent) return { available: false, reason: 'agent disabled (--no-agent)' };
    if (authRejected) return { available: false, reason: `${authRejected} Tap "Set up Claude" to sign in again.` };
    const signedIn = opts.auth === undefined || opts.auth === 'console' ? (await signIn.status()).loggedIn : false;
    const choice = chooseAuthMode(opts.auth, env, signedIn);
    authNotices = choice.notices;
    if (choice.error) return { available: false, reason: choice.error, ...(choice.mode ? { mode: choice.mode } : {}) };
    if (!choice.mode || (choice.mode === 'console' && !signedIn)) {
      return { available: false, reason: 'Not signed in. Tap "Set up Claude" to sign in with your Anthropic Console account.' };
    }
    // Local control request only; no prompt is sent and no model is called.
    const v = await (opts.verifyAuth ?? verifyAgentAuth)(choice.mode);
    return v.ok ? { available: true, source: v.source, mode: choice.mode } : { available: false, reason: v.reason, mode: choice.mode };
  };
  const approvals = new Approvals();
  const ask = approvals.ask.bind(approvals);
  const approve = approvals.approve.bind(approvals);
  const hub = new ChannelHub({ devices, log, ask, onChange: () => void refreshAgent() });

  let availability = await computeAvailability();
  const sessions = new Map<string, ChatSession>();
  /** Model chosen in the app, per device (built-in agent only). */
  const modelFor = new Map<string, string>();
  const mcp = opts.mcp ? createMcpHandler(devices, SERVER_VERSION) : undefined;
  let port = opts.port;

  const serverInfo = (session?: ChatSession, device?: DeviceSession): ServerInfo => {
    const model = availability.via ? undefined : (session?.modelName ?? (device ? modelFor.get(device.id) : undefined) ?? opts.model);
    const consoleSetup = availability.mode === undefined || availability.mode === 'console';
    return {
      version: SERVER_VERSION,
      agent: {
        available: availability.available,
        ...(availability.reason ? { reason: availability.reason } : {}),
        ...(model ? { model } : {}),
        ...(availability.via ? { via: availability.via } : {}),
        ...(availability.available && availability.source ? { credentials: availability.source } : {}),
        setup: !opts.demoAgent && opts.agent && consoleSetup,
      },
      repoAccess: repo.enabled ? (opts.allowEdits ? 'read-write' : 'read') : 'none',
      network: opts.lan ? 'lan' : 'loopback',
    };
  };

  const newSession = (device: DeviceSession): ChatSession | undefined => {
    if (opts.demoAgent) return new DemoSession(device);
    if (!availability.available) return undefined;
    if (availability.via === 'claude-code') return new ChannelChat(device, hub);
    if (opts.sessionFactory) return opts.sessionFactory(device);
    if (!availability.mode) return undefined;
    const s = new AgentSession(device, {
      auth: availability.mode,
      model: modelFor.get(device.id) ?? opts.model,
      repo,
      allowEdits: opts.allowEdits,
      instructions,
      log,
      approve,
      onAuthError: (reason) => {
        if (authRejected) return;
        authRejected = reason;
        log(`agent credentials rejected: ${reason}`);
        void refreshAgent();
      },
    });
    s.start();
    return s;
  };

  /** Re-evaluate credentials and (re)start sessions on every connected device. */
  const refreshAgent = async () => {
    availability = await computeAvailability();
    for (const d of devices.list()) {
      sessions.get(d.id)?.close();
      sessions.delete(d.id);
      const s = newSession(d);
      if (s) sessions.set(d.id, s);
      d.send({ type: 'welcome', sessionId: d.id, trusted: d.trusted, server: serverInfo(s, d) });
    }
    log(`agent ${availability.available ? `ready (credentials: ${availability.source})` : `unavailable: ${availability.reason}`}`);
  };

  const broadcast = (m: Parameters<DeviceSession['send']>[0]) => devices.list().forEach((d) => d.send(m));

  /** Anthropic Console sign-in in the computer's browser. Tapping again restarts it (e.g. after closing the tab). */
  const startSignIn = () => {
    pendingSignIn?.cancel();
    const attempt = signIn.start(log);
    pendingSignIn = attempt;
    log('sign-in started: finish it in your browser');
    broadcast({ type: 'setup.status', state: 'waiting', message: 'Finish signing in in the browser on your computer.' });
    void attempt.done.then(async (r) => {
      if (pendingSignIn !== attempt) return; // superseded by a newer attempt
      pendingSignIn = undefined;
      if (!r.ok) {
        log(`sign-in failed: ${r.reason ?? 'unknown error'}`);
        broadcast({ type: 'setup.status', state: 'failed', message: r.reason ?? 'Sign-in did not complete.' });
        return;
      }
      authRejected = undefined;
      await refreshAgent();
      if (!availability.available) broadcast({ type: 'setup.status', state: 'failed', message: availability.reason ?? 'The agent still cannot start.' });
    });
  };

  // ---------------------------------------------------------------- HTTP
  const http: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const origin = checkRequestOrigin(req, opts.lan);
    if (!origin.ok) return json(res, 403, { error: origin.reason });
    if (url.pathname === '/health') return json(res, 200, { ok: true, version: SERVER_VERSION });
    // Everything below controls the app: loopback only (even in LAN mode) and token-authenticated.
    if (!isLoopback(req.socket.remoteAddress)) return json(res, 403, { error: 'loopback only' });
    if (!bearerOk(req, token)) return json(res, 401, { error: UNAUTHORIZED });
    try {
      if (url.pathname === '/mcp' && mcp) {
        const raw = req.method === 'POST' ? await readBody(req, 2_000_000) : '';
        await mcp(req, res, raw ? JSON.parse(raw) : undefined);
        return;
      }
      if (url.pathname === '/api/channel/arm' && req.method === 'POST') {
        // Called by the `claude` launcher right before it starts Claude Code.
        hub.arm();
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/devices' && req.method === 'GET') {
        return json(
          res,
          200,
          devices.list().map((d) => ({ id: d.id, label: d.label, info: d.info, remote: d.remote, trusted: d.trusted, stats: d.stats })),
        );
      }
      if (url.pathname === '/api/pairing' && req.method === 'GET') {
        return json(res, 200, { code: pairing.currentCode, expiresAt: pairing.codeExpiresAt, paired: pairing.list() });
      }
      if (url.pathname === '/api/pairing/revoke' && req.method === 'POST') {
        pairing.revokeAll();
        // Trust is decided at connect time: make paired apps reconnect so it takes effect now.
        devices.list().filter((d) => d.trusted).forEach((d) => d.disconnect(4004, 'pairing revoked'));
        log(`all device pairings revoked; new pairing code: ${pairing.currentCode}`);
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/rpc' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req)) as { method?: unknown; params?: Record<string, unknown>; device?: string; timeoutMs?: number };
        if (!isRpcMethod(body.method)) return json(res, 400, { error: `unknown method ${String(body.method)}` });
        const device = devices.find(body.device);
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
      log(`http error: ${redactText(String(e))}`);
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
    }
  });

  // ------------------------------------------------------------ WebSocket
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const refuse = (socket: { write(s: string): void; destroy(): void }, status: string) => {
    socket.write(`HTTP/1.1 ${status}\r\n\r\n`);
    socket.destroy();
  };
  http.on('upgrade', (req, socket, head) => {
    const origin = checkRequestOrigin(req, opts.lan);
    if (!origin.ok) {
      log(`rejected websocket: ${origin.reason}`);
      return refuse(socket, '403 Forbidden');
    }
    if (new URL(req.url ?? '/', 'http://localhost').pathname === '/channel') {
      // The Claude Code channel bridge runs on this computer: loopback only, even with --lan, and token-authenticated.
      if (!isLoopback(req.socket.remoteAddress)) return refuse(socket, '403 Forbidden');
      if (!bearerOk(req, token)) {
        log('rejected channel bridge: missing or invalid token');
        return refuse(socket, '401 Unauthorized');
      }
      wss.handleUpgrade(req, socket, head, (ws) => hub.accept(ws));
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
        if (remote && !opts.lan) return ws.close(4003, 'remote connections disabled');
        const mustPair = remote || opts.requirePairing === true;
        let trusted = pairing.verifyToken(msg.auth?.token);
        let issued: string | undefined;
        if (!trusted && msg.auth?.pairingCode) {
          const r = pairing.redeem(msg.auth.pairingCode, `${msg.device.appName ?? 'app'} on ${msg.device.platform}${msg.device.model ? ` (${msg.device.model})` : ''}`);
          if (!r.ok) {
            log(`pairing failed from ${addr}: ${r.reason}`);
            send({ type: 'auth.required', reason: r.reason, pairing: true });
            return;
          }
          trusted = true;
          issued = r.token;
          log(`paired ${msg.device.appName ?? 'app'} on ${msg.device.platform}${remote ? ` at ${addr}` : ''}; new pairing code: ${pairing.currentCode}`);
        }
        if (mustPair && !trusted) {
          send({ type: 'auth.required', reason: 'Enter the pairing code shown in the server terminal.', pairing: true });
          return;
        }
        device = new DeviceSession(ws, msg.device, msg.capabilities, remote, trusted);
        devices.add(device);
        const session = newSession(device);
        if (session) sessions.set(device.id, session);
        log(`device connected: ${device.label}${remote ? ` from ${addr}` : ''}${trusted ? ' (paired)' : ''}`);
        device.send({ type: 'welcome', sessionId: device.id, trusted, ...(issued ? { deviceToken: issued } : {}), server: serverInfo(session, device) });
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
          devices.focus(device.id);
          log(`chat ← ${device.label}: ${redactText(msg.text).slice(0, 120)}`);
          await session.send(msg.text, msg.id, msg.context);
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
        case 'chat.config': {
          if (msg.model) modelFor.set(device.id, msg.model);
          else modelFor.delete(device.id);
          sessions.get(device.id)?.close();
          sessions.delete(device.id);
          const s = newSession(device);
          if (s) sessions.set(device.id, s);
          log(`model for ${device.label}: ${msg.model ?? 'default'}`);
          device.send({ type: 'welcome', sessionId: device.id, trusted: device.trusted, server: serverInfo(s, device) });
          return;
        }
        case 'setup.open':
          if (opts.demoAgent || !opts.agent) return;
          startSignIn();
          return;
        case 'approval.response':
          approvals.answer(msg.id, msg.approved);
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
      modelFor.delete(device.id);
      sessions.get(device.id)?.close();
      sessions.delete(device.id);
      device.close();
    });
    ws.on('error', (e) => log(`socket error: ${redactText(e.message)}`));
  };

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(opts.port, opts.lan ? '0.0.0.0' : '127.0.0.1', () => resolve());
  });
  const address = http.address();
  port = typeof address === 'object' && address ? address.port : opts.port;

  return {
    port,
    token,
    devices,
    pairing,
    agent: () => availability,
    get authNotices() {
      return authNotices;
    },
    close: async () => {
      pendingSignIn?.cancel();
      sessions.forEach((s) => s.close());
      wss.clients.forEach((c) => c.terminate());
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}
