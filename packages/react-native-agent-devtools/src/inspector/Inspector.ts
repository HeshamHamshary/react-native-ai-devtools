import type { Rect, Role, ScreenSummary, UIElement, UISnapshot } from 'react-native-agent-devtools-protocol';
import { redactText } from 'react-native-agent-devtools-protocol';
import { clock, FNV_SEED, fnv1a, truncate } from '../utils/misc';
import { componentName, FiberTag, isComposite, nativeTagOf, type Fiber } from './fiber';
import { RefRegistry } from './refs';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface InternalElement extends UIElement {
  fiber: Fiber;
  owners: Fiber[];
  fingerprint: string;
  hostType: string;
  pressHandler?: (...args: any[]) => unknown;
  longPressHandler?: (...args: any[]) => unknown;
  pressability: boolean;
  screenTag?: number;
  modalTag?: number;
  hitOffset?: { dx: number; dy: number };
  textParts: string[];
  route?: RouteInfo;
}

export interface InternalText {
  ref: string;
  text: string;
  bounds?: Rect;
  visible: boolean;
  header: boolean;
  fiber: Fiber;
  screenTag?: number;
}

export interface RouteInfo {
  name: string;
  key?: string;
  paramKeys: string[];
  navigation?: { goBack?: () => void; canGoBack?: () => boolean; navigate?: (...a: any[]) => void };
  screenTag?: number;
}

export interface Snapshot extends UISnapshot {
  id: number;
  takenAt: number;
  /** A native stack push/pop animation is in progress (two pushed screens attached). */
  transitioning: boolean;
  internal: {
    elements: InternalElement[];
    texts: InternalText[];
    byRef: Map<string, InternalElement>;
    hostByTag: Map<number, Fiber>;
    route?: RouteInfo;
    canGoBack: boolean;
  };
}

export interface InspectorDeps {
  measure: (f: Fiber) => Rect | undefined;
  flattenStyle: (style: unknown) => Record<string, unknown> | undefined;
  viewport: () => { width: number; height: number };
  probe?: (tags: number[], offsets: number[]) => Promise<{ shown: boolean[]; hit: number[] }>;
  keyboardVisible?: () => boolean;
  focusedTag?: () => number | undefined;
  /** Host tags that belong to the devtools overlay itself. */
  overlayTags?: () => Set<number>;
}

export interface InspectOptions {
  /** Skip native visibility/hit-test probing (faster, less accurate). */
  skipProbe?: boolean;
  maxElements?: number;
  maxTexts?: number;
}

const TEXT_INPUT_TYPES = new Set(['RCTSinglelineTextInputView', 'RCTMultilineTextInputView', 'AndroidTextInput', 'RCTTextInput']);
const SWITCH_TYPES = new Set(['RCTSwitch', 'AndroidSwitch']);
const SCROLL_TYPES = new Set(['RCTScrollView', 'AndroidHorizontalScrollView']);
const TEXT_TYPES = new Set(['RCTText', 'RCTParagraph']);
const SLIDER_TYPES = new Set(['RNCSlider']);
const LIST_COMPONENTS = /^(FlatList|SectionList|VirtualizedList|VirtualizedSectionList|FlashList|ListView)$/;

const ROLE_MAP: Record<string, Role> = {
  button: 'button',
  imagebutton: 'button',
  togglebutton: 'switch',
  keyboardkey: 'button',
  link: 'link',
  checkbox: 'checkbox',
  radio: 'radio',
  switch: 'switch',
  tab: 'tab',
  menuitem: 'menuitem',
  adjustable: 'slider',
  slider: 'slider',
  search: 'textbox',
  combobox: 'button',
  header: 'header',
  heading: 'header',
  image: 'image',
  img: 'image',
  alert: 'alert',
  progressbar: 'progressbar',
  text: 'text',
  list: 'list',
};

const MAX_DEPTH = 1500;

interface Ctx {
  hash: number;
  owners: Fiber[];
  interactive?: InternalElement;
  clip?: Rect;
  scroll?: InternalElement;
  modal?: InternalElement;
  screenTag?: number;
  stackTag?: number;
  hidden: boolean;
  route?: RouteInfo;
}

function intersect(a: Rect, b: Rect): Rect | undefined {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.width, b.x + b.width);
  const btm = Math.min(a.y + a.height, b.y + b.height);
  return r > x && btm > y ? { x, y, width: r - x, height: btm - y } : undefined;
}

