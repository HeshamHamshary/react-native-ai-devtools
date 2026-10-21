import type { ElementDetails, Finding, Rect, SourceRef } from 'react-native-agent-devtools-protocol';
import { redactText } from 'react-native-agent-devtools-protocol';
import { truncate } from '../utils/misc';
import { componentName, FiberTag, isComposite, nativeTagOf, type Fiber } from './fiber';
import type { InternalElement, Snapshot } from './Inspector';
import { elementCreationFrames, isLibraryFile, UNKNOWN_OWNER, type Symbolicator } from './source';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface DetailsDeps {
  flattenStyle: (style: unknown) => Record<string, unknown> | undefined;
  measure: (f: Fiber) => Rect | undefined;
  platform: 'ios' | 'android';
}

/** React internals and RN primitives: real, but not what the developer wrote. */
const INTERNAL_NAME =
  /^(View|Text|TextImpl|Animated.*|AnimatedComponent.*|Pressable|PressableImpl|Touchable.*|ScrollView.*|TextInput|Switch|Image|ImageImpl|FlatList|VirtualizedList.*|CellRenderer.*|ForwardRef.*|Memo.*|withAnimated.*|Unknown|AppContainer|RootComponent|LogBoxStateSubscription|DebuggingOverlay.*|ScreenContainer|ScreenStack.*|Screen|InnerScreen|MaybeScreen.*|NativeScreen.*|ResourceSavingView|SafeAreaProvider.*|.*Context|.*Provider|Suspense.*|Fragment)$/;

const LAYOUT_KEYS = [
  'width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight',
  'flex', 'flexGrow', 'flexShrink', 'flexBasis', 'flexDirection', 'flexWrap',
  'alignItems', 'alignSelf', 'alignContent', 'justifyContent', 'gap', 'rowGap', 'columnGap',
  'margin', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'marginHorizontal', 'marginVertical', 'marginStart', 'marginEnd',
  'padding', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight', 'paddingHorizontal', 'paddingVertical', 'paddingStart', 'paddingEnd',
  'position', 'top', 'bottom', 'left', 'right', 'zIndex', 'overflow', 'display', 'opacity', 'transform',
  'borderWidth', 'borderRadius', 'backgroundColor', 'fontSize', 'lineHeight', 'fontWeight', 'textAlign', 'color', 'pointerEvents',
];

/** Responder plumbing every Pressable has; not interesting as "the button's handlers". */
const PLUMBING = /^on(Responder|StartShouldSetResponder|MoveShouldSetResponder|Click$|Focus$|Blur$|Layout$|AccessibilityAction$)/;
const HANDLER = /^on[A-Z]/;

const debugOwner = (f: Fiber): Fiber | null => (f as any)._debugOwner ?? null;
const debugStack = (f: Fiber): string | undefined => {
  const s = (f as any)._debugStack;
  return typeof s === 'string' ? s : typeof s?.stack === 'string' ? s.stack : undefined;
};

function displayType(f: Fiber): string {
  if (f.tag === FiberTag.HostComponent) return String(f.type);
  return componentName(f.type) ?? 'Anonymous';
}

function primitive(v: unknown): string | number | boolean | undefined {
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return redactText(truncate(v, 80));
  return undefined;
}

function styleSummary(style: Record<string, unknown> | undefined): Record<string, string | number | boolean> | undefined {
  if (!style) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const k of LAYOUT_KEYS) {
    const v = style[k];
    if (v === undefined || v === null) continue;
    out[k] = typeof v === 'object' ? truncate(JSON.stringify(v), 120) : (v as string | number | boolean);
  }
  return Object.keys(out).length ? out : undefined;
}

/** Components directly wrapping a host view (up to the parent view), outermost first: the outermost is what the app wrote. */
function wrappersOf(host: Fiber): Fiber[] {
  const out: Fiber[] = [];
  for (let f = host.return; f && f.tag !== FiberTag.HostComponent && f.tag !== FiberTag.HostRoot; f = f.return) if (isComposite(f)) out.unshift(f);
  return out;
}

/**
 * Static description of the element whose host view is `host`. `el` is the
 * snapshot's interactive element for it, if any. No interaction is performed.
 */
