import { describe, expect, it, jest } from '@jest/globals';
import { auditScreen, layoutFindings, resetHostKeys } from '../inspector/audit';
import { attachSources, describeElement, elementForHost, formatDetails, type DetailsDeps } from '../inspector/details';
import type { Fiber } from '../inspector/fiber';
import { elementCreationFrames, isLibraryFile, parseStack, Symbolicator, UNKNOWN_OWNER } from '../inspector/source';
import { comp, host, makeInspector, pressable, root, tagOf, text } from './fixtures';

/* eslint-disable @typescript-eslint/no-explicit-any */

const BUNDLE = 'http://localhost:8081/index.bundle//&platform=ios&dev=true';
const hermesStack = (...frames: [string, number][]) =>
  ['Error: react-stack-top-frame', `    at anonymous (${BUNDLE}:26271:77)`, ...frames.map(([fn, line]) => `    at ${fn} (${BUNDLE}:${line}:10)`), `    at react_stack_bottom_frame (${BUNDLE}:9000:1)`, `    at renderWithHooks (${BUNDLE}:9100:1)`].join('\n');

const deps: DetailsDeps = {
  flattenStyle: (s) => (Array.isArray(s) ? Object.assign({}, ...s) : (s as Record<string, unknown>)),
  measure: (f) => (f as any).__rect,
  platform: 'ios',
};

/** Pretend Metro: bundle line N maps to an app file, lines >= 50000 to node_modules. */
const fakeMetro = () => {
  const calls: unknown[] = [];
  const fetchImpl = jest.fn(async (_url: string, init: { body: string }) => {
    const { stack } = JSON.parse(init.body) as { stack: { lineNumber: number; methodName: string }[] };
    calls.push(stack);
    return {
      ok: true,
      json: async () => ({
        stack: stack.map((f) =>
          f.lineNumber >= 50_000
            ? { file: '/proj/node_modules/react-native/Libraries/Components/Pressable/Pressable.js', lineNumber: 1, methodName: f.methodName }
            : { file: `/proj/src/screens/Screen${f.lineNumber}.tsx`, lineNumber: f.lineNumber % 1000, methodName: f.methodName },
        ),
      }),
    };
  });
  return { symbolicator: new Symbolicator(() => 'http://localhost:8081', fetchImpl as never), fetchImpl, calls };
};

describe('stack parsing and source mapping', () => {
  it('parses Hermes frames, including anonymous and "address at" frames', () => {
    const frames = parseStack(`Error: x\n    at LoginScreen (${BUNDLE}:117390:51)\n    at anonymous (address at ${BUNDLE}:1:2)\n    at ${BUNDLE}:3:4\n    at native`);
    expect(frames).toEqual([
      { fn: 'LoginScreen', file: BUNDLE, line: 117390, column: 51 },
      { fn: 'anonymous', file: BUNDLE, line: 1, column: 2 },
      { file: BUNDLE, line: 3, column: 4 },
    ]);
  });

  it('keeps only the JSX creation site of a React debug stack, like formatOwnerStack', () => {
    const frames = elementCreationFrames(hermesStack(['PrimaryButton', 102868]));
    expect(frames).toEqual([{ fn: 'PrimaryButton', file: BUNDLE, line: 102868, column: 10 }]);
    expect(elementCreationFrames(`Error: react-stack-top-frame\n    at UnknownOwner (${BUNDLE}:1:1)`)).toBeUndefined();
    expect(UNKNOWN_OWNER.test('at UnknownOwner (x)')).toBe(true);
  });

  it('treats node_modules, non-file frames and this library as library code', () => {
    expect(isLibraryFile('/a/node_modules/react-native/x.js')).toBe(true);
    expect(isLibraryFile('InternalBytecode.js')).toBe(true);
    expect(isLibraryFile('/repo/packages/react-native-agent-devtools/src/executor/Executor.ts')).toBe(true);
    expect(isLibraryFile('/repo/apps/example/src/App.tsx')).toBe(false);
  });

  it('symbolicates in one request and caches results', async () => {
    const { symbolicator, fetchImpl } = fakeMetro();
    const f = [{ fn: 'A', file: BUNDLE, line: 10, column: 1 }, { fn: 'B', file: BUNDLE, line: 60_000, column: 1 }];
    expect((await symbolicator.appLocations(f)).map((l) => l.file)).toEqual(['/proj/src/screens/Screen10.tsx']);
    await symbolicator.symbolicate(f);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports nothing (not a guess) when the dev server is unreachable', async () => {
    const s = new Symbolicator(() => 'http://localhost:8081', (async () => {
      throw new Error('ECONNREFUSED');
    }) as never);
    expect(await s.symbolicate([{ file: BUNDLE, line: 1, column: 1 }])).toEqual([null]);
  });
});

