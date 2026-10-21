#!/usr/bin/env node
// Builds the example app's JS bundle with Metro in release and dev mode and checks that
// the devtools runtime (socket, collectors, inspector, chat UI) is absent from the
// release bundle. The dev bundle must contain it, so the check cannot pass vacuously.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = join(root, 'apps', 'example');
const cli = join(app, 'node_modules', '.bin', 'react-native');
const out = mkdtempSync(join(tmpdir(), 'rnad-bundle-'));

/** Strings that only exist in the runtime's modules. */
const RUNTIME_MARKERS = ['RNAgentDevTools', 'chat.send', 'getStoredValue', 'AgentDevToolsInner', 'probeViews'];

function bundle(platform, dev) {
  const file = join(out, `${platform}.${dev ? 'dev' : 'release'}.js`);
  execFileSync(
    cli,
    ['bundle', '--platform', platform, '--dev', String(dev), '--minify', 'false', '--entry-file', 'index.js', '--bundle-output', file, '--assets-dest', join(out, 'assets'), '--reset-cache'],
    { cwd: app, stdio: ['ignore', 'ignore', 'inherit'] },
  );
  return readFileSync(file, 'utf8');
}

let failed = false;
for (const platform of process.argv.slice(2).length ? process.argv.slice(2) : ['ios', 'android']) {
  const release = bundle(platform, false);
  const dev = bundle(platform, true);
  const leaked = RUNTIME_MARKERS.filter((m) => release.includes(m));
  const missingInDev = RUNTIME_MARKERS.filter((m) => !dev.includes(m));
  const appPresent = release.includes('SkyTrips');
  console.log(
    `${platform}: release ${(release.length / 1024).toFixed(0)} KB, dev ${(dev.length / 1024).toFixed(0)} KB; ` +
      `runtime markers in release: ${leaked.length ? leaked.join(', ') : 'none'}`,
  );
  if (leaked.length || missingInDev.length || !appPresent) {
    failed = true;
    if (missingInDev.length) console.error(`  dev bundle is missing markers (check is stale): ${missingInDev.join(', ')}`);
    if (!appPresent) console.error('  release bundle does not contain the example app');
  }
}
if (failed) {
  console.error('FAIL: the devtools runtime is reachable from a release bundle');
  process.exit(1);
}
console.log('OK: release bundles contain none of the devtools runtime');