export function describeElement(snap: Snapshot, host: Fiber, el: InternalElement | undefined, deps: DetailsDeps): ElementDetails {
  const hostProps = host.memoizedProps ?? {};
  const wrappers = wrappersOf(host);
  const wrapper = wrappers[0];
  const wrapperProps = wrapper?.memoizedProps ?? {};
  const style = hostProps.style ? deps.flattenStyle(hostProps.style) : undefined;
  const measured = el?.bounds ?? deps.measure(host);
  const bounds = measured && { x: Math.round(measured.x), y: Math.round(measured.y), width: Math.round(measured.width), height: Math.round(measured.height) };

  // Owners: who rendered whom (React DevTools' "rendered by"), innermost first.
  const owners: ElementDetails['owners'] = [];
  for (let o = debugOwner(host); o && owners.length < 12; o = debugOwner(o)) {
    const name = componentName(o.type);
    if (name && owners[owners.length - 1]?.name !== name) owners.push({ name });
  }

  // Component nesting by tree position, outermost first.
  const path: string[] = [];
  for (let f: Fiber | null = host.return; f && path.length < 40; f = f.return) {
    if (!isComposite(f)) continue;
    const n = componentName(f.type);
    if (n && !INTERNAL_NAME.test(n) && path[0] !== n) path.unshift(n);
  }

  const props: ElementDetails['props'] = {};
  for (const [k, v] of Object.entries({ ...hostProps, ...wrapperProps })) {
    if (k === 'children' || k === 'style' || HANDLER.test(k) || k.startsWith('accessibility') || k.startsWith('aria-')) continue;
    const p = primitive(v);
    if (p !== undefined) props[k] = p;
  }

  const handlers: ElementDetails['handlers'] = [];
  const seen = new Set<string>();
  for (const fiber of [...wrappers, host]) {
    for (const [k, v] of Object.entries(fiber.memoizedProps ?? {})) {
      if (typeof v !== 'function' || !HANDLER.test(k) || PLUMBING.test(k) || seen.has(k)) continue;
      seen.add(k);
      const fnName = (v as { name?: string }).name;
      handlers.push({ prop: k, on: displayType(fiber), ...(fnName && fnName !== k && !/^(anonymous|bound )?$/.test(fnName) ? { name: fnName } : {}) });
    }
  }

  // pointerEvents on the view or any ancestor view that can block touches.
  const pointerEvents: { value: string; on: string }[] = [];
  for (let f: Fiber | null = host; f; f = f.return) {
    if (f.tag !== FiberTag.HostComponent) continue;
    const p = f.memoizedProps ?? {};
    const s = p.style ? deps.flattenStyle(p.style) : undefined;
    const v = p.pointerEvents ?? s?.pointerEvents;
    if (typeof v === 'string' && v !== 'auto' && (f === host || v === 'none' || v === 'box-only')) {
      pointerEvents.push({ value: v, on: f === host ? 'this view' : describeHost(f) });
    }
  }

  let disabledBy: string | undefined;
  if (el && !el.enabled) {
    for (let f: Fiber | null = host; f; f = f.return) {
      const p = f.memoizedProps ?? {};
      if (p.disabled === true || p.accessibilityState?.disabled === true || p.editable === false) {
        disabledBy = displayType(f);
        break;
      }
    }
  }

  const a11yState = hostProps.accessibilityState ?? wrapperProps.accessibilityState;
  const details: ElementDetails = {
    ...(el ? { ref: el.ref, role: el.role } : {}),
    ...(el?.label ? { label: el.label } : {}),
    ...(el?.text ? { text: el.text } : {}),
    host: {
      type: String(host.type),
      ...(nativeTagOf(host) !== undefined ? { tag: nativeTagOf(host) } : {}),
      ...(typeof hostProps.testID === 'string' ? { testID: hostProps.testID } : {}),
      ...(typeof hostProps.nativeID === 'string' ? { nativeID: hostProps.nativeID } : {}),
    },
    ...(el?.component ? { component: el.component } : path.length ? { component: path[path.length - 1] } : {}),
    owners,
    path: path.slice(-10),
    ...(snap.screen.route ? { route: snap.screen.route } : {}),
    ...(bounds ? { bounds } : {}),
    ...(el ? { visible: el.visible } : {}),
    ...(el?.hittable !== undefined ? { hittable: el.hittable } : {}),
    ...(el?.coveredBy ? { coveredBy: el.coveredBy } : {}),
    accessibility: {
      ...(primitive(hostProps.accessibilityLabel ?? wrapperProps.accessibilityLabel) !== undefined
        ? { label: String(primitive(hostProps.accessibilityLabel ?? wrapperProps.accessibilityLabel)) }
        : {}),
      ...(typeof (hostProps.accessibilityRole ?? wrapperProps.accessibilityRole ?? hostProps.role) === 'string'
        ? { role: hostProps.accessibilityRole ?? wrapperProps.accessibilityRole ?? hostProps.role }
        : {}),
      ...(typeof (hostProps.accessibilityHint ?? wrapperProps.accessibilityHint) === 'string'
        ? { hint: redactText(truncate(hostProps.accessibilityHint ?? wrapperProps.accessibilityHint, 120)) }
        : {}),
      ...(typeof hostProps.accessible === 'boolean' ? { accessible: hostProps.accessible } : {}),
      ...(a11yState && typeof a11yState === 'object' ? { state: { ...a11yState } } : {}),
    },
    ...(styleSummary(style) ? { style: styleSummary(style) } : {}),
    props,
    handlers,
    state: {
      enabled: el ? el.enabled : true,
      ...(disabledBy ? { disabledBy } : {}),
      ...(el?.focused ? { focused: true } : {}),
      ...(el?.value !== undefined ? { value: el.value } : {}),
      ...(pointerEvents.length ? { pointerEvents } : {}),
    },
    findings: [],
  };
  details.findings = diagnose(details, el, snap, host, deps);
  return details;
}

