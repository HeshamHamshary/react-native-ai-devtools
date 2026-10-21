import { Appearance, Dimensions, Keyboard, LogBox, Platform, StyleSheet, TextInput, findNodeHandle } from 'react-native';
import type {
  ChatState,
  ClientMessage,
  DeviceInfo,
  ElementDetails,
  LogEntry,
  LogLevel,
  NetworkEntry,
  RpcMethod,
  ScreenshotResult,
  ServerInfo,
  ServerMessage,
  SetupState,
  TurnStats,
} from 'react-native-agent-devtools-protocol';
import { PROTOCOL_VERSION, parseTarget, validateAction, validateSequence } from 'react-native-agent-devtools-protocol';
import { AlertTracker } from '../collectors/AlertTracker';
import { LogCollector } from '../collectors/LogCollector';
import { NavigationTracker, type NavigationRefLike } from '../collectors/NavigationTracker';
import { NetworkCollector, type NetworkOptions } from '../collectors/NetworkCollector';
import { CommitTracker } from '../executor/CommitTracker';
import { Executor, ToolFailure } from '../executor/Executor';
import { auditScreen, formatAudit, layoutFindings } from '../inspector/audit';
import { attachSources, describeElement, elementForHost, formatDetails, type DetailsDeps } from '../inspector/details';
import { boundingRect, currentFiberForInstance, FiberTag, nativeTagOf, type Fiber } from '../inspector/fiber';
import { formatElement, formatSnapshot } from '../inspector/format';
import { Inspector, type InternalElement, type Snapshot } from '../inspector/Inspector';
import { matchTarget } from '../inspector/match';
import { devServerOrigin, formatLocation, parseStack, Symbolicator } from '../inspector/source';
import { capabilities, native, nativeAvailable, nativeConstants } from '../native';
import { bundleURL, Connection, defaultServerUrl, type ConnectionState } from '../transport/Connection';
import { CancelledError, clock, nextId } from '../utils/misc';
import { Store } from '../utils/Store';

export const LIBRARY_VERSION = '0.1.0';

function newInstanceId(): string {
  let id = '';
  for (let i = 0; i < 24; i++) id += 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)];
  return id;
}

/** Short title for a picked element, e.g. `Pressable "Log in" · LoginScreen.tsx:88`. */
export function selectionTitle(d: ElementDetails): string {
  // Interactive elements by the app component that renders them; plain views by their element.
  const name = (d.ref ? (d.component ?? d.source?.element) : (d.source?.element ?? d.component)) ?? d.host.type.replace(/^RCT/, '');
  const label = d.label ?? d.host.testID;
  const where = d.source ? ` · ${d.source.file.split('/').pop()}:${d.source.line}` : '';
  return `${name}${label ? ` "${label}"` : ''}${where}`;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system' | 'error';
  /** For system lines: warnings are shown more prominently. */
  level?: 'info' | 'warning';
  text: string;
  ts: number;
  turnId?: string;
  tool?: { name: string; phase: 'start' | 'end'; ok?: boolean; durationMs?: number; summary?: string; detail?: string };
  /** A picked element sent along with a user message (its title). */
  attachment?: string;
  /** Screenshot taken by this tool call (data URI), for a preview in the chat. */
  image?: { uri: string; width: number; height: number };
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
  /** Paired with the server: this app may approve code edits and Claude Code permissions. */
  trusted?: boolean;
  /** The developer chose to pair this app (as opposed to the server requiring it). */
  pairingRequested?: boolean;
  serverUrl: string;
  chat: ChatState;
  turnId?: string;
  messages: ChatMessage[];
  pendingConfirm?: PendingConfirm;
  overlayHidden: boolean;
  lastStats?: TurnStats;
  /** Anthropic sign-in started from "Set up Claude" (cleared once the agent is available). */
  setup?: { state: SetupState; message?: string };
  /** Inspect mode: the next tap on the app picks an element instead of operating it. */
  inspecting: boolean;
  /** The element the developer picked, with everything known about it. */
  selection?: Selection;
}

