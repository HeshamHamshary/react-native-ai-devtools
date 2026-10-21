import { TurboModuleRegistry, type CodegenTypes, type TurboModule } from 'react-native';

/**
 * Native helpers that JavaScript cannot provide on its own.
 *
 * All view arguments are React host tags (Fabric `nativeTag`). The native side
 * resolves them to real views, so JS never has to translate coordinates.
 * Every method is a no-op that rejects with `RNAD_DISABLED` in non-debuggable builds.
 */
export interface Spec extends TurboModule {
  getConstants(): {
    isDebuggable: boolean;
    isEmulator: boolean;
    model: string;
    osVersion: string;
    appName: string;
    bundleId: string;
  };

  /** Safe-area insets of the key window, in points/dp. */
  getSafeAreaInsets(): Promise<CodegenTypes.UnsafeObject>;

  /**
   * For each tag: whether its native view is attached and shown, and (when
   * `offsets[2i]` is >= 0) the React tag of the view a real touch at
   * `view.origin + (offsets[2i], offsets[2i+1])` would hit.
   * Returns `{ shown: boolean[], hit: number[] }` (hit is -1 when not tested,
   * 0 when the touch would land on a non-React view).
   */
  probeViews(
    tags: ReadonlyArray<CodegenTypes.Int32>,
    offsets: ReadonlyArray<CodegenTypes.Double>
  ): Promise<CodegenTypes.UnsafeObject>;

  /**
   * Android: dispatch a synthesized DOWN/UP MotionEvent pair through the window
   * containing the view, at `view.origin + (dx, dy)`.
   * iOS: toggles/activates UIControls (UISwitch, UISegmentedControl, UIButton) via
   * public UIControl APIs; rejects with `RNAD_UNSUPPORTED` for other views because
   * iOS has no public in-process touch injection API.
   */
  tap(tag: CodegenTypes.Int32, dx: CodegenTypes.Double, dy: CodegenTypes.Double): Promise<CodegenTypes.UnsafeObject>;

  /** Android only: synthesized long press. */
  longPress(
    tag: CodegenTypes.Int32,
    dx: CodegenTypes.Double,
    dy: CodegenTypes.Double,
    durationMs: CodegenTypes.Double
  ): Promise<CodegenTypes.UnsafeObject>;

  /** Android only: synthesized swipe in window coordinates (points/dp). */
  swipe(
    x1: CodegenTypes.Double,
    y1: CodegenTypes.Double,
    x2: CodegenTypes.Double,
    y2: CodegenTypes.Double,
    durationMs: CodegenTypes.Double
  ): Promise<CodegenTypes.UnsafeObject>;

  /**
   * Enter text through the platform text-input stack (UITextInput.insertText /
   * Editable.replace) so React Native emits its normal change events.
   */
  typeText(
    tag: CodegenTypes.Int32,
    text: string,
    replace: boolean,
    submit: boolean
  ): Promise<CodegenTypes.UnsafeObject>;

  /**
   * Scroll the scroll view at `tag` (or its first scrollable descendant) by
   * (dx, dy) points/dp, clamped to content. Returns offset/extent before and after.
   */
  scrollBy(
    tag: CodegenTypes.Int32,
    dx: CodegenTypes.Double,
    dy: CodegenTypes.Double,
    animated: boolean
  ): Promise<CodegenTypes.UnsafeObject>;

  /** Android: in-app back dispatch (OnBackPressedDispatcher). iOS: rejects RNAD_UNSUPPORTED. */
  pressBack(): Promise<CodegenTypes.UnsafeObject>;

  /**
   * Capture the app's windows (including RN modals) as JPEG/PNG base64.
   * `boxes` is a flat [x, y, w, h, ...] list in points/dp drawn with `labels`
   * for annotated screenshots.
   */
  captureScreen(
    maxWidth: CodegenTypes.Double,
    quality: CodegenTypes.Double,
    boxes: ReadonlyArray<CodegenTypes.Double>,
    labels: ReadonlyArray<string>
  ): Promise<CodegenTypes.UnsafeObject>;

  /** Native-only UI the React tree cannot see (system alerts / dialogs). */
  getNativeOverlays(): Promise<CodegenTypes.UnsafeObject>;
}

export default TurboModuleRegistry.get<Spec>('RNAgentDevTools');
