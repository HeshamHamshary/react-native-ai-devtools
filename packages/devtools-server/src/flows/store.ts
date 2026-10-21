import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Flow } from 'react-native-agent-devtools-protocol';
import { flowName, validateFlow } from 'react-native-agent-devtools-protocol';

/**
 * Saved flows, one JSON file each, under the server's state directory (not the repo:
 * saving a flow never modifies the project). `flows export` writes elsewhere on request.
 */
export class FlowStore {
  readonly dir: string;

  constructor(stateDir: string) {
    this.dir = join(stateDir, 'flows');
  }

  private appDir(bundleId?: string): string {
    const dir = join(this.dir, flowName(bundleId ?? 'app') || 'app');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  save(flow: Flow): string {
    const file = join(this.appDir(flow.app?.bundleId), `${flowName(flow.name)}.json`);
    writeFileSync(file, `${JSON.stringify(flow, null, 2)}\n`, { mode: 0o600 });
    return file;
  }

  /** Find a flow by name, preferring the given app. */
  load(name: string, bundleId?: string): { flow: Flow; file: string } | undefined {
    const wanted = `${flowName(name)}.json`;
    const dirs = [...(bundleId ? [this.appDir(bundleId)] : []), ...this.apps().map((a) => join(this.dir, a))];
    for (const dir of dirs) {
      const file = join(dir, wanted);
      try {
        const v = validateFlow(JSON.parse(readFileSync(file, 'utf8')));
        if (v.ok) return { flow: v.value, file };
      } catch {
        // not here
      }
    }
    return undefined;
  }

  list(bundleId?: string): { name: string; app: string; steps: number; createdAt: string }[] {
    const out: { name: string; app: string; steps: number; createdAt: string }[] = [];
    for (const app of bundleId ? [flowName(bundleId)] : this.apps()) {
      let files: string[];
      try {
        files = readdirSync(join(this.dir, app)).filter((f) => f.endsWith('.json'));
      } catch {
        continue;
      }
      for (const f of files) {
        try {
          const v = validateFlow(JSON.parse(readFileSync(join(this.dir, app, f), 'utf8')));
          if (v.ok) out.push({ name: v.value.name, app, steps: v.value.steps.length, createdAt: v.value.createdAt });
        } catch {
          // skip unreadable files
        }
      }
    }
    return out;
  }

  private apps(): string[] {
    try {
      return readdirSync(this.dir);
    } catch {
      return [];
    }
  }
}
