/**
 * Source locations for React elements and JS errors.
 *
 * In development React 19 records, for every element, the stack at the moment its
 * JSX was evaluated (`fiber._debugStack`). Metro's `/symbolicate` endpoint (the one
 * LogBox uses) maps bundle positions back to the original files. A location is only
 * reported when symbolication actually succeeded; otherwise callers say why it is
 * unavailable instead of guessing.
 */

export interface StackFrame {
  fn?: string;
  file: string;
  line: number;
  column: number;
}

export interface SourceLocation {
  file: string;
  line: number;
  column?: number;
  fn?: string;
}

// Hermes:  "    at LoginScreen (http://localhost:8081/index.bundle?…:117390:51)"
//          "    at anonymous (address at http://…:1:2)"
//          "    at http://…:1:2"
// JSC/V8 also produce compatible "at" lines; "fn@url:line:col" (JSC) is handled too.
const AT_FRAME = /^\s*at (?:(.+?) \()?(?:address at )?((?:https?|file):\/\/.+?|[^\s()]+\.(?:js|bundle)[^\s()]*):(\d+):(\d+)\)?\s*$/;
const JSC_FRAME = /^\s*(.*?)@((?:https?|file):\/\/.+?):(\d+):(\d+)\s*$/;

export function parseStack(stack: string | undefined, max = 40): StackFrame[] {
  if (!stack) return [];
  const out: StackFrame[] = [];
  for (const line of stack.split('\n')) {
    const m = AT_FRAME.exec(line) ?? JSC_FRAME.exec(line);
    if (!m) continue;
    const fn = m[1]?.trim();
    out.push({ ...(fn && fn !== '<anonymous>' ? { fn } : {}), file: m[2]!, line: Number(m[3]), column: Number(m[4]) });
    if (out.length >= max) break;
  }
  return out;
}

/** React marks elements created after its per-second stack budget with this placeholder owner. */
export const UNKNOWN_OWNER = /\bUnknownOwner\b/;

/**
 * The frames of a React `_debugStack` that describe where the JSX was written. Like
 * React's own `formatOwnerStack`: the first frame is always the JSX factory (Hermes
 * names it `anonymous`), and everything from `react_stack_bottom_frame` down is React.
 */
export function elementCreationFrames(stack: string | undefined): StackFrame[] | undefined {
  if (!stack || UNKNOWN_OWNER.test(stack)) return undefined;
  const bottom = stack.indexOf('react_stack_bottom_frame');
  return parseStack(bottom >= 0 ? stack.slice(0, stack.lastIndexOf('\n', bottom)) : stack).slice(1);
}

/** node_modules, non-file frames, and this library's own code (even when linked from source). */
export const isLibraryFile = (file: string): boolean =>
  /[/\\]node_modules[/\\]|^(?!\/|[A-Za-z]:\\)|[/\\]react-native-agent-devtools[/\\](src|lib)[/\\]/.test(file);

/** Last path segments, for display ("src/screens/LoginScreen.tsx"). */
export function shortPath(file: string, segments = 3): string {
  const parts = file.split(/[/\\]/).filter(Boolean);
  return parts.slice(-segments).join('/');
}

type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

const SYMBOLICATE_TIMEOUT_MS = 4_000;

/** Maps bundle positions to original files through the Metro dev server, with a cache. */
export class Symbolicator {
  private cache = new Map<string, SourceLocation | null>();
  private readonly origin: () => string | undefined;
  private readonly fetchImpl: Fetch;

  constructor(origin: () => string | undefined, fetchImpl?: Fetch) {
    this.origin = origin;
    this.fetchImpl = fetchImpl ?? ((url, init) => fetch(url, init));
  }

  get available(): boolean {
    return !!this.origin();
  }

  /** One request for all uncached frames. Unresolvable frames map to null. */
  async symbolicate(frames: StackFrame[]): Promise<(SourceLocation | null)[]> {
    const key = (f: StackFrame) => `${f.file}:${f.line}:${f.column}`;
    const missing = frames.filter((f) => !this.cache.has(key(f)));
    const origin = this.origin();
    if (missing.length && origin) {
      const unique = [...new Map(missing.map((f) => [key(f), f])).values()];
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), SYMBOLICATE_TIMEOUT_MS);
      try {
        const res = await this.fetchImpl(`${origin}/symbolicate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ stack: unique.map((f) => ({ file: f.file, lineNumber: f.line, column: f.column, methodName: f.fn ?? '' })) }),
          signal: abort.signal,
        });
        const body = res.ok ? ((await res.json()) as { stack?: { file?: string; lineNumber?: number; column?: number; methodName?: string }[] }) : {};
        unique.forEach((f, i) => {
          const s = body.stack?.[i];
          const mapped = s && typeof s.file === 'string' && typeof s.lineNumber === 'number' && s.file !== f.file && !/^https?:/.test(s.file);
          this.cache.set(
            key(f),
            mapped ? { file: s.file!, line: s.lineNumber!, ...(typeof s.column === 'number' ? { column: s.column } : {}), ...(s.methodName ? { fn: s.methodName } : {}) } : null,
          );
        });
      } catch {
        // Dev server unreachable or slow: leave uncached so a later call can retry.
      } finally {
        clearTimeout(timer);
      }
    }
    if (this.cache.size > 5_000) this.cache.clear();
    return frames.map((f) => this.cache.get(key(f)) ?? null);
  }

  /** Frames that map into the app's own code (not node_modules), in order. */
  async appLocations(frames: StackFrame[], limit = 12): Promise<SourceLocation[]> {
    const mapped = await this.symbolicate(frames.slice(0, limit));
    return mapped.filter((m): m is SourceLocation => !!m && !isLibraryFile(m.file));
  }
}

export const formatLocation = (l: SourceLocation): string => `${l.fn ? `${l.fn} ` : ''}(${shortPath(l.file)}:${l.line}${l.column !== undefined ? `:${l.column}` : ''})`;

/** Origin of the dev server the bundle was loaded from (e.g. http://10.0.2.2:8081). */
export function devServerOrigin(scriptURL: string | undefined): string | undefined {
  const m = scriptURL ? /^(https?:\/\/[^/]+)/.exec(scriptURL) : null;
  return m?.[1];
}