const roundRect = (r: Rect): Rect => ({
  x: Math.round(r.x),
  y: Math.round(r.y),
  width: Math.round(r.width),
  height: Math.round(r.height),
});

function collectText(f: Fiber, out: string[], depth = 0): void {
  if (depth > 40) return;
  let c = f.child;
  while (c) {
    if (c.tag === FiberTag.HostText) {
      if (typeof c.memoizedProps === 'string' || typeof c.memoizedProps === 'number') out.push(String(c.memoizedProps));
    } else {
      collectText(c, out, depth + 1);
    }
    c = c.sibling;
  }
}

const cleanText = (parts: string[], sep = ''): string =>
  parts
    .join(sep)
    .replace(/[-]/g, '') // icon-font glyphs (private use area)
    .replace(/\s+/g, ' ')
    .trim();

function ownerProp(owners: Fiber[], name: string): unknown {
  for (const o of owners) {
    const v = o.memoizedProps?.[name];
    if (v !== undefined) return v;
  }
  return undefined;
}

function nearestNamedOwner(owners: Fiber[]): string | undefined {
  for (const o of owners) {
    const n = componentName(o.type);
    // Skip RN/React internals so we surface the app's own component names.
    if (n && !/^(View|Text|Animated|AnimatedComponent|Pressable|TouchableOpacity|TouchableHighlight|TouchableWithoutFeedback|TouchableNativeFeedback|ScrollView|TextInput|Switch|Image|ForwardRef|Memo|withAnimated|Unknown)/.test(n)) {
      return n;
    }
  }
  return undefined;
}

function a11yState(props: any, owners: Fiber[]): { disabled?: boolean; checked?: boolean | 'mixed'; selected?: boolean; expanded?: boolean } {
  const s = props.accessibilityState ?? {};
  return {
    disabled: !!(s.disabled || props['aria-disabled'] || props.disabled === true || ownerProp(owners, 'disabled') === true),
    checked: s.checked ?? props['aria-checked'],
    selected: s.selected ?? props['aria-selected'],
    expanded: s.expanded ?? props['aria-expanded'],
  };
}

/**
 * Builds compact, React-aware UI snapshots from the committed fiber tree.
 * Layout comes from Fabric synchronously; native probing (one batched async call)
 * adds attachment/visibility truth and real hit-testing.
 */
export class Inspector {
  readonly refs = new RefRegistry();
  private snapshotId = 0;
  last?: Snapshot;

  constructor(
    private readonly getRoot: () => Fiber | null,
    private readonly deps: InspectorDeps,
  ) {}

