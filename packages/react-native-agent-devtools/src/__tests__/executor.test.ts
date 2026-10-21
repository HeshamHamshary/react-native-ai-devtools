import { describe, expect, it, jest } from '@jest/globals';
import { LogCollector } from '../collectors/LogCollector';
import { NavigationTracker } from '../collectors/NavigationTracker';
import { NetworkCollector } from '../collectors/NetworkCollector';
import { CommitTracker } from '../executor/CommitTracker';
import { Executor, type ExecutorDeps } from '../executor/Executor';
import type { Fiber } from '../inspector/fiber';
import { comp, host, makeInspector, pressable, root, tagOf, text, type FakeProbe } from './fixtures';

const r = (x: number, y: number, width = 200, height = 44) => ({ x, y, width, height });

function setup(tree: () => Fiber, opts: Partial<ExecutorDeps> & { probe?: FakeProbe } = {}) {
  const inspector = makeInspector(tree, opts.probe);
  const native = {
    tap: jest.fn(async () => ({ mode: 'synthesized-touch', handled: true })),
    typeText: jest.fn(async (_t: number, text: string) => ({ mode: 'native', length: text.length, secure: false, submitted: false, value: text })),
    scrollBy: jest.fn(async () => ({ mode: 'native', before: { x: 0, y: 0 }, after: { x: 0, y: 300 }, max: { x: 0, y: 900 }, viewport: { width: 400, height: 800 }, moved: true })),
    pressBack: jest.fn(async () => ({ mode: 'native' })),
  };
  const confirm = jest.fn(async () => true);
  const deps: ExecutorDeps = {
    inspector,
    commits: new CommitTracker(),
    logs: new LogCollector(),
    network: new NetworkCollector(),
    nav: new NavigationTracker(),
    platform: 'ios',
    native: native as unknown as ExecutorDeps['native'],
    nativeAvailable: true,
    confirm,
    setOverlayHidden: () => {},
    confirmSensitive: true,
    ...opts,
  };
  return { exec: new Executor(deps), native, confirm, inspector };
}

describe('Executor.tap', () => {
  it('iOS: performs a semantic press through Pressability and reports the mode', async () => {
    const btn = pressable('Log in', r(20, 400), { testID: 'go' });
    const { exec, native } = setup(() => root([btn.fiber]));
    const res = await exec.tap({ testID: 'go' });
    expect(res.ok).toBe(true);
    expect(res.mode).toBe('semantic');
    expect(res.detail?.via).toBe('pressability');
    expect(btn.calls).toEqual(['grant', 'release', 'press']);
    expect(native.tap).not.toHaveBeenCalled();
    expect(res.target).toMatchObject({ role: 'button', label: 'Log in' });
    expect(res.changes?.screenChanged).toBe(false);
  });

  it('Android: synthesizes a touch at the visible center through the native module', async () => {
    const btn = pressable('Log in', r(20, 400, 200, 40), { testID: 'go' });
    const { exec, native } = setup(() => root([btn.fiber]), { platform: 'android' });
    const res = await exec.tap({ testID: 'go' });
    expect(res.mode).toBe('synthesized-touch');
    expect(native.tap).toHaveBeenCalledWith(tagOf(btn.view), 100, 20);
    expect(btn.calls).toEqual([]); // no JS shortcut was taken
  });

  it('refuses disabled and covered elements instead of pretending', async () => {
    const off = pressable('Submit', r(20, 100), { disabled: true, testID: 'off' });
    const covered = pressable('Promo', r(20, 300), { testID: 'promo' });
    const overlay = host('RCTView', { testID: 'overlay' }, [], r(20, 300));
    const tree = root([host('RCTView', {}, [off.fiber, covered.fiber, overlay])]);
    const { exec } = setup(() => tree, { probe: { hit: (t) => (t === tagOf(covered.view) ? tagOf(overlay) : t) } });

    const d = await exec.tap({ testID: 'off' });
    expect(d.ok).toBe(false);
    expect(d.error?.code).toBe('DISABLED');
    expect(off.calls).toEqual([]);

    const c = await exec.tap({ testID: 'promo' });
    expect(c.error?.code).toBe('NOT_HITTABLE');
    expect(c.error?.message).toContain('#overlay');
    expect(covered.calls).toEqual([]);

    const forced = await exec.tap({ testID: 'promo' }, 'semantic');
    expect(forced.ok).toBe(true);
    expect(forced.warnings?.[0]).toMatch(/covered/);
  });

  it('rejects touch mode on iOS with an explicit capability error', async () => {
    const btn = pressable('Go', r(0, 0), { testID: 'go' });
    const { exec } = setup(() => root([btn.fiber]));
    const res = await exec.tap({ testID: 'go' }, 'touch');
    expect(res.error?.code).toBe('UNSUPPORTED');
    expect(btn.calls).toEqual([]);
  });

  it('asks on-device before sensitive taps and honors a denial', async () => {
    const pay = pressable('Pay now', r(0, 100), { testID: 'pay' });
    const { exec, confirm } = setup(() => root([pay.fiber]));
    confirm.mockResolvedValueOnce(false);
    const denied = await exec.tap({ testID: 'pay' });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(denied.error?.code).toBe('DENIED');
    expect(pay.calls).toEqual([]);
    const allowed = await exec.tap({ testID: 'pay' });
    expect(allowed.ok).toBe(true);
  });

  it('blocks a duplicate submit when the screen did not change', async () => {
    const submit = pressable('Log in', r(0, 100), { testID: 'submit' });
    const { exec } = setup(() => root([submit.fiber]));
    expect((await exec.tap({ testID: 'submit' })).ok).toBe(true);
    const again = await exec.tap({ testID: 'submit' });
    expect(again.error?.code).toBe('BLOCKED');
    expect(submit.calls.filter((c) => c === 'press')).toHaveLength(1);
  });

  it('reports a throwing handler as THREW with the error message', async () => {
    const boom = pressable('Apply coupon', r(0, 100), {
      testID: 'boom',
      onPress: () => {
        throw new TypeError("Cannot read property 'value' of undefined");
      },
    });
    const { exec } = setup(() => root([boom.fiber]));
    const res = await exec.tap({ testID: 'boom' });
    expect(res.error?.code).toBe('THREW');
    expect(res.error?.message).toContain("Cannot read property 'value'");
    expect(res.target?.label).toBe('Apply coupon');
  });
});

