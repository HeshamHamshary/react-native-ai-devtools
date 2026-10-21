import type {
  ActionResult,
  Condition,
  Direction,
  ErrorCode,
  InteractionMode,
  ScreenChange,
  SequenceAction,
  SequenceOptions,
  TapMode,
  TargetSelector,
} from 'react-native-agent-devtools-protocol';
import { LIMITS, describeTarget, redactText } from 'react-native-agent-devtools-protocol';
import type { LogCollector } from '../collectors/LogCollector';
import type { NavigationTracker } from '../collectors/NavigationTracker';
import type { NetworkCollector } from '../collectors/NetworkCollector';
import { fabric, shadowNodeOf } from '../inspector/fiber';
import { formatElement, formatSnapshot } from '../inspector/format';
import type { InternalElement, Inspector, Snapshot } from '../inspector/Inspector';
import { matchTarget, screenHasText } from '../inspector/match';
import type { native as nativeApi } from '../native';
import { RingBuffer } from '../utils/RingBuffer';
import { CancelledError, clock, sleep, truncate } from '../utils/misc';
import type { CommitTracker } from './CommitTracker';

export class ToolFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly extra: Partial<ActionResult> = {},
  ) {
    super(message);
  }
}

export interface ConfirmRequest {
  title: string;
  detail: string;
}

export interface ExecutorDeps {
  inspector: Inspector;
  commits: CommitTracker;
  logs: LogCollector;
  network: NetworkCollector;
  nav: NavigationTracker;
  platform: 'ios' | 'android';
  native: typeof nativeApi;
  nativeAvailable: boolean;
  /** Ask the person holding the device. Resolves false on deny/timeout. */
  confirm: (req: ConfirmRequest) => Promise<boolean>;
  /** Temporarily make the devtools overlay transparent to touches/screenshots. */
  setOverlayHidden: (hidden: boolean) => void;
  isSensitive?: (el: { role: string; label?: string; text?: string; testID?: string }) => boolean;
  confirmSensitive: boolean;
}

export interface PerfSample {
  op: string;
  ms: number;
  ts: number;
}

const SENSITIVE =
  /\b(delete|remove|pay( now)?|purchase|buy|checkout|place order|confirm (booking|payment|purchase|order)|book now|transfer|send money|submit (order|payment)|cancel (booking|subscription|order|trip|reservation)|unsubscribe|deactivate|close account|reset (account|password))\b/i;
const SUBMIT_LIKE = /\b(submit|log ?in|sign ?in|sign ?up|register|pay|book|confirm|send|save|place order|checkout|purchase)\b/i;

function errCode(e: unknown): ErrorCode {
  if (e instanceof ToolFailure) return e.code;
  if (e instanceof CancelledError) return 'CANCELLED';
  const code = (e as { code?: string })?.code ?? '';
  if (code === 'RNAD_UNSUPPORTED' || code === 'UNSUPPORTED') return 'UNSUPPORTED';
  if (code === 'RNAD_NOT_FOUND') return 'NOT_FOUND';
  if (code === 'RNAD_DISABLED') return 'DISABLED';
  if (code === 'RNAD_NOT_HITTABLE') return 'NOT_HITTABLE';
  if (code.startsWith('RNAD_')) return 'NATIVE_ERROR';
  return 'INTERNAL';
}

/**
 * Executes UI actions on the device. Each action resolves its target against a
 * fresh snapshot, checks that a real touch could reach it, performs it with the best
 * available mechanism (reported as `mode`), waits for the UI to settle (event-driven)
 * and reports what changed.
 */
export class Executor {
  readonly perf = new RingBuffer<PerfSample>(200);
  private lastTap?: { fingerprint: string; ts: number; signature: string };

  constructor(private readonly d: ExecutorDeps) {}

  private record(op: string, ms: number) {
    this.perf.push({ op, ms: Math.round(ms * 10) / 10, ts: Date.now() });
  }

  async snapshot(skipProbe = false): Promise<Snapshot> {
    const t = clock();
    const s = await this.d.inspector.snapshot({ skipProbe });
    this.record(skipProbe ? 'snapshot-lite' : 'snapshot', clock() - t);
    this.d.nav.observeInferred(s.screen.route);
    return s;
  }

  // ------------------------------------------------------------------ helpers

