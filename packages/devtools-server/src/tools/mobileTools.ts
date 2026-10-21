import { z } from 'zod';
import type { ActionResult, LogEntry, NetworkEntry, RpcMethod, ScreenshotResult } from 'react-native-agent-devtools-protocol';
import type { DeviceSession, RpcResult } from '../transport/devices.ts';
import { RpcError } from '../transport/devices.ts';
import { formatAction, formatLogs, formatNetwork, formatSequence, type SequenceResult } from './format.ts';

export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface ToolOutput {
  [key: string]: unknown;
  content: ToolContent[];
  isError?: boolean;
}

export interface ToolContext {
  device: DeviceSession | undefined;
  signal?: AbortSignal;
  /** Called with device-side timing for per-turn performance stats. */
  onRpc?: (method: RpcMethod, r: RpcResult) => void;
}

export interface MobileTool {
  name: string;
  description: string;
  /** zod raw shape (shared by the Agent SDK and MCP SDK registrations). */
  shape: z.ZodRawShape;
  /** `control` tools change app state; `read` tools only observe. */
  kind: 'read' | 'control';
  summary: (args: Record<string, unknown>) => string;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutput>;
}

const text = (t: string, isError = false): ToolOutput => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

const target = z
  .string()
  .min(1)
  .describe('Element ref from get_ui (e.g. "e12"), "#testID", "text=Log in", "role=button", or visible text');

async function call<T>(ctx: ToolContext, method: RpcMethod, params: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
  if (!ctx.device) {
    throw new RpcError('NO_DEVICE', 'No app is connected. Open the app with react-native-agent-devtools enabled.');
  }
  const r = await ctx.device.rpc<T>(method, params, timeoutMs, ctx.signal);
  ctx.onRpc?.(method, r);
  return r.result;
}