  async snapshot(opts: InspectOptions = {}): Promise<Snapshot> {
    const started = clock();
    const maxElements = opts.maxElements ?? 300;
    const maxTexts = opts.maxTexts ?? 250;
    this.refs.beginSnapshot();
    const vp = this.deps.viewport();
    const viewport: Rect = { x: 0, y: 0, width: vp.width, height: vp.height };

    const elements: InternalElement[] = [];
    const texts: InternalText[] = [];
    const hostByTag = new Map<number, Fiber>();
    const screens: { tag: number; title?: string; stackTag?: number; presentation?: string }[] = [];
    const routes: RouteInfo[] = [];
    const stats = { fibers: 0, hostNodes: 0 };
    let lastStaticText: InternalText | undefined;
    const usedFingerprints = new Set<string>();

    /** A static text directly above, or on the same row to the left, labels a field/switch. */
    const nearbyLabel = (rect: Rect | undefined): string | undefined => {
      const lb = lastStaticText?.bounds;
      if (!lb || !rect || !lastStaticText) return undefined;
      const above = rect.y - (lb.y + lb.height) < 40 && rect.y >= lb.y && Math.abs(lb.x - rect.x) < 60;
      const sameRow = Math.abs(lb.y + lb.height / 2 - (rect.y + rect.height / 2)) < 24 && lb.x + lb.width <= rect.x + 4;
      return above || sameRow ? lastStaticText.text : undefined;
    };

    const fingerprintFor = (hash: number): string => {
      let fp = hash.toString(36);
      while (usedFingerprints.has(fp)) fp += '_';
      usedFingerprints.add(fp);
      return fp;
    };

    const addElement = (
      f: Fiber,
      ctx: Ctx,
      hash: number,
      role: Role,
      rect: Rect | undefined,
      extra: Partial<InternalElement>,
    ): InternalElement | undefined => {
      if (elements.length >= maxElements) return undefined;
      const props = f.memoizedProps ?? {};
      const fingerprint = fingerprintFor(hash);
      const visRect = rect && !ctx.hidden ? intersect(rect, viewport) : undefined;
      const clipped = visRect && ctx.clip ? intersect(visRect, ctx.clip) : visRect;
      const visible = !!clipped && rect!.width > 0 && rect!.height > 0;
      const testID: string | undefined = typeof props.testID === 'string' ? props.testID : undefined;
      const el: InternalElement = {
        ref: '',
        role,
        enabled: true,
        visible,
        actions: [],
        fiber: f,
        owners: ctx.owners,
        fingerprint,
        hostType: f.type,
        pressability: false,
        textParts: [],
        screenTag: ctx.screenTag,
        modalTag: ctx.modal?.tag,
        route: ctx.route,
        ...(testID ? { testID } : {}),
        ...(typeof props.nativeID === 'string' ? { nativeID: props.nativeID } : {}),
        ...(rect ? { bounds: roundRect(rect) } : {}),
        ...extra,
      };
      const tag = nativeTagOf(f);
      if (tag !== undefined) el.tag = tag;
      const component = nearestNamedOwner(ctx.owners);
      if (component) el.component = component;
      if (clipped && rect) {
        el.hitOffset = { dx: clipped.x + clipped.width / 2 - rect.x, dy: clipped.y + clipped.height / 2 - rect.y };
      }
      if (ctx.scroll) el.scrollContainer = ctx.scroll.ref || undefined;
      if (ctx.modal) el.modal = ctx.modal.ref || undefined;
      elements.push(el);
      return el;
    };

    const visit = (f: Fiber, ctx: Ctx, depth: number): void => {
      if (depth > MAX_DEPTH) return;
      stats.fibers++;
      const name = f.tag === FiberTag.HostComponent ? (f.type as string) : (componentName(f.type) ?? '');
      const hash = fnv1a(ctx.hash, `${f.tag}:${name}:${f.key ?? f.index}`);

      if (f.tag === FiberTag.Offscreen && f.memoizedProps?.mode === 'hidden') return;

      if (isComposite(f)) {
        const props = f.memoizedProps;
        let route = ctx.route;
        if (props && props.route && typeof props.route.name === 'string' && props.navigation) {
          route = {
            name: props.route.name,
            key: props.route.key,
            paramKeys: props.route.params ? Object.keys(props.route.params) : [],
            navigation: props.navigation,
            screenTag: ctx.screenTag,
          };
          routes.push(route);
        }
        visitChildren(f, { ...ctx, hash, owners: [f, ...ctx.owners], route }, depth);
        return;
      }

      if (f.tag === FiberTag.HostComponent) {
        visitHost(f, ctx, hash, depth);
        return;
      }

      if (f.tag === FiberTag.HostText) return;
      visitChildren(f, { ...ctx, hash }, depth);
    };

    const visitChildren = (f: Fiber, ctx: Ctx, depth: number): void => {
      let c = f.child;
      while (c) {
        visit(c, ctx, depth + 1);
        c = c.sibling;
      }
    };

    const visitHost = (f: Fiber, ctx: Ctx, hash: number, depth: number): void => {
      stats.hostNodes++;
      const type = f.type as string;
      const props = f.memoizedProps ?? {};
      const tag = nativeTagOf(f);
      if (tag !== undefined) hostByTag.set(tag, f);

      if (type === 'RNSScreen' && props.activityState === 0) return;

      const style = props.style ? this.deps.flattenStyle(props.style) : undefined;
      const hidden = ctx.hidden || style?.opacity === 0 || style?.display === 'none';
      const next: Ctx = { ...ctx, hash, owners: [], hidden };

      if (type === 'RNSScreenStack' && tag !== undefined) next.stackTag = tag;
      if (type === 'RNSScreen' && tag !== undefined) {
        next.screenTag = tag;
        screens.push({
          tag,
          ...(ctx.stackTag !== undefined ? { stackTag: ctx.stackTag } : {}),
          ...(typeof props.stackPresentation === 'string' ? { presentation: props.stackPresentation } : {}),
        });
      }
      if (type === 'RNSScreenStackHeaderConfig') {
        const screen = screens.find((s) => s.tag === ctx.screenTag);
        if (screen && typeof props.title === 'string' && !props.hidden) screen.title = props.title;
      }

      const owners = ctx.owners;
      const a11yLabel: string | undefined =
        props.accessibilityLabel ?? props['aria-label'] ?? (ownerProp(owners, 'accessibilityLabel') as string | undefined);
      const a11yRoleRaw: string | undefined = props.accessibilityRole ?? props.role ?? (ownerProp(owners, 'accessibilityRole') as string | undefined);
      const a11yRole = a11yRoleRaw ? ROLE_MAP[a11yRoleRaw] : undefined;
      const state = a11yState(props, owners);

      // ---- Text ---------------------------------------------------------------
      if (TEXT_TYPES.has(type)) {
        const parts: string[] = [];
        collectText(f, parts);
        const text = cleanText(parts);
        const pressable = typeof props.onResponderRelease === 'function' || typeof ownerProp(owners, 'onPress') === 'function';
        if (pressable && !ctx.interactive) {
          const rect = this.deps.measure(f);
          const el = addElement(f, next, hash, a11yRole ?? 'link', rect, {
            pressability: typeof props.onResponderRelease === 'function',
            pressHandler: ownerProp(owners, 'onPress') as any,
            longPressHandler: ownerProp(owners, 'onLongPress') as any,
            enabled: !state.disabled,
            actions: ['tap'],
          });
          if (el) {
            el.textParts.push(text);
            if (a11yLabel) el.label = a11yLabel;
          }
        } else if (ctx.interactive) {
          if (text) ctx.interactive.textParts.push(text);
        } else if (text && texts.length < maxTexts) {
          const rect = this.deps.measure(f);
          const visRect = rect && !hidden ? intersect(rect, viewport) : undefined;
          const clipped = visRect && ctx.clip ? intersect(visRect, ctx.clip) : visRect;
          const t: InternalText = {
            ref: '',
            text,
            visible: !!clipped,
            header: a11yRole === 'header',
            fiber: f,
            screenTag: ctx.screenTag,
            ...(rect ? { bounds: roundRect(rect) } : {}),
          };
          texts.push(t);
          lastStaticText = t;
        }
        return;
      }

      // ---- Text input -----------------------------------------------------------
      if (TEXT_INPUT_TYPES.has(type)) {
        const rect = this.deps.measure(f);
        const secure = props.secureTextEntry === true;
        const raw = props.text ?? props.value ?? ownerProp(owners, 'value') ?? ownerProp(owners, 'defaultValue');
        const editable = props.editable !== false && ownerProp(owners, 'editable') !== false;
        const label = a11yLabel ?? nearbyLabel(rect);
        addElement(f, next, hash, 'textbox', rect, {
          ...(label ? { label: truncate(label, 80) } : {}),
          ...(typeof props.placeholder === 'string' ? { placeholder: truncate(props.placeholder, 60) } : {}),
          secure,
          value: typeof raw === 'string' ? (secure ? `<${raw.length} chars hidden>` : redactText(truncate(raw, 120))) : undefined,
          enabled: editable && !state.disabled,
          actions: ['tap', 'type', 'clear'],
        });
        return;
      }

      // ---- Switch ------------------------------------------------------------------
      if (SWITCH_TYPES.has(type) || SLIDER_TYPES.has(type)) {
        const rect = this.deps.measure(f);
        const switchLabel = a11yLabel ?? nearbyLabel(rect);
        addElement(f, next, hash, SWITCH_TYPES.has(type) ? 'switch' : 'slider', rect, {
          ...(switchLabel ? { label: switchLabel } : {}),
          // iOS RCTSwitch uses `value`, Android's AndroidSwitch uses `on`.
          value: SWITCH_TYPES.has(type) ? (props.value ?? props.on) === true : props.value,
          enabled: props.disabled !== true && props.enabled !== false && !state.disabled,
          actions: ['tap'],
          pressHandler: (ownerProp(owners, 'onValueChange') as any) ?? undefined,
        });
        return;
      }

      // ---- Modal ----------------------------------------------------------------------
      if (type === 'RCTModalHostView') {
        const rect = this.deps.measure(f) ?? viewport;
        const el = addElement(f, next, hash, 'modal', rect, {
          ...(a11yLabel ? { label: a11yLabel } : {}),
          actions: [],
          visible: !hidden,
        });
        if (el) {
          next.modal = el;
          next.clip = undefined;
        }
        visitChildren(f, next, depth);
        return;
      }

      // ---- Scroll container ---------------------------------------------------------------
      if (SCROLL_TYPES.has(type)) {
        const rect = this.deps.measure(f);
        const listOwner = owners.find((o) => LIST_COMPONENTS.test(componentName(o.type) ?? ''));
        const horizontal = type === 'AndroidHorizontalScrollView' || props.horizontal === true;
        const el = addElement(f, next, hash, listOwner ? 'list' : 'scrollview', rect, {
          ...(a11yLabel ? { label: a11yLabel } : {}),
          actions: horizontal ? ['scroll-left', 'scroll-right'] : ['scroll-up', 'scroll-down'],
          enabled: props.scrollEnabled !== false,
          ...(listOwner ? { component: componentName(listOwner.type) } : {}),
        });
        if (el) {
          next.scroll = el;
          if (rect) next.clip = ctx.clip ? intersect(ctx.clip, rect) ?? { x: 0, y: 0, width: 0, height: 0 } : rect;
        }
        visitChildren(f, next, depth);
        return;
      }

      // ---- Pressables -----------------------------------------------------------------------
      const pressability = typeof props.onResponderRelease === 'function' && typeof props.onResponderGrant === 'function';
      const onPress = (typeof props.onPress === 'function' ? props.onPress : ownerProp(owners, 'onPress')) as any;
      const onClick = typeof props.onClick === 'function' ? props.onClick : undefined;
      const isPressable = pressability || typeof onPress === 'function' || (onClick && a11yRole === 'button');
      if (isPressable) {
        const duplicate = ctx.interactive && ctx.interactive.pressHandler !== undefined && ctx.interactive.pressHandler === onPress;
        if (!duplicate) {
          const rect = this.deps.measure(f);
          const el = addElement(f, next, hash, a11yRole && a11yRole !== 'text' && a11yRole !== 'header' ? a11yRole : 'button', rect, {
            ...(a11yLabel ? { label: a11yLabel } : {}),
            pressability,
            pressHandler: onPress ?? onClick,
            longPressHandler: ownerProp(owners, 'onLongPress') as any,
            enabled: !state.disabled,
            actions: ['tap'],
            ...(state.checked !== undefined ? { checked: state.checked } : {}),
            ...(state.selected !== undefined ? { selected: state.selected } : {}),
            ...(state.expanded !== undefined ? { expanded: state.expanded } : {}),
          });
          if (el) {
            if (el.longPressHandler) el.actions.push('longPress');
            next.interactive = el;
          }
        }
      } else if (a11yLabel && (a11yRole === 'image' || type === 'RCTImageView') && !ctx.interactive) {
        addElement(f, next, hash, 'image', this.deps.measure(f), { label: a11yLabel, actions: [] });
      }

      visitChildren(f, next, depth);
    };

    const root = this.getRoot();
    if (root) {
      let c: Fiber | null = root.child;
      while (c) {
        visit(c, { hash: FNV_SEED, owners: [], hidden: false }, 0);
        c = c.sibling;
      }
    }
    const walkMs = clock() - started;

    // ---- Native probe: attachment, visibility and hit-testing in one batched call ----
    let hitTestMs: number | undefined;
    const overlayTags = this.deps.overlayTags?.() ?? new Set<number>();
    if (this.deps.probe && !opts.skipProbe) {
      const probeStarted = clock();
      const tags: number[] = [];
      const offsets: number[] = [];
      for (const s of screens) {
        tags.push(s.tag);
        offsets.push(-1, -1);
      }
      const probed: InternalElement[] = [];
      for (const el of elements) {
        if (el.tag === undefined) continue;
        probed.push(el);
        tags.push(el.tag);
        const testHit = el.visible && el.hitOffset && el.role !== 'modal' && el.role !== 'scrollview' && el.role !== 'list';
        if (testHit) offsets.push(el.hitOffset!.dx, el.hitOffset!.dy);
        else offsets.push(-1, -1);
      }
      try {
        const res = await this.deps.probe(tags, offsets);
        const hiddenScreens = new Set<number>();
        screens.forEach((s, i) => {
          if (res.shown[i] === false) hiddenScreens.add(s.tag);
        });
        const base = screens.length;
        probed.forEach((el, i) => {
          const shown = res.shown[base + i];
          const hit = res.hit[base + i];
          if (shown === false) el.visible = false;
          if (hit !== undefined && hit >= 0 && el.visible) {
            const covering = this.coveringHost(el, hit, hostByTag, overlayTags);
            el.hittable = covering === null;
            if (covering) el.coveredBy = covering;
          }
        });
        if (hiddenScreens.size) {
          // Screens detached from the window (e.g. under the top of a native stack).
          const keep = (s?: number) => s === undefined || !hiddenScreens.has(s);
          for (let i = elements.length - 1; i >= 0; i--) if (!keep(elements[i]!.screenTag)) elements.splice(i, 1);
          for (let i = texts.length - 1; i >= 0; i--) if (!keep(texts[i]!.screenTag)) texts.splice(i, 1);
          for (let i = routes.length - 1; i >= 0; i--) if (!keep(routes[i]!.screenTag)) routes.splice(i, 1);
          for (let i = screens.length - 1; i >= 0; i--) if (hiddenScreens.has(screens[i]!.tag)) screens.splice(i, 1);
        }
      } catch {
        // Native probing is best-effort; the snapshot stays valid without it.
      }
      hitTestMs = clock() - probeStarted;
    }

    // ---- Labels, refs and texts ----
    for (const el of elements) {
      const text = cleanText(el.textParts, ' ');
      if (text && el.role !== 'textbox') el.text = truncate(text, 120);
      if (!el.label) {
        el.label =
          (el.role === 'textbox' ? el.placeholder : undefined) ??
          (text ? truncate(text, 80) : undefined) ??
          (el.testID ? el.testID.replace(/[-_]+/g, ' ') : undefined) ??
          (el.role === 'scrollview' || el.role === 'list' || el.role === 'modal' ? el.component : undefined) ??
          el.component;
      }
      if (el.label) el.label = redactText(el.label);
      if (el.text) el.text = redactText(el.text);
      el.ref = this.refs.assign(el.fingerprint, { testID: el.testID, role: el.role, label: el.label });
    }
    // Container refs are only known after assignment.
    const byFiber = new Map<Fiber, InternalElement>();
    elements.forEach((el) => byFiber.set(el.fiber, el));
    for (const el of elements) {
      if (el.scrollContainer === '') delete el.scrollContainer;
      if (el.modal === '') delete el.modal;
    }
    this.linkContainers(elements, byFiber);
    texts.forEach((t, i) => {
      t.ref = `t${i + 1}`;
      t.text = redactText(truncate(t.text, 160));
    });

    const focusedTag = this.deps.focusedTag?.();
    const route = routes[routes.length - 1];
    const topScreen = screens[screens.length - 1];
    const modals = elements.filter((e) => e.role === 'modal' && e.visible);
    const interactive = elements.filter((e) => e.role !== 'modal');
    const signatureParts = [route?.name ?? '', ...modals.map((m) => m.fingerprint)];
    for (const el of interactive) if (el.visible) signatureParts.push(el.fingerprint);
    let sig = FNV_SEED;
    for (const p of signatureParts) sig = fnv1a(sig, p);

    const byRef = new Map<string, InternalElement>();
    elements.forEach((el) => byRef.set(el.ref, el));
    const focusedRef = focusedTag !== undefined ? elements.find((e) => e.tag === focusedTag)?.ref : undefined;
    if (focusedRef) byRef.get(focusedRef)!.focused = true;

    const screen: ScreenSummary = {
      ...(route ? { route: route.name, routeParamKeys: route.paramKeys } : {}),
      ...(topScreen?.title ? { title: topScreen.title } : {}),
      modals: modals.map((m) => m.label ?? m.ref),
      window: { width: Math.round(vp.width), height: Math.round(vp.height) },
      orientation: vp.width > vp.height ? 'landscape' : 'portrait',
      keyboardVisible: this.deps.keyboardVisible?.() ?? false,
      ...(focusedRef ? { focusedRef } : {}),
      interactiveCount: interactive.filter((e) => e.visible).length,
      textCount: texts.filter((t) => t.visible).length,
      signature: sig.toString(36),
    };

    const pushedPerStack = new Map<number, number>();
    for (const s of screens) {
      if (s.stackTag === undefined || (s.presentation && s.presentation !== 'push')) continue;
      pushedPerStack.set(s.stackTag, (pushedPerStack.get(s.stackTag) ?? 0) + 1);
    }
    const transitioning = !!this.deps.probe && !opts.skipProbe && [...pushedPerStack.values()].some((n) => n > 1);

    let canGoBack = false;
    try {
      canGoBack = !!route?.navigation?.canGoBack?.();
    } catch {
      canGoBack = false;
    }

    const snap: Snapshot = {
      id: ++this.snapshotId,
      takenAt: Date.now(),
      transitioning,
      screen,
      elements,
      texts: texts.map((t) => ({ ref: t.ref, text: t.text, visible: t.visible, ...(t.bounds ? { bounds: t.bounds } : {}) })),
      stats: {
        fibers: stats.fibers,
        hostNodes: stats.hostNodes,
        collectMs: Math.round((clock() - started) * 10) / 10,
        ...(hitTestMs !== undefined ? { hitTestMs: Math.round(hitTestMs * 10) / 10 } : {}),
      },
      internal: { elements, texts, byRef, hostByTag, ...(route ? { route } : {}), canGoBack },
    };
    void walkMs;
    this.last = snap;
    return snap;
  }

