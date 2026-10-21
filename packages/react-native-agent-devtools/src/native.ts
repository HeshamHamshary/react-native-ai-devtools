import { Platform } from 'react-native';
import type { CapabilityMap, Rect } from 'react-native-agent-devtools-protocol';
import NativeModule from './specs/NativeRNAgentDevTools';

/**
 * Typed, null-safe access to the native helper module. When the module is not
 * linked (e.g. Expo Go, or a build without a native rebuild) every call rejects
 * with an explicit UNSUPPORTED error instead of silently degrading.
 */

export interface ProbeResult {
  shown: boolean[];
  hit: number[];
}

export interface ScrollResult {
  mode: 'native';
  before: { x: number; y: number };
  after: { x: number; y: number };
  max: { x: number; y: number };
  viewport: { width: number; height: number };
  moved: boolean;
}

export interface TypeResult {
  mode: 'native';
  length: number;
  secure: boolean;
  submitted: boolean;
  value?: string;
}

export interface CaptureResult {
  data: string;
  mimeType: 'image/jpeg' | 'image/png';
  width: number;
  height: number;
  pointWidth: number;
  pointHeight: number;
  scale: number;
  captureMs: number;
}

export interface NativeOverlay {
  type: 'alert' | 'actionSheet';
  title?: string;
  message?: string;
  actions: { title: string; style?: string }[];
}

export class NativeUnavailableError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const mod = NativeModule;

export const nativeAvailable = mod != null;

function need() {
  if (!mod) {
    throw new NativeUnavailableError(
      'UNSUPPORTED',
      'Native module RNAgentDevTools is not linked. Rebuild the app (a development build is required; Expo Go is not supported).',
    );
  }
  return mod;
}

let constantsCache: ReturnType<NonNullable<typeof mod>['getConstants']> | null = null;

export function nativeConstants() {
  if (!mod) return null;
  if (!constantsCache) constantsCache = mod.getConstants();
  return constantsCache;
}

export const native = {
  probeViews: (tags: number[], offsets: number[]): Promise<ProbeResult> =>
    need().probeViews(tags, offsets) as Promise<ProbeResult>,
  tap: (tag: number, dx: number, dy: number): Promise<Record<string, unknown>> =>
    need().tap(tag, dx, dy) as Promise<Record<string, unknown>>,
  longPress: (tag: number, dx: number, dy: number, ms: number): Promise<Record<string, unknown>> =>
    need().longPress(tag, dx, dy, ms) as Promise<Record<string, unknown>>,
  swipe: (x1: number, y1: number, x2: number, y2: number, ms: number): Promise<Record<string, unknown>> =>
    need().swipe(x1, y1, x2, y2, ms) as Promise<Record<string, unknown>>,
  typeText: (tag: number, text: string, replace: boolean, submit: boolean): Promise<TypeResult> =>
    need().typeText(tag, text, replace, submit) as Promise<TypeResult>,
  scrollBy: (tag: number, dx: number, dy: number, animated = false): Promise<ScrollResult> =>
    need().scrollBy(tag, dx, dy, animated) as Promise<ScrollResult>,
  pressBack: (): Promise<Record<string, unknown>> => need().pressBack() as Promise<Record<string, unknown>>,
  captureScreen: (maxWidth: number, quality: number, boxes: Rect[] = [], labels: string[] = []): Promise<CaptureResult> =>
    need().captureScreen(
      maxWidth,
      quality,
      boxes.flatMap((b) => [b.x, b.y, b.width, b.height]),
      labels,
    ) as Promise<CaptureResult>,
  getNativeOverlays: async (): Promise<NativeOverlay[]> => {
    const r = (await need().getNativeOverlays()) as { overlays?: NativeOverlay[] };
    return r.overlays ?? [];
  },
  getRootFrame: async (): Promise<{ x: number; y: number; width: number; height: number; scale: number; unit: 'px' | 'pt' }> =>
    (await need().getRootFrame()) as { x: number; y: number; width: number; height: number; scale: number; unit: 'px' | 'pt' },
  pressAlertButton: async (title: string): Promise<{ pressed?: boolean; dismissed?: boolean; mode?: string; found?: boolean }> =>
    (await need().pressAlertButton(title)) as { pressed?: boolean; dismissed?: boolean; mode?: string; found?: boolean },
  getStoredValue: async (key: string): Promise<string | undefined> => {
    if (!mod) return undefined;
    const r = (await mod.getStoredValue(key)) as { value?: string };
    return r.value || undefined;
  },
  setStoredValue: async (key: string, value: string | undefined): Promise<void> => {
    if (mod) await mod.setStoredValue(key, value ?? '');
  },
  getSafeAreaInsets: async (): Promise<{ top: number; bottom: number; left: number; right: number }> => {
    if (!mod) return { top: Platform.OS === 'ios' ? 47 : 24, bottom: Platform.OS === 'ios' ? 34 : 0, left: 0, right: 0 };
    return (await mod.getSafeAreaInsets()) as { top: number; bottom: number; left: number; right: number };
  },
};

/** What this device can actually do. Reported to the server and to the agent. */
export function capabilities(): CapabilityMap {
  const ios = Platform.OS === 'ios';
  const n = nativeAvailable;
  const nativeNote = n ? undefined : 'native module not linked';
  return {
    inspect: { supported: true, note: 'React fiber tree + Fabric layout' },
    hitTest: { supported: n, note: n ? 'UIView.hitTest / TouchTargetHelper' : nativeNote },
    tap: ios
      ? { supported: true, mode: 'semantic', note: 'iOS has no public in-process touch API: JS press via Pressability, verified with native hit-test; UISwitch/UIButton toggled natively' }
      : n
        ? { supported: true, mode: 'synthesized-touch', note: 'MotionEvent dispatched through the window view hierarchy' }
        : { supported: true, mode: 'semantic', note: nativeNote },
    longPress: ios ? { supported: true, mode: 'semantic' } : { supported: n, mode: 'synthesized-touch', note: nativeNote },
    swipe: ios
      ? { supported: false, note: 'requires an OS-level backend on iOS' }
      : { supported: n, mode: 'synthesized-touch', note: nativeNote },
    typeText: n ? { supported: true, mode: 'native' } : { supported: true, mode: 'semantic', note: nativeNote },
    scroll: { supported: n, mode: 'native', note: nativeNote },
    back: ios
      ? { supported: true, mode: 'semantic', note: 'navigation.goBack() via the React Navigation adapter' }
      : { supported: n, mode: 'native', note: n ? 'OnBackPressedDispatcher' : nativeNote },
    screenshot: { supported: n, note: n ? (ios ? 'UIKit drawHierarchy' : 'PixelCopy') : nativeNote },
    nativeAlerts: { supported: n, note: 'read-only' },
    logs: { supported: true },
    network: { supported: true, note: 'XMLHttpRequest/fetch only; native-originated requests are not captured' },
  };
}