export interface Selection {
  details: ElementDetails;
  text: string;
  /** Source positions are still being resolved through Metro. */
  resolving: boolean;
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

const INTERNAL_KEYS = ['fiber', 'coveredByFiber', 'owners', 'fingerprint', 'hostType', 'pressHandler', 'longPressHandler', 'pressability', 'screenTag', 'modalTag', 'hitOffset', 'textParts', 'route'];

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
  readonly alerts = new AlertTracker();
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
  readonly symbolicator = new Symbolicator(() => devServerOrigin(bundleURL()));
  private readonly detailsDeps: DetailsDeps;
  private selectionHost?: Fiber;
  private lastScreenshot?: { uri: string; width: number; height: number; ts: number };

  constructor(private readonly opts: RuntimeOptions) {
    const routeOf = () => this.nav.current;
    this.logs = new LogCollector(opts.logCapacity ?? 500, routeOf);
    this.network = new NetworkCollector(opts.network ?? {}, routeOf);
    this.pairingCode = opts.pairingCode;
    this.store = new Store<UIState>({
      connection: 'idle',
      serverUrl: opts.serverUrl ?? defaultServerUrl(),
      chat: 'idle',
      messages: [],
      overlayHidden: false,
      inspecting: false,
    });
    this.detailsDeps = {
      flattenStyle: (st) => StyleSheet.flatten(st as never) as Record<string, unknown> | undefined,
      measure: (f) => boundingRect(f),
      platform: Platform.OS === 'android' ? 'android' : 'ios',
    };
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
    this.alerts.install();
    this.nav.attach(this.opts.navigationRef);
    // A paired device keeps its token across reloads and restarts (Keychain / app-private prefs),
    // and its install id so a reload resumes the same conversation.
    void Promise.all([native.getStoredValue(this.tokenKey()).catch(() => undefined), native.getStoredValue('instance').catch(() => undefined)]).then(
      ([token, instance]) => {
        this.deviceToken = token;
        this.instance = instance ?? newInstanceId();
        if (!instance) void native.setStoredValue('instance', this.instance).catch(() => undefined);
        if (!this.stopped) this.connect();
      },
    );
  }

  /** Stable per install; a fresh one per JS context when native storage is unavailable. */
  private instance = newInstanceId();

  private stopped = false;

  private tokenKey(): string {
    return `token:${this.store.get().serverUrl}`;
  }

  private saveToken(token: string | undefined): void {
    this.deviceToken = token;
    void native.setStoredValue(this.tokenKey(), token).catch(() => undefined);
  }

  stop(): void {
    this.stopped = true;
    this.conn?.stop();
    this.conn = undefined;
    this.logs.uninstall();
    this.network.uninstall();
    this.alerts.uninstall();
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

  /** Pair this app voluntarily (simulators connect without pairing but cannot approve). */
  requestPairing(): void {
    this.store.set({ pairingRequested: true });
  }

  /** Leave the pairing screen; only possible when the server does not require pairing. */
  cancelPairing(): void {
    this.pairingCode = undefined;
    this.store.set({ pairingRequested: false });
    if (this.store.get().connection === 'pairing-required') {
      this.store.set({ connection: 'connecting' });
      this.conn?.reconnect();
    }
  }

  /** Forget this app's pairing; the server keeps treating it as unpaired until it pairs again. */
  unpair(): void {
    this.saveToken(undefined);
    this.store.set({ trusted: false });
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
      ...(c?.simulatorUdid ? { simulatorUdid: c.simulatorUdid } : {}),
      ...(typeof c?.pid === 'number' && c.pid > 0 ? { pid: c.pid } : {}),
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
      instance: this.instance,
      ...(Object.keys(auth).length ? { auth } : {}),
    };
  }

  private send(msg: ClientMessage): void {
    this.conn?.send(msg);
  }

  // ---------------------------------------------------------------- chat

