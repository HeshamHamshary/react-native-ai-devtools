import type { Role } from './types.ts';

/** Hard limits enforced by the device executor regardless of what the agent asks for. */
export const LIMITS = {
  maxSequenceActions: 25,
  maxSequenceMs: 60_000,
  maxWaitMs: 15_000,
  defaultWaitMs: 5_000,
  maxSleepMs: 2_000,
  maxTextLength: 2_000,
} as const;

export interface TargetSelector {
  ref?: string;
  testID?: string;
  /** Matches label or visible text (case-insensitive substring unless `exact`). */
  text?: string;
  label?: string;
  role?: Role;
  /** Pick the n-th match (0-based) when several elements match. */
  index?: number;
  exact?: boolean;
}

/**
 * A target can be a selector object or a compact string:
 * `e12` / `@e12` (ref), `#login-button` (testID), `text=Log in`, `label=Email`,
 * `role=button`, or free text matched against labels and visible text.
 */
export type Target = string | TargetSelector;

const ROLES: ReadonlySet<string> = new Set([
  'button', 'link', 'textbox', 'switch', 'checkbox', 'radio', 'slider', 'tab', 'menuitem',
  'scrollview', 'list', 'modal', 'header', 'image', 'text', 'alert', 'progressbar', 'other',
]);

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && ROLES.has(value);
}

export function parseTarget(input: unknown): TargetSelector | null {
  if (typeof input === 'string') {
    const s = input.trim();
    if (!s) return null;
    const ref = /^@?(e\d+)$/i.exec(s);
    if (ref) return { ref: ref[1]!.toLowerCase() };
    if (s.startsWith('#') && s.length > 1) return { testID: s.slice(1) };
    const kv = /^(text|label|role|testid|ref)\s*[=:]\s*(.+)$/i.exec(s);
    if (kv) {
      const key = kv[1]!.toLowerCase();
      const value = kv[2]!.trim().replace(/^["']|["']$/g, '');
      if (key === 'role') return isRole(value) ? { role: value } : null;
      if (key === 'testid') return { testID: value };
      if (key === 'ref') return { ref: value.replace(/^@/, '').toLowerCase() };
      return key === 'label' ? { label: value } : { text: value };
    }
    return { text: s.replace(/^["']|["']$/g, '') };
  }
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const o = input as Record<string, unknown>;
    const out: TargetSelector = {};
    if (typeof o.ref === 'string' && o.ref) out.ref = o.ref.replace(/^@/, '').toLowerCase();
    if (typeof o.testID === 'string' && o.testID) out.testID = o.testID;
    if (typeof o.text === 'string' && o.text) out.text = o.text;
    if (typeof o.label === 'string' && o.label) out.label = o.label;
    if (o.role !== undefined) {
      if (!isRole(o.role)) return null;
      out.role = o.role;
    }
    if (typeof o.index === 'number' && Number.isInteger(o.index) && o.index >= 0) out.index = o.index;
    if (o.exact === true) out.exact = true;
    if (!out.ref && !out.testID && !out.text && !out.label && !out.role) return null;
    return out;
  }
  return null;
}

export function describeTarget(t: TargetSelector): string {
  if (t.ref) return t.ref;
  const parts: string[] = [];
  if (t.testID) parts.push(`#${t.testID}`);
  if (t.role) parts.push(`role=${t.role}`);
  if (t.label) parts.push(`label="${t.label}"`);
  if (t.text) parts.push(`"${t.text}"`);
  if (t.index !== undefined) parts.push(`[${t.index}]`);
  return parts.join(' ');
}

export type Direction = 'up' | 'down' | 'left' | 'right';
export type TapMode = 'auto' | 'semantic' | 'touch';

export interface Condition {
  target?: TargetSelector;
  route?: string;
  text?: string;
  /** Wait for the target/text to disappear instead of appear. */
  gone?: boolean;
  timeoutMs?: number;
}

export type SequenceAction =
  | { type: 'tap'; target: TargetSelector; mode?: TapMode; expect?: Condition }
  | { type: 'longPress'; target: TargetSelector; expect?: Condition }
  | { type: 'type'; target: TargetSelector; text: string; replace?: boolean; submit?: boolean; expect?: Condition }
  | { type: 'clear'; target: TargetSelector; expect?: Condition }
  | { type: 'scroll'; target?: TargetSelector; direction: Direction; amount?: number; expect?: Condition }
  | { type: 'scrollTo'; target: TargetSelector; expect?: Condition }
  | { type: 'waitFor'; condition: Condition }
  | { type: 'assert'; condition: Condition }
  | { type: 'back'; expect?: Condition }
  | { type: 'sleep'; ms: number };

export type ActionType = SequenceAction['type'];

const DIRECTIONS: ReadonlySet<string> = new Set(['up', 'down', 'left', 'right']);
const TAP_MODES: ReadonlySet<string> = new Set(['auto', 'semantic', 'touch']);

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

function parseCondition(input: unknown, where: string): Validation<Condition> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: `${where}: condition must be an object` };
  }
  const o = input as Record<string, unknown>;
  const c: Condition = {};
  if (o.target !== undefined) {
    const t = parseTarget(o.target);
    if (!t) return { ok: false, error: `${where}: invalid target` };
    c.target = t;
  }
  if (o.route !== undefined) {
    if (typeof o.route !== 'string' || !o.route) return { ok: false, error: `${where}: route must be a string` };
    c.route = o.route;
  }
  if (o.text !== undefined) {
    if (typeof o.text !== 'string' || !o.text) return { ok: false, error: `${where}: text must be a string` };
    c.text = o.text;
  }
  if (o.gone !== undefined) c.gone = o.gone === true;
  if (o.timeoutMs !== undefined) {
    if (typeof o.timeoutMs !== 'number' || !(o.timeoutMs >= 0)) {
      return { ok: false, error: `${where}: timeoutMs must be a non-negative number` };
    }
    c.timeoutMs = Math.min(o.timeoutMs, LIMITS.maxWaitMs);
  }
  if (!c.target && !c.route && !c.text) {
    return { ok: false, error: `${where}: condition needs target, route or text` };
  }
  return { ok: true, value: c };
}

function requireTarget(o: Record<string, unknown>, where: string): Validation<TargetSelector> {
  const t = parseTarget(o.target);
  return t ? { ok: true, value: t } : { ok: false, error: `${where}: missing or invalid target` };
}

export function validateAction(input: unknown, index = 0): Validation<SequenceAction> {
  const where = `actions[${index}]`;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: `${where}: must be an object` };
  }
  const o = input as Record<string, unknown>;
  let expect: Condition | undefined;
  if (o.expect !== undefined) {
    const e = parseCondition(o.expect, `${where}.expect`);
    if (!e.ok) return e;
    expect = e.value;
  }
  const withExpect = <T extends object>(a: T): T => (expect ? { ...a, expect } : a);

  switch (o.type) {
    case 'tap':
    case 'longPress':
    case 'clear':
    case 'scrollTo': {
      const t = requireTarget(o, where);
      if (!t.ok) return t;
      if (o.type === 'tap') {
        if (o.mode !== undefined && (typeof o.mode !== 'string' || !TAP_MODES.has(o.mode))) {
          return { ok: false, error: `${where}: mode must be auto, semantic or touch` };
        }
        return { ok: true, value: withExpect({ type: 'tap', target: t.value, ...(o.mode ? { mode: o.mode as TapMode } : {}) }) };
      }
      return { ok: true, value: withExpect({ type: o.type, target: t.value }) as SequenceAction };
    }
    case 'type': {
      const t = requireTarget(o, where);
      if (!t.ok) return t;
      if (typeof o.text !== 'string') return { ok: false, error: `${where}: text must be a string` };
      if (o.text.length > LIMITS.maxTextLength) return { ok: false, error: `${where}: text too long` };
      return {
        ok: true,
        value: withExpect({
          type: 'type',
          target: t.value,
          text: o.text,
          ...(o.replace === false ? { replace: false } : { replace: true }),
          ...(o.submit === true ? { submit: true } : {}),
        }),
      };
    }
    case 'scroll': {
      if (typeof o.direction !== 'string' || !DIRECTIONS.has(o.direction)) {
        return { ok: false, error: `${where}: direction must be up, down, left or right` };
      }
      let target: TargetSelector | undefined;
      if (o.target !== undefined) {
        const t = requireTarget(o, where);
        if (!t.ok) return t;
        target = t.value;
      }
      if (o.amount !== undefined && (typeof o.amount !== 'number' || !(o.amount > 0) || o.amount > 10)) {
        return { ok: false, error: `${where}: amount is a viewport fraction in (0, 10]` };
      }
      return {
        ok: true,
        value: withExpect({
          type: 'scroll',
          direction: o.direction as Direction,
          ...(target ? { target } : {}),
          ...(typeof o.amount === 'number' ? { amount: o.amount } : {}),
        }),
      };
    }
    case 'waitFor':
    case 'assert': {
      const source = o.condition ?? { target: o.target, route: o.route, text: o.text, gone: o.gone, timeoutMs: o.timeoutMs };
      const c = parseCondition(stripUndefined(source), where);
      if (!c.ok) return c;
      return { ok: true, value: { type: o.type, condition: c.value } };
    }
    case 'back':
      return { ok: true, value: withExpect({ type: 'back' }) };
    case 'sleep': {
      if (typeof o.ms !== 'number' || !(o.ms >= 0)) return { ok: false, error: `${where}: ms must be a number` };
      return { ok: true, value: { type: 'sleep', ms: Math.min(o.ms, LIMITS.maxSleepMs) } };
    }
    default:
      return { ok: false, error: `${where}: unknown action type ${JSON.stringify(o.type)}` };
  }
}

