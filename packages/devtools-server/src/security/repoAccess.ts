import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Files never readable by the agent, even inside an allowed root. */
export const SECRET_FILE =
  /(^|[/\\])(\.env(\.[^/\\]*)?|\.npmrc|\.yarnrc(\.yml)?|\.netrc|\.pypirc|\.git-credentials|id_(rsa|ed25519|ecdsa|dsa)(\.pub)?|[^/\\]*\.(pem|key|p12|pfx|keystore|jks|mobileprovision|p8)|credentials(\.json)?|secrets?\.(json|ya?ml|env)|service-account[^/\\]*\.json|google-services\.json|GoogleService-Info\.plist|local\.properties|\.xcode\.env\.local)$/i;

const SECRET_DIR = /(^|[/\\])(\.git|\.ssh|\.aws|\.gnupg|\.config[/\\]gcloud|\.rnad)([/\\]|$)/i;

export type FileTool = 'Read' | 'Grep' | 'Glob' | 'Edit' | 'Write' | 'MultiEdit' | 'NotebookEdit';

export interface AccessDecision {
  allow: boolean;
  reason?: string;
}

function real(p: string): string {
  try {
    return existsSync(p) ? realpathSync(p) : resolve(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Path allowlist for the agent's built-in file tools. Resolves symlinks so a link
 * inside the repo cannot point outside it.
 */
export class RepoAccess {
  readonly roots: string[];

  constructor(roots: string[]) {
    this.roots = roots.map((r) => real(r));
  }

  get enabled(): boolean {
    return this.roots.length > 0;
  }

  inside(p: string): boolean {
    const target = real(isAbsolute(p) ? p : resolve(this.roots[0] ?? process.cwd(), p));
    return this.roots.some((root) => {
      const rel = relative(root, target);
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..'));
    });
  }

  check(tool: string, input: Record<string, unknown>): AccessDecision {
    if (!this.enabled) return { allow: false, reason: 'Repository access is disabled (start the server with --repo <path>).' };
    const paths: string[] = [];
    for (const key of ['file_path', 'path', 'notebook_path']) {
      if (typeof input[key] === 'string') paths.push(input[key] as string);
    }
    if ((tool === 'Grep' || tool === 'Glob') && paths.length === 0) paths.push(this.roots[0]!);
    for (const key of ['pattern', 'glob']) {
      const v = input[key];
      if ((tool === 'Glob' || key === 'glob') && typeof v === 'string' && (v.includes('..') || isAbsolute(v))) {
        return { allow: false, reason: `Pattern "${v}" escapes the allowed repository roots.` };
      }
    }
    for (const p of paths) {
      if (!this.inside(p)) return { allow: false, reason: `${p} is outside the allowed repository roots.` };
      if (SECRET_FILE.test(p) || SECRET_DIR.test(p)) return { allow: false, reason: `${p} looks like a secret or credential file and is never readable.` };
    }
    return { allow: true };
  }
}
