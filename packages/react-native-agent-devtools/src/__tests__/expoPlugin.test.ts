import { expect, it, jest } from '@jest/globals';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The real @expo/config-plugins applies mods during prebuild; here we apply the mod directly.
jest.mock(
  '@expo/config-plugins',
  () => ({
    withInfoPlist: (config: { modResults?: Record<string, unknown> }, mod: (c: { modResults: Record<string, unknown> }) => unknown) =>
      mod({ ...config, modResults: config.modResults ?? {} }),
    createRunOncePlugin: (fn: unknown) => fn,
  }),
  { virtual: true },
);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const plugin = require('../../app.plugin.js') as (config: unknown, props?: unknown) => { modResults: Record<string, unknown> };

function project(deps: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'rnad-expo-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: deps }));
  return { _internal: { projectRoot: root } };
}

it('adds the Local Network description only when missing', () => {
  const added = plugin({ ...project({ 'expo-dev-client': '*' }), modResults: {} });
  expect(added.modResults.NSLocalNetworkUsageDescription).toMatch(/developer tools/);
  const kept = plugin({ ...project({ 'expo-dev-client': '*' }), modResults: { NSLocalNetworkUsageDescription: 'Existing' } });
  expect(kept.modResults.NSLocalNetworkUsageDescription).toBe('Existing');
  const off = plugin({ ...project({ 'expo-dev-client': '*' }), modResults: {} }, { localNetwork: false });
  expect(off.modResults.NSLocalNetworkUsageDescription).toBeUndefined();
});

it('warns when the project has no development client (Expo Go cannot load the module)', () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  plugin({ ...project({ expo: '*' }), modResults: {} });
  expect(warn.mock.calls[0]?.[0]).toMatch(/Expo Go cannot load/);
  warn.mockRestore();
});
