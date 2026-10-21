import { Appearance, Dimensions, Keyboard, Platform, StyleSheet, TextInput, findNodeHandle } from 'react-native';
import type {
  ChatState,
  ClientMessage,
  DeviceInfo,
  LogLevel,
  RpcMethod,
  ScreenshotResult,
  ServerInfo,
  ServerMessage,
  SetupState,
  TurnStats,
} from 'react-native-agent-devtools-protocol';
import { PROTOCOL_VERSION, parseTarget, validateAction, validateSequence } from 'react-native-agent-devtools-protocol';
import { LogCollector } from '../collectors/LogCollector';
import { NavigationTracker, type NavigationRefLike } from '../collectors/NavigationTracker';
import { NetworkCollector, type NetworkOptions } from '../collectors/NetworkCollector';
import { CommitTracker } from '../executor/CommitTracker';
import { Executor, ToolFailure } from '../executor/Executor';
import { boundingRect, currentFiberForInstance, FiberTag, nativeTagOf, type Fiber } from '../inspector/fiber';
import { formatElement, formatSnapshot } from '../inspector/format';
import { Inspector } from '../inspector/Inspector';
import { matchTarget } from '../inspector/match';
import { capabilities, native, nativeAvailable, nativeConstants } from '../native';
import { Connection, defaultServerUrl, type ConnectionState } from '../transport/Connection';
import { CancelledError, clock, nextId } from '../utils/misc';
import { Store } from '../utils/Store';

export const LIBRARY_VERSION = '0.1.0';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system' | 'error';
  text: string;
  ts: number;
  turnId?: string;
  tool?: { name: string; phase: 'start' | 'end'; ok?: boolean; durationMs?: number; summary?: string };
}

export interface PendingConfirm {
  id: string;
  title: string;
  detail: string;
  source: 'device' | 'server';
}

export interface UIState {
  connection: 'idle' | 'connecting' | 'connected' | 'disconnected' | 'pairing-required' | 'error';
  connectionDetail?: string;
  server?: ServerInfo;
  serverUrl: string;
  chat: ChatState;
  turnId?: string;
  messages: ChatMessage[];
  pendingConfirm?: PendingConfirm;
  overlayHidden: boolean;
  lastStats?: TurnStats;
  /** Anthropic sign-in started from "Set up Claude" (cleared once the agent is available). */
  setup?: { state: SetupState; message?: string };
}

export interface RuntimeOptions {
  serverUrl?: string;
  /** Pairing token issued by the server for LAN connections (optional). */
  pairingCode?: string;
  network?: NetworkOptions;
  navigationRef?: NavigationRefLike | null;
  confirmSensitiveActions?: boolean;
  isSensitive?: (el: { role: string; label?: string; text?: string; testID?: string }) => boolean;
  logCapacity?: number;
}

type Rpc = (params: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;

function strip<T extends object>(o: T, keys: string[]): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!keys.includes(k)) out[k] = v;
  return out as Partial<T>;
}

const INTERNAL_KEYS = ['fiber', 'owners', 'fingerprint', 'hostType', 'pressHandler', 'longPressHandler', 'pressability', 'screenTag', 'modalTag', 'hitOffset', 'textParts', 'route'];

/**
 * Orchestrates collectors, inspector, executor and the server connection for one
 * mounted <AgentDevTools> provider.
 */
export class Runtime {
  readonly store: Store<UIState>;
  readonly commits = new CommitTracker();
  readonly logs: LogCollector;
  readonly network: NetworkCollector;
  readonly nav = new NavigationTracker();
  readonly inspector: Inspector;
  readonly executor: Executor;
  private conn?: Connection;
  private appAnchor: unknown = null;
  private overlayAnchor: unknown = null;
  private inflight = new Map<string, AbortController>();
  private confirmResolvers = new Map<string, (ok: boolean) => void>();
  private pairingCode?: string;
  private deviceToken?: string;
  private deltaBuffer = '';
  private deltaTimer?: ReturnType<typeof setTimeout>;
  private currentAssistantId?: string;
  private rpcStats = { calls: 0, deviceMs: 0 };

