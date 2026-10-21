import type { NavigationEvent } from 'react-native-agent-devtools-protocol';
import { RingBuffer } from '../utils/RingBuffer';

/** Structural subset of React Navigation's NavigationContainerRef we rely on. */
export interface NavigationRefLike {
  getCurrentRoute?: () => { name: string; params?: object } | undefined;
  addListener?: (event: 'state', cb: () => void) => () => void;
  canGoBack?: () => boolean;
  goBack?: () => void;
  isReady?: () => boolean;
}

/**
 * Tracks route changes. Sources, in priority order:
 * 1. an optional React Navigation container ref (exact, event-driven),
 * 2. explicit `reportRoute()` calls,
 * 3. routes inferred by the inspector from `route` props in the fiber tree.
 */
export class NavigationTracker {
  readonly history = new RingBuffer<NavigationEvent>(50);
  current?: string;
  private unsubscribe?: () => void;
  ref?: NavigationRefLike;

  attach(ref: NavigationRefLike | undefined | null): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.ref = ref ?? undefined;
    if (!ref?.addListener) return;
    const read = () => {
      const r = ref.getCurrentRoute?.();
      if (r?.name) this.record(r.name, 'react-navigation', r.params ? Object.keys(r.params) : undefined);
    };
    this.unsubscribe = ref.addListener('state', read);
    if (ref.isReady?.() !== false) read();
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  record(route: string, source: NavigationEvent['source'], paramKeys?: string[]): void {
    if (route === this.current) return;
    this.current = route;
    this.history.push({ ts: Date.now(), route, source, ...(paramKeys?.length ? { paramKeys } : {}) });
  }

  /** Called with routes inferred from snapshots; ignored when an exact source is attached. */
  observeInferred(route: string | undefined): void {
    if (!route || this.ref?.addListener) return;
    this.record(route, 'manual');
  }
}