  private resolve(snap: Snapshot, target: TargetSelector) {
    const m = matchTarget(snap, target, this.d.inspector.refs);
    if (!m.ok) throw new ToolFailure(m.error.code, m.error.message);
    return m;
  }

  private targetInfo(el: InternalElement): ActionResult['target'] {
    return { ref: el.ref, role: el.role, ...(el.label ? { label: el.label } : {}), ...(el.testID ? { testID: el.testID } : {}) };
  }

  private sensitive(el: InternalElement): boolean {
    const probe = { role: el.role, label: el.label, text: el.text, testID: el.testID };
    if (this.d.isSensitive) return this.d.isSensitive(probe);
    return [el.label, el.text, el.testID].some((s) => !!s && SENSITIVE.test(s));
  }

  private async guardSensitive(el: InternalElement, verb: string): Promise<void> {
    if (!this.d.confirmSensitive || !this.sensitive(el)) return;
    const ok = await this.d.confirm({
      title: 'Allow this action?',
      detail: `The agent wants to ${verb} ${el.role} "${el.label ?? el.ref}". This looks like a destructive or externally consequential action.`,
    });
    if (!ok) throw new ToolFailure('DENIED', `The user declined: ${verb} "${el.label ?? el.ref}". Do not retry; ask the user how to proceed.`);
  }

  private guardDuplicate(el: InternalElement, snap: Snapshot): void {
    const prev = this.lastTap;
    const label = `${el.label ?? ''} ${el.testID ?? ''}`;
    if (
      prev &&
      prev.fingerprint === el.fingerprint &&
      Date.now() - prev.ts < 2_000 &&
      prev.signature === snap.screen.signature &&
      SUBMIT_LIKE.test(label)
    ) {
      throw new ToolFailure(
        'BLOCKED',
        `Blocked a possible duplicate submission: "${el.label}" was tapped ${Date.now() - prev.ts}ms ago and the screen has not changed. Wait for the result (waitFor) before tapping again.`,
      );
    }
  }

  /** Make sure our own overlay is not what a touch would hit. */
  private async ensureNotCoveredByOverlay(snap: Snapshot, el: InternalElement): Promise<{ snap: Snapshot; el: InternalElement }> {
    if (el.hittable !== false || el.coveredBy !== 'the devtools overlay') return { snap, el };
    this.d.setOverlayHidden(true);
    await this.d.commits.nextCommit(100);
    const s2 = await this.snapshot();
    return { snap: s2, el: s2.internal.byRef.get(el.ref) ?? el };
  }

  private changes(before: Snapshot, after: Snapshot, logId: number, netId: number): ScreenChange & { errors: string[]; failed: string[] } {
    const beforeFp = new Set(before.internal.elements.filter((e) => e.visible).map((e) => e.fingerprint));
    const afterFp = new Set(after.internal.elements.filter((e) => e.visible).map((e) => e.fingerprint));
    let added = 0;
    let removed = 0;
    afterFp.forEach((f) => !beforeFp.has(f) && added++);
    beforeFp.forEach((f) => !afterFp.has(f) && removed++);
    const errors = this.d.logs.query({ errorsOnly: true, sinceId: logId, limit: 3 }).map((e) => truncate(e.message, 300));
    const failed = this.d.network
      .query({ failuresOnly: true, sinceId: netId, limit: 3 })
      .map((n) => `${n.method} ${n.url} → ${n.status ?? 0}${n.error ? ` (${n.error})` : ''}`);
    return {
      screenChanged: before.screen.signature !== after.screen.signature,
      ...(before.screen.route ? { routeBefore: before.screen.route } : {}),
      ...(after.screen.route ? { routeAfter: after.screen.route } : {}),
      addedInteractive: added,
      removedInteractive: removed,
      newErrors: errors.length,
      newFailedRequests: failed.length,
      keyboardVisible: after.screen.keyboardVisible,
      errors,
      failed,
    };
  }