  constructor(private readonly opts: RuntimeOptions) {
    const routeOf = () => this.nav.current;
    this.logs = new LogCollector(opts.logCapacity ?? 500, routeOf);
    this.network = new NetworkCollector(opts.network ?? {}, routeOf);
    this.pairingCode = opts.pairingCode;
    this.deviceToken = (globalThis as { __RNAD_DEVICE_TOKEN__?: string }).__RNAD_DEVICE_TOKEN__;
    this.store = new Store<UIState>({
      connection: 'idle',
      serverUrl: opts.serverUrl ?? defaultServerUrl(),
      chat: 'idle',
      messages: [],
      overlayHidden: false,
    });
    this.inspector = new Inspector(() => this.appRoot(), {
      measure: (f) => boundingRect(f),
      flattenStyle: (s) => StyleSheet.flatten(s as never) as Record<string, unknown> | undefined,
      viewport: () => Dimensions.get('window'),
      probe: nativeAvailable ? (tags, offsets) => native.probeViews(tags, offsets) : undefined,
      keyboardVisible: () => (typeof Keyboard.isVisible === 'function' ? Keyboard.isVisible() : false),
      focusedTag: () => {
        const focused = TextInput.State?.currentlyFocusedInput?.();
        if (!focused) return undefined;
        const h = findNodeHandle(focused as never);
        return typeof h === 'number' ? h : undefined;
      },
      overlayTags: () => this.overlayTags(),
    });
    this.executor = new Executor({
      inspector: this.inspector,
      commits: this.commits,
      logs: this.logs,
      network: this.network,
      nav: this.nav,
      platform: Platform.OS === 'android' ? 'android' : 'ios',
      native,
      nativeAvailable,
      confirm: (req) => this.confirm({ ...req, source: 'device' }),
      setOverlayHidden: (hidden) => {
        if (this.store.get().overlayHidden !== hidden) this.store.set({ overlayHidden: hidden });
      },
      isSensitive: opts.isSensitive,
      confirmSensitive: opts.confirmSensitiveActions !== false,
    });
  }

  // ---------------------------------------------------------------- lifecycle

  setAppAnchor = (instance: unknown) => {
    this.appAnchor = instance;
  };

  setOverlayAnchor = (instance: unknown) => {
    this.overlayAnchor = instance;
  };

  start(): void {
    this.logs.install();
    this.network.install();
    this.nav.attach(this.opts.navigationRef);
    this.connect();
  }

  stop(): void {
    this.conn?.stop();
    this.conn = undefined;
    this.logs.uninstall();
    this.network.uninstall();
    this.nav.detach();
    this.inflight.forEach((c) => c.abort());
    this.inflight.clear();
  }

  setNavigationRef(ref: NavigationRefLike | null | undefined): void {
    this.nav.attach(ref);
  }

  private appRoot(): Fiber | null {
    const f = currentFiberForInstance(this.appAnchor);
    return f ?? null;
  }

  private overlayTags(): Set<number> {
    const tags = new Set<number>();
    const root = currentFiberForInstance(this.overlayAnchor);
    if (!root) return tags;
    const stack: Fiber[] = root.child ? [root.child] : [];
    while (stack.length) {
      const f = stack.pop()!;
      if (f.tag === FiberTag.HostComponent) {
        const t = nativeTagOf(f);
        if (t !== undefined) tags.add(t);
      }
      if (f.sibling) stack.push(f.sibling);
      if (f.child) stack.push(f.child);
    }
    return tags;
  }

  // -------------------------------------------------------------- connection

  connect(): void {
    this.conn?.stop();
    const url = this.store.get().serverUrl;
    this.conn = new Connection(url, {
      onState: (s, detail) => this.onConnState(s, detail),
      onMessage: (m) => this.onServerMessage(m),
      hello: () => this.hello(),
    });
    this.conn.start();
  }

  disconnect(): void {
    this.conn?.stop();
    this.conn = undefined;
    this.store.set({ connection: 'idle', connectionDetail: 'disconnected by user', chat: 'idle' });
  }

  /** Ask the server to start Anthropic sign-in in the computer's browser. */
  openSetup(): boolean {
    if (!this.conn?.isOpen) return false;
    this.store.set({ setup: { state: 'waiting' } });
    this.send({ type: 'setup.open' });
    return true;
  }

