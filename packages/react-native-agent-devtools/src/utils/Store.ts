import { useSyncExternalStore } from 'react';

/** Minimal observable state container used by the overlay UI (no external deps). */
export class Store<S extends object> {
  private listeners = new Set<() => void>();

  constructor(private state: S) {}

  get = (): S => this.state;

  set(patch: Partial<S> | ((s: S) => Partial<S>)): void {
    const next = typeof patch === 'function' ? patch(this.state) : patch;
    this.state = { ...this.state, ...next };
    this.listeners.forEach((l) => l());
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}

export function useStore<S extends object, T>(store: Store<S>, select: (s: S) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}