function stripUndefined(v: unknown): unknown {
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined));
}

export interface SequenceOptions {
  /** Abort the whole sequence after this many ms. Capped at LIMITS.maxSequenceMs. */
  timeoutMs?: number;
  /** Continue past failed steps instead of stopping (never applies to BLOCKED/DENIED/CANCELLED). */
  continueOnError?: boolean;
}

export function validateSequence(input: unknown): Validation<{ actions: SequenceAction[]; options: Required<SequenceOptions> }> {
  if (!input || typeof input !== 'object') return { ok: false, error: 'sequence must be an object' };
  const o = input as Record<string, unknown>;
  if (!Array.isArray(o.actions) || o.actions.length === 0) {
    return { ok: false, error: 'actions must be a non-empty array' };
  }
  if (o.actions.length > LIMITS.maxSequenceActions) {
    return { ok: false, error: `too many actions (${o.actions.length} > ${LIMITS.maxSequenceActions})` };
  }
  const actions: SequenceAction[] = [];
  for (let i = 0; i < o.actions.length; i++) {
    const r = validateAction(o.actions[i], i);
    if (!r.ok) return r;
    actions.push(r.value);
  }
  const opts = (o.options && typeof o.options === 'object' ? o.options : {}) as Record<string, unknown>;
  const timeoutMs =
    typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0
      ? Math.min(opts.timeoutMs, LIMITS.maxSequenceMs)
      : LIMITS.maxSequenceMs;
  return { ok: true, value: { actions, options: { timeoutMs, continueOnError: opts.continueOnError === true } } };
}