function describeHost(f: Fiber): string {
  for (let p = f.return; p; p = p.return) {
    if (p.tag === FiberTag.HostComponent) break;
    const n = componentName(p.type);
    if (n && isComposite(p)) return `${n} (${String(f.type)})`;
  }
  return String(f.type);
}

const MIN_TARGET = { ios: 44, android: 48 };

/** Static checks: what would stop a real finger, a screen reader, or the layout. */
export function diagnose(d: ElementDetails, el: InternalElement | undefined, snap: Snapshot, host: Fiber, deps: DetailsDeps): Finding[] {
  const out: Finding[] = [];
  const add = (severity: Finding['severity'], code: string, message: string) => out.push({ severity, code, message, ...(d.ref ? { ref: d.ref } : {}) });
  const b = d.bounds;
  const win = snap.screen.window;
  const interactive = !!el && el.actions.includes('tap');

  if (!b) add('warning', 'NOT_LAID_OUT', 'The view has no layout (not mounted or not measured yet).');
  else if (b.width <= 0 || b.height <= 0) add('error', 'ZERO_SIZE', `The view is ${b.width}x${b.height}, so nothing can be seen or tapped.`);
  else if (b.x + b.width <= 0 || b.y + b.height <= 0 || b.x >= win.width || b.y >= win.height) {
    let scrolled = false;
    for (let f = host.return; f && !scrolled; f = f.return) scrolled = f.tag === FiberTag.HostComponent && /ScrollView$/.test(String(f.type));
    if (scrolled) add('info', 'SCROLLED_OUT', 'Scrolled out of view inside a scroll container (scroll to it to see it).');
    else add('warning', 'OFF_SCREEN', `The view is outside the screen (at ${b.x},${b.y}).`);
  }
  else if (el && !el.visible) add('warning', 'CLIPPED', 'The view is on screen but clipped by its scroll container, hidden (opacity 0 / display none) or in an inactive screen.');
  else if (b.x < 0 || b.x + b.width > win.width + 0.5) add('warning', 'OVERFLOWS_SCREEN', `The view extends past the screen edge horizontally (x ${b.x} to ${b.x + b.width}, screen width ${win.width}).`);

  for (let f: Fiber | null = host; f; f = f.return) {
    if (f.tag !== FiberTag.HostComponent) continue;
    const s = f.memoizedProps?.style ? deps.flattenStyle(f.memoizedProps.style) : undefined;
    if (s?.opacity === 0) {
      add('warning', 'TRANSPARENT', `${f === host ? 'The view' : `An ancestor (${describeHost(f)})`} has opacity 0.`);
      break;
    }
  }

  if (el && !el.enabled) add('info', 'DISABLED', `The element is disabled${d.state.disabledBy ? ` (disabled set on ${d.state.disabledBy})` : ''}; taps are ignored.`);
  for (const pe of d.state.pointerEvents ?? []) {
    const blocksSelf = pe.on === 'this view' ? pe.value === 'none' || pe.value === 'box-none' : pe.value === 'none';
    if (blocksSelf) add('error', 'POINTER_EVENTS', `pointerEvents="${pe.value}" on ${pe.on} prevents this element from receiving touches.`);
  }
  if (el?.hittable === false) {
    add('error', 'COVERED', `A real touch at its center lands on ${el.coveredBy ?? 'another view'}, not on this element.`);
  }
  if (el && (el.role === 'button' || el.role === 'link') && !el.pressHandler && !el.pressability && !el.explicit) {
    add('warning', 'NO_HANDLER', 'It looks like a button but has no onPress/press handler.');
  }
  if (interactive && b && el!.visible && (b.width < MIN_TARGET[deps.platform] || b.height < MIN_TARGET[deps.platform])) {
    add('info', 'SMALL_TARGET', `Touch target is ${b.width}x${b.height}; platform guidance is at least ${MIN_TARGET[deps.platform]}x${MIN_TARGET[deps.platform]} (hitSlop can extend it).`);
  }
  if (interactive && !d.accessibility.label && !el!.text && el!.role !== 'textbox') {
    add(
      'info',
      'NO_LABEL',
      el!.label && el!.label !== el!.component
        ? `No accessibility label: "${el!.label}" is nearby text that screen readers do not associate with this ${el!.role}. Set accessibilityLabel.`
        : 'Interactive element without an accessibility label or visible text; screen readers announce nothing useful.',
    );
  }
  return out;
}

