/**
 * Core data model shared by the in-app runtime and the desktop server.
 *
 * Everything that crosses the WebSocket is plain JSON. Keep these types
 * free of runtime dependencies so they can be bundled by Metro and run by Node.
 */

export const PROTOCOL_VERSION = 1;

/**
 * How an interaction was actually performed. Tool results always report this so
 * the agent (and the developer) can tell a real touch from a handler call.
 *
 * - `semantic`: a JavaScript handler (e.g. `onPress`) was invoked directly. Bypasses
 *   native hit-testing, gesture recognizers and the responder system.
 * - `native`: a public native API was called on the target view
 *   (e.g. `UIScrollView.setContentOffset`, `UITextField.insertText`, `Editable.replace`).
 *   Exercises native event emission but not finger input.
 * - `synthesized-touch`: a MotionEvent sequence was dispatched through the app's own
 *   window/view hierarchy (Android). Real hit-testing and RN touch pipeline, but not
 *   delivered by the OS input system.
 * - `os-injected`: input injected by the OS automation layer from outside the app
 *   (e.g. `adb shell input`, XCUITest). Closest to a physical touch.
 */
export type InteractionMode = 'semantic' | 'native' | 'synthesized-touch' | 'os-injected';

export type Platform = 'ios' | 'android';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DeviceInfo {
  platform: Platform;
  osVersion: string;
  model?: string;
  isEmulator?: boolean;
  appName?: string;
  bundleId?: string;
  rnVersion?: string;
  libraryVersion: string;
  /** Logical (dp/pt) window size. */
  window: { width: number; height: number; scale: number; fontScale?: number };
  colorScheme?: 'light' | 'dark' | null;
}

export type Role =
  | 'button'
  | 'link'
  | 'textbox'
  | 'switch'
  | 'checkbox'
  | 'radio'
  | 'slider'
  | 'tab'
  | 'menuitem'
  | 'scrollview'
  | 'list'
  | 'modal'
  | 'header'
  | 'image'
  | 'text'
  | 'alert'
  | 'progressbar'
  | 'other';

export interface UIElement {
  /** Short ref for this snapshot, e.g. `e12`. Stable across snapshots while the element persists. */
  ref: string;
  role: Role;
  label?: string;
  /** Visible text inside the element (joined, truncated). */
  text?: string;
  testID?: string;
  nativeID?: string;
  /** Nearest named React component that owns the element, e.g. `LoginButton`. */
  component?: string;
  placeholder?: string;
  /** Text input value (redacted for secure fields), switch/checkbox state, slider value. */
  value?: string | boolean | number;
  secure?: boolean;
  bounds?: Rect;
  enabled: boolean;
  /** Intersects the viewport (and every scroll container it lives in). */
  visible: boolean;
  /** Center point is not covered by another view (only when native hit-testing ran). */
  hittable?: boolean;
  coveredBy?: string;
  focused?: boolean;
  checked?: boolean | 'mixed';
  selected?: boolean;
  expanded?: boolean;
  /** Supported actions, e.g. `tap`, `type`, `scroll`. */
  actions: string[];
  /** Ref of the scroll container the element lives in, if any. */
  scrollContainer?: string;
  /** Ref of the modal the element lives in, if any. */
  modal?: string;
  /** React host tag. Internal; used by the device to resolve native views. */
  tag?: number;
  depth?: number;
}

export interface ScreenSummary {
  route?: string;
  routeParamKeys?: string[];
  navigator?: string;
  title?: string;
  modals: string[];
  window: { width: number; height: number };
  orientation: 'portrait' | 'landscape';
  keyboardVisible: boolean;
  focusedRef?: string;
  interactiveCount: number;
  textCount: number;
  /** Cheap structural fingerprint of the current screen. Changes when the screen changes. */
  signature: string;
}

export interface UISnapshot {
  screen: ScreenSummary;
  elements: UIElement[];
  /** Static text not inside interactive elements (truncated). */
  texts: { ref: string; text: string; bounds?: Rect; visible: boolean }[];
  stats: { fibers: number; hostNodes: number; collectMs: number; hitTestMs?: number };
}

export type LogLevel = 'debug' | 'log' | 'info' | 'warn' | 'error';

export interface LogEntry {
  id: number;
  ts: number;
  level: LogLevel;
  message: string;
  source: 'console' | 'global-error' | 'promise' | 'devtools' | 'action';
  stack?: string;
  fatal?: boolean;
  route?: string;
  repeat?: number;
}

export interface NetworkEntry {
  id: number;
  ts: number;
  method: string;
  url: string;
  status?: number;
  ok?: boolean;
  durationMs?: number;
  error?: string;
  requestBytes?: number;
  responseBytes?: number;
  responseType?: string;
  route?: string;
  pending?: boolean;
  requestBody?: string;
  responseBody?: string;
}

export interface NavigationEvent {
  ts: number;
  route: string;
  paramKeys?: string[];
  action?: string;
  source: 'react-navigation' | 'manual';
}

export interface ScreenshotResult {
  data: string;
  mimeType: 'image/jpeg' | 'image/png';
  /** Pixel size of the encoded image. */
  width: number;
  height: number;
  /** Logical window size in points/dp; image px = points * (width / pointWidth). */
  pointWidth: number;
  pointHeight: number;
  scale: number;
  captureMs: number;
  annotated: boolean;
}

export type ErrorCode =
  | 'INVALID'
  | 'NOT_FOUND'
  | 'AMBIGUOUS'
  | 'STALE'
  | 'DISABLED'
  | 'NOT_HITTABLE'
  | 'UNSUPPORTED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'BLOCKED'
  | 'DENIED'
  | 'THREW'
  | 'NATIVE_ERROR'
  | 'NO_DEVICE'
  | 'INTERNAL';

export interface ToolError {
  code: ErrorCode;
  message: string;
}

export interface ScreenChange {
  screenChanged: boolean;
  routeBefore?: string;
  routeAfter?: string;
  addedInteractive?: number;
  removedInteractive?: number;
  newErrors?: number;
  newFailedRequests?: number;
  keyboardVisible?: boolean;
}

export interface ActionResult {
  ok: boolean;
  action: string;
  target?: { ref: string; role: Role; label?: string; testID?: string };
  mode?: InteractionMode;
  durationMs: number;
  /** The target ref was stale and had to be re-resolved against the current UI. */
  reResolved?: boolean;
  settled?: boolean;
  changes?: ScreenChange;
  warnings?: string[];
  error?: ToolError;
  detail?: Record<string, unknown>;
}

export interface CapabilityInfo {
  supported: boolean;
  mode?: InteractionMode;
  note?: string;
}

export type CapabilityMap = Record<string, CapabilityInfo>;