/** LoginScreen renders <PrimaryButton>, which renders <Pressable>, which renders the host View. */
function tree(opts: { overlay?: boolean; disabled?: boolean } = {}) {
  const btn = pressable('Log in', { x: 20, y: 400, width: 300, height: 48 }, { testID: 'login-submit', disabled: opts.disabled });
  const primary = comp('PrimaryButton', { title: 'Log in' }, [btn.fiber]);
  const screen = comp('LoginScreen', {}, [host('RCTView', {}, [primary, ...(opts.overlay ? [host('RCTView', { testID: 'promo-overlay', style: { position: 'absolute' } }, [], { x: 0, y: 380, width: 400, height: 100 })] : [])], { x: 0, y: 0, width: 400, height: 800 })]);
  // React's owner links and creation stacks.
  Object.assign(btn.view as any, { _debugOwner: btn.fiber, _debugStack: { stack: hermesStack(['Pressable', 55015]) } });
  Object.assign(btn.fiber as any, { _debugOwner: primary, _debugStack: { stack: hermesStack(['PrimaryButton', 35]) } });
  Object.assign(primary as any, { _debugOwner: screen, _debugStack: { stack: hermesStack(['LoginScreen', 1076]) } });
  Object.assign(screen as any, { _debugOwner: null, _debugStack: { stack: hermesStack(['SceneView', 92937]) } });
  return { root: root([screen]), btn, primary, screen };
}

