import { join } from 'node:path';
import { z } from 'zod';
import { flowName } from 'react-native-agent-devtools-protocol';
import type { MobileTool, ToolContext, ToolOutput } from '../tools/mobileTools.ts';
import { toMaestro } from './maestro.ts';
import { formatRun, runFlow } from './runner.ts';

const text = (t: string, isError = false): ToolOutput => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

function need(ctx: ToolContext): string | undefined {
  if (!ctx.device) return 'No app is connected.';
  if (!ctx.flows) return 'Flows are not available on this server.';
  return undefined;
}

/** Turn what just happened in the app into a repeatable test, and replay it. */
export const FLOW_TOOLS: MobileTool[] = [
  {
    name: 'mobile_save_flow',
    kind: 'read',
    description:
      'Save the actions performed on this app (recently, by you or replays) as a replayable test flow. Refs become stable selectors (testID, or role + label), each navigation becomes a route expectation, secure-field text becomes an environment variable placeholder. Saved on the developer\'s computer (not in the repo). Use last_steps to keep only the end of the session, e.g. the login steps.',
    shape: {
      name: z.string().min(1).max(80),
      last_steps: z.number().int().min(1).max(200).optional().describe('Only the last N recorded actions (default: all)'),
      description: z.string().max(500).optional(),
    },
    summary: (a) => `Save flow "${String(a.name)}"`,
    run: async (a, ctx) => {
      const missing = need(ctx);
      if (missing) return text(missing, true);
      const flow = ctx.flows!.recorder.toFlow(ctx.device!, String(a.name), {
        ...(typeof a.last_steps === 'number' ? { count: a.last_steps } : {}),
        ...(typeof a.description === 'string' ? { description: a.description } : {}),
      });
      if (!flow) return text('Nothing recorded yet: perform the actions first (tap, type, scroll, wait…), then save.', true);
      const file = ctx.flows!.store.save(flow);
      const secrets = flow.steps.flatMap((s) => (s.type === 'type' ? [...s.text.matchAll(/\$\{([A-Z0-9_]+)\}/g)].map((m) => m[1]) : []));
      return text(
        [
          `Saved flow "${flow.name}" (${flow.steps.length} steps${flow.startRoute ? `, starts on ${flow.startRoute}` : ''}) to ${file}.`,
          ...(secrets.length ? [`Secret text was not stored; set ${secrets.join(', ')} when replaying.`] : []),
          'Replay: mobile_run_flow, or `react-native-agent-devtools-server flows run <name>`. Maestro: `flows export <name> --maestro`.',
          JSON.stringify(flow.steps, null, 1).slice(0, 3_000),
        ].join('\n'),
      );
    },
  },
  {
    name: 'mobile_run_flow',
    kind: 'control',
    description:
      'Replay a saved flow on the connected app and report each step. Stops at the first failed step or unmet expectation and takes a screenshot. Start from the screen the flow was recorded on.',
    shape: {
      name: z.string().min(1).max(80),
      secrets: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), z.string().max(2000)).optional().describe('Values for ${NAME} placeholders (secure-field text)'),
    },
    summary: (a) => `Run flow "${String(a.name)}"`,
    run: async (a, ctx) => {
      const missing = need(ctx);
      if (missing) return text(missing, true);
      const found = ctx.flows!.store.load(String(a.name), ctx.device!.info.bundleId);
      if (!found) return text(`No flow named "${String(a.name)}". mobile_list_flows lists them.`, true);
      const secrets = (a.secrets ?? {}) as Record<string, string>;
      const r = await runFlow(found.flow, ctx, { env: { ...process.env, ...secrets }, screenshotPath: join(ctx.flows!.store.dir, `${flowName(found.flow.name)}.failure.jpg`) });
      return text(formatRun(found.flow, r), !r.ok);
    },
  },
  {
    name: 'mobile_list_flows',
    kind: 'read',
    description: 'List the saved test flows for this app.',
    shape: {},
    summary: () => 'List flows',
    run: async (_a, ctx) => {
      if (!ctx.flows) return text('Flows are not available on this server.', true);
      const list = ctx.flows.store.list(ctx.device?.info.bundleId);
      return text(list.length ? list.map((f) => `- ${f.name} (${f.steps} steps, ${f.createdAt.slice(0, 10)})`).join('\n') : 'No saved flows yet.');
    },
  },
];

export { toMaestro };
