import type { WebSocket } from 'ws';
import type { TurnStats } from 'react-native-agent-devtools-protocol';
import { appStateBlock, selectionBlock } from '../agent/prompt.ts';
import { toolDetail } from '../tools/format.ts';
import { MOBILE_TOOLS, type ToolContext, type ToolOutput } from '../tools/mobileTools.ts';
import type { DeviceRegistry, DeviceSession } from '../transport/devices.ts';
import { parseBridgeMessage, type BridgeMessage, type HubMessage } from './messages.ts';

/** How long after `claude` is launched its bridge may claim the app chat. */
const ARM_WINDOW_MS = 5 * 60_000;
const SLOW_NOTICE_MS = 30_000;

interface ChannelTurn {
  chatId: string;
  device: DeviceSession;
  t0: number;
  firstReplyAt?: number;
  toolMs: number;
  deviceMs: number;
  toolCalls: number;
  slowTimer?: NodeJS.Timeout;
}

export interface ChannelHubOptions {
  devices: DeviceRegistry;
  log: (line: string) => void;
  /** Ask on the device; resolves undefined when nobody answers in time. */
  ask: (device: DeviceSession, title: string, detail: string) => Promise<boolean | undefined>;
  /** The chat bridge connected or went away. */
  onChange: () => void;
  /** OS-level input for the mobile tools. */
  os?: ToolContext['os'];
}

const errorOutput = (text: string): ToolOutput => ({ content: [{ type: 'text', text }], isError: true });

/**
 * Routes the app chat into the developer's own Claude Code session through a
 * channel (Claude Code research preview). Claude Code runs on the developer's
 * existing login; nothing here holds model credentials.
 */
export class ChannelHub {
  private chatBridge?: WebSocket;
  private armedUntil = 0;
  private turn?: ChannelTurn;
  /** Set when the developer presses Stop; control tools are refused until their next message. */
  private stopped = false;
  /** Late replies (after Stop or a first reply) still reach the device that asked. */
  private recent = new Map<string, DeviceSession>();
  private readonly opts: ChannelHubOptions;

  constructor(opts: ChannelHubOptions) {
    this.opts = opts;
  }

  get chatAvailable(): boolean {
    return !!this.chatBridge && this.chatBridge.readyState === this.chatBridge.OPEN;
  }

  get busy(): boolean {
    return !!this.turn;
  }

  /** Called by the `claude` launcher just before it starts Claude Code. */
  arm(): void {
    this.armedUntil = Date.now() + ARM_WINDOW_MS;
  }