describe('Executor text, waits and sequences', () => {
  const form = () => {
    const btn = pressable('Continue', r(20, 300), { testID: 'next' });
    return root([
      comp('TextInput', {}, [host('RCTSinglelineTextInputView', { testID: 'name', placeholder: 'Name' }, [], r(20, 100, 300, 44))]),
      btn.fiber,
    ]);
  };

  it('types through the native text stack', async () => {
    const tree = form();
    const { exec, native } = setup(() => tree);
    const res = await exec.typeText({ testID: 'name' }, 'Alex');
    expect(res.ok).toBe(true);
    expect(res.mode).toBe('native');
    expect(native.typeText).toHaveBeenCalledWith(expect.any(Number), 'Alex', true, false);
  });

  it('waitFor times out with the current screen attached', async () => {
    const tree = form();
    const { exec } = setup(() => tree);
    const res = await exec.waitFor({ text: 'Never appears', timeoutMs: 250 });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('TIMEOUT');
    expect(String(res.detail?.screen)).toContain('Continue');
    expect((await exec.waitFor({ text: 'Continue', timeoutMs: 250 })).ok).toBe(true);
  });

  it('runs a sequence and stops at the first failure', async () => {
    const tree = form();
    const { exec } = setup(() => tree);
    const res = await exec.runSequence(
      [
        { type: 'type', target: { testID: 'name' }, text: 'Alex' },
        { type: 'tap', target: { testID: 'missing' } },
        { type: 'tap', target: { testID: 'next' } },
      ],
      { timeoutMs: 10_000, continueOnError: false },
    );
    expect(res.ok).toBe(false);
    expect(res.completed).toBe(1);
    expect(res.steps).toHaveLength(2);
    expect(res.steps[1]!.error?.code).toBe('NOT_FOUND');
    expect(res.stopped).toMatch(/step 1/);
    expect(res.finalScreen).toContain('Continue');
  });

  it('fails a step whose expect condition is not met (no blind continuation)', async () => {
    const tree = form();
    const { exec } = setup(() => tree);
    const res = await exec.runSequence(
      [
        { type: 'tap', target: { testID: 'next' }, expect: { route: 'Home', timeoutMs: 200 } },
        { type: 'type', target: { testID: 'name' }, text: 'never' },
      ],
      { timeoutMs: 10_000, continueOnError: false },
    );
    expect(res.steps).toHaveLength(1);
    expect(res.steps[0]!.error?.message).toMatch(/expected state was not reached/);
  });

  it('honors cancellation between steps', async () => {
    const tree = form();
    const { exec } = setup(() => tree);
    const ac = new AbortController();
    ac.abort();
    const res = await exec.runSequence([{ type: 'tap', target: { testID: 'next' } }], { timeoutMs: 10_000, continueOnError: false }, ac.signal);
    expect(res.ok).toBe(false);
    expect(res.steps[0]!.error?.code).toBe('CANCELLED');
  });

  it('enforces the sequence timeout', async () => {
    const tree = form();
    const { exec } = setup(() => tree);
    const res = await exec.runSequence(
      [
        { type: 'sleep', ms: 150 },
        { type: 'tap', target: { testID: 'next' } },
      ],
      { timeoutMs: 100, continueOnError: false },
    );
    expect(res.steps[1]!.error?.code).toBe('TIMEOUT');
  });
});