describe('element details', () => {
  it('describes owners, handlers, props and the creation site in app code', async () => {
    const t = tree();
    const snap = await makeInspector(() => t.root).snapshot();
    const el = snap.internal.elements.find((e) => e.testID === 'login-submit')!;
    const d = describeElement(snap, el.fiber, el, deps);
    expect(d.owners.map((o) => o.name)).toEqual(['Pressable', 'PrimaryButton', 'LoginScreen']);
    expect(d.handlers.map((h) => `${h.prop}@${h.on}`)).toEqual(['onPress@Pressable']);
    expect(d.host).toMatchObject({ type: 'RCTView', testID: 'login-submit' });
    expect(d.findings).toEqual([]);

    const { symbolicator, fetchImpl } = fakeMetro();
    await attachSources(d, el.fiber, symbolicator);
    // The host View is created inside Pressable (node_modules); <Pressable> is written in PrimaryButton's file.
    expect(d.source).toMatchObject({ file: '/proj/src/screens/Screen35.tsx', line: 35, element: 'Pressable', inComponent: 'PrimaryButton' });
    expect(d.owners.find((o) => o.name === 'PrimaryButton')?.source).toMatchObject({ file: '/proj/src/screens/Screen1076.tsx', line: 76 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(formatDetails(d)).toMatch(/source: <Pressable> at \/proj\/src\/screens\/Screen35\.tsx:35 \(in PrimaryButton\)/);
  });

  it('explains missing source instead of guessing', async () => {
    const t = tree();
    (t.btn.view as any)._debugStack = { stack: `Error: react-stack-top-frame\n    at UnknownOwner (${BUNDLE}:1:1)` };
    (t.btn.fiber as any)._debugStack = undefined;
    (t.primary as any)._debugStack = undefined;
    (t.screen as any)._debugStack = undefined;
    const snap = await makeInspector(() => t.root).snapshot();
    const el = snap.internal.elements.find((e) => e.testID === 'login-submit')!;
    const d = describeElement(snap, el.fiber, el, deps);
    await attachSources(d, el.fiber, fakeMetro().symbolicator);
    expect(d.source).toBeUndefined();
    expect(d.sourceNote).toMatch(/render burst/);

    const offline = describeElement(snap, el.fiber, el, deps);
    await attachSources(offline, el.fiber, new Symbolicator(() => undefined));
    expect(offline.sourceNote).toMatch(/dev server URL is unknown/);
  });

  it('flags a covered element, names the covering view and where it is written', async () => {
    const t = tree({ overlay: true });
    const overlayTag = tagOf((t.screen.child as any).child.sibling);
    const snap = await makeInspector(() => t.root, { hit: (tag) => (tag === tagOf(t.btn.view) ? overlayTag : tag) }).snapshot();
    const el = snap.internal.elements.find((e) => e.testID === 'login-submit')!;
    expect(el.hittable).toBe(false);
    const d = describeElement(snap, el.fiber, el, deps);
    expect(d.findings.map((f) => f.code)).toContain('COVERED');
    expect(d.findings.find((f) => f.code === 'COVERED')!.message).toMatch(/#promo-overlay/);
    Object.assign(el.coveredByFiber as any, { _debugOwner: t.screen, _debugStack: { stack: hermesStack(['LoginScreen', 1089]) } });
    await attachSources(d, el.fiber, fakeMetro().symbolicator, el.coveredByFiber);
    expect(d.coveredBySource).toMatchObject({ file: '/proj/src/screens/Screen1089.tsx', line: 89 });
  });

  it('reports disabled state and who set it, and pointerEvents that block touches', async () => {
    const t = tree({ disabled: true });
    (t.screen.child as any).memoizedProps.pointerEvents = 'none';
    const snap = await makeInspector(() => t.root).snapshot();
    const el = snap.internal.elements.find((e) => e.testID === 'login-submit')!;
    const d = describeElement(snap, el.fiber, el, deps);
    expect(d.state.enabled).toBe(false);
    expect(d.findings.map((f) => f.code)).toEqual(expect.arrayContaining(['DISABLED', 'POINTER_EVENTS']));
    expect(d.findings.find((f) => f.code === 'POINTER_EVENTS')!.message).toMatch(/pointerEvents="none" on LoginScreen/);
  });

  it('maps a tapped child view back to its interactive element', async () => {
    const t = tree();
    const snap = await makeInspector(() => t.root).snapshot();
    const label = t.btn.view.child!;
    expect(elementForHost(snap, label)?.testID).toBe('login-submit');
  });
});

describe('screen audit and layout checks', () => {
  it('finds covered, overlapping and unlabelled targets plus errors and failures on the screen', async () => {
    const a = pressable('Pay', { x: 20, y: 100, width: 200, height: 48 }, { testID: 'pay' });
    const b = pressable('Pay', { x: 40, y: 110, width: 200, height: 48 }, { testID: 'pay-2' });
    const icon = pressable('', { x: 300, y: 100, width: 20, height: 20 }, { testID: 'icon' });
    const r = root([comp('Checkout', {}, [host('RCTView', {}, [a.fiber, b.fiber, icon.fiber], { x: 0, y: 0, width: 400, height: 800 })])]);
    const snap = await makeInspector(() => r).snapshot();
    const result = auditScreen({
      snap,
      deps,
      errors: [{ id: 1, ts: Date.now(), level: 'error', message: 'TypeError: x is undefined', source: 'global-error' }],
      requests: [{ id: 1, ts: Date.now(), method: 'GET', url: 'https://api.example/cart', status: 500, ok: false }],
    });
    const codes = result.findings.map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(['OVERLAP', 'DUPLICATE_LABEL', 'SMALL_TARGET', 'NO_LABEL', 'ERRORS', 'FAILED_REQUESTS']));
    expect(result.findings[0]!.severity).toBe('error');
  });

  it('detects text outside its container and misaligned rows', async () => {
    resetHostKeys();
    const row = (label: string, value: string, valueRect: { x: number; y: number }, y: number, testID?: string) =>
      host('RCTView', { style: { flexDirection: 'row', justifyContent: 'space-between' } }, [
        host('RCTText', {}, [text(label)], { x: 20, y, width: 60, height: 17 }),
        host('RCTText', testID ? { testID } : {}, [text(value)], { ...valueRect, width: 50, height: 17 }),
      ], { x: 20, y, width: 340, height: 17 });
    const r = root([
      comp('PriceCard', {}, [
        host('RCTView', {}, [row('Base fare', '$412.00', { x: 310, y: 100 }, 100), row('Taxes', '$77.00', { x: 328, y: 129 }, 120, 'misaligned-price')], { x: 0, y: 0, width: 400, height: 300 }),
      ]),
    ]);
    const snap = await makeInspector(() => r).snapshot();
    const messages = layoutFindings(snap, deps).map((f) => `${f.code}: ${f.message}`);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/OUTSIDE_CONTAINER: "\$77\.00" \(#misaligned-price\) extends 18pt past the right edge/),
        expect.stringMatching(/MISALIGNED: In a row in PriceCard, "\$77\.00" .* sits 9pt lower than "Taxes"/),
        expect.stringMatching(/MISALIGNED: "\$77\.00" .* is 18pt right of the matching item "\$412\.00"/),
      ]),
    );
    const priceFiber = snap.internal.texts.find((t) => t.testID === 'misaligned-price')!.fiber as Fiber;
    expect(layoutFindings(snap, deps, priceFiber).length).toBe(3);
  });
});
