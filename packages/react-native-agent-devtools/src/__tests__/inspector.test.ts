import { describe, expect, it } from '@jest/globals';
import { formatSnapshot } from '../inspector/format';
import { matchTarget } from '../inspector/match';
import { comp, host, makeInspector, pressable, root, tagOf, text } from './fixtures';

const r = (x: number, y: number, width = 200, height = 44) => ({ x, y, width, height });

function loginTree() {
  const login = pressable('Log in', r(20, 400), { testID: 'login-submit' });
  const forgot = pressable('Forgot password?', r(20, 460), { disabled: true });
  const tree = root([
    comp('LoginScreen', { route: { name: 'Login', key: 'Login-1' }, navigation: { canGoBack: () => false } }, [
      host('RCTView', {}, [
        host('RCTText', {}, [text('Welcome back')], r(20, 60, 300, 30)),
        host('RCTText', {}, [text('Email')], r(20, 150, 100, 18)),
        comp('TextInput', { value: 'jane@example.com' }, [
          host('RCTSinglelineTextInputView', { testID: 'email', placeholder: 'you@example.com', text: 'jane@example.com' }, [], r(20, 170, 300, 44)),
        ]),
        comp('TextInput', {}, [host('RCTSinglelineTextInputView', { testID: 'password', secureTextEntry: true, text: 'hunter22', accessibilityLabel: 'Password' }, [], r(20, 230, 300, 44))]),
        host('RCTText', {}, [text('Remember me')], r(20, 300, 120, 20)),
        comp('Switch', { onValueChange: () => {} }, [host('RCTSwitch', { value: true }, [], r(300, 296, 51, 31))]),
        login.fiber,
        forgot.fiber,
        host('RCTText', {}, [text('Below the fold')], r(20, 1200, 200, 20)),
      ]),
    ]),
  ]);
  return { tree, login, forgot };
}

describe('Inspector', () => {
  it('discovers interactive elements without registration', async () => {
    const { tree } = loginTree();
    const snap = await makeInspector(() => tree).snapshot();
    const byRole = (role: string) => snap.elements.filter((e) => e.role === role);

    expect(snap.screen.route).toBe('Login');
    const [email, password] = byRole('textbox');
    expect(email).toMatchObject({ label: 'Email', testID: 'email', placeholder: 'you@example.com' });
    expect(email!.value).toBe('<email>'); // redacted personal data
    expect(password).toMatchObject({ label: 'Password', secure: true, value: '<8 chars hidden>' });
    expect(byRole('switch')[0]).toMatchObject({ label: 'Remember me', value: true });
    const buttons = byRole('button');
    expect(buttons.map((b) => b.label)).toEqual(['Log in', 'Forgot password?']);
    expect(buttons[0]).toMatchObject({ testID: 'login-submit', enabled: true, hittable: true });
    expect(buttons[1]!.enabled).toBe(false);
    expect(snap.texts.find((t) => t.text === 'Welcome back')?.visible).toBe(true);
    expect(snap.texts.find((t) => t.text === 'Below the fold')?.visible).toBe(false);
    expect(snap.stats.fibers).toBeGreaterThan(10);
  });

  it('keeps refs stable across snapshots', async () => {
    const { tree } = loginTree();
    const insp = makeInspector(() => tree);
    const a = await insp.snapshot();
    const b = await insp.snapshot();
    expect(b.elements.map((e) => e.ref)).toEqual(a.elements.map((e) => e.ref));
    expect(new Set(a.elements.map((e) => e.ref)).size).toBe(a.elements.length);
  });

  it('reports when another view would receive a real touch', async () => {
    const promo = pressable('Claim promo', r(20, 500), { testID: 'promo' });
    const overlay = host('RCTView', { testID: 'promo-overlay' }, [], r(20, 500));
    const tree = root([comp('Screen', {}, [host('RCTView', {}, [promo.fiber, overlay])])]);
    const insp = makeInspector(() => tree, { hit: (t) => (t === tagOf(promo.view) ? tagOf(overlay) : t) });
    const snap = await insp.snapshot();
    const el = snap.elements.find((e) => e.testID === 'promo')!;
    expect(el.hittable).toBe(false);
    expect(el.coveredBy).toContain('#promo-overlay');
    expect(formatSnapshot(snap)).toContain('[covered by');
  });

  it('treats a hit on the element’s own child as hittable', async () => {
    const btn = pressable('Pay', r(20, 500), { testID: 'pay' });
    const tree = root([btn.fiber]);
    const label = btn.view.child!;
    const snap = await makeInspector(() => tree, { hit: () => tagOf(label) }).snapshot();
    expect(snap.elements[0]!.hittable).toBe(true);
  });

  it('prunes screens that are detached from the window', async () => {
    const a = pressable('Old screen button', r(20, 300));
    const b = pressable('Top screen button', r(20, 300));
    const screenA = host('RNSScreen', { stackPresentation: 'push' }, [comp('A', { route: { name: 'Home' }, navigation: {} }, [a.fiber])]);
    const screenB = host('RNSScreen', { stackPresentation: 'push' }, [comp('B', { route: { name: 'Details' }, navigation: { canGoBack: () => true } }, [b.fiber])]);
    const tree = root([host('RNSScreenStack', {}, [screenA, screenB])]);
    const detached = tagOf(screenA);
    const snap = await makeInspector(() => tree, { shown: (t) => t !== detached }).snapshot();
    expect(snap.elements.map((e) => e.label)).toEqual(['Top screen button']);
    expect(snap.screen.route).toBe('Details');
    expect(snap.internal.canGoBack).toBe(true);
    expect(snap.transitioning).toBe(false);
    // While both pushed screens are attached, a transition is in progress.
    const during = await makeInspector(() => tree).snapshot();
    expect(during.transitioning).toBe(true);
  });

  it('skips inactive screens and hidden subtrees', async () => {
    const hidden = pressable('Hidden', r(20, 100));
    const inactive = pressable('Inactive', r(20, 200));
    const tree = root([
      host('RNSScreen', { activityState: 0 }, [inactive.fiber]),
      host('RCTView', { style: { opacity: 0 } }, [hidden.fiber]),
    ]);
    const snap = await makeInspector(() => tree).snapshot();
    expect(snap.elements.find((e) => e.label === 'Inactive')).toBeUndefined();
    expect(snap.elements.find((e) => e.label === 'Hidden')?.visible).toBe(false);
  });

  it('marks elements outside a scroll viewport as off-screen and links their container', async () => {
    const far = pressable('Continue', r(20, 1500), { testID: 'continue' });
    const tree = root([comp('ScrollView', {}, [host('RCTScrollView', {}, [host('RCTScrollContentView', {}, [far.fiber])], r(0, 0, 400, 800))])]);
    const snap = await makeInspector(() => tree).snapshot();
    const el = snap.elements.find((e) => e.testID === 'continue')!;
    const sv = snap.elements.find((e) => e.role === 'scrollview')!;
    expect(el.visible).toBe(false);
    expect(el.scrollContainer).toBe(sv.ref);
    expect(formatSnapshot(snap)).toMatch(/off-screen \(scroll to reach\): e\d+ button "Continue"/);
  });

  it('dedupes nested pressables that share one handler', async () => {
    const onPress = () => {};
    const inner = host('RCTView', { onResponderGrant: () => {}, onResponderRelease: () => {} }, [host('RCTText', {}, [text('Card')], r(0, 0))], r(0, 0));
    const outer = comp('Card', { onPress }, [host('RCTView', { onResponderGrant: () => {}, onResponderRelease: () => {} }, [comp('Inner', { onPress }, [inner])], r(0, 0))]);
    const snap = await makeInspector(() => root([outer])).snapshot();
    expect(snap.elements.filter((e) => e.role === 'button')).toHaveLength(1);
  });
});

