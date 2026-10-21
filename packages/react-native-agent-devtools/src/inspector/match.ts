import type { TargetSelector, ToolError } from 'react-native-agent-devtools-protocol';
import { describeTarget } from 'react-native-agent-devtools-protocol';
import type { InternalElement, Snapshot } from './Inspector';
import type { RefRegistry } from './refs';

export type MatchResult =
  | { ok: true; element: InternalElement; reResolved: boolean }
  | { ok: false; error: ToolError };

const norm = (s: string | undefined) => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

function score(el: InternalElement, needle: string, exact: boolean, field: 'any' | 'label'): number {
  const hay = field === 'label' ? [norm(el.label)] : [norm(el.label), norm(el.text), norm(el.placeholder), norm(el.testID)];
  let best = 0;
  for (const h of hay) {
    if (!h) continue;
    if (h === needle) best = Math.max(best, 4);
    else if (exact) continue;
    else if (h.startsWith(needle)) best = Math.max(best, 3);
    else if (new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(h)) best = Math.max(best, 2);
    else if (h.includes(needle)) best = Math.max(best, 1);
  }
  return best;
}

function pick(cands: InternalElement[], sel: TargetSelector): MatchResult {
  if (cands.length === 0) {
    return { ok: false, error: { code: 'NOT_FOUND', message: `No element matches ${describeTarget(sel)}` } };
  }
  if (sel.index !== undefined) {
    const el = cands[sel.index];
    return el
      ? { ok: true, element: el, reResolved: false }
      : { ok: false, error: { code: 'NOT_FOUND', message: `Only ${cands.length} match(es) for ${describeTarget(sel)}` } };
  }
  if (cands.length === 1) return { ok: true, element: cands[0]!, reResolved: false };
  const visible = cands.filter((c) => c.visible);
  if (visible.length === 1) return { ok: true, element: visible[0]!, reResolved: false };
  const list = cands
    .slice(0, 6)
    .map((c) => `${c.ref} ${c.role} "${c.label ?? ''}"${c.visible ? '' : ' (off-screen)'}`)
    .join('; ');
  return {
    ok: false,
    error: { code: 'AMBIGUOUS', message: `${cands.length} elements match ${describeTarget(sel)}: ${list}. Use a ref or index.` },
  };
}

/**
 * Resolve a selector against a snapshot. Refs that are no longer present are
 * re-resolved by testID, then by unique role+label, and reported as `reResolved`;
 * otherwise a STALE error tells the agent to re-read the UI.
 */
export function matchTarget(snap: Snapshot, sel: TargetSelector, refs: RefRegistry): MatchResult {
  const all = snap.internal.elements.filter((e) => e.role !== 'modal' || sel.role === 'modal');

  if (sel.ref) {
    const direct = snap.internal.byRef.get(sel.ref);
    if (direct) return { ok: true, element: direct, reResolved: false };
    const entry = refs.lookup(sel.ref);
    if (!entry) {
      return { ok: false, error: { code: 'NOT_FOUND', message: `Unknown ref ${sel.ref}. Call get_ui to see current refs.` } };
    }
    let cands: InternalElement[] = [];
    if (entry.testID) cands = all.filter((e) => e.testID === entry.testID);
    if (cands.length !== 1 && entry.label) {
      cands = all.filter((e) => e.role === entry.role && norm(e.label) === norm(entry.label));
    }
    if (cands.length === 1) return { ok: true, element: cands[0]!, reResolved: true };
    return {
      ok: false,
      error: {
        code: 'STALE',
        message: `${sel.ref} (${entry.role ?? 'element'} "${entry.label ?? ''}") is no longer on screen. The UI changed; call get_ui for fresh refs.`,
      },
    };
  }

  let cands = all;
  if (sel.testID) cands = cands.filter((e) => e.testID === sel.testID);
  if (sel.role) cands = cands.filter((e) => e.role === sel.role);
  const needle = norm(sel.label ?? sel.text);
  if (needle) {
    const scored = cands
      .map((e) => ({ e, s: score(e, needle, sel.exact === true, sel.label ? 'label' : 'any') }))
      .filter((x) => x.s > 0);
    const top = Math.max(0, ...scored.map((x) => x.s));
    cands = scored.filter((x) => x.s === top).map((x) => x.e);
  }
  return pick(cands, sel);
}

/** True if any visible element or static text contains `text`. */
export function screenHasText(snap: Snapshot, text: string): boolean {
  const needle = norm(text);
  return (
    snap.internal.elements.some((e) => e.visible && (norm(e.label).includes(needle) || norm(e.text).includes(needle))) ||
    snap.texts.some((t) => t.visible && norm(t.text).includes(needle))
  );
}