  /** Send a chat message; `withSelection` attaches the element picked in inspect mode. */
  sendChat(text: string, withSelection = false): void {
    const t = text.trim();
    if (!t) return;
    const id = nextId('m');
    const selection = withSelection ? this.store.get().selection : undefined;
    this.addMessage({ id, role: 'user', text: t, ts: Date.now(), ...(selection ? { attachment: selectionTitle(selection.details) } : {}) });
    if (!this.conn?.isOpen || this.store.get().connection !== 'connected') {
      this.addMessage({ id: nextId('e'), role: 'error', text: 'Not connected to the devtools server.', ts: Date.now() });
      return;
    }
    this.send({ type: 'chat.send', id, text: t, ...(selection ? { context: { selection: selection.text } } : {}) });
    this.store.set({ chat: 'thinking' });
  }

  // ------------------------------------------------------------- inspection

  startInspect(): void {
    this.store.set({ inspecting: true });
  }

  stopInspect(): void {
    this.store.set({ inspecting: false });
  }

  clearSelection(): void {
    this.selectionHost = undefined;
    this.store.set({ selection: undefined });
  }

  /** Inspect what a real touch at window point (x, y) would land on. */
  async pickAt(x: number, y: number): Promise<void> {
    const snap = await this.executor.snapshot();
    const hit = await this.inspector.hostAt(snap, x, y);
    if (!hit.fiber || hit.outside) {
      this.store.set({ selection: undefined });
      this.addMessage({ id: nextId('n'), role: 'system', level: 'info', text: `That point is covered by ${hit.outside ?? 'something outside the app'}, which can't be inspected.`, ts: Date.now() });
      return;
    }
    const el = elementForHost(snap, hit.fiber);
    await this.select(snap, el?.fiber ?? hit.fiber, el);
  }

  /** Move the selection to the enclosing view (skipping wrappers with the same frame). */
  async selectParent(): Promise<void> {
    const current = this.selectionHost;
    if (!current) return;
    const snap = await this.executor.snapshot();
    const rect = boundingRect(current);
    for (let f = current.return; f; f = f.return) {
      if (f.tag !== FiberTag.HostComponent) continue;
      const r = boundingRect(f);
      if (r && rect && r.x === rect.x && r.y === rect.y && r.width === rect.width && r.height === rect.height) continue;
      const el = snap.internal.elements.find((e) => e.fiber === f || e.fiber === f.alternate);
      await this.select(snap, f, el && el.role !== 'scrollview' && el.role !== 'list' ? el : undefined);
      return;
    }
  }

  /** Static description plus the layout checks for the element's row. */
  private describe(snap: Snapshot, host: Fiber, el: InternalElement | undefined): ElementDetails {
    const details = describeElement(snap, host, el, this.detailsDeps);
    if (!el) details.findings.push(...layoutFindings(snap, this.detailsDeps, host));
    return details;
  }

  /**
   * A snapshot taken after any native screen transition has finished (hit-tests are
   * wrong mid-animation), with our own panel out of the way: it is not part of the
   * app, so it must never count as covering an element.
   */
  private async settledSnapshot(): Promise<Snapshot> {
    let snap = await this.executor.snapshot();
    for (let i = 0; i < 15 && snap.transitioning; i++) {
      await new Promise<void>((r) => setTimeout(() => r(), 100));
      snap = await this.executor.snapshot();
    }
    if (snap.internal.elements.some((e) => e.coveredBy === 'the devtools overlay')) {
      this.store.set({ overlayHidden: true });
      try {
        await this.nextFrame();
        await this.nextFrame();
        snap = await this.executor.snapshot();
      } finally {
        this.store.set({ overlayHidden: false });
      }
    }
    return snap;
  }

  private async select(snap: Snapshot, host: Fiber, el: InternalElement | undefined): Promise<void> {
    this.selectionHost = host;
    const details = this.describe(snap, host, el);
    this.store.set({ selection: { details, text: formatDetails(details), resolving: true } });
    await attachSources(details, host, this.symbolicator, el?.coveredByFiber).catch(() => undefined);
    if (this.selectionHost !== host) return;
    this.store.set({ selection: { details, text: formatDetails(details), resolving: false } });
  }

