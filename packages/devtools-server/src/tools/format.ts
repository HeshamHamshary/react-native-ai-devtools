import type { ActionResult, LogEntry, NetworkEntry } from 'react-native-agent-devtools-protocol';
import { redactText } from 'react-native-agent-devtools-protocol';

const ago = (ts: number) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
};

/** Compact text rendering of an action result for the model. */
export function formatAction(r: ActionResult): string {
  const lines: string[] = [];
  const target = r.target ? ` ${r.target.ref} ${r.target.role}${r.target.label ? ` "${r.target.label}"` : ''}` : '';
  const head = r.ok ? `✓ ${r.action}${target}` : `✗ ${r.action}${target} failed: ${r.error?.code}`;
  const meta = [r.mode ? `mode=${r.mode}` : '', `${r.durationMs}ms`, r.settled === false ? 'not fully settled' : '', r.reResolved ? 'ref re-resolved' : '']
    .filter(Boolean)
    .join(' · ');
  lines.push(`${head} (${meta})`);
  if (!r.ok && r.error) lines.push(`  ${r.error.message}`);
  if (r.warnings?.length) lines.push(`  warnings: ${r.warnings.join('; ')}`);
  const c = r.changes;
  if (c) {
    const parts: string[] = [];
    if (c.routeBefore !== c.routeAfter) parts.push(`route ${c.routeBefore ?? '?'} → ${c.routeAfter ?? '?'}`);
    else if (c.screenChanged) parts.push('screen updated');
    else parts.push('no visible UI change');
    if (c.addedInteractive || c.removedInteractive) parts.push(`+${c.addedInteractive ?? 0}/-${c.removedInteractive ?? 0} interactive`);
    if (c.keyboardVisible) parts.push('keyboard shown');
    if (c.newErrors) parts.push(`${c.newErrors} new JS error(s)`);
    if (c.newFailedRequests) parts.push(`${c.newFailedRequests} failed request(s)`);
    lines.push(`  changes: ${parts.join(', ')}`);
  }
  const d = r.detail ?? {};
  for (const [k, v] of Object.entries(d)) {
    if (k === 'screen') continue;
    if (Array.isArray(v)) {
      if (v.length) lines.push(`  ${k}: ${v.join(' | ')}`);
    } else if (v !== undefined && v !== null && typeof v !== 'object') {
      lines.push(`  ${k}: ${String(v)}`);
    } else if (v && typeof v === 'object') {
      lines.push(`  ${k}: ${JSON.stringify(v)}`);
    }
  }
  if (typeof d.screen === 'string') lines.push(`now on screen:\n${d.screen}`);
  return lines.join('\n');
}

export interface SequenceResult {
  ok: boolean;
  completed: number;
  total: number;
  durationMs: number;
  stopped?: string;
  steps: (ActionResult & { step: number })[];
  finalScreen: string;
}

export function formatSequence(r: SequenceResult): string {
  const lines = [
    `${r.ok ? '✓' : '✗'} sequence ${r.completed}/${r.total} steps in ${r.durationMs}ms${r.stopped ? ` — stopped at ${r.stopped}` : ''}`,
  ];
  for (const s of r.steps) {
    const body = formatAction(s)
      .split('\n')
      .map((l, i) => (i === 0 ? `${s.step + 1}. ${l}` : `   ${l}`))
      .filter((l) => !l.includes('now on screen:'));
    lines.push(...body);
  }
  lines.push(`final screen:\n${r.finalScreen}`);
  return lines.join('\n');
}

export function formatLogs(entries: LogEntry[], total: number, dropped: number, capturedSince?: number): string {
  const since = capturedSince ? ` Capture started ${ago(capturedSince)}; anything earlier is unknown.` : '';
  if (!entries.length) return `No matching log entries (buffer: ${total} entries${dropped ? `, ${dropped} older dropped` : ''}).${since}`;
  const lines = entries.map((e) => {
    const repeat = e.repeat ? ` ×${e.repeat}` : '';
    const where = e.route ? ` [${e.route}]` : '';
    const frames = e.appFrames?.length
      ? `\n    ${e.appFrames.map((f) => `at ${f}`).join('\n    ')}`
      : e.stack && e.level === 'error'
        ? `\n    ${e.stack.split('\n').slice(0, 4).join('\n    ')}`
        : '';
    return `${ago(e.ts)} ${e.level.toUpperCase()} (${e.source})${where}${repeat}: ${e.message}${frames}`;
  });
  return `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} (oldest first):${since}\n${lines.join('\n')}`;
}

export function formatNetwork(entries: NetworkEntry[], pending: number): string {
  if (!entries.length) return `No matching requests captured (in flight: ${pending}).`;
  const lines = entries.map((n) => {
    const status = n.pending ? 'pending' : n.error ? `FAILED ${n.status ?? 0} (${n.error})` : n.ok === false ? `${n.status} (HTTP error)` : String(n.status);
    const extra = [n.durationMs !== undefined ? `${n.durationMs}ms` : '', n.route ? `on ${n.route}` : '', n.responseType ?? '']
      .filter(Boolean)
      .join(', ');
    const bodies = [n.requestBody ? `\n    request: ${n.requestBody}` : '', n.responseBody ? `\n    response: ${n.responseBody}` : ''].join('');
    const initiator = n.initiator?.length ? `\n    started by ${n.initiator.join(' ← ')}` : '';
    return `${ago(n.ts)} ${n.method} ${n.url} → ${status}${extra ? ` (${extra})` : ''}${initiator}${bodies}`;
  });
  return `${entries.length} request(s), in flight: ${pending}\n${lines.join('\n')}`;
}

/** Text part of a tool result, redacted and shortened, for the expandable tool row in the app. */
export function toolDetail(content: unknown): string | undefined {
  const parts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.flatMap((c) => (c && typeof c === 'object' && (c as { type?: string }).type === 'text' ? [String((c as { text?: unknown }).text ?? '')] : [])) : [];
  const text = parts.join('\n').trim();
  return text ? redactText(text).slice(0, 1_200) : undefined;
}