  /**
   * Event-driven settle: React commits go quiet, requests started by the action
   * finish (bounded), and the screen signature is stable with no stack transition.
   */
  async settle(startedTs: number, signal?: AbortSignal, maxMs = 5_000): Promise<{ snap: Snapshot; settled: boolean }> {
    const t0 = clock();
    const deadline = t0 + maxMs;
    await this.d.commits.waitForQuiet(60, 700, signal);
    while (this.d.network.inflightSince(startedTs) > 0 && clock() < Math.min(deadline, t0 + 4_000)) {
      await this.d.commits.nextCommit(100, signal);
    }
    await this.d.commits.waitForQuiet(60, 700, signal);
    let snap = await this.snapshot();
    let settled = false;
    while (clock() < deadline) {
      if (signal?.aborted) throw new CancelledError();
      await sleep(80, signal);
      const next = await this.snapshot();
      const stable = next.screen.signature === snap.screen.signature && !next.transitioning;
      snap = next;
      if (stable) {
        settled = true;
        break;
      }
    }
    this.record('settle', clock() - t0);
    return { snap, settled };
  }

  async lightSettle(signal?: AbortSignal): Promise<{ snap: Snapshot; settled: boolean }> {
    const t0 = clock();
    const settled = await this.d.commits.waitForQuiet(50, 400, signal);
    const snap = await this.snapshot();
    this.record('settle-light', clock() - t0);
    return { snap, settled };
  }

  /** Common wrapper: timing, settle, change report, structured errors. Never throws. */
  private async act(
    action: string,
    signal: AbortSignal | undefined,
    body: (snap: Snapshot) => Promise<{
      el?: InternalElement;
      mode?: InteractionMode;
      warnings?: string[];
      detail?: Record<string, unknown>;
      reResolved?: boolean;
      skipSettle?: boolean;
      /** Typing rarely navigates: only wait for React to go quiet, not for animations. */
      lightSettle?: boolean;
    }>,
  ): Promise<ActionResult> {
    const t0 = clock();
    const startedTs = Date.now();
    const logId = this.d.logs.lastId;
    const netId = this.d.network.lastId;
    let before: Snapshot | undefined;
    try {
      before = await this.snapshot();
      const r = await body(before);
      const result: ActionResult = {
        ok: true,
        action,
        durationMs: 0,
        ...(r.el ? { target: this.targetInfo(r.el) } : {}),
        ...(r.mode ? { mode: r.mode } : {}),
        ...(r.reResolved ? { reResolved: true } : {}),
        ...(r.warnings?.length ? { warnings: r.warnings } : {}),
      };
      const detail: Record<string, unknown> = { ...(r.detail ?? {}) };
      if (!r.skipSettle) {
        const { snap: after, settled } = r.lightSettle ? await this.lightSettle(signal) : await this.settle(startedTs, signal);
        const { errors, failed, ...changes } = this.changes(before, after, logId, netId);
        result.settled = settled;
        result.changes = changes;
        if (errors.length) detail.newErrors = errors;
        if (failed.length) detail.failedRequests = failed;
        const routeChanged = changes.routeBefore !== changes.routeAfter;
        if (routeChanged || after.screen.modals.length !== before.screen.modals.length || (changes.addedInteractive ?? 0) > 6) {
          detail.screen = formatSnapshot(after, { maxElements: 40, maxTexts: 20 });
        } else if ((changes.addedInteractive ?? 0) > 0) {
          const beforeFp = new Set(before.internal.elements.map((e) => e.fingerprint));
          detail.added = after.internal.elements
            .filter((e) => e.visible && !beforeFp.has(e.fingerprint))
            .slice(0, 6)
            .map((e) => formatElement(e));
        }
      }
      if (Object.keys(detail).length) result.detail = detail;
      result.durationMs = Math.round(clock() - t0);
      this.record(action, clock() - t0);
      return result;
    } catch (e) {
      const code = errCode(e);
      const message = e instanceof Error ? e.message : String(e);
      if (code === 'THREW' || code === 'NATIVE_ERROR') this.d.logs.add({ level: 'error', message: `[agent ${action}] ${message}`, source: 'action' });
      return {
        ok: false,
        action,
        durationMs: Math.round(clock() - t0),
        error: { code, message },
        ...(e instanceof ToolFailure ? e.extra : {}),
      };
    } finally {
      this.d.setOverlayHidden(false);
    }
  }

  // ---------------------------------------------------------------- actions

