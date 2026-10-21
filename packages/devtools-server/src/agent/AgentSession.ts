import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSdkMcpServer,
  query,
  tool,
  type AccountInfo,
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
  /** API key from the server environment or the local credential store. */
  apiKey?: string;
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

const CLOUD_PROVIDERS = new Set(['bedrock', 'vertex', 'foundry', 'anthropicAws', 'anthropicGoogleCloud', 'mantle']);
const API_KEY_SOURCES = new Set(['ANTHROPIC_API_KEY', 'apiKeyHelper']);

/**
 * The in-app agent may only run on credentials the developer configured for this
 * server: an API key or a cloud provider. A personal claude.ai login (OAuth) is
 * never acceptable: Anthropic's Agent SDK terms do not allow products to use it,
 * and Claude Code can silently prefer a stored login over ANTHROPIC_API_KEY.
 */
export function authDecision(info: AccountInfo | undefined): { ok: boolean; source: string; reason?: string } {
  if (!info) return { ok: false, source: 'unknown', reason: 'could not determine which credentials the agent would use' };
  if (info.apiProvider && CLOUD_PROVIDERS.has(info.apiProvider)) return { ok: true, source: info.apiProvider };
  if (info.apiKeySource && API_KEY_SOURCES.has(info.apiKeySource)) return { ok: true, source: info.apiKeySource };
  const source = info.apiKeySource ?? info.tokenSource ?? 'unknown';
  return {
    ok: false,
    source,
    reason: `the agent would authenticate with "${source}"${info.subscriptionType ? ` (${info.subscriptionType} subscription login)` : ''}, not with a configured API key. The in-app chat only runs on ANTHROPIC_API_KEY or Bedrock/Vertex/Foundry credentials.`,
  };
}

/** Isolated Claude Code config dir so the subprocess never inherits a personal login, settings or plugins. */
let isolatedConfigDir: string | undefined;
function agentEnv(apiKey?: string): Record<string, string> {
  isolatedConfigDir ??= mkdtempSync(join(tmpdir(), 'rnad-claude-config-'));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
  if (apiKey && !env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = apiKey;
  env.CLAUDE_CONFIG_DIR = isolatedConfigDir;
  return env;
}

/**
 * Validate an API key against Anthropic's model list endpoint (free, no tokens).
 * Used only for a key the developer just pasted into the local setup page.
 */
export async function validateApiKey(key: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'Anthropic rejected this key (invalid, revoked or without API access).' };
    return { ok: false, reason: `Could not validate the key (HTTP ${res.status}). Try again in a moment.` };
  } catch (e) {
    return { ok: false, reason: `Could not reach api.anthropic.com to validate the key: ${(e as Error).message}` };
  }
}

/** Check credentials without sending any prompt (no model call). */
export async function verifyAgentAuth(apiKey?: string, timeoutMs = 20_000): Promise<{ ok: boolean; source: string; reason?: string }> {
  const idle = new AsyncQueue<SDKUserMessage>();
  const q = query({ prompt: idle, options: { env: agentEnv(apiKey), tools: [], settingSources: [], persistSession: false } });
  try {
    const info = await Promise.race([
      q.accountInfo(),
      new Promise<undefined>((r) => setTimeout(() => r(undefined), timeoutMs)),
    ]);
    return authDecision(info);
  } catch (e) {
    return { ok: false, source: 'error', reason: `credential check failed: ${redactText(String((e as Error)?.message ?? e))}` };
  } finally {
    idle.close();
    try {
      q.close();
    } catch {
      // already closed
    }
  }
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
  /** Resolves once the session's credentials have been checked (fail closed). */
  private ready?: Promise<{ ok: boolean; reason?: string }>;
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
        env: agentEnv(this.cfg.apiKey),
      },
    });
    const q = this.q;
    this.ready = Promise.race([
      q.accountInfo().then(authDecision),
      new Promise<{ ok: false; source: string; reason: string }>((r) =>
        setTimeout(() => r({ ok: false, source: 'timeout', reason: 'credential check timed out' }), 20_000),
      ),
    ]).catch((e: unknown) => ({ ok: false, source: 'error', reason: `credential check failed: ${redactText(String(e))}` }));
    void this.ready.then((d) => {
      if (d.ok) {
        this.cfg.log(`agent credentials: ${'source' in d ? d.source : 'ok'}`);
        void this.loop();
      } else {
        this.cfg.log(`agent disabled: ${d.reason}`);
        this.close();
      }
    });
  }

  async send(text: string, turnId: string): Promise<void> {
    const auth = await this.ready;
    if (!auth?.ok || this.closed) {
      this.device.send({ type: 'chat.error', message: `Agent unavailable: ${auth?.reason ?? 'session closed'}`, code: 'AGENT_UNAVAILABLE' });
      return;
    }
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
