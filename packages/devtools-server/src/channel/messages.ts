import type { ToolOutput } from '../tools/mobileTools.ts';

/**
 * Messages between the devtools server and the Claude Code channel bridge
 * (`react-native-agent-devtools-server channel`, spawned by Claude Code over stdio).
 * They travel over a loopback-only WebSocket at /channel.
 */
export type BridgeMessage =
  /** `chat`: started by the `claude` launcher, so it may carry the app's chat. */
  | { type: 'hello'; chat: boolean }
  | { type: 'tool.call'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'reply'; id: string; chatId: string; text: string }
  | { type: 'permission.request'; requestId: string; toolName: string; description: string; inputPreview: string };

export type HubMessage =
  /** Whether this bridge carries the app chat (otherwise it only serves tools). */
  | { type: 'welcome'; chat: boolean }
  | { type: 'tool.result'; id: string; output: ToolOutput }
  | { type: 'reply.result'; id: string; ok: boolean; error?: string }
  | { type: 'message'; chatId: string; device: string; platform: string; content: string }
  | { type: 'stop'; chatId: string }
  | { type: 'permission.verdict'; requestId: string; behavior: 'allow' | 'deny' };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

export function parseBridgeMessage(raw: string): BridgeMessage | undefined {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isObj(m)) return undefined;
  switch (m.type) {
    case 'hello':
      return { type: 'hello', chat: m.chat === true };
    case 'tool.call':
      return isStr(m.id, 64) && isStr(m.name, 64) && isObj(m.args) ? { type: 'tool.call', id: m.id, name: m.name, args: m.args } : undefined;
    case 'reply':
      return isStr(m.id, 64) && isStr(m.chatId, 64) && isStr(m.text, 20_000) ? { type: 'reply', id: m.id, chatId: m.chatId, text: m.text } : undefined;
    case 'permission.request':
      return isStr(m.requestId, 16) && isStr(m.toolName, 200) && typeof m.description === 'string' && typeof m.inputPreview === 'string'
        ? { type: 'permission.request', requestId: m.requestId, toolName: m.toolName, description: m.description.slice(0, 1_000), inputPreview: m.inputPreview.slice(0, 4_000) }
        : undefined;
    default:
      return undefined;
  }
}

export function parseHubMessage(raw: string): HubMessage | undefined {
  try {
    const m = JSON.parse(raw) as HubMessage;
    return isObj(m) && typeof m.type === 'string' ? m : undefined;
  } catch {
    return undefined;
  }
}