  tap(target: TargetSelector, mode: TapMode = 'auto', signal?: AbortSignal, long = false): Promise<ActionResult> {
    return this.act(long ? 'longPress' : 'tap', signal, async (snap0) => {
      const warnings: string[] = [];
      let snap = snap0;
      let m = this.resolve(snap, target);
      let el = m.element;
      if (!el.visible && el.scrollContainer) {
        const r = await this.scrollIntoView(el, signal);
        snap = r.snap;
        el = r.el;
        warnings.push('scrolled the element into view first');
      }
      if (!el.visible) {
        throw new ToolFailure('NOT_HITTABLE', `${el.ref} ${el.role} "${el.label ?? ''}" is not visible on screen.`, {
          target: this.targetInfo(el),
        });
      }
      if (!el.enabled) {
        throw new ToolFailure('DISABLED', `${el.ref} ${el.role} "${el.label ?? ''}" is disabled; a real tap would do nothing.`, {
          target: this.targetInfo(el),
        });
      }
      ({ snap, el } = await this.ensureNotCoveredByOverlay(snap, el));
      if (el.hittable === false) {
        if (mode !== 'semantic') {
          throw new ToolFailure(
            'NOT_HITTABLE',
            `${el.ref} "${el.label ?? ''}" is covered by ${el.coveredBy}. A real finger tap at its center would hit that instead. Investigate the overlap, or pass mode "semantic" to invoke the handler anyway.`,
            { target: this.targetInfo(el) },
          );
        }
        warnings.push(`element is covered by ${el.coveredBy}; invoked semantically anyway`);
      }
      await this.guardSensitive(el, long ? 'long-press' : 'tap');
      if (!long) this.guardDuplicate(el, snap);

      const off = el.hitOffset ?? { dx: (el.bounds?.width ?? 0) / 2, dy: (el.bounds?.height ?? 0) / 2 };
      let performed: { mode: InteractionMode; detail?: Record<string, unknown> };
      if (mode === 'touch' && (this.d.platform === 'ios' || !this.d.nativeAvailable)) {
        throw new ToolFailure(
          'UNSUPPORTED',
          this.d.platform === 'ios'
            ? 'In-process touch injection is not possible on iOS with public APIs. Use mode "auto" (semantic + hit-test verified) or an OS-level backend.'
            : 'Native module not linked; cannot synthesize touches.',
        );
      }
      if (el.explicit) {
        if (typeof el.pressHandler !== 'function') throw new ToolFailure('UNSUPPORTED', `${el.ref} is an AgentTarget without onActivate.`);
        const handler = el.pressHandler;
        try {
          await handler();
        } catch (e) {
          throw new ToolFailure('THREW', `onActivate threw: ${e instanceof Error ? e.message : String(e)}`, { target: this.targetInfo(el), mode: 'semantic' });
        }
        performed = { mode: 'semantic', detail: { via: 'AgentTarget.onActivate' } };
      } else if (this.d.platform === 'android' && this.d.nativeAvailable && mode !== 'semantic' && el.tag !== undefined) {
        const r = long ? await this.d.native.longPress(el.tag, off.dx, off.dy, 700) : await this.d.native.tap(el.tag, off.dx, off.dy);
        performed = { mode: 'synthesized-touch', detail: { handled: r.handled } };
      } else if (this.d.platform === 'ios' && this.d.nativeAvailable && el.role === 'switch' && el.tag !== undefined && mode !== 'semantic') {
        const r = await this.d.native.tap(el.tag, off.dx, off.dy);
        performed = { mode: 'native', detail: { control: r.control, value: r.value } };
      } else {
        performed = await this.semanticPress(el, off, long);
      }
      this.lastTap = { fingerprint: el.fingerprint, ts: Date.now(), signature: snap.screen.signature };
      return { el, mode: performed.mode, warnings, detail: performed.detail, reResolved: m.reResolved };
    });
  }