/** Where the app's own code created `host`: the first app-mapped site along its owner chain. */
export async function firstAppSite(host: Fiber, symbolicator: Symbolicator): Promise<SourceRef | undefined> {
  const tops = [];
  for (let f: Fiber | null = host; f && tops.length < 10; f = debugOwner(f)) {
    const top = elementCreationFrames(debugStack(f))?.[0];
    if (top) tops.push(top);
  }
  const mapped = await symbolicator.symbolicate(tops);
  const site = mapped.find((m) => !!m && !isLibraryFile(m.file));
  return site ? { file: site.file, line: site.line, ...(site.column !== undefined ? { column: site.column } : {}) } : undefined;
}

/**
 * Resolve where the element's JSX is written: walk from the host view through the
 * components that rendered it and take the first creation site in the app's own
 * code. Owner entries get their sites too. Only Metro-mapped positions are reported.
 */
export async function attachSources(d: ElementDetails, host: Fiber, symbolicator: Symbolicator, coveredBy?: Fiber): Promise<void> {
  const chain: Fiber[] = [host];
  for (let o = debugOwner(host); o && chain.length < 10; o = debugOwner(o)) chain.push(o);
  const stacks = chain.map((f) => debugStack(f));
  if (stacks.every((s) => !s)) {
    d.sourceNote = 'React did not record creation stacks for this element (needs a development build with React 19).';
    return;
  }
  if (!symbolicator.available) {
    d.sourceNote = 'The Metro dev server URL is unknown, so source positions cannot be mapped.';
    return;
  }
  const budget = stacks.some((st) => !!st && UNKNOWN_OWNER.test(st));
  // The creation site is the first frame after React's jsx helpers: one Metro request for all of them.
  const tops = stacks.map((st) => elementCreationFrames(st)?.[0]);
  const mapped = await symbolicator.symbolicate(tops.filter((t): t is NonNullable<typeof t> => !!t));
  let k = 0;
  const sites = tops.map((t) => {
    if (!t) return undefined;
    const m = mapped[k++];
    return m && !isLibraryFile(m.file) ? m : undefined;
  });
  if (coveredBy) {
    const site = await firstAppSite(coveredBy, symbolicator);
    if (site) d.coveredBySource = site;
  }
  const toRef = (s: { file: string; line: number; column?: number }): SourceRef => ({ file: s.file, line: s.line, ...(s.column !== undefined ? { column: s.column } : {}) });
  // owners[k] is chain[k + 1]: where that component's element was written.
  d.owners.forEach((o, k) => {
    const idx = chain.findIndex((f, i) => i > 0 && componentName(f.type) === o.name);
    const site = idx > 0 ? sites[idx] : undefined;
    if (site && k < 12) o.source = toRef(site);
  });
  const i = sites.findIndex((s) => !!s);
  if (i >= 0) {
    const site = sites[i]!;
    d.source = { ...toRef(site), element: displayType(chain[i]!), ...(site.fn ? { inComponent: site.fn } : {}) };
  } else {
    d.sourceNote = budget
      ? 'React skipped recording creation stacks during a large render burst; inspect again after the next render.'
      : 'Every creation site maps into libraries (node_modules) or could not be mapped by Metro.';
  }
}

