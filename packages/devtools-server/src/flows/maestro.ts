import type { Condition, Flow, FlowStep, TargetSelector } from 'react-native-agent-devtools-protocol';

const q = (s: string) => JSON.stringify(s);
const regex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A Maestro element selector (indented block lines), or undefined when Maestro can't express it. */
function selector(t: TargetSelector | undefined, indent: string): string[] | undefined {
  if (!t) return undefined;
  if (t.testID) return [`${indent}id: ${q(t.testID)}`];
  const text = t.label ?? t.text;
  if (text) return [`${indent}text: ${q(t.exact || t.label ? regex(text) : `.*${regex(text)}.*`)}`];
  return undefined;
}

function describe(t: TargetSelector | undefined): string {
  if (!t) return 'element';
  return t.testID ? `#${t.testID}` : (t.label ?? t.text ?? t.role ?? 'element');
}

function condition(c: Condition, verb: 'wait' | 'assert'): string[] {
  if (c.route) return [`# expect route ${q(c.route)} (a React route; Maestro can't see it)`];
  const sel = c.target ? selector(c.target, '      ') : c.text ? [`      text: ${q(`.*${regex(c.text)}.*`)}`] : undefined;
  if (!sel) return [`# ${verb}: ${JSON.stringify(c)} (not expressible in Maestro)`];
  if (verb === 'assert') return [`- ${c.gone ? 'assertNotVisible' : 'assertVisible'}:`, ...sel.map((l) => l.slice(2))];
  return [`- extendedWaitUntil:`, `    ${c.gone ? 'notVisible' : 'visible'}:`, ...sel, `    timeout: ${c.timeoutMs ?? 5000}`];
}

function pct(p: { x: number; y: number }, w?: { width: number; height: number }): string {
  if (!w) return `${Math.round(p.x)},${Math.round(p.y)}`;
  return `${Math.round((p.x / w.width) * 100)}%,${Math.round((p.y / w.height) * 100)}%`;
}

function stepLines(s: FlowStep, flow: Flow): string[] {
  const out: string[] = [];
  const tapOn = (cmd: 'tapOn' | 'longPressOn', t: TargetSelector) => {
    const sel = selector(t, '    ');
    return sel ? [`- ${cmd}:`, ...sel] : [`# ${cmd} ${describe(t)}: no testID or label to select it by`];
  };
  switch (s.type) {
    case 'tap':
      out.push(...tapOn('tapOn', s.target));
      break;
    case 'longPress':
      out.push(...tapOn('longPressOn', s.target));
      break;
    case 'type':
      out.push(...tapOn('tapOn', s.target));
      if (s.replace !== false) out.push('- eraseText: 100');
      out.push(`- inputText: ${q(s.text)}`);
      if (s.submit) out.push('- pressKey: Enter');
      break;
    case 'clear':
      out.push(...tapOn('tapOn', s.target), '- eraseText: 100');
      break;
    case 'scroll':
      // Maestro swipes move the finger; scrolling down means swiping up.
      out.push(s.direction === 'down' ? '- scroll' : `- swipe:\n    direction: ${{ up: 'DOWN', left: 'RIGHT', right: 'LEFT' }[s.direction]}`);
      break;
    case 'scrollTo': {
      const sel = selector(s.target, '      ');
      out.push(...(sel ? ['- scrollUntilVisible:', '    element:', ...sel, '    direction: DOWN'] : [`# scroll to ${describe(s.target)}: no selector`]));
      break;
    }
    case 'waitFor':
      out.push(...condition(s.condition, 'wait'));
      break;
    case 'assert':
      out.push(...condition(s.condition, 'assert'));
      break;
    case 'back':
      out.push(flow.app?.platform === 'ios' ? '# back: iOS has no system back; use the navigation bar button' : '- back');
      break;
    case 'sleep':
      out.push('- waitForAnimationToEnd');
      break;
    case 'swipe':
      out.push('- swipe:', `    start: ${q(pct(s.from, flow.app?.window))}`, `    end: ${q(pct(s.to, flow.app?.window))}`, `    duration: ${s.durationMs ?? 300}`);
      break;
    case 'alert':
      out.push(`- tapOn: ${q(regex(s.button))}`);
      break;
    case 'dismissKeyboard':
      out.push('- hideKeyboard');
      break;
  }
  if ('expect' in s && s.expect) out.push(...condition(s.expect, 'wait'));
  return out;
}

/**
 * Best-effort Maestro flow. Maestro selects by testID (`id`) and visible text; React
 * routes and roles have no Maestro equivalent and become comments. Secret text stays
 * a `${ENV_VAR}` placeholder (pass it with `maestro test -e NAME=value`).
 */
export function toMaestro(flow: Flow): string {
  const lines = [
    ...(flow.app?.bundleId ? [`appId: ${flow.app.bundleId}`] : ['appId: com.example.app # set your app id']),
    `name: ${q(flow.name)}`,
    '---',
    `# Exported from react-native-agent-devtools flow "${flow.name}"${flow.startRoute ? `; starts on route ${q(flow.startRoute)}` : ''}.`,
  ];
  for (const s of flow.steps) lines.push(...stepLines(s, flow));
  return `${lines.join('\n')}\n`;
}
