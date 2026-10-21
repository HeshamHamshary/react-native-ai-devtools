import type { ActionResult, Flow, FlowStep, TargetSelector } from 'react-native-agent-devtools-protocol';
import { flowName, parseTarget } from 'react-native-agent-devtools-protocol';
import type { DeviceSession } from '../transport/devices.ts';

interface Recorded {
  step: FlowStep;
  routeBefore?: string;
  routeAfter?: string;
  ts: number;
}

const MAX_RECORDED = 200;

/**
 * Keeps the actions that succeeded on each app (per install, so a reload doesn't lose
 * them) for "save that as a test". Refs (e12) are only valid in one session, so each
 * target is rewritten from the action's own result to a stable selector.
 */
export class FlowRecorder {
  private byApp = new Map<string, Recorded[]>();

  private key(device: DeviceSession): string {
    return device.instance ?? device.id;
  }

  /** Stable selector for what the action actually hit: testID, else role + exact label. */
  static stableTarget(result: ActionResult | undefined, given: unknown): TargetSelector | undefined {
    const t = result?.target;
    if (t?.testID) return { testID: t.testID };
    if (t?.label) return { role: t.role, label: t.label, exact: true };
    const parsed = parseTarget(given);
    return parsed && !parsed.ref ? parsed : undefined;
  }

  record(device: DeviceSession, step: FlowStep, result: ActionResult): void {
    if (!result.ok) return;
    const list = this.byApp.get(this.key(device)) ?? [];
    list.push({ step, routeBefore: result.changes?.routeBefore, routeAfter: result.changes?.routeAfter, ts: Date.now() });
    if (list.length > MAX_RECORDED) list.splice(0, list.length - MAX_RECORDED);
    this.byApp.set(this.key(device), list);
  }

  recent(device: DeviceSession): readonly Recorded[] {
    return this.byApp.get(this.key(device)) ?? [];
  }

  clear(device: DeviceSession): void {
    this.byApp.delete(this.key(device));
  }

  /** Turn the last `count` recorded actions into a flow, adding route expectations. */
  toFlow(device: DeviceSession, name: string, opts: { count?: number; description?: string } = {}): Flow | undefined {
    const all = this.recent(device);
    const picked = opts.count ? all.slice(-opts.count) : all;
    if (!picked.length) return undefined;
    const steps: FlowStep[] = [];
    for (const r of picked) {
      const navigated = r.routeAfter && r.routeAfter !== r.routeBefore;
      if (navigated && 'type' in r.step && r.step.type !== 'swipe' && r.step.type !== 'alert' && r.step.type !== 'dismissKeyboard' && r.step.type !== 'waitFor' && r.step.type !== 'assert' && r.step.type !== 'sleep') {
        steps.push({ ...r.step, expect: { route: r.routeAfter! } } as FlowStep);
      } else {
        steps.push(r.step);
        if (navigated) steps.push({ type: 'waitFor', condition: { route: r.routeAfter! } });
      }
    }
    const info = device.info;
    const startRoute = picked.find((r) => r.routeBefore)?.routeBefore;
    return {
      version: 1,
      name: flowName(name),
      ...(opts.description ? { description: opts.description } : {}),
      app: {
        ...(info.bundleId ? { bundleId: info.bundleId } : {}),
        ...(info.appName ? { name: info.appName } : {}),
        platform: info.platform,
        window: { width: Math.round(info.window.width), height: Math.round(info.window.height) },
      },
      ...(startRoute ? { startRoute } : {}),
      createdAt: new Date().toISOString(),
      steps,
    };
  }
}

/** Env var name for secret text typed into a field, e.g. #login-password -> RNAD_SECRET_LOGIN_PASSWORD. */
export function secretVar(target: TargetSelector | undefined): string {
  const base = (target?.testID ?? target?.label ?? 'FIELD').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `RNAD_SECRET_${base || 'FIELD'}`.slice(0, 64);
}
