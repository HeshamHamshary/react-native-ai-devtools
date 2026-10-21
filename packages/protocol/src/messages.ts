import { PROTOCOL_VERSION } from './types.ts';
import type { CapabilityMap, DeviceInfo, ToolError } from './types.ts';

/** Methods the server may invoke on the device. */
export const RPC_METHODS = [
  'getCapabilities',
  'getScreen',
  'getUI',
  'resolve',
  'tap',
  'longPress',
  'typeText',
  'clearText',
  'scroll',
  'scrollTo',
  'swipe',
  'waitFor',
  'back',
  'runSequence',
  'screenshot',
  'getLogs',
  'getNetwork',
  'getNavigation',
  'getPerf',
  'inspect',
  'audit',
  'getSelection',
] as const;

export type RpcMethod = (typeof RPC_METHODS)[number];

const RPC_METHOD_SET: ReadonlySet<string> = new Set(RPC_METHODS);

export function isRpcMethod(v: unknown): v is RpcMethod {
  return typeof v === 'string' && RPC_METHOD_SET.has(v);
}

export interface TurnStats {
  totalMs: number;
  /** Time from sending the prompt to the first streamed token. */
  firstTokenMs?: number;
  /** Wall time spent executing device tools (round trip, including transport). */
  toolMs: number;
  /** Device-reported execution time across tool calls (excludes transport). */
  deviceMs: number;
  /** totalMs - toolMs: model reasoning + agent overhead. */
  modelMs: number;
  toolCalls: number;
  apiMs?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
}

export interface ServerInfo {
  version: string;
  agent: {
    available: boolean;
    reason?: string;
    model?: string;
    /** The server can run Anthropic sign-in on the computer. */
    setup?: boolean;
    /** The chat goes to the developer's own Claude Code session (channel) instead of the in-app agent. */
    via?: 'claude-code';
    /** Which credentials the in-app agent runs on (e.g. "Anthropic Console sign-in"). Never the credential itself. */
    credentials?: string;
  };
  repoAccess: 'none' | 'read' | 'read-write';
  network: 'loopback' | 'lan';
}

// ---- device -> server ----------------------------------------------------

export type ClientMessage =
  | {
      type: 'hello';
      protocol: number;
      device: DeviceInfo;
      capabilities: CapabilityMap;
      auth?: { token?: string; pairingCode?: string };
    }
  /** `context.selection`: the element the developer picked in inspect mode, as text. */
  | { type: 'chat.send'; id: string; text: string; context?: { selection?: string } }
  | { type: 'chat.cancel' }
  | { type: 'chat.reset' }
  /** Choose the in-app agent's model for this device (`undefined` = server default). Starts a new conversation. */
  | { type: 'chat.config'; model?: string }
  | { type: 'rpc.result'; id: string; ok: true; result: unknown; deviceMs?: number }
  | { type: 'rpc.result'; id: string; ok: false; error: ToolError; deviceMs?: number }
  | { type: 'approval.response'; id: string; approved: boolean }
  /** Ask the server to start Anthropic sign-in in the computer's browser. */
  | { type: 'setup.open' }
  | { type: 'ping'; ts: number };

// ---- server -> device ----------------------------------------------------

export type ChatState = 'idle' | 'thinking' | 'acting';

export type ServerMessage =
  /**
   * `trusted`: the device is paired, so it may approve code edits and Claude Code
   * permission requests. Unpaired simulators on the dev machine can chat but not approve.
   */
  | { type: 'welcome'; sessionId: string; deviceToken?: string; trusted?: boolean; server: ServerInfo }
  | { type: 'auth.required'; reason: string; pairing: boolean }
  | { type: 'chat.status'; state: ChatState; turnId?: string }
  | { type: 'chat.delta'; turnId: string; text: string }
  | { type: 'chat.text'; turnId: string; text: string }
  | {
      type: 'chat.tool';
      turnId: string;
      toolId: string;
      name: string;
      phase: 'start' | 'end';
      summary?: string;
      ok?: boolean;
      durationMs?: number;
      /** First part of the tool's text output (redacted), shown when the row is expanded. */
      detail?: string;
    }
  | { type: 'chat.done'; turnId: string; ok: boolean; error?: string; stats?: TurnStats }
  | { type: 'chat.error'; message: string; code?: string }
  /** Informational line in the chat (does not end the turn). */
  | { type: 'chat.notice'; text: string; level: 'info' | 'warning' }
  | { type: 'rpc.call'; id: string; method: RpcMethod; params: unknown; timeoutMs?: number }
  | { type: 'rpc.cancel'; id: string }
  | { type: 'approval.request'; id: string; title: string; detail: string; risk: 'medium' | 'high' }
  /** Progress of the sign-in started by `setup.open`. Success arrives as a new `welcome`. */
  | { type: 'setup.status'; state: SetupState; message?: string }
  | { type: 'pong'; ts: number };

export type SetupState = 'waiting' | 'failed';

/** Largest message accepted on either side (screenshots are the biggest payloads). */
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
export const MAX_CHAT_TEXT = 8_000;

export type Parsed<T> = { ok: true; msg: T } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

function decode(raw: unknown): Parsed<Record<string, unknown>> {
  if (typeof raw !== 'string') return { ok: false, error: 'message must be text' };
  if (raw.length > MAX_MESSAGE_BYTES) return { ok: false, error: 'message too large' };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
  if (!isObj(data) || typeof data.type !== 'string') return { ok: false, error: 'missing type' };
  return { ok: true, msg: data };
}

function validDevice(d: unknown): d is DeviceInfo {
  if (!isObj(d)) return false;
  if (d.platform !== 'ios' && d.platform !== 'android') return false;
  if (!isStr(d.osVersion, 64) || !isStr(d.libraryVersion, 32)) return false;
  const w = d.window;
  return isObj(w) && typeof w.width === 'number' && typeof w.height === 'number' && typeof w.scale === 'number';
}