  /** Describe what covers `el` when a real touch at its center would land on `hitTag`. */
  private coveringHost(el: InternalElement, hitTag: number, hostByTag: Map<number, Fiber>, overlayTags: Set<number>): string | null {
    if (hitTag === el.tag) return null;
    if (overlayTags.has(hitTag)) return 'the devtools overlay';
    if (hitTag === 0) return 'another window or non-React view (dialog, LogBox error screen, keyboard or system UI)';
    const hitFiber = hostByTag.get(hitTag) ?? this.findHostOutsideApp(hitTag);
    if (!hitFiber) return `view #${hitTag} outside the inspected app tree`;
    if (!hostByTag.has(hitTag)) {
      for (let f: Fiber | null = hitFiber; f; f = f.return) {
        const n = componentName(f.type) ?? '';
        if (n.startsWith('LogBox')) return 'a LogBox dev notification (warning/error toast); dismiss it in the app first';
      }
      return `${describeFiber(hitFiber)} (rendered outside the app tree)`;
    }
    // Is the hit view inside the element (e.g. its label Text)?
    for (let f: Fiber | null = hitFiber; f; f = f.return) {
      if (f === el.fiber || f === el.fiber.alternate) return null;
    }
    // Hit an ancestor of the element: touches pass through the element (e.g. pointerEvents="none").
    for (let f: Fiber | null = el.fiber.return; f; f = f.return) {
      if (f === hitFiber || f === hitFiber.alternate) return `its container (${describeFiber(hitFiber)}); the element does not receive touches`;
    }
    return describeFiber(hitFiber);
  }