  /**
   * Semantic press. Prefers driving the host's Pressability responder handlers
   * (onStartShouldSetResponder → onResponderGrant → onResponderRelease), which honors
   * `disabled`, fires onPressIn/onPressOut/onPress and visual feedback. Falls back
   * to calling `onPress` directly. Native hit-testing already ran before this.
   */
  private async semanticPress(el: InternalElement, off: { dx: number; dy: number }, long: boolean): Promise<{ mode: InteractionMode; detail?: Record<string, unknown> }> {
    const props = el.fiber.memoizedProps ?? {};
    const call = async (fn: () => unknown) => {
      try {
        await fn();
      } catch (e) {
        const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        this.d.logs.addError(e, 'action');
        throw new ToolFailure('THREW', `The press handler threw: ${msg}. On a real device this would surface as an uncaught JS error.`, {
          target: this.targetInfo(el),
          mode: 'semantic',
        });
      }
    };
    if (el.role === 'switch' && typeof el.pressHandler === 'function') {
      await call(() => el.pressHandler!(!(el.value === true)));
      return { mode: 'semantic', detail: { via: 'onValueChange' } };
    }
    if (el.pressability && typeof props.onResponderGrant === 'function') {
      const node = shadowNodeOf(el.fiber);
      const ui = fabric() as { measure?: (n: unknown, cb: (...a: number[]) => void) => void } | undefined;
      const b = el.bounds ?? { x: 0, y: 0, width: 0, height: 0 };
      const mk = (phase: 'start' | 'end') => {
        const ne: Record<string, unknown> = {
          identifier: 1,
          locationX: off.dx,
          locationY: off.dy,
          pageX: b.x + off.dx,
          pageY: b.y + off.dy,
          target: el.tag,
          timestamp: Date.now(),
        };
        ne.changedTouches = [ne];
        ne.touches = phase === 'start' ? [ne] : [];
        return {
          nativeEvent: ne,
          currentTarget: { measure: (cb: (...a: number[]) => void) => (node && ui?.measure ? ui.measure(node, cb) : undefined) },
          target: el.tag,
          timeStamp: Date.now(),
          type: phase === 'start' ? 'responderGrant' : 'responderRelease',
          persist() {},
          isPersistent: () => true,
          preventDefault() {},
          stopPropagation() {},
          isDefaultPrevented: () => false,
          isPropagationStopped: () => false,
        };
      };
      if (typeof props.onStartShouldSetResponder === 'function' && props.onStartShouldSetResponder(mk('start')) === false) {
        throw new ToolFailure('DISABLED', `${el.ref} refused the touch (onStartShouldSetResponder returned false; likely disabled).`);
      }
      await call(() => props.onResponderGrant(mk('start')));
      await sleep(long ? 650 : 40);
      await call(() => props.onResponderRelease(mk('end')));
      return { mode: 'semantic', detail: { via: 'pressability' } };
    }
    const handler = long ? el.longPressHandler : el.pressHandler;
    if (typeof handler === 'function') {
      await call(() => handler({ nativeEvent: { pageX: 0, pageY: 0, locationX: off.dx, locationY: off.dy, timestamp: Date.now() } }));
      return { mode: 'semantic', detail: { via: long ? 'onLongPress' : 'onPress' } };
    }
    throw new ToolFailure('UNSUPPORTED', `${el.ref} has no press handler to invoke semantically.`);
  }

  typeText(target: TargetSelector, text: string, opts: { replace?: boolean; submit?: boolean } = {}, signal?: AbortSignal): Promise<ActionResult> {
    const replace = opts.replace !== false;
    return this.act(text === '' && replace ? 'clearText' : 'typeText', signal, async (snap0) => {
      const warnings: string[] = [];
      let m = this.resolve(snap0, target);
      let el = m.element;
      if (el.role !== 'textbox') {
        throw new ToolFailure('INVALID', `${el.ref} is a ${el.role}, not a text field.`, { target: this.targetInfo(el) });
      }
      if (!el.visible && el.scrollContainer) {
        el = (await this.scrollIntoView(el, signal)).el;
        warnings.push('scrolled the field into view first');
      }
      if (!el.enabled) throw new ToolFailure('DISABLED', `${el.ref} "${el.label ?? ''}" is not editable.`, { target: this.targetInfo(el) });
      let mode: InteractionMode;
      let detail: Record<string, unknown> = {};
      if (this.d.nativeAvailable && el.tag !== undefined) {
        const r = await this.d.native.typeText(el.tag, text, replace, opts.submit === true);
        mode = 'native';
        detail = { length: r.length, submitted: r.submitted, ...(r.secure ? { secure: true } : { value: redactText(r.value ?? '') }) };
        const expected = replace ? text : undefined;
        if (expected !== undefined && !r.secure && r.value !== expected) {
          warnings.push(`field now contains "${truncate(redactText(r.value ?? ''), 60)}" (input may be masked, formatted or length-limited)`);
        }
      } else {
        const onChangeText = el.owners.map((o) => o.memoizedProps?.onChangeText).find((f) => typeof f === 'function');
        if (!onChangeText) throw new ToolFailure('UNSUPPORTED', 'No native module and no onChangeText handler to call.');
        const next = replace ? text : `${typeof el.value === 'string' ? el.value : ''}${text}`;
        onChangeText(next);
        mode = 'semantic';
        warnings.push('native module unavailable: called onChangeText directly');
      }
      return { el, mode, warnings, detail, reResolved: m.reResolved, lightSettle: opts.submit !== true };
    });
  }