describe('matchTarget', () => {
  it('resolves refs, testIDs, text and roles', async () => {
    const { tree } = loginTree();
    const insp = makeInspector(() => tree);
    const snap = await insp.snapshot();
    const login = snap.elements.find((e) => e.testID === 'login-submit')!;
    const ok = (sel: object) => {
      const m = matchTarget(snap, sel, insp.refs);
      if (!m.ok) throw new Error(m.error.message);
      return m.element;
    };
    expect(ok({ ref: login.ref })).toBe(login);
    expect(ok({ testID: 'login-submit' })).toBe(login);
    expect(ok({ text: 'log in' })).toBe(login);
    expect(ok({ text: 'Remember' }).role).toBe('switch');
    expect(ok({ role: 'textbox', index: 1 }).testID).toBe('password');
    const amb = matchTarget(snap, { role: 'textbox' }, insp.refs);
    expect(amb.ok).toBe(false);
    if (!amb.ok) expect(amb.error.code).toBe('AMBIGUOUS');
    const none = matchTarget(snap, { text: 'Checkout' }, insp.refs);
    expect(!none.ok && none.error.code).toBe('NOT_FOUND');
  });

  it('re-resolves stale refs by testID and otherwise reports STALE', async () => {
    let tree = loginTree().tree;
    const insp = makeInspector(() => tree);
    const first = await insp.snapshot();
    const loginRef = first.elements.find((e) => e.testID === 'login-submit')!.ref;
    const forgotRef = first.elements.find((e) => e.label === 'Forgot password?')!.ref;

    // Same button, different position in the tree (new fingerprint), same testID.
    const moved = pressable('Log in', r(20, 600), { testID: 'login-submit' });
    tree = root([comp('Other', {}, [host('RCTView', {}, [host('RCTView', {}, [moved.fiber])])])]);
    const second = await insp.snapshot();
    const m = matchTarget(second, { ref: loginRef }, insp.refs);
    expect(m.ok && m.reResolved).toBe(true);
    const gone = matchTarget(second, { ref: forgotRef }, insp.refs);
    expect(!gone.ok && gone.error.code).toBe('STALE');
  });
});
