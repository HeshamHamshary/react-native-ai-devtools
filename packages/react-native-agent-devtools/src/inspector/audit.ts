import type { Finding, LogEntry, NetworkEntry, Rect } from 'react-native-agent-devtools-protocol';
import { describeElement, type DetailsDeps } from './details';
import { componentName, FiberTag, isComposite, type Fiber } from './fiber';
import type { InternalElement, InternalText, Snapshot } from './Inspector';

export interface AuditInput {
  snap: Snapshot;
  deps: DetailsDeps;
  /** Recent errors (already filtered to the last few minutes). */
  errors: LogEntry[];
  /** Recent completed requests. */
  requests: NetworkEntry[];
}

export interface AuditResult {
  route?: string;
  findings: Finding[];
  checked: { elements: number; texts: number };
}

const area = (r: Rect) => Math.max(0, r.width) * Math.max(0, r.height);

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function nested(a: InternalElement, b: InternalElement): boolean {
  for (let f = a.fiber.return; f; f = f.return) if (f === b.fiber || f === b.fiber.alternate) return true;
  for (let f = b.fiber.return; f; f = f.return) if (f === a.fiber || f === a.fiber.alternate) return true;
  return false;
}

const SEVERITY = { error: 0, warning: 1, info: 2 } as const;

/**
 * Static review of the current screen: what would stop a user, a screen reader or
 * the layout, plus errors and failed requests recorded while it was shown. Nothing
 * is tapped or changed.
 */
export function auditScreen({ snap, deps, errors, requests }: AuditInput): AuditResult {
  const findings: Finding[] = [];
  const route = snap.screen.route;
  const visible = snap.internal.elements.filter((e) => e.visible && e.role !== 'modal' && e.role !== 'scrollview' && e.role !== 'list');

  for (const el of visible) {
    for (const f of describeElement(snap, el.fiber, el, deps).findings) {
      if (f.code === 'CLIPPED' || f.code === 'OFF_SCREEN' || f.code === 'DISABLED') continue;
      findings.push(f);
    }
  }

  const tappable = visible.filter((e) => e.actions.includes('tap') && e.bounds && e.hittable !== false);
  for (let i = 0; i < tappable.length; i++) {
    for (let j = i + 1; j < tappable.length; j++) {
      const a = tappable[i]!;
      const b = tappable[j]!;
      const o = overlap(a.bounds!, b.bounds!);
      if (o > 0.3 * Math.min(area(a.bounds!), area(b.bounds!)) && !nested(a, b)) {
        findings.push({ severity: 'warning', code: 'OVERLAP', ref: a.ref, message: `${a.ref} "${a.label ?? ''}" and ${b.ref} "${b.label ?? ''}" overlap; a tap in the shared area reaches only one of them.` });
      }
    }
  }

  const byLabel = new Map<string, InternalElement[]>();
  for (const el of visible) {
    if (!el.label || !el.actions.includes('tap')) continue;
    const key = `${el.role}:${el.label.toLowerCase()}`;
    byLabel.set(key, [...(byLabel.get(key) ?? []), el]);
  }
  for (const [, els] of byLabel) {
    if (els.length > 1) {
      findings.push({ severity: 'info', code: 'DUPLICATE_LABEL', ref: els[0]!.ref, message: `${els.length} ${els[0]!.role}s are labelled "${els[0]!.label}" (${els.map((e) => e.ref).join(', ')}); screen-reader users can't tell them apart.` });
    }
  }

  findings.push(...layoutFindings(snap, deps));

  const win = snap.screen.window;
  for (const t of snap.internal.texts) {
    if (t.visible && t.bounds && t.bounds.x + t.bounds.width > win.width + 0.5) {
      findings.push({ severity: 'warning', code: 'TEXT_OVERFLOW', message: `Text "${t.text.slice(0, 40)}" extends past the right edge of the screen (to x=${t.bounds.x + t.bounds.width}, width ${win.width}).` });
    }
  }

  const here = (r?: string) => !route || r === route;
  const screenErrors = errors.filter((e) => here(e.route));
  if (screenErrors.length) {
    const first = screenErrors[screenErrors.length - 1]!;
    findings.push({ severity: 'error', code: 'ERRORS', message: `${screenErrors.length} error(s) logged on this screen; latest: ${first.message.slice(0, 160)}${first.fatal ? ' (fatal)' : ''}` });
  }
  const failed = requests.filter((r) => here(r.route) && !r.pending && r.ok === false);
  if (failed.length) {
    const f = failed[failed.length - 1]!;
    findings.push({ severity: 'error', code: 'FAILED_REQUESTS', message: `${failed.length} failed request(s) on this screen; latest: ${f.method} ${f.url} → ${f.status || f.error}` });
  }

  findings.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity]);
  return { ...(route ? { route } : {}), findings, checked: { elements: visible.length, texts: snap.internal.texts.filter((t) => t.visible).length } };
}

const hostParent = (f: Fiber): Fiber | undefined => {
  for (let p = f.return; p; p = p.return) if (p.tag === FiberTag.HostComponent) return p;
  return undefined;
};

function ownerName(f: Fiber): string {
  for (let p = f.return; p; p = p.return) {
    const n = isComposite(p) ? componentName(p.type) : undefined;
    if (n && !/^(View|Text|TextImpl|Animated|ForwardRef|Memo)/.test(n)) return n;
  }
  return 'its parent';
}

