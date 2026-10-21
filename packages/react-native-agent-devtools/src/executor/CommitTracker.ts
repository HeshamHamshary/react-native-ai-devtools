import { CancelledError, clock, sleep } from '../utils/misc';

/**
 * Observes React commits of the app subtree through a public `<Profiler onRender>`
 * callback, so waits can be event-driven instead of fixed delays.
 */
export class CommitTracker {
  lastCommit = clock();
  commits = 0;
  private waiters = new Set<() => void>();

  onRender = (): void => {
    this.lastCommit = clock();
    this.commits++;
    const w = [...this.waiters];
    this.waiters.clear();
    w.forEach((fn) => fn());
  };

  /** Resolves on the next commit or after `timeoutMs`, whichever is first. */
  nextCommit(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new CancelledError());
      let done = false;
      const finish = (v: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        this.waiters.delete(onCommit);
        signal?.removeEventListener?.('abort', onAbort);
        resolve(v);
      };
      const onCommit = () => finish(true);
      const onAbort = () => {
        if (done) return;
        done = true;
        clearTimeout(t);
        this.waiters.delete(onCommit);
        reject(new CancelledError());
      };
      const t = setTimeout(() => finish(false), timeoutMs);
      this.waiters.add(onCommit);
      signal?.addEventListener?.('abort', onAbort);
    });
  }

  /** Resolves once no commit happened for `quietMs` (true), or after `maxMs` (false). */
  async waitForQuiet(quietMs: number, maxMs: number, signal?: AbortSignal): Promise<boolean> {
    const deadline = clock() + maxMs;
    for (;;) {
      if (signal?.aborted) throw new CancelledError();
      const since = clock() - this.lastCommit;
      if (since >= quietMs) return true;
      const remaining = deadline - clock();
      if (remaining <= 0) return false;
      await sleep(Math.min(quietMs - since + 1, remaining), signal);
    }
  }
}