  submitPairingCode(code: string): void {
    this.pairingCode = code.trim().toUpperCase();
    this.conn?.reconnect();
  }

  private onConnState(s: ConnectionState, detail?: string): void {
    if (s === 'connecting') {
      if (this.store.get().connection !== 'pairing-required') this.store.set({ connection: 'connecting', connectionDetail: detail });
    } else if (s === 'closed') {
      if (this.store.get().connection !== 'pairing-required') {
        this.store.set({ connection: 'disconnected', connectionDetail: detail, chat: 'idle' });
      }
      this.inflight.forEach((c) => c.abort());
    }
  }

  private deviceInfo(): DeviceInfo {
    const c = nativeConstants();
    const w = Dimensions.get('window');
    const rn = (Platform.constants as { reactNativeVersion?: { major: number; minor: number; patch: number } }).reactNativeVersion;
    return {
      platform: Platform.OS === 'android' ? 'android' : 'ios',
      osVersion: c?.osVersion ?? String(Platform.Version),
      libraryVersion: LIBRARY_VERSION,
      window: { width: w.width, height: w.height, scale: w.scale, fontScale: w.fontScale },
      colorScheme: ((s) => (s === 'light' || s === 'dark' ? s : null))(Appearance.getColorScheme()),
      ...(c ? { model: c.model, isEmulator: c.isEmulator, appName: c.appName, bundleId: c.bundleId } : {}),
      ...(rn ? { rnVersion: `${rn.major}.${rn.minor}.${rn.patch}` } : {}),
    };
  }

  private hello(): ClientMessage {
    const auth: { token?: string; pairingCode?: string } = {};
    if (this.deviceToken) auth.token = this.deviceToken;
    if (this.pairingCode) auth.pairingCode = this.pairingCode;
    return {
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      device: this.deviceInfo(),
      capabilities: capabilities(),
      ...(Object.keys(auth).length ? { auth } : {}),
    };
  }

  private send(msg: ClientMessage): void {
    this.conn?.send(msg);
  }

  // ---------------------------------------------------------------- chat

  sendChat(text: string): void {
    const t = text.trim();
    if (!t) return;
    const id = nextId('m');
    this.addMessage({ id, role: 'user', text: t, ts: Date.now() });
    if (!this.conn?.isOpen || this.store.get().connection !== 'connected') {
      this.addMessage({ id: nextId('e'), role: 'error', text: 'Not connected to the devtools server.', ts: Date.now() });
      return;
    }
    this.send({ type: 'chat.send', id, text: t });
    this.store.set({ chat: 'thinking' });
  }

  cancel(): void {
    this.send({ type: 'chat.cancel' });
    this.inflight.forEach((c) => c.abort());
  }

  resetChat(): void {
    this.send({ type: 'chat.reset' });
    this.currentAssistantId = undefined;
    this.store.set({ messages: [], lastStats: undefined });
  }

  private addMessage(m: ChatMessage): void {
    this.store.set((s) => ({ messages: [...s.messages.slice(-199), m] }));
  }

  private patchMessage(id: string, patch: (m: ChatMessage) => ChatMessage): void {
    this.store.set((s) => ({ messages: s.messages.map((m) => (m.id === id ? patch(m) : m)) }));
  }

  private flushDeltas = (): void => {
    this.deltaTimer = undefined;
    const text = this.deltaBuffer;
    this.deltaBuffer = '';
    if (!text) return;
    const turnId = this.store.get().turnId;
    if (!this.currentAssistantId) {
      this.currentAssistantId = nextId('a');
      this.addMessage({ id: this.currentAssistantId, role: 'assistant', text, ts: Date.now(), turnId });
    } else {
      this.patchMessage(this.currentAssistantId, (m) => ({ ...m, text: m.text + text }));
    }
  };