describe('collectors', () => {
  it('LogCollector chains console and the global error handler, redacts and bounds memory', () => {
    const original = jest.fn();
    const prevHandler = jest.fn();
    const g = globalThis as unknown as { ErrorUtils?: unknown };
    const savedEU = g.ErrorUtils;
    let handler: ((e: unknown, fatal?: boolean) => void) | undefined = prevHandler;
    g.ErrorUtils = { getGlobalHandler: () => handler, setGlobalHandler: (h: typeof handler) => (handler = h) };
    const savedWarn = console.warn;
    console.warn = original;
    const logs = new LogCollector(3, () => 'Login');
    logs.install();
    try {
      console.warn('token=abc123secret for jane@example.com');
      console.warn('token=abc123secret for jane@example.com');
      expect(original).toHaveBeenCalledTimes(2);
      const [first] = logs.query();
      expect(first!.message).not.toContain('abc123secret');
      expect(first!.message).not.toContain('jane@example.com');
      expect(first!.repeat).toBe(2);
      expect(first!.route).toBe('Login');
      handler!(new Error('boom'), true);
      expect(prevHandler).toHaveBeenCalledWith(expect.any(Error), true);
      expect(logs.query({ errorsOnly: true })[0]).toMatchObject({ source: 'global-error', fatal: true });
      for (let i = 0; i < 10; i++) console.warn(`w${i}`);
      expect(logs.buffer.size).toBe(3);
    } finally {
      logs.uninstall();
      console.warn = savedWarn;
      g.ErrorUtils = savedEU;
    }
    expect(console.warn).toBe(savedWarn);
  });

  it('NetworkCollector records sanitized XHR traffic and failures', async () => {
    type L = () => void;
    class FakeXHR {
      status = 0;
      responseType = '';
      responseText = '';
      private listeners: Record<string, L[]> = {};
      open(_m: string, _u: string) {}
      send(_b?: unknown) {}
      setRequestHeader() {}
      getResponseHeader(n: string) {
        return n === 'content-type' ? 'application/json; charset=utf-8' : null;
      }
      addEventListener(t: string, fn: L) {
        (this.listeners[t] ??= []).push(fn);
      }
      fire(t: string) {
        this.listeners[t]?.forEach((f) => f());
      }
    }
    const g = globalThis as unknown as { XMLHttpRequest?: unknown };
    const saved = g.XMLHttpRequest;
    g.XMLHttpRequest = FakeXHR;
    const net = new NetworkCollector({}, () => 'Checkout');
    net.install();
    try {
      const ok = new FakeXHR();
      ok.open('get', 'https://api.example.com/users/me?access_token=SECRET&page=2');
      ok.send();
      expect(net.inflightSince(0)).toBe(1);
      ok.status = 200;
      ok.fire('loadend');
      const bad = new FakeXHR();
      bad.open('POST', 'https://api.example.com/pay');
      bad.send('{"card":"4111111111111111","password":"x"}');
      bad.fire('error');
      bad.fire('loadend');
      const all = net.query();
      expect(all[0]).toMatchObject({ method: 'GET', status: 200, ok: true, route: 'Checkout', responseType: 'application/json' });
      expect(all[0]!.url).toBe('https://api.example.com/users/me?access_token=[REDACTED]&page=2');
      expect(all[1]).toMatchObject({ ok: false, error: 'network error' });
      expect(all[1]!.requestBody).toBeUndefined(); // bodies are opt-in
      expect(net.query({ failuresOnly: true })).toHaveLength(1);
      expect(net.inflightSince(0)).toBe(0);
    } finally {
      net.uninstall();
      g.XMLHttpRequest = saved;
    }
  });
});

it('fixtures sanity: text helper produces host text', () => {
  expect(text('x').tag).toBe(6);
});
