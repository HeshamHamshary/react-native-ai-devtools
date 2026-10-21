import { writeFileSync } from 'node:fs';
import type { ActionResult, Flow, FlowStep, ScreenshotResult, SequenceAction } from 'react-native-agent-devtools-protocol';
import { LIMITS, SECRET_PLACEHOLDER } from 'react-native-agent-devtools-protocol';
import { MOBILE_TOOLS, osAct, type ToolContext, type ToolOutput } from '../tools/mobileTools.ts';
import type { SequenceResult } from '../tools/format.ts';

export interface FlowRun {
  ok: boolean;
  completed: number;
  total: number;
  durationMs: number;
  steps: { index: number; ok: boolean; summary: string }[];
  failure?: string;
  /** Screenshot taken when the run failed. */
  screenshot?: string;
}

const SEQUENCE_TYPES = new Set(['tap', 'longPress', 'type', 'clear', 'scroll', 'scrollTo', 'waitFor', 'assert', 'back', 'sleep']);
const inApp = (s: FlowStep): boolean => SEQUENCE_TYPES.has(s.type) && !('os' in s && s.os);

function stepSummary(s: FlowStep): string {
  const t = 'target' in s && s.target ? (s.target.testID ? `#${s.target.testID}` : (s.target.label ?? s.target.text ?? s.target.role)) : '';
  return `${s.type}${t ? ` ${t}` : ''}${'os' in s && s.os ? ' (os)' : ''}`;
}

/** Replace ${NAME} in typed text from the environment; secrets never live in flow files. */
export function resolveSecrets(flow: Flow, env: NodeJS.ProcessEnv): { steps: FlowStep[]; missing: string[] } {
  const missing = new Set<string>();
  const steps = flow.steps.map((s) => {
    if (s.type !== 'type') return s;
    const text = s.text.replace(SECRET_PLACEHOLDER, (_m, name: string) => {
      const v = env[name];
      if (v === undefined) missing.add(name);
      return v ?? '';
    });
    return { ...s, text };
  });
  return { steps, missing: [...missing] };
}

const toolText = (o: ToolOutput) => o.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

/**
 * Replay a flow. Consecutive in-app steps run as one on-device sequence (no round
 * trips; it stops at the first diverging expectation); OS-level steps go through the
 * OS automation backend. Stops at the first failure and takes a screenshot.
 */
export async function runFlow(flow: Flow, ctx: ToolContext, opts: { env?: NodeJS.ProcessEnv; screenshotPath?: string } = {}): Promise<FlowRun> {
  const t0 = performance.now();
  const run: FlowRun = { ok: true, completed: 0, total: flow.steps.length, durationMs: 0, steps: [] };
  const { steps, missing } = resolveSecrets(flow, opts.env ?? process.env);
  const fail = async (index: number, message: string) => {
    run.ok = false;
    run.failure = `step ${index + 1} (${stepSummary(steps[index] ?? { type: 'sleep', ms: 0 })}): ${message}`;
    if (opts.screenshotPath && ctx.device) {
      try {
        const shot = (await ctx.device.rpc<ScreenshotResult>('screenshot', { maxWidth: 720 }, 15_000)).result;
        writeFileSync(opts.screenshotPath, Buffer.from(shot.data, 'base64'));
        run.screenshot = opts.screenshotPath;
      } catch {
        // the failure report stands without a screenshot
      }
    }
  };
  if (!ctx.device) {
    run.ok = false;
    run.failure = 'No app is connected.';
    return run;
  }
  if (missing.length) {
    run.ok = false;
    run.failure = `Set ${missing.join(', ')} in the environment: secret text is not stored in flows.`;
    return run;
  }

  for (let i = 0; i < steps.length && run.ok; ) {
    const step = steps[i]!;
    if (inApp(step)) {
      const chunk: SequenceAction[] = [];
      while (i + chunk.length < steps.length && chunk.length < LIMITS.maxSequenceActions && inApp(steps[i + chunk.length]!)) chunk.push(steps[i + chunk.length] as SequenceAction);
      const r = (await ctx.device.rpc<SequenceResult>('runSequence', { actions: chunk, options: { timeoutMs: LIMITS.maxSequenceMs, continueOnError: false } }, LIMITS.maxSequenceMs + 15_000)).result;
      for (const s of r.steps) {
        run.steps.push({ index: i + s.step, ok: s.ok, summary: `${stepSummary(chunk[s.step]!)}${s.mode ? ` [${s.mode}]` : ''}${s.ok ? '' : ` ✗ ${s.error?.code}: ${s.error?.message ?? ''}`}` });
        if (s.ok) run.completed++;
      }
      if (!r.ok) {
        const failed = r.steps.find((s) => !s.ok);
        await fail(i + (failed?.step ?? r.completed), failed?.error?.message ?? r.stopped ?? 'the sequence stopped');
        break;
      }
      i += chunk.length;
      continue;
    }

    let out: ToolOutput;
    if (step.type === 'tap' || step.type === 'longPress') {
      out = await osAct(ctx, step.type, step.target, (input, at) => (step.type === 'longPress' ? input.longPress(at!, 800) : input.tap(at!)));
    } else if (step.type === 'type') {
      if (step.replace !== false) await ctx.device.rpc<ActionResult>('clearText', { target: step.target });
      out = await osAct(ctx, 'type', step.target, async (input, at) => {
        await input.tap(at!);
        if (step.text) await input.typeText(step.text);
        if (step.submit) await input.pressKey('enter');
      });
    } else {
      const tool = MOBILE_TOOLS.find((t) =>
        step.type === 'swipe' ? t.name === 'mobile_swipe' : step.type === 'alert' ? t.name === 'mobile_alert' : step.type === 'dismissKeyboard' ? t.name === 'mobile_dismiss_keyboard' : false,
      );
      if (!tool) {
        await fail(i, `cannot replay step type ${step.type} with OS-level input`);
        break;
      }
      const args =
        step.type === 'swipe'
          ? { from_x: step.from.x, from_y: step.from.y, to_x: step.to.x, to_y: step.to.y, duration_ms: step.durationMs ?? 300, ...(step.os ? { mode: 'os' } : {}) }
          : step.type === 'alert'
            ? { button: step.button, ...(step.os ? { mode: 'os' } : {}) }
            : {};
      out = await tool.run(args, ctx);
    }
    const text = toolText(out);
    run.steps.push({ index: i, ok: !out.isError, summary: `${stepSummary(step)} ${text.split('\n')[0] ?? ''}`.trim() });
    if (out.isError) {
      await fail(i, text.split('\n').slice(0, 2).join(' '));
      break;
    }
    run.completed++;
    i++;
  }
  run.durationMs = Math.round(performance.now() - t0);
  return run;
}

export function formatRun(flow: Flow, r: FlowRun): string {
  const head = `${r.ok ? '✓' : '✗'} flow "${flow.name}": ${r.completed}/${r.total} steps in ${r.durationMs}ms`;
  return [head, ...r.steps.map((s) => `  ${s.index + 1}. ${s.ok ? '✓' : '✗'} ${s.summary}`), ...(r.failure ? [`failure: ${r.failure}`] : []), ...(r.screenshot ? [`screenshot: ${r.screenshot}`] : [])].join('\n');
}