  private pickScrollContainer(snap: Snapshot, direction: Direction): InternalElement | undefined {
    const horizontal = direction === 'left' || direction === 'right';
    const cands = snap.internal.elements.filter(
      (e) => (e.role === 'scrollview' || e.role === 'list') && e.visible && e.enabled && e.actions.some((a) => a.includes(horizontal ? 'left' : 'up')),
    );
    // If a modal is open, only its scroll views are reachable.
    const modal = snap.internal.elements.find((e) => e.role === 'modal' && e.visible);
    const pool = modal ? cands.filter((c) => c.modal === modal.ref) : cands;
    return pool.sort((a, b) => (b.bounds?.width ?? 0) * (b.bounds?.height ?? 0) - (a.bounds?.width ?? 0) * (a.bounds?.height ?? 0))[0];
  }

  scroll(target: TargetSelector | undefined, direction: Direction, amount = 0.75, signal?: AbortSignal): Promise<ActionResult> {
    return this.act('scroll', signal, async (snap) => {
      if (!this.d.nativeAvailable) throw new ToolFailure('UNSUPPORTED', 'Scrolling requires the native module.');
      let el: InternalElement | undefined;
      let reResolved = false;
      if (target) {
        const m = this.resolve(snap, target);
        el = m.element;
        reResolved = m.reResolved;
        if (el.role !== 'scrollview' && el.role !== 'list') {
          const container = el.scrollContainer ? snap.internal.byRef.get(el.scrollContainer) : undefined;
          if (!container) throw new ToolFailure('INVALID', `${el.ref} is not scrollable and not inside a scroll view.`);
          el = container;
        }
      } else {
        el = this.pickScrollContainer(snap, direction);
      }
      if (!el || el.tag === undefined) throw new ToolFailure('NOT_FOUND', 'No visible scrollable container on screen.');
      const vh = el.bounds?.height ?? 500;
      const vw = el.bounds?.width ?? 300;
      const dy = direction === 'down' ? vh * amount : direction === 'up' ? -vh * amount : 0;
      const dx = direction === 'right' ? vw * amount : direction === 'left' ? -vw * amount : 0;
      const r = await this.d.native.scrollBy(el.tag, dx, dy, false);
      const warnings = r.moved ? [] : [`already at the ${direction === 'down' || direction === 'right' ? 'end' : 'start'}; nothing moved`];
      const atEnd = direction === 'down' ? r.after.y >= r.max.y - 1 : direction === 'up' ? r.after.y <= 0.5 : direction === 'right' ? r.after.x >= r.max.x - 1 : r.after.x <= 0.5;
      return { el, mode: 'native', warnings, reResolved, detail: { offset: r.after, max: r.max, atEdge: atEnd } };
    });
  }

  /** Scroll the element's container until the element is visible. */
  private async scrollIntoView(el: InternalElement, signal?: AbortSignal): Promise<{ snap: Snapshot; el: InternalElement }> {
    let snap = this.d.inspector.last!;
    let current = el;
    for (let i = 0; i < 6; i++) {
      if (current.visible) break;
      const container = current.scrollContainer ? snap.internal.byRef.get(current.scrollContainer) : undefined;
      if (!container || container.tag === undefined || !container.bounds || !current.bounds || !this.d.nativeAvailable) break;
      const c = container.bounds;
      const b = current.bounds;
      const dy = b.y + b.height / 2 - (c.y + c.height * 0.4);
      const dx = container.actions.includes('scroll-left') ? b.x + b.width / 2 - (c.x + c.width / 2) : 0;
      const r = await this.d.native.scrollBy(container.tag, dx, container.actions.includes('scroll-left') ? 0 : dy, false);
      await this.d.commits.waitForQuiet(50, 400, signal);
      snap = await this.snapshot();
      current = snap.internal.elements.find((e) => e.fingerprint === el.fingerprint) ?? current;
      if (!r.moved) break;
    }
    return { snap, el: current };
  }

