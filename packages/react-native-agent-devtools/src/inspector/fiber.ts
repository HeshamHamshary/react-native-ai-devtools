/**
 * Read-only access to React's committed fiber tree.
 *
 * React Native exposes no public DOM-like view-control API, but in development the
 * reconciler's fibers are reachable from any class component instance
 * (`instance._reactInternals`). We only *read* fibers; nothing here mutates React state.
 * Fiber internals are not a stable public API, so every access is defensive.
 */

export const FiberTag = {
  FunctionComponent: 0,
  ClassComponent: 1,
  HostRoot: 3,
  HostPortal: 4,
  HostComponent: 5,
  HostText: 6,
  Fragment: 7,
  ForwardRef: 11,
  Memo: 14,
  SimpleMemo: 15,
  Offscreen: 22,
} as const;

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface Fiber {
  tag: number;
  type: any;
  key: string | null;
  index: number;
  child: Fiber | null;
  sibling: Fiber | null;
  return: Fiber | null;
  memoizedProps: any;
  stateNode: any;
  alternate: Fiber | null;
}

export function isComposite(f: Fiber): boolean {
  return (
    f.tag === FiberTag.FunctionComponent ||
    f.tag === FiberTag.ClassComponent ||
    f.tag === FiberTag.ForwardRef ||
    f.tag === FiberTag.Memo ||
    f.tag === FiberTag.SimpleMemo
  );
}

export function componentName(type: any): string | undefined {
  if (!type) return undefined;
  if (typeof type === 'string') return type;
  if (typeof type === 'function') return type.displayName || type.name || undefined;
  if (typeof type === 'object') {
    if (typeof type.displayName === 'string') return type.displayName;
    if (type.render) return componentName(type.render); // forwardRef
    if (type.type) return componentName(type.type); // memo
  }
  return undefined;
}

/** Fabric host instance: `{ node, canonical: { nativeTag, ... } }`. */
export function nativeTagOf(f: Fiber): number | undefined {
  const s = f.stateNode;
  if (!s) return undefined;
  const tag = s.canonical?.nativeTag ?? s._nativeTag ?? s.__nativeTag;
  return typeof tag === 'number' ? tag : undefined;
}

export function shadowNodeOf(f: Fiber): unknown {
  return f.stateNode?.node;
}

/**
 * The fiber for `instance` in the *current* (committed) tree. A class instance is
 * shared by both alternates, so we start from the root's `current` and search down.
 */
export function currentFiberForInstance(instance: unknown): Fiber | null {
  const internals: Fiber | undefined = (instance as { _reactInternals?: Fiber } | null)?._reactInternals;
  if (!internals) return null;
  let top: Fiber = internals;
  while (top.return) top = top.return;
  const rootCurrent: Fiber | undefined = top.stateNode?.current;
  if (!rootCurrent) return internals;
  // Iterative DFS; the anchor is near the top of the tree so this is cheap.
  const stack: Fiber[] = [rootCurrent];
  let visited = 0;
  while (stack.length && visited < 5000) {
    const f = stack.pop()!;
    visited++;
    if (f.stateNode === instance) return f;
    if (f.sibling) stack.push(f.sibling);
    if (f.child) stack.push(f.child);
  }
  return internals;
}

/** Everything React Native's Fabric renderer gives us for synchronous layout reads. */
interface FabricUIManager {
  getBoundingClientRect?: (node: unknown, includeTransform: boolean) => [number, number, number, number] | undefined;
  measureInWindow?: (node: unknown, cb: (x: number, y: number, w: number, h: number) => void) => void;
}

export function fabric(): FabricUIManager | undefined {
  return (globalThis as { nativeFabricUIManager?: FabricUIManager }).nativeFabricUIManager;
}

export function boundingRect(f: Fiber): { x: number; y: number; width: number; height: number } | undefined {
  const node = shadowNodeOf(f);
  const ui = fabric();
  if (!node || !ui?.getBoundingClientRect) return undefined;
  try {
    const r = ui.getBoundingClientRect(node, true);
    if (!r) return undefined;
    return { x: r[0], y: r[1], width: r[2], height: r[3] };
  } catch {
    return undefined;
  }
}

/** measureInWindow is synchronous in Fabric; returns undefined if it turns out not to be. */
export function windowRect(f: Fiber): { x: number; y: number; width: number; height: number } | undefined {
  const node = shadowNodeOf(f);
  const ui = fabric();
  if (!node || !ui?.measureInWindow) return undefined;
  let out: { x: number; y: number; width: number; height: number } | undefined;
  try {
    ui.measureInWindow(node, (x, y, width, height) => {
      out = { x, y, width, height };
    });
  } catch {
    return undefined;
  }
  return out;
}
