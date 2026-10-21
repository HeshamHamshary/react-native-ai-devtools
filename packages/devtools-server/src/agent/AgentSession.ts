import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSdkMcpServer,
  query,
  tool,
  type CanUseTool,
  type HookCallback,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { TurnStats } from 'react-native-agent-devtools-protocol';
import { redactText } from 'react-native-agent-devtools-protocol';
import type { RepoAccess } from '../security/repoAccess.ts';
import { CONTROL_TOOLS, MOBILE_TOOLS } from '../tools/mobileTools.ts';
import type { DeviceSession } from '../transport/devices.ts';
import { AsyncQueue } from './AsyncQueue.ts';
import { appStateBlock, systemPrompt } from './prompt.ts';

export interface AgentConfig {
  model?: string;
  repo: RepoAccess;
  allowEdits: boolean;
  loadProjectSettings: boolean;
  log: (msg: string) => void;
  /** Ask the developer on the device (used for repository edits). */
  approve: (device: DeviceSession, title: string, detail: string) => Promise<boolean>;
}

export function agentAvailability(env = process.env): { available: boolean; reason?: string } {
  if (env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_USE_BEDROCK === '1' || env.CLAUDE_CODE_USE_VERTEX === '1' || env.CLAUDE_CODE_USE_FOUNDRY === '1') {
    return { available: true };
  }
  return {
    available: false,
    reason:
      'No model credentials in the server environment. Set ANTHROPIC_API_KEY (or CLAUDE_CODE_USE_BEDROCK=1 / CLAUDE_CODE_USE_VERTEX=1 with cloud credentials) and restart the server. You can still drive the app from Claude Code via the MCP endpoint.',
  };
}

interface Turn {
  id: string;
  t0: number;
  firstTokenAt?: number;
  toolMs: number;
  deviceMs: number;
  toolCalls: number;
  tools: Map<string, { name: string; t0: number; control: boolean }>;
  streamed: boolean;
}

const MOBILE_PREFIX = 'mcp__mobile__';

function toolSummary(name: string, input: Record<string, unknown>): string {
  const short = name.startsWith(MOBILE_PREFIX) ? name.slice(MOBILE_PREFIX.length) : name;
  const def = MOBILE_TOOLS.find((t) => t.name === short);
  if (def) return def.summary(input);
  if (short === 'Read') return `Read ${String(input.file_path ?? '').split('/').slice(-2).join('/')}`;
  if (short === 'Grep') return `Search code for "${String(input.pattern ?? '').slice(0, 30)}"`;
  if (short === 'Glob') return `Find files ${String(input.pattern ?? '')}`;
  return short;
}

/**
 * One persistent Claude Agent SDK conversation per connected device, using
 * streaming input mode so the session (and its prompt cache) survives across
 * chat messages and supports interrupt().
 */
export class AgentSession {
  private queue = new AsyncQueue<SDKUserMessage>();
  private q?: Query;
  private turn?: Turn;
  private costSoFar = 0;
  private model?: string;
  private closed = false;
  private cancelRequested = false;
  private readonly device: DeviceSession;
  private readonly cfg: AgentConfig;

  constructor(device: DeviceSession, cfg: AgentConfig) {
    this.device = device;
    this.cfg = cfg;
  }

  get busy(): boolean {
    return !!this.turn;
  }

  get modelName(): string | undefined {
    return this.model;
  }