/** Validate a message received by the server from a device. */
export function parseClientMessage(raw: unknown): Parsed<ClientMessage> {
  const d = decode(raw);
  if (!d.ok) return d;
  const m = d.msg;
  switch (m.type) {
    case 'hello': {
      if (m.protocol !== PROTOCOL_VERSION) {
        return { ok: false, error: `unsupported protocol ${String(m.protocol)} (server speaks ${PROTOCOL_VERSION})` };
      }
      if (!validDevice(m.device)) return { ok: false, error: 'hello: invalid device info' };
      if (!isObj(m.capabilities)) return { ok: false, error: 'hello: invalid capabilities' };
      if (m.auth !== undefined) {
        if (!isObj(m.auth)) return { ok: false, error: 'hello: invalid auth' };
        if (m.auth.token !== undefined && !isStr(m.auth.token, 256)) return { ok: false, error: 'hello: invalid token' };
        if (m.auth.pairingCode !== undefined && !isStr(m.auth.pairingCode, 32)) {
          return { ok: false, error: 'hello: invalid pairing code' };
        }
      }
      return { ok: true, msg: m as ClientMessage };
    }
    case 'chat.send':
      if (!isStr(m.id, 64)) return { ok: false, error: 'chat.send: invalid id' };
      if (!isStr(m.text, MAX_CHAT_TEXT)) return { ok: false, error: 'chat.send: text must be 1..8000 chars' };
      if (m.context !== undefined) {
        if (!isObj(m.context) || (m.context.selection !== undefined && !isStr(m.context.selection, MAX_CHAT_TEXT))) {
          return { ok: false, error: 'chat.send: invalid context' };
        }
        if (typeof m.context.selection === 'string') {
          return { ok: true, msg: { type: 'chat.send', id: m.id, text: m.text, context: { selection: m.context.selection } } };
        }
      }
      return { ok: true, msg: { type: 'chat.send', id: m.id, text: m.text } };
    case 'chat.cancel':
    case 'chat.reset':
    case 'setup.open':
      return { ok: true, msg: { type: m.type } };
    case 'chat.config':
      if (m.model !== undefined && (typeof m.model !== 'string' || !/^[A-Za-z0-9._\-[\]]{1,64}$/.test(m.model))) {
        return { ok: false, error: 'chat.config: invalid model' };
      }
      return { ok: true, msg: { type: 'chat.config', ...(m.model ? { model: m.model } : {}) } };
    case 'rpc.result': {
      if (!isStr(m.id, 64)) return { ok: false, error: 'rpc.result: invalid id' };
      const deviceMs = typeof m.deviceMs === 'number' ? m.deviceMs : undefined;
      if (m.ok === true) return { ok: true, msg: { type: 'rpc.result', id: m.id, ok: true, result: m.result, deviceMs } };
      if (m.ok === false && isObj(m.error) && typeof m.error.code === 'string' && typeof m.error.message === 'string') {
        return {
          ok: true,
          msg: { type: 'rpc.result', id: m.id, ok: false, error: m.error as unknown as ToolError, deviceMs },
        };
      }
      return { ok: false, error: 'rpc.result: invalid result' };
    }
    case 'approval.response':
      if (!isStr(m.id, 64) || typeof m.approved !== 'boolean') return { ok: false, error: 'approval.response: invalid' };
      return { ok: true, msg: { type: 'approval.response', id: m.id, approved: m.approved } };
    case 'ping':
      return { ok: true, msg: { type: 'ping', ts: typeof m.ts === 'number' ? m.ts : 0 } };
    default:
      return { ok: false, error: `unknown message type ${JSON.stringify(m.type).slice(0, 40)}` };
  }
}

/** Validate a message received by the device from the server. */
export function parseServerMessage(raw: unknown): Parsed<ServerMessage> {
  const d = decode(raw);
  if (!d.ok) return d;
  const m = d.msg;
  switch (m.type) {
    case 'welcome':
      if (!isStr(m.sessionId, 128) || !isObj(m.server)) return { ok: false, error: 'welcome: invalid' };
      return { ok: true, msg: m as ServerMessage };
    case 'rpc.call':
      if (!isStr(m.id, 64)) return { ok: false, error: 'rpc.call: invalid id' };
      if (!isRpcMethod(m.method)) return { ok: false, error: `rpc.call: unknown method ${String(m.method)}` };
      return { ok: true, msg: m as ServerMessage };
    case 'chat.notice':
      if (!isStr(m.text, 2_000)) return { ok: false, error: 'chat.notice: invalid text' };
      return { ok: true, msg: { type: 'chat.notice', text: m.text, level: m.level === 'warning' ? 'warning' : 'info' } };
    case 'setup.status':
      if (m.state !== 'waiting' && m.state !== 'failed') return { ok: false, error: 'setup.status: invalid state' };
      if (m.message !== undefined && !isStr(m.message, 500)) return { ok: false, error: 'setup.status: invalid message' };
      return { ok: true, msg: { type: 'setup.status', state: m.state, ...(m.message !== undefined ? { message: m.message } : {}) } };
    case 'rpc.cancel':
    case 'chat.delta':
    case 'chat.text':
    case 'chat.tool':
    case 'chat.done':
    case 'chat.status':
    case 'chat.error':
    case 'auth.required':
    case 'approval.request':
    case 'pong':
      return { ok: true, msg: m as ServerMessage };
    default:
      return { ok: false, error: `unknown message type ${JSON.stringify(m.type).slice(0, 40)}` };
  }
}

export function encode(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}