  scrollTo(target: TargetSelector, signal?: AbortSignal): Promise<ActionResult> {
    return this.act('scrollTo', signal, async (snap0) => {
      let snap = snap0;
      for (let page = 0; page < 10; page++) {
        const m = matchTarget(snap, target, this.d.inspector.refs);
        if (m.ok) {
          if (m.element.visible) return { el: m.element, mode: 'native', detail: { pages: page }, skipSettle: page === 0 };
          const r = await this.scrollIntoView(m.element, signal);
          if (r.el.visible) return { el: r.el, mode: 'native', detail: { pages: page } };
        } else if (m.error.code !== 'NOT_FOUND') {
          throw new ToolFailure(m.error.code, m.error.message);
        }
        // Not rendered yet (virtualized list): page down the main scroll container.
        const container = this.pickScrollContainer(snap, 'down');
        if (!container || container.tag === undefined || !this.d.nativeAvailable) break;
        const r = await this.d.native.scrollBy(container.tag, 0, (container.bounds?.height ?? 500) * 0.8, false);
        if (!r.moved) break;
        await this.d.commits.waitForQuiet(60, 500, signal);
        snap = await this.snapshot();
      }
      throw new ToolFailure('NOT_FOUND', `Could not find ${describeTarget(target)} after scrolling.`);
    });
  }

  swipe(from: { x: number; y: number }, to: { x: number; y: number }, durationMs = 300, signal?: AbortSignal): Promise<ActionResult> {
    return this.act('swipe', signal, async () => {
      if (this.d.platform === 'ios') {
        throw new ToolFailure('UNSUPPORTED', 'Swipe gestures need OS-level input on iOS (not available in-process). Use scroll instead.');
      }
      await this.d.native.swipe(from.x, from.y, to.x, to.y, durationMs);
      return { mode: 'synthesized-touch' };
    });
  }

  back(signal?: AbortSignal): Promise<ActionResult> {
    return this.act('back', signal, async (snap) => {
      if (this.d.platform === 'android' && this.d.nativeAvailable) {
        await this.d.native.pressBack();
        return { mode: 'native' };
      }
      const nav = snap.internal.route?.navigation ?? this.d.nav.ref;
      if (nav?.canGoBack?.() && nav.goBack) {
        nav.goBack();
        return { mode: 'semantic', detail: { via: 'navigation.goBack()' } };
      }
      throw new ToolFailure('UNSUPPORTED', 'No back navigation available on this screen.');
    });
  }

  // ------------------------------------------------------------------- waits

  private conditionMet(snap: Snapshot, c: Condition): boolean {
    const checks: boolean[] = [];
    if (c.route) checks.push((snap.screen.route ?? '').toLowerCase() === c.route.toLowerCase());
    if (c.target) {
      const m = matchTarget(snap, c.target, this.d.inspector.refs);
      const present = m.ok && m.element.visible;
      checks.push(c.gone ? !present : present);
    }
    if (c.text) {
      const present = screenHasText(snap, c.text);
      checks.push(c.gone ? !present : present);
    }
    return checks.every(Boolean);
  }

  async waitFor(c: Condition, signal?: AbortSignal): Promise<ActionResult> {
    const t0 = clock();
    const timeout = Math.min(c.timeoutMs ?? LIMITS.defaultWaitMs, LIMITS.maxWaitMs);
    const what = [c.route && `route "${c.route}"`, c.target && describeTarget(c.target), c.text && `text "${c.text}"`].filter(Boolean).join(' + ');
    try {
      for (;;) {
        const snap = await this.snapshot();
        if (this.conditionMet(snap, c) && !snap.transitioning) {
          return { ok: true, action: 'waitFor', durationMs: Math.round(clock() - t0), detail: { condition: `${c.gone ? 'gone: ' : ''}${what}` } };
        }
        if (clock() - t0 > timeout) {
          return {
            ok: false,
            action: 'waitFor',
            durationMs: Math.round(clock() - t0),
            error: {
              code: 'TIMEOUT',
              message: `Timed out after ${timeout}ms waiting for ${c.gone ? 'disappearance of ' : ''}${what}. Current route: ${snap.screen.route ?? 'unknown'}.`,
            },
            detail: { screen: formatSnapshot(snap, { maxElements: 25, maxTexts: 15 }) },
          };
        }
        // Wake on the next React commit, or poll for native-only changes.
        await this.d.commits.nextCommit(150, signal);
      }
    } catch (e) {
      return { ok: false, action: 'waitFor', durationMs: Math.round(clock() - t0), error: { code: errCode(e), message: String((e as Error)?.message ?? e) } };
    }
  }