  start(): void {
    const mobile = createSdkMcpServer({
      name: 'mobile',
      version: '0.1.0',
      alwaysLoad: true,
      timeout: 90_000,
      tools: MOBILE_TOOLS.map((t) =>
        tool(t.name, t.description, t.shape, async (args) => {
          const out = await t.run(args as Record<string, unknown>, {
            device: this.device,
            onRpc: (_m, r) => {
              if (this.turn) this.turn.deviceMs += r.deviceMs;
            },
          });
          return out;
        }),
      ),
    });

    const repoTools = this.cfg.repo.enabled ? ['Read', 'Grep', 'Glob', ...(this.cfg.allowEdits ? ['Edit', 'Write'] : [])] : [];

    // Enforced for every built-in file tool call, including read-only tools that
    // never reach canUseTool.
    const guard: HookCallback = async (input) => {
      if (input.hook_event_name !== 'PreToolUse') return {};
      const name = input.tool_name;
      if (name.startsWith('mcp__')) return {};
      const decision = this.cfg.repo.check(name, (input.tool_input ?? {}) as Record<string, unknown>);
      if (decision.allow && repoTools.includes(name)) return {};
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: decision.reason ?? `${name} is not available in this session.`,
        },
      };
    };

    const canUseTool: CanUseTool = async (name, input) => {
      if (name.startsWith(MOBILE_PREFIX)) return { behavior: 'allow', updatedInput: input };
      if ((name === 'Edit' || name === 'Write') && this.cfg.allowEdits && this.cfg.repo.check(name, input).allow) {
        const file = String(input.file_path ?? '');
        const ok = await this.cfg.approve(this.device, 'Allow code edit?', `The agent wants to ${name === 'Write' ? 'write' : 'edit'} ${file}.`);
        return ok ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'The developer declined this edit.' };
      }
      if (['Read', 'Grep', 'Glob'].includes(name) && this.cfg.repo.check(name, input).allow) return { behavior: 'allow', updatedInput: input };
      return { behavior: 'deny', message: `${name} is not permitted in this session.` };
    };

    this.q = query({
      prompt: this.queue,
      options: {
        ...(this.cfg.model ? { model: this.cfg.model } : {}),
        systemPrompt: systemPrompt({
          device: this.device.info,
          capabilities: this.device.capabilities,
          repoRoots: this.cfg.repo.roots,
          allowEdits: this.cfg.allowEdits,
        }),
        cwd: this.cfg.repo.roots[0] ?? mkdtempSync(join(tmpdir(), 'rnad-agent-')),
        ...(this.cfg.repo.roots.length > 1 ? { additionalDirectories: this.cfg.repo.roots.slice(1) } : {}),
        tools: repoTools,
        mcpServers: { mobile },
        allowedTools: [`${MOBILE_PREFIX}*`],
        disallowedTools: ['Bash', 'BashOutput', 'KillShell', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit', 'TodoWrite'],
        canUseTool,
        hooks: { PreToolUse: [{ hooks: [guard] }] },
        permissionMode: 'default',
        settingSources: this.cfg.loadProjectSettings ? ['project'] : [],
        includePartialMessages: true,
        persistSession: false,
        stderr: (data: string) => this.cfg.log(`[agent stderr] ${redactText(data.trim()).slice(0, 500)}`),
      },
    });
    void this.loop();
  }

  async send(text: string, turnId: string): Promise<void> {
    if (this.closed) return;
    this.turn = { id: turnId, t0: performance.now(), toolMs: 0, deviceMs: 0, toolCalls: 0, tools: new Map(), streamed: false };
    this.device.send({ type: 'chat.status', state: 'thinking', turnId });
    // Attach a compact snapshot so simple questions need no tool round trip.
    let summary: string | undefined;
    let note: string | undefined;
    try {
      const r = await this.device.rpc<{ text: string }>('getScreen', {}, 2_500);
      summary = r.result.text;
      this.turn.deviceMs += r.deviceMs;
    } catch (e) {
      note = e instanceof Error ? e.message : 'unavailable';
    }
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: `${appStateBlock(summary, note)}\n\n${text}` },
      parent_tool_use_id: null,
    });
  }

  async interrupt(): Promise<void> {
    if (this.turn) this.cancelRequested = true;
    this.device.cancelAll();
    try {
      await this.q?.interrupt();
    } catch (e) {
      this.cfg.log(`interrupt failed: ${String(e)}`);
    }
  }

  close(): void {
    this.closed = true;
    this.queue.close();
    try {
      this.q?.close();
    } catch {
      // already closed
    }
  }

  private finishTurn(ok: boolean, error?: string, result?: Extract<SDKMessage, { type: 'result' }>): void {
    const t = this.turn;
    if (!t) return;
    this.turn = undefined;
    if (this.cancelRequested) {
      this.cancelRequested = false;
      ok = false;
      error = 'Stopped.';
    }
    const totalMs = Math.round(performance.now() - t.t0);
    let costUsd: number | undefined;
    if (result && typeof result.total_cost_usd === 'number') {
      costUsd = Math.max(0, result.total_cost_usd - this.costSoFar);
      this.costSoFar = result.total_cost_usd;
    }
    const usage = (result as { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } } | undefined)?.usage;
    const stats: TurnStats = {
      totalMs,
      ...(t.firstTokenAt ? { firstTokenMs: Math.round(t.firstTokenAt - t.t0) } : {}),
      toolMs: Math.round(t.toolMs),
      deviceMs: Math.round(t.deviceMs),
      modelMs: Math.max(0, totalMs - Math.round(t.toolMs)),
      toolCalls: t.toolCalls,
      ...(result?.duration_api_ms !== undefined ? { apiMs: result.duration_api_ms } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(usage?.input_tokens !== undefined ? { inputTokens: usage.input_tokens + (usage.cache_read_input_tokens ?? 0) } : {}),
      ...(usage?.output_tokens !== undefined ? { outputTokens: usage.output_tokens } : {}),
      ...(this.model ? { model: this.model } : {}),
    };
    this.cfg.log(
      `turn ${t.id}: ${totalMs}ms total · first token ${stats.firstTokenMs ?? '–'}ms · tools ${stats.toolMs}ms (device ${stats.deviceMs}ms, ${t.toolCalls} calls) · model ${stats.modelMs}ms${costUsd !== undefined ? ` · $${costUsd.toFixed(4)}` : ''}`,
    );
    this.device.send({ type: 'chat.done', turnId: t.id, ok, ...(error ? { error } : {}), stats });
    this.device.send({ type: 'chat.status', state: 'idle' });
  }

  private async loop(): Promise<void> {
    if (!this.q) return;
    try {
      for await (const msg of this.q) this.handle(msg);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.cfg.log(`agent session ended with error: ${redactText(message)}`);
      if (this.turn) this.finishTurn(false, `Agent error: ${redactText(message)}`);
      else this.device.send({ type: 'chat.error', message: `Agent error: ${redactText(message)}` });
    }
  }

  private handle(msg: SDKMessage): void {
    const turn = this.turn;
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          this.model = msg.model;
          this.cfg.log(`agent ready: model=${msg.model} tools=${msg.tools.length} permissionMode=${msg.permissionMode}`);
        }
        return;
      case 'stream_event': {
        if (!turn) return;
        const ev = msg.event as { type: string; delta?: { type: string; text?: string } };
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          turn.firstTokenAt ??= performance.now();
          turn.streamed = true;
          this.device.send({ type: 'chat.delta', turnId: turn.id, text: ev.delta.text });
        }
        return;
      }
      case 'assistant': {
        if (!turn || msg.parent_tool_use_id) return;
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') {
            const name = block.name;
            const short = name.startsWith(MOBILE_PREFIX) ? name.slice(MOBILE_PREFIX.length) : name;
            const control = CONTROL_TOOLS.has(short);
            turn.tools.set(block.id, { name: short, t0: performance.now(), control });
            turn.toolCalls++;
            this.device.send({
              type: 'chat.tool',
              turnId: turn.id,
              toolId: block.id,
              name: short,
              phase: 'start',
              summary: toolSummary(name, (block.input ?? {}) as Record<string, unknown>),
            });
            if (control) this.device.send({ type: 'chat.status', state: 'acting', turnId: turn.id });
          } else if (block.type === 'text' && !turn.streamed && block.text) {
            this.device.send({ type: 'chat.text', turnId: turn.id, text: block.text });
          }
        }
        turn.streamed = false;
        return;
      }
      case 'user': {
        if (!turn || msg.parent_tool_use_id) return;
        const content = msg.message.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (typeof block !== 'object' || block === null || (block as { type?: string }).type !== 'tool_result') continue;
          const b = block as { tool_use_id: string; is_error?: boolean };
          const started = turn.tools.get(b.tool_use_id);
          if (!started) continue;
          const durationMs = Math.round(performance.now() - started.t0);
          turn.toolMs += durationMs;
          this.device.send({ type: 'chat.tool', turnId: turn.id, toolId: b.tool_use_id, name: started.name, phase: 'end', ok: !b.is_error, durationMs });
          if (started.control) this.device.send({ type: 'chat.status', state: 'thinking', turnId: turn.id });
        }
        return;
      }
      case 'result':
        if (msg.subtype === 'success') this.finishTurn(true, undefined, msg);
        else {
          const errs = (msg as { errors?: string[] }).errors;
          this.finishTurn(false, `Agent stopped: ${msg.subtype}${errs?.length ? ` — ${redactText(errs.join('; ')).slice(0, 300)}` : ''}`, msg);
        }
        return;
      default:
        return;
    }
  }
}
