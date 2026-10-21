import { validateAction, type SequenceAction } from './actions.ts';

/**
 * A replayable test flow: the actions an agent (or developer) performed, with stable
 * selectors (testID, or role + label) instead of per-session refs, and expectations
 * captured while recording (route after navigation). Steps marked `os` replay with
 * OS-level input. Secret text is never stored: it is `${ENV_VAR}`, read at replay.
 */
export type FlowStep =
  | (SequenceAction & { os?: boolean })
  | { type: 'swipe'; from: { x: number; y: number }; to: { x: number; y: number }; durationMs?: number; os?: boolean }
  | { type: 'alert'; button: string; os?: boolean }
  | { type: 'dismissKeyboard' };

export interface Flow {
  version: 1;
  name: string;
  description?: string;
  app?: { bundleId?: string; name?: string; platform?: 'ios' | 'android'; window?: { width: number; height: number } };
  /** Route the flow was recorded from; replay should start there. */
  startRoute?: string;
  createdAt: string;
  steps: FlowStep[];
}

export const MAX_FLOW_STEPS = 200;

/** `${NAME}` placeholders in typed text are replaced from the environment at replay. */
export const SECRET_PLACEHOLDER = /\$\{([A-Z][A-Z0-9_]{0,63})\}/g;

export function flowName(name: string): string {
  return name.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

const point = (v: unknown): v is { x: number; y: number } =>
  !!v && typeof v === 'object' && typeof (v as { x?: unknown }).x === 'number' && typeof (v as { y?: unknown }).y === 'number';

export function validateFlow(input: unknown): { ok: true; value: Flow } | { ok: false; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'flow must be an object' };
  const o = input as Record<string, unknown>;
  if (o.version !== 1) return { ok: false, error: 'unsupported flow version' };
  if (typeof o.name !== 'string' || !flowName(o.name)) return { ok: false, error: 'flow name required' };
  if (!Array.isArray(o.steps) || !o.steps.length || o.steps.length > MAX_FLOW_STEPS) return { ok: false, error: `flow needs 1..${MAX_FLOW_STEPS} steps` };
  const steps: FlowStep[] = [];
  for (let i = 0; i < o.steps.length; i++) {
    const s = o.steps[i] as Record<string, unknown>;
    const os = s?.os === true ? { os: true } : {};
    if (s?.type === 'swipe') {
      if (!point(s.from) || !point(s.to)) return { ok: false, error: `steps[${i}]: swipe needs from/to points` };
      steps.push({ type: 'swipe', from: s.from, to: s.to, ...(typeof s.durationMs === 'number' ? { durationMs: s.durationMs } : {}), ...os });
    } else if (s?.type === 'alert') {
      if (typeof s.button !== 'string' || !s.button) return { ok: false, error: `steps[${i}]: alert needs a button` };
      steps.push({ type: 'alert', button: s.button, ...os });
    } else if (s?.type === 'dismissKeyboard') {
      steps.push({ type: 'dismissKeyboard' });
    } else {
      const r = validateAction(s, i);
      if (!r.ok) return { ok: false, error: r.error.replace('actions[', 'steps[') };
      steps.push({ ...r.value, ...os });
    }
  }
  return {
    ok: true,
    value: {
      version: 1,
      name: flowName(o.name),
      ...(typeof o.description === 'string' ? { description: o.description.slice(0, 500) } : {}),
      ...(o.app && typeof o.app === 'object' ? { app: o.app as Flow['app'] } : {}),
      ...(typeof o.startRoute === 'string' ? { startRoute: o.startRoute } : {}),
      createdAt: typeof o.createdAt === 'string' ? o.createdAt : new Date(0).toISOString(),
      steps,
    },
  };
}
