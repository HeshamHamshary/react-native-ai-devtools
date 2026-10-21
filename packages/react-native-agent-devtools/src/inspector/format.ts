import type { UIElement } from 'react-native-agent-devtools-protocol';
import type { Snapshot } from './Inspector';

export interface FormatOptions {
  /** Include element bounds (for layout questions). */
  bounds?: boolean;
  /** Max visible elements to list. */
  maxElements?: number;
  /** Max static texts to list. */
  maxTexts?: number;
  /** Include off-screen elements (in scroll containers) as a summary. */
  offscreen?: boolean;
}

const q = (s: string) => `"${s.replace(/"/g, "'")}"`;

export function formatElement(el: UIElement, opts: FormatOptions = {}): string {
  const parts: string[] = [el.ref, el.role];
  if (el.label) parts.push(q(el.label));
  if (el.text && el.text !== el.label) parts.push(`text=${q(el.text)}`);
  if (el.testID) parts.push(`#${el.testID}`);
  if (el.role === 'textbox') {
    if (el.placeholder && el.placeholder !== el.label) parts.push(`placeholder=${q(el.placeholder)}`);
    if (el.value !== undefined) parts.push(el.secure ? `value=${String(el.value)}` : `value=${q(String(el.value))}`);
    if (el.secure) parts.push('[secure]');
  } else if (el.role === 'switch' || el.role === 'slider') {
    if (el.value !== undefined) parts.push(`value=${el.value === true ? 'on' : el.value === false ? 'off' : String(el.value)}`);
  }
  if (el.checked !== undefined) parts.push(`[checked=${String(el.checked)}]`);
  if (el.selected) parts.push('[selected]');
  if (el.expanded !== undefined) parts.push(`[${el.expanded ? 'expanded' : 'collapsed'}]`);
  if (!el.enabled) parts.push('[disabled]');
  if (el.focused) parts.push('[focused]');
  // Our own panel is not part of the app; taps move it out of the way first.
  if (el.hittable === false && el.coveredBy !== 'the devtools overlay') parts.push(`[covered by ${el.coveredBy ?? 'another view'}]`);
  if (el.component && el.role !== 'list') parts.push(`<${el.component}>`);
  if (opts.bounds && el.bounds) {
    const b = el.bounds;
    parts.push(`@${b.x},${b.y} ${b.width}x${b.height}`);
  }
  return parts.join(' ');
}

/** Compact, token-lean text rendering of a snapshot for the agent. */
export function formatSnapshot(snap: Snapshot, opts: FormatOptions = {}): string {
  const maxElements = opts.maxElements ?? 80;
  const maxTexts = opts.maxTexts ?? 40;
  const s = snap.screen;
  const lines: string[] = [];
  const head = [`screen: ${s.route ?? 'unknown route'}`];
  if (s.title) head.push(`title=${q(s.title)}`);
  head.push(`${s.window.width}x${s.window.height} ${s.orientation}`);
  if (s.keyboardVisible) head.push('keyboard=shown');
  if (snap.internal.canGoBack) head.push('back=available');
  lines.push(head.join(' · '));
  if (s.modals.length) lines.push(`modal open: ${s.modals.map(q).join(', ')} (elements outside it are not reachable)`);

  const visible = snap.elements.filter((e) => e.visible && e.role !== 'modal');
  const offscreen = snap.elements.filter((e) => !e.visible && e.role !== 'modal' && e.scrollContainer);
  lines.push(`interactive (${visible.length}):`);
  for (const el of visible.slice(0, maxElements)) lines.push(`  ${formatElement(el, opts)}`);
  if (visible.length > maxElements) lines.push(`  …${visible.length - maxElements} more (use a narrower query)`);

  const texts = snap.texts.filter((t) => t.visible);
  if (texts.length) {
    const shown = texts.slice(0, maxTexts).map((t) => (opts.bounds && t.bounds ? `${q(t.text)}@${t.bounds.x},${t.bounds.y}` : q(t.text)));
    lines.push(`text: ${shown.join(' · ')}${texts.length > maxTexts ? ` · …${texts.length - maxTexts} more` : ''}`);
  }
  if (opts.offscreen !== false && offscreen.length) {
    const list = offscreen.slice(0, 15).map((e) => `${e.ref} ${e.role}${e.label ? ` ${q(e.label)}` : ''}`);
    lines.push(`off-screen (scroll to reach): ${list.join(', ')}${offscreen.length > 15 ? `, …${offscreen.length - 15} more` : ''}`);
  }
  return lines.join('\n');
}