async function guarded(fn: () => Promise<ToolOutput>): Promise<ToolOutput> {
  try {
    return await fn();
  } catch (e) {
    const code = e instanceof RpcError ? e.code : 'INTERNAL';
    return text(`✗ ${code}: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

const action = (r: ActionResult): ToolOutput => text(formatAction(r), !r.ok);

const quote = (v: unknown) => (typeof v === 'string' ? (v.length > 30 ? `${v.slice(0, 29)}…` : v) : '');

export const MOBILE_TOOLS: MobileTool[] = [
  {
    name: 'mobile_get_screen',
    kind: 'read',
    description:
      'Fast summary of the current screen: route, title, open modals, keyboard state and the main interactive elements. Use first to orient.',
    shape: {},
    summary: () => 'Read screen summary',
    run: (_a, ctx) => guarded(async () => text((await call<{ text: string }>(ctx, 'getScreen', {})).text)),
  },
  {
    name: 'mobile_get_ui',
    kind: 'read',
    description:
      'Compact UI snapshot of the running app from the React tree plus native hit-testing: every interactive element with a stable ref (e1, e2…), role, label, state, and whether a real touch could reach it ("covered by …"), plus visible text and off-screen elements. Prefer this over screenshots for navigation and interaction.',
    shape: {
      bounds: z.boolean().optional().describe('Include element bounds (x,y,w,h in points) — use for layout questions'),
      max_elements: z.number().int().min(5).max(300).optional(),
    },
    summary: (a) => (a.bounds ? 'Read UI with layout' : 'Read UI'),
    run: (a, ctx) =>
      guarded(async () => {
        const r = await call<{ text: string; stats: { collectMs: number; hitTestMs?: number } }>(ctx, 'getUI', {
          bounds: a.bounds === true,
          ...(typeof a.max_elements === 'number' ? { maxElements: a.max_elements } : {}),
        });
        return text(`${r.text}\n(snapshot ${r.stats.collectMs}ms${r.stats.hitTestMs !== undefined ? `, hit-test ${r.stats.hitTestMs}ms` : ''})`);
      }),
  },
  {
    name: 'mobile_inspect',
    kind: 'read',
    description: [
      'Everything known about one element, React-aware: the file:line where its JSX is written (mapped through Metro), the components that rendered it',
      'and where, props, event handlers present, layout style, accessibility, pointerEvents on it and its ancestors, whether a real touch reaches it',
      '(and where the covering view is written), plus static findings (disabled, covered, no handler, outside its container, misaligned, small target).',
      'Works on any view, not only interactive ones (element refs, text refs like t12, #testID or visible text).',
      'Omit target to inspect the element the developer picked in the app with inspect mode. Static: nothing is tapped.',
      'Use it first for "why doesn\'t this work", "why is this misaligned" and "which component/file is this".',
    ].join(' '),
    shape: {
      target: target.optional().describe('Element to inspect; omit for the developer\'s selection'),
      x: z.number().optional().describe('Or inspect what a real touch at this window point (points) would hit'),
      y: z.number().optional(),
    },
    summary: (a) => (a.target ? `Inspect ${quote(a.target)}` : typeof a.x === 'number' ? `Inspect point ${String(a.x)},${String(a.y)}` : 'Inspect selected element'),
    run: (a, ctx) =>
      guarded(async () => {
        const params = typeof a.x === 'number' && typeof a.y === 'number' ? { point: { x: a.x, y: a.y } } : a.target ? { target: a.target } : {};
        return text((await call<{ text: string }>(ctx, 'inspect', params, 15_000)).text);
      }),
  },
  {
    name: 'mobile_audit_screen',
    kind: 'read',
    description:
      'Static review of the current screen in milliseconds: elements a real touch cannot reach (and what covers them), disabled or handler-less buttons, overlapping touch targets, small targets, missing accessibility labels, text outside its container or misaligned in rows, and errors / failed requests recorded on this screen. Nothing is tapped. Use for "check this screen for bugs".',
    shape: {},
    summary: () => 'Audit screen',
    run: (_a, ctx) => guarded(async () => text((await call<{ text: string }>(ctx, 'audit', {}, 15_000)).text)),
  },
  {
    name: 'mobile_tap',
    kind: 'control',
    description:
      'Tap an element. The device verifies a real touch at the element center would reach it (refuses with NOT_HITTABLE if covered), scrolls it into view if needed, performs the tap and waits for the UI to settle, then reports what changed (route change, new elements, JS errors, failed requests). The result states the interaction mode actually used: Android uses synthesized touch events through the real view hierarchy; iOS uses a semantic press (no public in-process touch API) verified by native hit-testing.',
    shape: {
      target,
      mode: z
        .enum(['auto', 'semantic', 'touch'])
        .optional()
        .describe('auto (default). semantic = call the JS handler even if covered. touch = require real touch synthesis (Android only)'),
      long: z.boolean().optional().describe('Long press instead of tap'),
    },
    summary: (a) => `${a.long ? 'Long-press' : 'Tap'} ${quote(a.target)}`,
    run: (a, ctx) =>
      guarded(async () =>
        action(
          await call<ActionResult>(ctx, a.long ? 'longPress' : 'tap', {
            target: a.target,
            ...(a.mode ? { mode: a.mode } : {}),
          }),
        ),
      ),
  },
  {
    name: 'mobile_type',
    kind: 'control',
    description:
      'Type into a text field through the native text input stack (React Native emits its normal change events). Replaces the current value by default. Empty text clears the field. Set submit to press the keyboard return/submit key afterwards.',
    shape: {
      target,
      text: z.string().max(2000),
      replace: z.boolean().optional().describe('Replace existing text (default true); false appends at the cursor'),
      submit: z.boolean().optional(),
    },
    summary: (a) => `Type into ${quote(a.target)}`,
    run: (a, ctx) =>
      guarded(async () =>
        action(await call<ActionResult>(ctx, 'typeText', { target: a.target, text: a.text, replace: a.replace !== false, submit: a.submit === true })),
      ),
  },
  {
    name: 'mobile_scroll',
    kind: 'control',
    description: 'Scroll a scroll view or list (the largest visible one by default) by a fraction of its viewport.',
    shape: {
      direction: z.enum(['up', 'down', 'left', 'right']),
      target: target.optional().describe('Scroll container ref, or any element inside it'),
      amount: z.number().min(0.1).max(5).optional().describe('Viewport fraction, default 0.75'),
    },
    summary: (a) => `Scroll ${String(a.direction)}`,
    run: (a, ctx) =>
      guarded(async () =>
        action(
          await call<ActionResult>(ctx, 'scroll', {
            direction: a.direction,
            ...(a.target ? { target: a.target } : {}),
            ...(typeof a.amount === 'number' ? { amount: a.amount } : {}),
          }),
        ),
      ),
  },
  {
    name: 'mobile_scroll_to',
    kind: 'control',
    description: 'Scroll until the target element is visible (pages through virtualized lists if it is not rendered yet).',
    shape: { target },
    summary: (a) => `Scroll to ${quote(a.target)}`,
    run: (a, ctx) => guarded(async () => action(await call<ActionResult>(ctx, 'scrollTo', { target: a.target }))),
  },
  {
    name: 'mobile_swipe',
    kind: 'control',
    description: 'Swipe gesture between two points in window coordinates (points). Android only (synthesized touch); unsupported on iOS without an OS-level backend.',
    shape: {
      from_x: z.number(),
      from_y: z.number(),
      to_x: z.number(),
      to_y: z.number(),
      duration_ms: z.number().int().min(50).max(2000).optional(),
    },
    summary: () => 'Swipe',
    run: (a, ctx) =>
      guarded(async () =>
        action(
          await call<ActionResult>(ctx, 'swipe', {
            from: { x: a.from_x, y: a.from_y },
            to: { x: a.to_x, y: a.to_y },
            durationMs: a.duration_ms ?? 300,
          }),
        ),
      ),
  },
  {
    name: 'mobile_wait_for',
    kind: 'read',
    description: 'Wait (event-driven, no fixed sleeps) until a route is active, an element appears/disappears, or text appears/disappears.',
    shape: {
      route: z.string().optional(),
      target: target.optional(),
      text: z.string().optional(),
      gone: z.boolean().optional(),
      timeout_ms: z.number().int().min(100).max(15000).optional(),
    },
    summary: (a) => `Wait for ${quote(a.route ?? a.target ?? a.text)}`,
    run: (a, ctx) =>
      guarded(async () =>
        action(
          await call<ActionResult>(
            ctx,
            'waitFor',
            {
              ...(a.route ? { route: a.route } : {}),
              ...(a.target ? { target: a.target } : {}),
              ...(a.text ? { text: a.text } : {}),
              ...(a.gone ? { gone: true } : {}),
              ...(a.timeout_ms ? { timeoutMs: a.timeout_ms } : {}),
            },
            20_000,
          ),
        ),
      ),
  },
  {
    name: 'mobile_back',
    kind: 'control',
    description: 'Navigate back (Android: in-app back dispatch; iOS: navigation.goBack()).',
    shape: {},
    summary: () => 'Go back',
    run: (_a, ctx) => guarded(async () => action(await call<ActionResult>(ctx, 'back', {}))),
  },
  {
    name: 'mobile_execute_sequence',
    kind: 'control',
    description: [
      'Run several UI actions on the device in ONE call (no model round trip between steps). Steps run in order; each waits for the UI to settle.',
      'Stops at the first failure or when a step\'s `expect` condition is not met, so it never continues blindly after the UI diverges. Max 25 steps / 60 s.',
      'Action types: tap {target, mode?}, longPress {target}, type {target, text, replace?, submit?}, clear {target}, scroll {direction, target?, amount?},',
      'scrollTo {target}, waitFor {route?|target?|text?, gone?, timeoutMs?}, assert {route?|target?|text?, gone?}, back {}, sleep {ms ≤ 2000, avoid}.',
      'Any action may include expect: {route?|target?|text?, gone?, timeoutMs?}.',
      'Example: [{"type":"type","target":"#email","text":"a@b.co"},{"type":"tap","target":"text=Log in","expect":{"route":"Home"}}]',
    ].join(' '),
    shape: {
      actions: z.array(z.record(z.string(), z.unknown())).min(1).max(25),
      timeout_ms: z.number().int().min(1000).max(60000).optional(),
      continue_on_error: z.boolean().optional(),
    },
    summary: (a) => `Run ${Array.isArray(a.actions) ? a.actions.length : '?'} actions`,
    run: (a, ctx) =>
      guarded(async () => {
        const r = await call<SequenceResult>(
          ctx,
          'runSequence',
          { actions: a.actions, options: { timeoutMs: a.timeout_ms ?? 60_000, continueOnError: a.continue_on_error === true } },
          75_000,
        );
        return text(formatSequence(r), !r.ok);
      }),
  },
  {
    name: 'mobile_screenshot',
    kind: 'read',
    description:
      'Capture the app screen as an image (the devtools overlay is hidden). Use for visual questions (layout, alignment, colors, images) — not for routine navigation. annotate=true draws element refs on the image.',
    shape: {
      annotate: z.boolean().optional(),
      max_width: z.number().int().min(240).max(1600).optional().describe('Output width in px (default 720)'),
    },
    summary: (a) => (a.annotate ? 'Annotated screenshot' : 'Screenshot'),
    run: (a, ctx) =>
      guarded(async () => {
        const r = await call<ScreenshotResult>(ctx, 'screenshot', { annotate: a.annotate === true, maxWidth: a.max_width ?? 720 });
        return {
          content: [
            { type: 'image', data: r.data, mimeType: r.mimeType },
            {
              type: 'text',
              text: `Screenshot ${r.width}x${r.height}px of a ${Math.round(r.pointWidth)}x${Math.round(r.pointHeight)}pt window (1pt = ${(r.width / r.pointWidth).toFixed(2)}px). Captured in ${Math.round(r.captureMs)}ms.${r.annotated ? ' Boxes are labelled with element refs.' : ''}`,
            },
          ],
        };
      }),
  },
  {
    name: 'mobile_get_logs',
    kind: 'read',
    description:
      'Recent console output and uncaught JS errors captured in the app since the devtools started (redacted). Error stacks are mapped to app source lines ("at fn (file:line)"). Use errors_only for a quick error check.',
    shape: {
      errors_only: z.boolean().optional(),
      levels: z.array(z.enum(['debug', 'log', 'info', 'warn', 'error'])).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    summary: (a) => (a.errors_only ? 'Read JS errors' : 'Read logs'),
    run: (a, ctx) =>
      guarded(async () => {
        const r = await call<{ entries: LogEntry[]; total: number; dropped: number; capturedSince?: number }>(ctx, 'getLogs', {
          errorsOnly: a.errors_only === true,
          ...(a.levels ? { levels: a.levels } : {}),
          limit: a.limit ?? 40,
        });
        return text(formatLogs(r.entries, r.total, r.dropped, r.capturedSince));
      }),
  },
  {
    name: 'mobile_get_network',
    kind: 'read',
    description:
      'Recent fetch/XMLHttpRequest activity from the app JS (sanitized URLs, status, duration, failure reason, the screen it ran on, and the app code that started it as file:line). Native-originated requests are not captured.',
    shape: {
      failures_only: z.boolean().optional(),
      url_contains: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    summary: (a) => (a.failures_only ? 'Read failed requests' : 'Read network'),
    run: (a, ctx) =>
      guarded(async () => {
        const r = await call<{ entries: NetworkEntry[]; pending: number }>(ctx, 'getNetwork', {
          failuresOnly: a.failures_only === true,
          ...(a.url_contains ? { urlContains: a.url_contains } : {}),
          limit: a.limit ?? 20,
        });
        return text(formatNetwork(r.entries, r.pending));
      }),
  },
  {
    name: 'mobile_get_navigation',
    kind: 'read',
    description: 'Current route, recent navigation history, and native alerts/dialogs that are not part of the React tree.',
    shape: {},
    summary: () => 'Read navigation',
    run: (_a, ctx) => guarded(async () => text(JSON.stringify(await call(ctx, 'getNavigation', {}), null, 1))),
  },
  {
    name: 'mobile_get_device',
    kind: 'read',
    description: 'Device/app info, the interaction capabilities of this platform (which actions are real touches vs semantic), and device-side performance stats.',
    shape: {},
    summary: () => 'Read device info',
    run: (_a, ctx) =>
      guarded(async () => {
        const perf = await call(ctx, 'getPerf', {});
        return text(JSON.stringify({ device: ctx.device?.info, capabilities: ctx.device?.capabilities, perf }, null, 1));
      }),
  },
];

export const CONTROL_TOOLS = new Set(MOBILE_TOOLS.filter((t) => t.kind === 'control').map((t) => t.name));