  private onServerMessage(m: ServerMessage): void {
    switch (m.type) {
      case 'welcome':
        if (m.deviceToken) {
          this.deviceToken = m.deviceToken;
          (globalThis as { __RNAD_DEVICE_TOKEN__?: string }).__RNAD_DEVICE_TOKEN__ = m.deviceToken;
        }
        this.pairingCode = undefined;
        this.store.set({
          connection: 'connected',
          connectionDetail: undefined,
          server: m.server,
          setup: undefined,
          // A re-welcome without an agent (e.g. credentials rejected mid-turn) ends any turn in progress.
          ...(m.server.agent.available ? {} : { chat: 'idle' as const }),
        });
        break;
      case 'setup.status':
        this.store.set({ setup: { state: m.state, ...(m.message ? { message: m.message } : {}) } });
        break;
      case 'auth.required':
        this.deviceToken = undefined;
        this.store.set({ connection: 'pairing-required', connectionDetail: m.reason });
        break;
      case 'chat.status':
        if (m.state === 'idle') this.flushDeltas();
        this.store.set({ chat: m.state, ...(m.turnId ? { turnId: m.turnId } : {}) });
        break;
      case 'chat.delta':
        this.deltaBuffer += m.text;
        if (!this.deltaTimer) this.deltaTimer = setTimeout(this.flushDeltas, 40);
        break;
      case 'chat.text':
        this.flushDeltas();
        if (!this.currentAssistantId) this.addMessage({ id: nextId('a'), role: 'assistant', text: m.text, ts: Date.now(), turnId: m.turnId });
        break;
      case 'chat.tool':
        this.flushDeltas();
        this.currentAssistantId = undefined;
        if (m.phase === 'start') {
          this.addMessage({ id: `tool-${m.toolId}`, role: 'tool', text: m.summary ?? m.name, ts: Date.now(), turnId: m.turnId, tool: { name: m.name, phase: 'start', summary: m.summary } });
        } else {
          this.patchMessage(`tool-${m.toolId}`, (x) => ({
            ...x,
            tool: { name: m.name, phase: 'end', ok: m.ok, durationMs: m.durationMs, summary: m.summary ?? x.tool?.summary },
          }));
        }
        break;
      case 'chat.done':
        this.flushDeltas();
        this.currentAssistantId = undefined;
        if (!m.ok && m.error) this.addMessage({ id: nextId('e'), role: 'error', text: m.error, ts: Date.now(), turnId: m.turnId });
        this.store.set({ chat: 'idle', ...(m.stats ? { lastStats: m.stats } : {}) });
        break;
      case 'chat.error':
        this.flushDeltas();
        this.currentAssistantId = undefined;
        this.addMessage({ id: nextId('e'), role: 'error', text: m.message, ts: Date.now() });
        this.store.set({ chat: 'idle' });
        break;
      case 'rpc.call':
        void this.runRpc(m.id, m.method, m.params);
        break;
      case 'rpc.cancel':
        this.inflight.get(m.id)?.abort();
        break;
      case 'approval.request':
        void this.confirm({ title: m.title, detail: m.detail, source: 'server' }, m.id).then((approved) =>
          this.send({ type: 'approval.response', id: m.id, approved }),
        );
        break;
      case 'pong':
        break;
    }
  }

  // -------------------------------------------------------------- approvals

