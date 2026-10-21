import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Anthropic Console API keys look like `sk-ant-api03-…`. */
export const API_KEY_PATTERN = /^sk-ant-[A-Za-z0-9_-]{20,}$/;

export const CONSOLE_KEYS_URL = 'https://console.anthropic.com/settings/keys';

/**
 * Stores the developer's own Anthropic API key on their computer
 * (`$XDG_CONFIG_HOME/react-native-agent-devtools/credentials.json`, mode 0600).
 * The key is never sent to the app, never logged and never returned by any endpoint.
 */
export class CredentialStore {
  readonly dir: string;
  readonly file: string;

  constructor(dir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'react-native-agent-devtools')) {
    this.dir = dir;
    this.file = join(dir, 'credentials.json');
  }

  read(): string | undefined {
    try {
      if (!existsSync(this.file)) return undefined;
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as { anthropicApiKey?: unknown };
      return typeof data.anthropicApiKey === 'string' && API_KEY_PATTERN.test(data.anthropicApiKey) ? data.anthropicApiKey : undefined;
    } catch {
      return undefined;
    }
  }

  save(key: string): void {
    const trimmed = key.trim();
    if (!API_KEY_PATTERN.test(trimmed)) throw new Error('That does not look like an Anthropic API key (expected sk-ant-…).');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.file, JSON.stringify({ anthropicApiKey: trimmed }), { mode: 0o600 });
    chmodSync(this.file, 0o600);
  }

  clear(): void {
    rmSync(this.file, { force: true });
  }
}

/** Where the agent's API key comes from: the environment wins over the stored key. */
export function resolveApiKey(store: CredentialStore, env = process.env): { key?: string; source: 'env' | 'stored' | 'none' } {
  if (env.ANTHROPIC_API_KEY) return { key: env.ANTHROPIC_API_KEY, source: 'env' };
  const stored = store.read();
  return stored ? { key: stored, source: 'stored' } : { source: 'none' };
}