  /** Details for an agent-supplied target or point, sources included. */
  private async inspectRpc(p: Record<string, unknown>): Promise<{ details: ElementDetails; text: string }> {
    const snap = await this.settledSnapshot();
    let host: Fiber;
    let el: InternalElement | undefined;
    const point = p.point as { x?: unknown; y?: unknown } | undefined;
    if (point && typeof point.x === 'number' && typeof point.y === 'number') {
      const hit = await this.inspector.hostAt(snap, point.x, point.y);
      if (!hit.fiber) throw new ToolFailure('NOT_FOUND', `Nothing inspectable at ${point.x},${point.y}: ${hit.outside ?? 'no view'}.`);
      el = elementForHost(snap, hit.fiber);
      host = el?.fiber ?? hit.fiber;
    } else if (p.target === undefined && this.selectionHost) {
      host = this.selectionHost;
      el = elementForHost(snap, host);
    } else {
      const sel = this.target(p);
      const m = matchTarget(snap, sel, this.inspector.refs);
      const any = m.ok ? undefined : this.findAnyHost(snap, sel);
      if (!m.ok && !any) throw new ToolFailure(m.error.code, m.error.message);
      el = m.ok ? m.element : undefined;
      host = m.ok ? m.element.fiber : any!;
    }
    const details = this.describe(snap, host, el);
    if (p.sources !== false) await attachSources(details, host, this.symbolicator, el?.coveredByFiber).catch(() => undefined);
    return { details, text: formatDetails(details) };
  }

  /**
   * Inspection may target any view, not just interactive ones: static texts by ref
   * (t12) or text, and any view by testID.
   */
  private findAnyHost(snap: Snapshot, sel: { ref?: string; testID?: string; text?: string }): Fiber | undefined {
    if (sel.ref && /^t\d+$/.test(sel.ref)) return snap.internal.texts.find((t) => t.ref === sel.ref)?.fiber;
    if (sel.testID) {
      for (const f of snap.internal.hostByTag.values()) if (f.memoizedProps?.testID === sel.testID) return f;
    }
    if (sel.text) {
      const needle = sel.text.toLowerCase();
      return (snap.internal.texts.find((t) => t.text.toLowerCase() === needle) ?? snap.internal.texts.find((t) => t.text.toLowerCase().includes(needle)))?.fiber;
    }
    return undefined;
  }

  /** Map error stacks to app source lines (at most a few entries per call; cached). */
  private async withErrorSources(entries: LogEntry[]): Promise<LogEntry[]> {
    const todo = entries.filter((e) => e.stack && !e.appFrames).slice(-8);
    await Promise.all(
      todo.map(async (e) => {
        const frames = await this.symbolicator.appLocations(parseStack(e.stack));
        e.appFrames = frames.slice(0, 4).map(formatLocation);
      }),
    ).catch(() => undefined);
    return entries;
  }

  /** Map the app code that started each request (at most a few entries per call). */
  private async withInitiators(entries: NetworkEntry[]): Promise<NetworkEntry[]> {
    const todo = entries.filter((e) => !e.initiator && this.network.stacks.has(e.id)).slice(-10);
    await Promise.all(
      todo.map(async (e) => {
        const frames = await this.symbolicator.appLocations(parseStack(this.network.stacks.get(e.id)));
        if (frames.length) e.initiator = frames.slice(0, 3).map(formatLocation);
      }),
    ).catch(() => undefined);
    return entries;
  }

  cancel(): void {
    this.send({ type: 'chat.cancel' });
    this.inflight.forEach((c) => c.abort());
  }

  /** Choose the built-in agent's model (undefined = server default); starts a new conversation. */
  setModel(model: string | undefined): void {
    this.send({ type: 'chat.config', ...(model ? { model } : {}) });
    this.currentAssistantId = undefined;
    this.store.set({ messages: [], lastStats: undefined });
  }

  resetChat(): void {
    this.send({ type: 'chat.reset' });
    this.currentAssistantId = undefined;
    this.store.set({ messages: [], lastStats: undefined });
  }

  private addMessage(m: ChatMessage): void {
    this.store.set((s) => ({ messages: [...s.messages.slice(-199), m] }));
  }