  confirm(req: Omit<PendingConfirm, 'id'>, id = nextId('c'), timeoutMs = 60_000): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.answerConfirm(id, false), timeoutMs);
      this.confirmResolvers.set(id, (ok) => {
        clearTimeout(timer);
        resolve(ok);
      });
      this.store.set({ pendingConfirm: { id, ...req } });
    });
  }

  answerConfirm(id: string, ok: boolean): void {
    const r = this.confirmResolvers.get(id);
    this.confirmResolvers.delete(id);
    if (this.store.get().pendingConfirm?.id === id) this.store.set({ pendingConfirm: undefined });
    r?.(ok);
  }

  // ----------------------------------------------------------------- RPC

  private async runRpc(id: string, method: RpcMethod, params: unknown): Promise<void> {
    const controller = new AbortController();
    this.inflight.set(id, controller);
    const t0 = clock();
    try {
      const result = await this.handle(method, (params && typeof params === 'object' ? params : {}) as Record<string, unknown>, controller.signal);
      const deviceMs = Math.round(clock() - t0);
      this.rpcStats.calls++;
      this.rpcStats.deviceMs += deviceMs;
      this.send({ type: 'rpc.result', id, ok: true, result, deviceMs });
    } catch (e) {
      const code = e instanceof ToolFailure ? e.code : e instanceof CancelledError ? 'CANCELLED' : 'INTERNAL';
      this.send({
        type: 'rpc.result',
        id,
        ok: false,
        error: { code, message: e instanceof Error ? e.message : String(e) },
        deviceMs: Math.round(clock() - t0),
      });
    } finally {
      this.inflight.delete(id);
    }
  }

  private target(p: Record<string, unknown>) {
    const t = parseTarget(p.target);
    if (!t) throw new ToolFailure('INVALID', 'Missing or invalid target. Use a ref like "e12", "#testID", or visible text.');
    return t;
  }

  /** Dispatch table for device RPCs. Parameters are validated here, on the device. */
  private readonly rpc: Record<RpcMethod, Rpc> = {
    getCapabilities: async () => capabilities(),
    getScreen: async () => {
      const s = await this.executor.snapshot();
      return { text: formatSnapshot(s, { maxElements: 20, maxTexts: 12, offscreen: false }), screen: s.screen, stats: s.stats };
    },
    getUI: async (p) => {
      const s = await this.executor.snapshot();
      if (p.format === 'json') {
        return {
          screen: s.screen,
          elements: s.internal.elements.map((e) => strip(e, INTERNAL_KEYS)),
          texts: s.texts,
          stats: s.stats,
        };
      }
      return {
        text: formatSnapshot(s, {
          bounds: p.bounds === true,
          maxElements: typeof p.maxElements === 'number' ? p.maxElements : 80,
          offscreen: p.offscreen !== false,
        }),
        stats: s.stats,
      };
    },
    resolve: async (p) => {
      const s = await this.executor.snapshot();
      const m = matchTarget(s, this.target(p), this.inspector.refs);
      if (!m.ok) throw new ToolFailure(m.error.code, m.error.message);
      return { element: strip(m.element, INTERNAL_KEYS), line: formatElement(m.element, { bounds: true }) };
    },
    tap: async (p, signal) => {
      const mode = p.mode === 'semantic' || p.mode === 'touch' ? p.mode : 'auto';
      return this.executor.tap(this.target(p), mode, signal);
    },
    longPress: async (p, signal) => this.executor.tap(this.target(p), 'auto', signal, true),
    typeText: async (p, signal) => {
      if (typeof p.text !== 'string') throw new ToolFailure('INVALID', 'text must be a string');
      return this.executor.typeText(this.target(p), p.text, { replace: p.replace !== false, submit: p.submit === true }, signal);
    },
    clearText: async (p, signal) => this.executor.typeText(this.target(p), '', { replace: true }, signal),
    scroll: async (p, signal) => {
      const v = validateAction({ type: 'scroll', ...p });
      if (!v.ok || v.value.type !== 'scroll') throw new ToolFailure('INVALID', v.ok ? 'invalid scroll' : v.error);
      return this.executor.scroll(v.value.target, v.value.direction, v.value.amount, signal);
    },
    scrollTo: async (p, signal) => this.executor.scrollTo(this.target(p), signal),
    swipe: async (p, signal) => {
      const from = p.from as { x: number; y: number } | undefined;
      const to = p.to as { x: number; y: number } | undefined;
      if (!from || !to || [from.x, from.y, to.x, to.y].some((n) => typeof n !== 'number')) {
        throw new ToolFailure('INVALID', 'swipe needs from {x,y} and to {x,y} in points');
      }
      return this.executor.swipe(from, to, typeof p.durationMs === 'number' ? p.durationMs : 300, signal);
    },
    waitFor: async (p, signal) => {
      const v = validateAction({ type: 'waitFor', ...p });
      if (!v.ok || v.value.type !== 'waitFor') throw new ToolFailure('INVALID', v.ok ? 'invalid condition' : v.error);
      return this.executor.waitFor(v.value.condition, signal);
    },
    back: async (_p, signal) => this.executor.back(signal),
    runSequence: async (p, signal) => {
      const v = validateSequence(p);
      if (!v.ok) throw new ToolFailure('INVALID', v.error);
      return this.executor.runSequence(v.value.actions, v.value.options, signal);
    },
    screenshot: async (p) => this.screenshot(p),
    getLogs: async (p) => {
      const levels = Array.isArray(p.levels) ? (p.levels.filter((l) => typeof l === 'string') as LogLevel[]) : undefined;
      const entries = this.logs.query({
        levels,
        errorsOnly: p.errorsOnly === true,
        limit: typeof p.limit === 'number' ? Math.min(p.limit, 200) : 40,
      });
      return { entries, total: this.logs.buffer.size, dropped: this.logs.buffer.droppedCount };
    },
    getNetwork: async (p) => ({
      entries: this.network.query({
        failuresOnly: p.failuresOnly === true,
        limit: typeof p.limit === 'number' ? Math.min(p.limit, 100) : 20,
        urlContains: typeof p.urlContains === 'string' ? p.urlContains : undefined,
      }),
      pending: this.network.inflightSince(0),
      note: 'Captures XMLHttpRequest/fetch from JS only. Bodies are captured only when enabled in the app config.',
    }),
    getNavigation: async () => {
      let overlays: unknown[] = [];
      try {
        overlays = nativeAvailable ? await native.getNativeOverlays() : [];
      } catch {
        overlays = [];
      }
      return { current: this.nav.current, history: this.nav.history.toArray(undefined, 20), nativeOverlays: overlays };
    },
    getPerf: async () => this.perfSummary(),
  };

  private handle(method: RpcMethod, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const fn = this.rpc[method];
    if (!fn) throw new ToolFailure('UNSUPPORTED', `Unknown method ${method}`);
    return fn(params, signal);
  }

  private nextFrame(): Promise<void> {
    return new Promise((r) => requestAnimationFrame(() => r()));
  }

  async screenshot(p: Record<string, unknown>): Promise<ScreenshotResult> {
    if (!nativeAvailable) throw new ToolFailure('UNSUPPORTED', 'Screenshots require the native module (rebuild the app).');
    const maxWidth = typeof p.maxWidth === 'number' ? Math.min(Math.max(p.maxWidth, 200), 1600) : 720;
    const quality = typeof p.quality === 'number' ? Math.min(Math.max(p.quality, 0.2), 1) : 0.7;
    let boxes: { x: number; y: number; width: number; height: number }[] = [];
    let labels: string[] = [];
    if (p.annotate === true) {
      const s = await this.executor.snapshot();
      const els = s.internal.elements.filter((e) => e.visible && e.bounds && e.role !== 'modal').slice(0, 50);
      boxes = els.map((e) => e.bounds!);
      labels = els.map((e) => e.ref);
    }
    this.store.set({ overlayHidden: true });
    try {
      await this.nextFrame();
      await this.nextFrame();
      const r = await native.captureScreen(maxWidth, quality, boxes, labels);
      return { ...r, annotated: boxes.length > 0 };
    } finally {
      this.store.set({ overlayHidden: false });
    }
  }

  perfSummary() {
    const byOp = new Map<string, number[]>();
    for (const s of this.executor.perf.toArray()) {
      const list = byOp.get(s.op) ?? [];
      list.push(s.ms);
      byOp.set(s.op, list);
    }
    const pct = (arr: number[], p: number) => {
      const a = [...arr].sort((x, y) => x - y);
      return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] ?? 0;
    };
    const ops: Record<string, { n: number; p50: number; p95: number }> = {};
    byOp.forEach((v, k) => {
      ops[k] = { n: v.length, p50: pct(v, 50), p95: pct(v, 95) };
    });
    return {
      ops,
      rpc: { calls: this.rpcStats.calls, avgDeviceMs: this.rpcStats.calls ? Math.round(this.rpcStats.deviceMs / this.rpcStats.calls) : 0 },
      lastSnapshot: this.inspector.last?.stats,
      transport: { bytesIn: this.conn?.bytesIn ?? 0, bytesOut: this.conn?.bytesOut ?? 0 },
      lastTurn: this.store.get().lastStats,
    };
  }
}
