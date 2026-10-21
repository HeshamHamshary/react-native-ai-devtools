import type { Rect } from 'react-native-agent-devtools-protocol';
import type { Fiber } from '../inspector/fiber';
import { Inspector, type InspectorDeps } from '../inspector/Inspector';

/* eslint-disable @typescript-eslint/no-explicit-any */

let nextTag = 100;

type Node = Fiber & { __rect?: Rect };

function link(parent: Fiber, children: Fiber[]): void {
  parent.child = children[0] ?? null;
  children.forEach((c, i) => {
    c.return = parent;
    c.index = i;
    c.sibling = children[i + 1] ?? null;
  });
}

/** Host component fiber (Fabric-shaped stateNode). */
export function host(type: string, props: Record<string, unknown> = {}, children: Fiber[] = [], rect?: Rect): Node {
  const tag = nextTag++;
  const f: Node = {
    tag: 5,
    type,
    key: (props.key as string) ?? null,
    index: 0,
    child: null,
    sibling: null,
    return: null,
    memoizedProps: props,
    stateNode: { node: { tag }, canonical: { nativeTag: tag } },
    alternate: null,
    __rect: rect,
  };
  link(f, children);
  return f;
}

export function text(value: string): Fiber {
  return { tag: 6, type: null, key: null, index: 0, child: null, sibling: null, return: null, memoizedProps: value, stateNode: {}, alternate: null };
}

/** Function component fiber with a given display name. */
export function comp(name: string, props: Record<string, unknown> = {}, children: Fiber[] = []): Fiber {
  const type = { [name]: () => null }[name]!;
  const f: Fiber = { tag: 0, type, key: (props.key as string) ?? null, index: 0, child: null, sibling: null, return: null, memoizedProps: props, stateNode: null, alternate: null };
  link(f, children);
  return f;
}

export function root(children: Fiber[]): Fiber {
  const r: Fiber = { tag: 3, type: null, key: null, index: 0, child: null, sibling: null, return: null, memoizedProps: {}, stateNode: {}, alternate: null };
  link(r, children);
  return r;
}

export const tagOf = (f: Fiber): number => f.stateNode.canonical.nativeTag;

/** A Pressable-like subtree: composite with onPress -> host View with Pressability handlers. */
export function pressable(label: string, rect: Rect, opts: { onPress?: (...a: any[]) => void; disabled?: boolean; testID?: string; name?: string } = {}) {
  const calls: string[] = [];
  const onPress = opts.onPress ?? (() => calls.push('press'));
  const view = host(
    'RCTView',
    {
      testID: opts.testID,
      accessible: true,
      accessibilityState: opts.disabled ? { disabled: true } : undefined,
      onStartShouldSetResponder: () => !opts.disabled,
      onResponderGrant: () => calls.push('grant'),
      onResponderRelease: () => {
        calls.push('release');
        if (!opts.disabled) onPress();
      },
      onClick: () => {},
    },
    [host('RCTText', {}, [text(label)], rect)],
    rect,
  );
  return { fiber: comp(opts.name ?? 'Pressable', { onPress, disabled: opts.disabled }, [view]), view, calls };
}

export interface FakeProbe {
  shown?: (tag: number) => boolean;
  hit?: (tag: number) => number | undefined;
}

export function makeInspector(getRoot: () => Fiber | null, probe: FakeProbe = {}, extra: Partial<InspectorDeps> = {}) {
  return new Inspector(getRoot, {
    measure: (f) => (f as Node).__rect,
    flattenStyle: (s) => (Array.isArray(s) ? Object.assign({}, ...s) : (s as Record<string, unknown>)),
    viewport: () => ({ width: 400, height: 800 }),
    probe: async (tags, offsets) => ({
      shown: tags.map((t) => probe.shown?.(t) ?? true),
      hit: tags.map((t, i) => (offsets[2 * i]! < 0 ? -1 : (probe.hit?.(t) ?? t))),
    }),
    ...extra,
  });
}