const q = (t: InternalText) => `"${t.text.slice(0, 30)}"${t.testID ? ` (#${t.testID})` : ''}`;

/**
 * Layout heuristics for static text, the usual home of alignment bugs: text drawn
 * outside its container, items in a row that don't line up, and the same column
 * drifting between rows that share a layout.
 */
export function layoutFindings(snap: Snapshot, deps: DetailsDeps, only?: Fiber): Finding[] {
  const rows = new Map<Fiber, InternalText[]>();
  // For a single inspected view, look at its row and the rows beside it, scrolled into view or not.
  const scope = only ? hostParent(hostParent(only) ?? only) : undefined;
  const inScope = (f: Fiber) => {
    if (!scope) return true;
    for (let p = f.return; p; p = p.return) if (p === scope || p === scope.alternate) return true;
    return false;
  };
  for (const t of snap.internal.texts) {
    if ((!only && !t.visible) || !t.bounds || !inScope(t.fiber)) continue;
    const parent = hostParent(t.fiber);
    if (parent) rows.set(parent, [...(rows.get(parent) ?? []), t]);
  }
  if (only) {
    const mine = (t: InternalText) => t.fiber === only || t.fiber === only.alternate;
    return layoutFromRows(rows, deps).filter((f) => f.texts.some(mine)).map((f) => f.finding);
  }
  return layoutFromRows(rows, deps).map((f) => f.finding);
}

function layoutFromRows(rows: Map<Fiber, InternalText[]>, deps: DetailsDeps): { finding: Finding; texts: InternalText[] }[] {
  const out: { finding: Finding; texts: InternalText[] }[] = [];
  const styleOf = (f: Fiber) => (f.memoizedProps?.style ? deps.flattenStyle(f.memoizedProps.style) : undefined) ?? {};
  const signature = (f: Fiber) => {
    const st = styleOf(f);
    return `${String(st.flexDirection ?? 'column')}|${String(st.justifyContent ?? '')}|${String(st.alignItems ?? '')}`;
  };

  for (const [parent, items] of rows) {
    const pb = deps.measure(parent);
    const st = styleOf(parent);
    if (pb && st.overflow !== 'hidden') {
      for (const t of items) {
        const b = t.bounds!;
        const right = b.x + b.width - (pb.x + pb.width);
        const left = pb.x - b.x;
        const below = b.y + b.height - (pb.y + pb.height);
        const worst = Math.max(right, left, below);
        if (worst > 1.5) {
          const side = worst === right ? 'right' : worst === left ? 'left' : 'bottom';
          out.push({
            texts: [t],
            finding: { severity: 'warning', code: 'OUTSIDE_CONTAINER', message: `${q(t)} extends ${Math.round(worst)}pt past the ${side} edge of its container in ${ownerName(parent)} (check negative margins, fixed widths or position).` },
          });
        }
      }
    }
    if (st.flexDirection === 'row' && items.length >= 2 && !st.alignItems) {
      const tops = items.map((t) => t.bounds!.y);
      const spread = Math.max(...tops) - Math.min(...tops);
      if (spread > 3) {
        const low = items[tops.indexOf(Math.max(...tops))]!;
        const high = items[tops.indexOf(Math.min(...tops))]!;
        out.push({ texts: items, finding: { severity: 'warning', code: 'MISALIGNED', message: `In a row in ${ownerName(parent)}, ${q(low)} sits ${Math.round(spread)}pt lower than ${q(high)}.` } });
      }
    }
  }

  // Sibling rows with the same layout should line their columns up.
  const groups = new Map<string, { parent: Fiber; items: InternalText[] }[]>();
  for (const [parent, items] of rows) {
    const grand = hostParent(parent);
    if (!grand || items.length < 2) continue;
    const key = `${hostKey(grand)}:${signature(parent)}:${items.length}`;
    groups.set(key, [...(groups.get(key) ?? []), { parent, items }]);
  }
  for (const rowsOfGroup of groups.values()) {
    if (rowsOfGroup.length < 2) continue;
    const cols = rowsOfGroup[0]!.items.length;
    for (let c = 0; c < cols; c++) {
      const edge = (t: InternalText) => (c === cols - 1 ? t.bounds!.x + t.bounds!.width : t.bounds!.x);
      const ref = edge(rowsOfGroup[0]!.items[c]!);
      for (const r of rowsOfGroup.slice(1)) {
        const t = r.items[c]!;
        const d = Math.round(edge(t) - ref);
        if (Math.abs(d) > 2) {
          out.push({
            texts: [t],
            finding: { severity: 'warning', code: 'MISALIGNED', message: `${q(t)} is ${Math.abs(d)}pt ${d > 0 ? 'right' : 'left'} of the matching item ${q(rowsOfGroup[0]!.items[c]!)} in the row above (same layout, ${c === cols - 1 ? 'right' : 'left'} edges differ).` },
          });
        }
      }
    }
  }
  return out;
}

let hostKeys = new WeakMap<Fiber, number>();
let nextHostKey = 1;
function hostKey(f: Fiber): number {
  let k = hostKeys.get(f) ?? (f.alternate ? hostKeys.get(f.alternate) : undefined);
  if (k === undefined) {
    k = nextHostKey++;
    hostKeys.set(f, k);
  }
  return k;
}
/** For tests. */
export function resetHostKeys(): void {
  hostKeys = new WeakMap();
  nextHostKey = 1;
}

export function formatAudit(a: AuditResult): string {
  const head = `audit of ${a.route ?? 'the current screen'}: ${a.findings.length} finding(s) across ${a.checked.elements} interactive elements and ${a.checked.texts} texts (static checks; nothing was tapped)`;
  return [head, ...a.findings.map((f) => `  [${f.severity}] ${f.code}${f.ref ? ` ${f.ref}` : ''}: ${f.message}`)].join('\n');
}