  /** Keep screenshot previews for the last three only (each is ~100 KB of base64). */
  private trimImages(): void {
    const withImages = this.store.get().messages.filter((m) => m.image);
    if (withImages.length <= 3) return;
    const drop = new Set(withImages.slice(0, -3).map((m) => m.id));
    this.store.set((s) => ({ messages: s.messages.map((m) => (drop.has(m.id) ? { ...m, image: undefined } : m)) }));
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
        if (m.deviceToken) this.saveToken(m.deviceToken);
        // A stored token the server no longer accepts (revoked, or a different server).
        else if (m.trusted === false && this.deviceToken) this.saveToken(undefined);
        this.pairingCode = undefined;
        this.store.set({
          connection: 'connected',
          connectionDetail: undefined,
          server: m.server,
          trusted: m.trusted === true,
          ...(m.trusted ? { pairingRequested: false } : {}),
          setup: undefined,
          // A re-welcome without an agent (e.g. credentials rejected mid-turn) ends any turn in progress.
          ...(m.server.agent.available ? {} : { chat: 'idle' as const }),
        });
        break;
      case 'setup.status':
        this.store.set({ setup: { state: m.state, ...(m.message ? { message: m.message } : {}) } });
        break;
      case 'auth.required':
        if (this.deviceToken) this.saveToken(undefined);
        this.pairingCode = undefined;
        this.store.set({ connection: 'pairing-required', connectionDetail: m.reason, trusted: false });
        break;
      case 'chat.history': {
        // Rebuild the transcript the server kept while this app reloaded or reconnected.
        this.currentAssistantId = undefined;
        this.store.set({ messages: [] });
        for (const e of m.events) {
          if (e.type === 'chat.user') this.addMessage({ id: e.id, role: 'user', text: e.text, ts: Date.now(), ...(e.attachment ? { attachment: e.attachment } : {}) });
          else this.onServerMessage(e);
        }
        this.flushDeltas();
        this.currentAssistantId = undefined;
        break;
      }
      case 'chat.notice':
        this.flushDeltas();
        this.currentAssistantId = undefined;
        this.addMessage({ id: nextId('n'), role: 'system', level: m.level, text: m.text, ts: Date.now() });
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
          const shot = this.lastScreenshot;
          this.patchMessage(`tool-${m.toolId}`, (x) => ({
            ...x,
            tool: { name: m.name, phase: 'end', ok: m.ok, durationMs: m.durationMs, summary: m.summary ?? x.tool?.summary, ...(m.detail ? { detail: m.detail } : {}) },
            // The screenshot this call produced was captured on this device while the row was open.
            ...(/screenshot/.test(m.name) && m.ok && shot && shot.ts >= x.ts ? { image: { uri: shot.uri, width: shot.width, height: shot.height } } : {}),
          }));
          if (/screenshot/.test(m.name)) this.trimImages();
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
      if (p.sources !== false) await this.withErrorSources(entries);
      return {
        entries,
        total: this.logs.buffer.size,
        dropped: this.logs.buffer.droppedCount,
        capturedSince: this.logs.installedAt,
        note: 'Only output after the devtools runtime started is captured; earlier errors (before <AgentDevTools> mounted) are not.',
      };
    },
    getNetwork: async (p) => {
      const entries = this.network.query({
        failuresOnly: p.failuresOnly === true,
        limit: typeof p.limit === 'number' ? Math.min(p.limit, 100) : 20,
        urlContains: typeof p.urlContains === 'string' ? p.urlContains : undefined,
      });
      if (p.sources !== false) await this.withInitiators(entries);
      return {
        entries,
        pending: this.network.inflightSince(0),
        note: 'Captures XMLHttpRequest/fetch from JS only, from when the devtools runtime started. Bodies are captured only when enabled in the app config.',
      };
    },
    inspect: async (p) => this.inspectRpc(p),
    audit: async () => {
      const snap = await this.settledSnapshot();
      const since = Date.now() - 5 * 60_000;
      const result = auditScreen({
        snap,
        deps: this.detailsDeps,
        errors: this.logs.query({ errorsOnly: true, limit: 50 }).filter((e) => e.ts >= since),
        requests: this.network.query({ limit: 100 }).filter((e) => e.ts >= since),
      });
      return { ...result, text: formatAudit(result) };
    },
    getSelection: async () => {
      const sel = this.store.get().selection;
      return sel ? { details: sel.details, text: sel.text } : { text: 'The developer has not picked an element (inspect mode is in the chat panel).' };
    },
    getNavigation: async () => {
      let overlays: unknown[] = [];
      try {
        overlays = nativeAvailable ? await native.getNativeOverlays() : [];
      } catch {
        overlays = [];
      }
      if (!overlays.length) this.alerts.current = undefined; // dismissed outside our wrapper
      const alert = this.alerts.current;
      return {
        current: this.nav.current,
        history: this.nav.history.toArray(undefined, 20),
        nativeOverlays: overlays,
        ...(alert ? { alert: { title: alert.title, message: alert.message, buttons: alert.buttons.map((b) => ({ text: b.text, style: b.style })) } } : {}),
      };
    },
    prepareExternal: async (p, signal) => {
      const action = typeof p.action === 'string' ? p.action : 'tap';
      const target = p.target === undefined ? undefined : this.target(p);
      const prepared = await this.executor.prepareExternal(action, target, signal);
      let frame;
      try {
        frame = nativeAvailable ? await native.getRootFrame() : undefined;
      } catch {
        frame = undefined;
      }
      return { ...prepared, ...(frame ? { frame } : {}), window: Dimensions.get('window') };
    },
    finishExternal: async (p, signal) => {
      if (typeof p.token !== 'string') throw new ToolFailure('INVALID', 'token required');
      return this.executor.finishExternal(p.token, { ok: p.ok !== false, error: typeof p.error === 'string' ? p.error : undefined, backend: String(p.backend ?? 'os') }, signal);
    },
    dismissKeyboard: async (_p, signal) =>
      this.executor.run(
        'dismissKeyboard',
        async () => {
          const was = typeof Keyboard.isVisible === 'function' ? Keyboard.isVisible() : undefined;
          Keyboard.dismiss();
          return { mode: 'semantic', ...(was === false ? { warnings: ['the keyboard was not visible'] } : {}) };
        },
        signal,
      ),
    dismissLogBox: async (_p, signal) =>
      this.executor.run(
        'dismissLogBox',
        async () => {
          // Public LogBox API; the errors stay in getLogs.
          LogBox.clearAllLogs();
          return { mode: 'semantic', detail: { note: 'LogBox notifications and the error screen were cleared; the errors are still available in mobile_get_logs.' } };
        },
        signal,
      ),
    pressAlertButton: async (p, signal) => {
      const title = typeof p.title === 'string' ? p.title : '';
      if (!title) throw new ToolFailure('INVALID', 'title (the button text) is required');
      return this.executor.run(
        'pressAlertButton',
        async () => {
          await this.executor.confirmIfSensitive(title, 'press the alert button');
          if (Platform.OS === 'android' && nativeAvailable) {
            const r = await native.pressAlertButton(title);
            if (r.pressed) return { mode: 'native', detail: { button: title } };
          }
          const alert = this.alerts.current;
          const button = alert?.buttons.find((b) => b.text.toLowerCase() === title.toLowerCase());
          if (!alert || !button) {
            const available = alert ? alert.buttons.map((b) => `"${b.text}"`).join(', ') : 'none (no Alert.alert dialog is open)';
            throw new ToolFailure('NOT_FOUND', `No alert button "${title}". Buttons: ${available}.`);
          }
          if (nativeAvailable) await native.pressAlertButton(title).catch(() => undefined);
          button.onPress?.();
          if (this.alerts.current === alert) this.alerts.current = undefined;
          return { mode: 'semantic', detail: { button: button.text, note: 'Dismissed the native alert and called its button callback (no public API delivers a real tap to an iOS alert; use mode os for that).' } };
        },
        signal,
      );
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
      this.lastScreenshot = { uri: `data:${r.mimeType};base64,${r.data}`, width: r.width, height: r.height, ts: Date.now() };
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