  accept(ws: WebSocket): void {
    let chat = false;
    const send = (m: HubMessage) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
    };
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const msg = parseBridgeMessage(data.toString('utf8'));
      if (!msg) return;
      switch (msg.type) {
        case 'hello':
          // Only a session started by the launcher carries the chat; any other Claude Code
          // session that loads the bridge just gets the mobile tools.
          chat = msg.chat || Date.now() < this.armedUntil;
          if (chat) {
            this.armedUntil = 0;
            const previous = this.chatBridge;
            this.chatBridge = ws;
            previous?.close(4000, 'replaced by a newer Claude Code session');
            this.opts.log('Claude Code connected: the app chat now goes to your Claude Code session');
            this.opts.onChange();
          }
          send({ type: 'welcome', chat });
          return;
        case 'tool.call':
          void this.runTool(msg, chat).then((output) => send({ type: 'tool.result', id: msg.id, output }));
          return;
        case 'reply':
          send({ type: 'reply.result', id: msg.id, ...this.reply(msg.chatId, msg.text, chat) });
          return;
        case 'permission.request':
          if (chat) void this.relayPermission(msg, send);
          return;
      }
    });
    ws.on('close', () => {
      if (this.chatBridge !== ws) return;
      this.chatBridge = undefined;
      this.finish(false, 'Claude Code disconnected.');
      this.opts.log('Claude Code disconnected from the app chat');
      this.opts.onChange();
    });
  }

  async send(device: DeviceSession, text: string, chatId: string, context?: { selection?: string }): Promise<void> {
    if (!this.chatAvailable) {
      device.send({ type: 'chat.error', message: 'Claude Code is not connected.', code: 'AGENT_UNAVAILABLE' });
      return;
    }
    this.stopped = false;
    const turn: ChannelTurn = { chatId, device, t0: performance.now(), toolMs: 0, deviceMs: 0, toolCalls: 0 };
    this.turn = turn;
    this.remember(chatId, device);
    device.once('close', () => {
      if (this.turn !== turn) return;
      clearTimeout(turn.slowTimer);
      this.turn = undefined;
    });
    device.send({ type: 'chat.status', state: 'thinking', turnId: chatId });
    // Same automatic snapshot as the in-app agent, so simple questions need no tool call.
    let summary: string | undefined;
    let note: string | undefined;
    try {
      const r = await device.rpc<{ text: string }>('getScreen', {}, 2_500);
      summary = r.result.text;
      turn.deviceMs += r.deviceMs;
    } catch (e) {
      note = e instanceof Error ? e.message : 'unavailable';
    }
    this.post({ type: 'message', chatId, device: device.label, platform: device.info.platform, content: `${appStateBlock(summary, note)}\n\n${selectionBlock(context?.selection)}${text}` });
    turn.slowTimer = setTimeout(() => {
      if (this.turn !== turn || turn.toolCalls > 0) return;
      device.send({
        type: 'chat.notice',
        level: 'warning',
        text: 'No response from Claude Code yet. Check its terminal: if it says channels are blocked by org policy, an admin needs to enable channels.',
      });
    }, SLOW_NOTICE_MS);
  }

  stop(device: DeviceSession): void {
    const t = this.turn;
    if (!t || t.device !== device) return;
    this.stopped = true;
    device.cancelAll();
    this.post({ type: 'stop', chatId: t.chatId });
    this.finish(false, 'Stopped. Claude Code was asked to stop, and app actions are blocked until your next message.');
  }

  private reply(chatId: string, text: string, chat: boolean): { ok: boolean; error?: string } {
    if (!chat) return { ok: false, error: 'This Claude Code session is not connected to the app chat. Start it with `react-native-agent-devtools-server claude`.' };
    const device = this.turn?.chatId === chatId ? this.turn.device : this.recent.get(chatId);
    if (!device?.open) return { ok: false, error: 'The app that sent this message is no longer connected.' };
    device.send({ type: 'chat.text', turnId: chatId, text });
    if (this.turn?.chatId === chatId) {
      this.turn.firstReplyAt ??= performance.now();
      this.finish(true);
    }
    return { ok: true };
  }

  private async runTool(msg: Extract<BridgeMessage, { type: 'tool.call' }>, chat: boolean): Promise<ToolOutput> {
    const tool = MOBILE_TOOLS.find((t) => t.name === msg.name);
    if (!tool) return errorOutput(`Unknown tool ${msg.name}.`);
    if (chat && this.stopped && tool.kind === 'control') {
      return errorOutput('The developer pressed Stop in the app. Do not operate the app again until they send a new message.');
    }
    const turn = chat ? this.turn : undefined;
    const device = turn?.device ?? this.opts.devices.active();
    const t0 = performance.now();
    if (turn) {
      turn.toolCalls++;
      device?.send({ type: 'chat.tool', turnId: turn.chatId, toolId: msg.id, name: tool.name, phase: 'start', summary: tool.summary(msg.args) });
      if (tool.kind === 'control') device?.send({ type: 'chat.status', state: 'acting', turnId: turn.chatId });
    }
    const out = await tool.run(msg.args, {
      device,
      ...(this.opts.os ? { os: this.opts.os } : {}),
      onRpc: (_m, r) => {
        if (turn) turn.deviceMs += r.deviceMs;
      },
    });
    if (turn && this.turn === turn) {
      const durationMs = Math.round(performance.now() - t0);
      turn.toolMs += durationMs;
      const detail = toolDetail(out.content);
      device?.send({ type: 'chat.tool', turnId: turn.chatId, toolId: msg.id, name: tool.name, phase: 'end', ok: !out.isError, durationMs, ...(detail ? { detail } : {}) });
      if (tool.kind === 'control') device?.send({ type: 'chat.status', state: 'thinking', turnId: turn.chatId });
    }
    return out;
  }

  /**
   * Claude Code's "allow this tool?" prompt, answered on the device. The terminal prompt
   * stays open too. Only a paired device may answer: anything that can reach the
   * server's port could otherwise approve commands in the developer's session.
   */
  private async relayPermission(msg: Extract<BridgeMessage, { type: 'permission.request' }>, send: (m: HubMessage) => void): Promise<void> {
    const device = this.turn?.device ?? this.opts.devices.active();
    if (!device) return;
    if (!device.trusted) {
      device.send({
        type: 'chat.notice',
        level: 'info',
        text: `Claude Code is asking to use ${msg.toolName}${msg.description ? ` (${msg.description.slice(0, 200)})` : ''}. Answer in your Claude Code terminal, or pair this app to approve from here.`,
      });
      return;
    }
    const detail = [msg.description, msg.inputPreview].filter(Boolean).join('\n\n').slice(0, 1_500);
    const answer = await this.opts.ask(device, `Claude Code wants to use ${msg.toolName}`, detail);
    if (answer === undefined) return;
    send({ type: 'permission.verdict', requestId: msg.requestId, behavior: answer ? 'allow' : 'deny' });
  }

  private finish(ok: boolean, error?: string): void {
    const t = this.turn;
    if (!t) return;
    this.turn = undefined;
    clearTimeout(t.slowTimer);
    const totalMs = Math.round(performance.now() - t.t0);
    const stats: TurnStats = {
      totalMs,
      ...(t.firstReplyAt ? { firstTokenMs: Math.round(t.firstReplyAt - t.t0) } : {}),
      toolMs: Math.round(t.toolMs),
      deviceMs: Math.round(t.deviceMs),
      modelMs: Math.max(0, totalMs - Math.round(t.toolMs)),
      toolCalls: t.toolCalls,
      model: 'Claude Code',
    };
    t.device.send({ type: 'chat.done', turnId: t.chatId, ok, ...(error ? { error } : {}), stats });
    t.device.send({ type: 'chat.status', state: 'idle' });
  }

  private post(m: HubMessage): void {
    const ws = this.chatBridge;
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
  }

  /** An app reconnected (same install): route its turn and late replies to the new connection. */
  rebind(from: DeviceSession, to: DeviceSession): void {
    if (this.turn?.device === from) this.turn.device = to;
    for (const [id, d] of this.recent) if (d === from) this.recent.set(id, to);
  }

  private remember(chatId: string, device: DeviceSession): void {
    this.recent.set(chatId, device);
    if (this.recent.size > 50) this.recent.delete(this.recent.keys().next().value!);
  }
}

/** The per-device chat session when the chat goes to Claude Code. */
export class ChannelChat {
  readonly modelName = undefined;
  private device: DeviceSession;
  private readonly hub: ChannelHub;

  constructor(device: DeviceSession, hub: ChannelHub) {
    this.device = device;
    this.hub = hub;
  }

  attach(device: DeviceSession): void {
    this.hub.rebind(this.device, device);
    this.device = device;
  }

  /** One Claude Code conversation serves every connected app, one message at a time. */
  get busy(): boolean {
    return this.hub.busy;
  }

  send(text: string, turnId: string, context?: { selection?: string }): Promise<void> {
    return this.hub.send(this.device, text, turnId, context);
  }

  async interrupt(): Promise<void> {
    this.hub.stop(this.device);
  }

  close(): void {}
}