  async assert(c: Condition): Promise<ActionResult> {
    const t0 = clock();
    const snap = await this.snapshot();
    const ok = this.conditionMet(snap, c);
    return ok
      ? { ok: true, action: 'assert', durationMs: Math.round(clock() - t0) }
      : { ok: false, action: 'assert', durationMs: Math.round(clock() - t0), error: { code: 'NOT_FOUND', message: 'Assertion failed' }, detail: { screen: formatSnapshot(snap, { maxElements: 25 }) } };
  }

  // ---------------------------------------------------------------- sequences

  async execute(a: SequenceAction, signal?: AbortSignal): Promise<ActionResult> {
    switch (a.type) {
      case 'tap':
        return this.tap(a.target, a.mode ?? 'auto', signal);
      case 'longPress':
        return this.tap(a.target, 'auto', signal, true);
      case 'type':
        return this.typeText(a.target, a.text, { replace: a.replace, submit: a.submit }, signal);
      case 'clear':
        return this.typeText(a.target, '', { replace: true }, signal);
      case 'scroll':
        return this.scroll(a.target, a.direction, a.amount, signal);
      case 'scrollTo':
        return this.scrollTo(a.target, signal);
      case 'waitFor':
        return this.waitFor(a.condition, signal);
      case 'assert':
        return this.assert(a.condition);
      case 'back':
        return this.back(signal);
      case 'sleep': {
        const t0 = clock();
        await sleep(a.ms, signal);
        return { ok: true, action: 'sleep', durationMs: Math.round(clock() - t0) };
      }
    }
  }

  async runSequence(actions: SequenceAction[], options: Required<SequenceOptions>, signal?: AbortSignal) {
    const t0 = clock();
    const deadline = t0 + options.timeoutMs;
    const steps: (ActionResult & { step: number })[] = [];
    let stopReason: string | undefined;
    for (let i = 0; i < actions.length; i++) {
      if (signal?.aborted) {
        stopReason = 'cancelled';
        steps.push({ step: i, ok: false, action: actions[i]!.type, durationMs: 0, error: { code: 'CANCELLED', message: 'Sequence cancelled' } });
        break;
      }
      if (clock() > deadline) {
        stopReason = 'timeout';
        steps.push({ step: i, ok: false, action: actions[i]!.type, durationMs: 0, error: { code: 'TIMEOUT', message: `Sequence exceeded ${options.timeoutMs}ms` } });
        break;
      }
      const a = actions[i]!;
      let r = await this.execute(a, signal);
      const expect = 'expect' in a ? a.expect : undefined;
      if (r.ok && expect) {
        const w = await this.waitFor(expect, signal);
        if (!w.ok) {
          r = { ...r, ok: false, error: { code: 'TIMEOUT', message: `Step ran, but the expected state was not reached: ${w.error?.message}` }, detail: { ...(r.detail ?? {}), ...(w.detail ?? {}) } };
        }
      }
      // Keep the trace compact: full screen dumps only on the final/failed step.
      const compact = { step: i, ...r };
      if (compact.detail?.screen && i < actions.length - 1 && r.ok) {
        const { screen: _omit, ...rest } = compact.detail;
        compact.detail = rest;
      }
      steps.push(compact);
      if (!r.ok) {
        const hard = ['BLOCKED', 'DENIED', 'CANCELLED', 'STALE'].includes(r.error?.code ?? '');
        if (!options.continueOnError || hard) {
          stopReason = `step ${i} (${a.type}) failed: ${r.error?.code}`;
          break;
        }
      }
    }
    const finalSnap = await this.snapshot();
    return {
      ok: steps.length === actions.length && steps.every((s) => s.ok),
      completed: steps.filter((s) => s.ok).length,
      total: actions.length,
      durationMs: Math.round(clock() - t0),
      ...(stopReason ? { stopped: stopReason } : {}),
      steps,
      finalScreen: formatSnapshot(finalSnap, { maxElements: 40, maxTexts: 20 }),
    };
  }
}