/** Find the snapshot element a host fiber belongs to (itself or the nearest interactive ancestor). */
export function elementForHost(snap: Snapshot, host: Fiber): InternalElement | undefined {
  const byFiber = new Map<Fiber, InternalElement>();
  for (const el of snap.internal.elements) {
    byFiber.set(el.fiber, el);
    if (el.fiber.alternate) byFiber.set(el.fiber.alternate, el);
  }
  for (let f: Fiber | null = host; f; f = f.return) {
    const el = byFiber.get(f);
    if (el && el.role !== 'modal' && el.role !== 'scrollview' && el.role !== 'list') return el;
  }
  return undefined;
}

/** Compact text for the model or the chat attachment. */
export function formatDetails(d: ElementDetails): string {
  const lines: string[] = [];
  const head = [d.ref ?? 'element', d.role ?? d.host.type];
  if (d.label) head.push(`"${d.label}"`);
  if (d.host.testID) head.push(`#${d.host.testID}`);
  if (d.component) head.push(`<${d.component}>`);
  lines.push(head.join(' '));
  if (d.source) {
    lines.push(`source: <${d.source.element}> at ${d.source.file}:${d.source.line}${d.source.inComponent ? ` (in ${d.source.inComponent})` : ''}`);
    const usedAt = d.component && d.component !== d.source.inComponent ? d.owners.find((o) => o.name === d.component)?.source : undefined;
    if (usedAt) lines.push(`used as <${d.component}> at ${usedAt.file}:${usedAt.line}`);
  } else if (d.sourceNote) lines.push(`source: unavailable (${d.sourceNote})`);
  if (d.owners.length) {
    lines.push(`rendered by: ${d.owners.map((o) => `${o.name}${o.source ? ` (${o.source.file.split('/').slice(-2).join('/')}:${o.source.line})` : ''}`).join(' ← ')}`);
  }
  if (d.path.length) lines.push(`path: ${d.path.join(' > ')}`);
  lines.push(`native view: ${d.host.type}${d.host.tag !== undefined ? ` tag=${d.host.tag}` : ''}${d.route ? ` · screen ${d.route}` : ''}`);
  if (d.bounds) lines.push(`bounds: ${d.bounds.x},${d.bounds.y} ${d.bounds.width}x${d.bounds.height}${d.visible === false ? ' (not visible)' : ''}${d.hittable === false ? ` (covered by ${d.coveredBy ?? 'another view'})` : d.hittable ? ' (hittable)' : ''}`);
  if (d.coveredBySource) lines.push(`covering view is written at ${d.coveredBySource.file}:${d.coveredBySource.line}`);
  const st = d.state;
  lines.push(`state: ${st.enabled ? 'enabled' : `disabled${st.disabledBy ? ` by ${st.disabledBy}` : ''}`}${st.focused ? ', focused' : ''}${st.value !== undefined ? `, value=${JSON.stringify(st.value)}` : ''}`);
  if (d.handlers.length) lines.push(`handlers: ${d.handlers.map((h) => `${h.prop}${h.name ? `=${h.name}` : ''} on ${h.on}`).join(', ')} (handler source locations are not available)`);
  else lines.push('handlers: none');
  const a = d.accessibility;
  if (Object.keys(a).length) lines.push(`accessibility: ${JSON.stringify(a)}`);
  if (Object.keys(d.props).length) lines.push(`props: ${JSON.stringify(d.props)}`);
  if (d.style) lines.push(`style: ${JSON.stringify(d.style)}`);
  if (st.pointerEvents?.length) lines.push(`pointerEvents: ${st.pointerEvents.map((p) => `${p.value} on ${p.on}`).join('; ')}`);
  if (d.findings.length) {
    lines.push('findings:');
    for (const f of d.findings) lines.push(`  [${f.severity}] ${f.code}: ${f.message}`);
  } else lines.push('findings: none (static checks only; nothing was tapped)');
  return lines.join('\n');
}