  /** Search the whole React tree (LogBox, other roots under AppContainer) for a host tag. */
  private findHostOutsideApp(tag: number): Fiber | undefined {
    let top = this.getRoot();
    if (!top) return undefined;
    while (top.return) top = top.return;
    const stack: Fiber[] = [top.stateNode?.current ?? top];
    let n = 0;
    while (stack.length && n++ < 20_000) {
      const f = stack.pop()!;
      if (f.tag === FiberTag.HostComponent && nativeTagOf(f) === tag) return f;
      if (f.sibling) stack.push(f.sibling);
      if (f.child) stack.push(f.child);
    }
    return undefined;
  }

  private linkContainers(elements: InternalElement[], byFiber: Map<Fiber, InternalElement>): void {
    for (const el of elements) {
      delete el.scrollContainer;
      delete el.modal;
      for (let f: Fiber | null = el.fiber.return; f; f = f.return) {
        const c = byFiber.get(f);
        if (!c) continue;
        if (!el.scrollContainer && (c.role === 'scrollview' || c.role === 'list')) el.scrollContainer = c.ref;
        if (!el.modal && c.role === 'modal') el.modal = c.ref;
        if (el.scrollContainer && el.modal) break;
      }
    }
  }
}

export function describeFiber(f: Fiber): string {
  const props = f.memoizedProps ?? {};
  let owner: string | undefined;
  for (let p = f.return; p && !owner; p = p.return) {
    if (p.tag === FiberTag.HostComponent) break;
    if (isComposite(p)) owner = componentName(p.type);
  }
  const bits = [owner ?? (f.type === 'RCTView' ? 'View' : String(f.type))];
  if (typeof props.testID === 'string') bits.push(`#${props.testID}`);
  if (typeof props.accessibilityLabel === 'string') bits.push(`"${truncate(props.accessibilityLabel, 40)}"`);
  if (props.pointerEvents) bits.push(`pointerEvents=${props.pointerEvents}`);
  return bits.join(' ');
}
