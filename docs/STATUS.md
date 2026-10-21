# Status (2026-10-21, release-preparation pass)

This page states what has been built, what has been verified and how, and what has not. Anything not listed as verified should be treated as unverified.

## Environment

| Item | Value |
|---|---|
| Host | macOS 26.6.2 (arm64), Node 24.10, Xcode 26.0.1, JDK 17 |
| React Native | 0.86.2, New Architecture (Fabric, bridgeless), React 19.2.3, Hermes, **debug builds** |
| iOS | iPhone 17 Pro simulator, iOS 26.0 |
| Android | "Medium Phone API 36.1" emulator, Android 16, **2 GB RAM** |
| Agent SDK | `@anthropic-ai/claude-agent-sdk` 0.3.306 (bundled Claude Code 2.1.306) |
| OS input | adb (Android SDK platform-tools), Maestro CLI (local `maestro mcp`) |
| Physical devices | **None were used.** Nothing here was verified on a physical device. |
| Real model | **No model call was made in this pass.** The rule is: none without the owner's explicit approval. |

## What was built in this pass

| Phase | Result | Commits |
|---|---|---|
| **A. Security, auth isolation, baseline** | <ul><li>Agent credentials only from an explicit `--auth` mode or a completed Console sign-in. The agent's environment is scrubbed and its config directory isolated; the reported credential source must match exactly.</li><li>Bearer token for `/mcp`, `/api/*`, `/channel`.</li><li>Hashed, persistent, revocable pairing; only paired devices can approve.</li><li>Release bundles contain none of the runtime (checked).</li><li>Regression test for the credential incident using the real Claude Code binary.</li></ul> | `2165791`, `9960d79`, `4623ff3` |
| **B. In-app chat, inspection, AI debugging** | <ul><li>`mobile_inspect`: source file:line through Metro, owners, props, handlers, style, a11y, hit-test, covering view and its source, findings.</li><li>`mobile_audit_screen`.</li><li>Inspect mode in the panel (pick, parent, "Ask about this").</li><li>Error and request-initiator stacks mapped to app source.</li><li>Conversation resume across reloads.</li><li>Model picker; screenshot thumbnails; generic branding.</li></ul> | `ac8228c`, `625ce4d`, `4327f87`, `b8a09f5` |
| **C. OS-level automation, parity, diagnostics** | <ul><li>`os-injected` taps, typing and swipes (adb; XCUITest through Maestro on the iOS simulator).</li><li>Native alerts on both platforms; keyboard and LogBox dismissal.</li><li>Native logs (logcat by pid; simulator unified log).</li><li>Per-device OS-input availability.</li></ul> | `1aaa83b`, `8aca611` |
| **D. Replayable tests, Expo, physical devices** | <ul><li>Record, save, replay and Maestro export of flows, with stable selectors, route expectations and secret placeholders.</li><li>Expo config plugin.</li><li>Connection troubleshooting hint for physical devices. The device runs themselves were not possible here.</li></ul> | `d23edcf`, `8e2a5ac`, `2928b16` |
| **E. CI, docs, performance, release prep** | <ul><li>ESLint.</li><li>GitHub Actions: checks, Android build, iOS simulator build.</li><li>Hermes heap in `getPerf`.</li><li>Docs: README, API reference, MCP guide, troubleshooting, SECURITY.md, CHANGELOG, setup, architecture, capability matrix, this page.</li><li>npm name and license checks.</li></ul> | `779b4ea`, `35f5dd4`, docs commit |

The Claude Code channel path (in-app chat answered by your own Claude Code) from the earlier session is unchanged and still covered by its tests.

## Test and build results (run at the end of this pass)

| Check | Result |
|---|---|
| `yarn lint` (ESLint, typescript-eslint, react-hooks) | clean |
| `yarn typecheck` (all workspaces) | clean |
| `packages/devtools-server` (`node --test`) | **50/50 passed** |
| `packages/protocol` (`node --test`) | **16/16 passed** |
| `packages/react-native-agent-devtools` (jest, 7 suites) | **52/52 passed** |
| `yarn build` (Bob for the RN library; tsc for protocol and server) | passed |
| `yarn check:release-bundle` | passed. Release bundles: iOS 2684 KB, Android 2687 KB, **no runtime markers** (dev: 5185 / 5194 KB). |
| iOS `xcodebuild` Debug, simulator | BUILD SUCCEEDED (during this pass, after the native changes) |
| Android `:app:assembleDebug` | BUILD SUCCESSFUL (during this pass, after the native changes) |
| GitHub Actions workflow | **written but never run**: the branch hasn't been pushed |

Server tests cover:
- pairing, token auth, origin/rebinding
- repo allowlist, RPC, MCP
- LAN pairing over a real interface
- the auth modes, plus the real-binary credential regression
- the channel bridge with a fake Claude Code
- OS-input backend selection, adb serial matching and coordinate conversion
- flows: record, save, replay, failure screenshot, secrets, validation, Maestro export
- conversation resume

The tests make no model calls.

## iOS and Android validation (simulator and emulator, debug builds)

Everything below was driven through the same tools the agent uses (`tool` / `call` CLI, no model), and the in-app UI was checked with the clearly labelled `--demo-agent`.

| Scenario | iOS sim | Android emu | Evidence |
|---|---|---|---|
| Pairing persists across app restart and server restart | ✅ Keychain | ✅ SharedPreferences | Paired, then restarted both sides; reconnected trusted |
| `unpair` disconnects and un-trusts | — | — | Integration test with a real WebSocket device; not run against the apps |
| Inspect: JSX source location | ✅ `ui.tsx:35`, `LoginScreen.tsx:76` | ✅ inspect runs (benchmarked); same Metro mapping | Exact lines checked against the files on iOS |
| Inspect: covered button → covering view's source | ✅ `PlaygroundScreen.tsx:89` | ⚠️ coverage detected; covering source not checked | Playground's invisible overlay |
| Audit: misaligned price in a row | ✅ 18 pt / 9 pt offsets found | ✅ audit runs (benchmarked) | Playground card |
| Error → app source line | ✅ `PlaygroundScreen.tsx:30` | ✅ `PlaygroundScreen.tsx:30` | `mobile_get_logs` |
| Failed request → initiator | ✅ `api.ts:27` | ✅ `api.ts:27` | `mobile_get_network` |
| Inspect mode UI (pick, parent, Ask about this) | ✅ (driven with Maestro) | ✅ (driven with adb input) | Screenshots |
| Conversation resumes after the app is killed and relaunched | ✅ | ⚠️ same code, not run | `chat.history` replayed |
| OS-level tap / type | ✅ Maestro | ✅ adb | `mode: os-injected` in results |
| OS-level swipe | ✅ Maestro (Home scrolled) | ⚠️ adb swipe not run; in-app synthesized swipe ✅ | |
| Native alert button | ✅ semantic ("Clear") and OS ("Not now", 2.8 s) | ✅ native `performClick` | "2b · Native alert" card, status line checked |
| Dismiss keyboard / LogBox | ✅ | ✅ | |
| Native logs | ✅ unified log (~13 s to read) | ✅ logcat by pid (<1 s) | |
| Flow record → save → replay | ✅ 4/4 steps in 1.2 s; refused without the secret | ✅ the iOS-recorded flow replayed 4/4 in 1.4 s | Cross-platform: same selectors |
| Maestro export runs under Maestro | ✅ logged in | — | `maestro test` on the exported YAML |

## Benchmarks (debug builds, device time unless noted; no model involved)

| Operation | iOS simulator | Android emulator (2 GB AVD) |
|---|---|---|
| `getScreen` p50 | 3 ms | 4 ms |
| `getUI` p50 | 3 ms | 3 ms |
| Screenshot p50 / p95 | 77 / 130 ms | 79 / 751 ms |
| Login sequence (2 × type + tap + navigation, one call; includes the mock API's 700 ms delay) | 1424 ms | 1511 ms |
| `inspect` one element | 48–123 ms (first call includes Metro symbolication) | 8–50 ms |
| `audit` a screen | ~62 ms (panel open) | 6–29 ms |
| OS-level tap | ~1 s after a ~10 s Maestro warm-up | 0.8–3.8 s |
| Hermes heap (`getPerf`) | 25.2 MB | 29.4 MB |

Android memory overhead of the devtools, from one `dumpsys meminfo` sample each, with and without the provider:
- native heap PSS: 89.0 vs 82.7 MB
- Java heap: 16.9 vs 12.3 MB

These are single samples, not a controlled measurement.

The 2 GB AVD swaps under a debug RN app, which explains the long Android p95s. Use 4 GB+ for benchmarking.

**Model latency** isn't measured: no model calls were allowed in this pass. In the earlier session, one unintended turn took 6.9 s ([incident](security.md#incident-the-in-app-agent-ran-on-the-developers-claude-code-login-2026-10-21)). Device work is milliseconds, so model round trips dominate. That's why results are self-contained and sequences run on the device.

## Security audit findings

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | An unapproved `ANTHROPIC_API_KEY` was ignored by Claude Code, which fell back to the developer's stored login (the incident). | High | **Fixed** (`2165791`): explicit modes, scrubbed env, isolated config dir, exact source check, real-binary regression test |
| 2 | The documented `ANTHROPIC_API_KEY` mode could never pass the gate. | Medium (broken feature) | **Fixed**: the key goes through an `apiKeyHelper` flag setting |
| 3 | `/mcp`, `/api/*` and `/channel` were reachable by any local process. | High | **Fixed**: bearer token (0600 file), constant-time compare |
| 4 | Repo `settings.json`, hooks and helpers could run inside the agent's Claude Code. | Medium | **Fixed**: `settingSources: []`; `--project-instructions` adds CLAUDE.md as text only |
| 5 | Any connected app could approve edits and permission prompts. | Medium | **Fixed**: only paired (trusted) devices approve; others are told to answer in the terminal |
| 6 | Pairing tokens were in memory only, so people re-paired often. | Low | **Fixed**: persistent, stored as SHA-256 hashes, 30-day expiry, `unpair` revokes and disconnects |
| 7 | The runtime could ship in release bundles if `__DEV__` handling regressed. | Medium | **Fixed**: `__DEV__`-folded require split; CI checks release bundles for runtime markers |
| 8 | Well-known key formats (sk-ant, ghp_, AKIA, …) weren't redacted. | Low | **Fixed** in `redact.ts` |
| 9 | OS input runs external tools. | Info | `execFile` (no shell); adb text is shell-quoted for the device shell; Maestro YAML strings JSON-escaped; only local Maestro commands are used |
| 10 | Flows could leak typed passwords. | Medium | **Fixed by design**: secure-field text is stored as `${RNAD_SECRET_*}`; a test asserts the secret is never written |
| 11 | `--lan` uses plain `ws://`. | Medium | **Open, documented**: trusted networks only; pairing prevents control, not eavesdropping |
| 12 | Unpaired loopback apps can chat and act on themselves. | Low | **Open, by design**: `--require-pairing` for shared machines |

Full model: [security.md](security.md). Reporting: [SECURITY.md](../SECURITY.md).

## Not verified, and known limitations

**Not verified:**

- **A real model in the in-app chat.** The UI was verified with the demo agent, which runs real device tools. No real model was run, by instruction: it needs the owner's approval and credentials.
- **The channel path with a real Claude Code.** It is verified against a fake Claude Code over the real bridge. The owner's org must enable channels, and Claude Code ≥ 2.1.234 is needed.
- **A completed Console sign-in.** The gate's expected source label comes from Claude Code 2.1.306's own strings.
- **Physical devices** (USB Android, LAN iPhone). The code paths are shared with the simulator and emulator, and LAN pairing is tested over a real interface.
- **Expo in a real Expo project.** The plugin is unit-tested against `@expo/config-plugins` only.
- **The CI workflow.** It has not run on GitHub yet.
- **Conversation resume on Android** and **adb swipes.** Same code paths as verified ones, but not run.

**Limitations:**

- **iOS in-process taps are semantic** (hit-test gated). Real touches need Maestro on the simulator; there is no OS input for physical iPhones.
- **Android `synthesized-touch`** is in-process. Use `mode: "os"` for adb-injected input.
- **OS input on iOS** takes ~10 s to start, then ~1 s per action. Maestro is a third-party dependency (Apache-2.0); confirm with IT/Infra before installing.
- **Coverage:** JS-level network and console only. Native SDK traffic isn't visible, and native logs are read on the computer (not from physical iPhones).
- **Source locations** need a dev build with React 19 creation stacks and a reachable Metro. React's owner-stack budget (10k/s) can hide some; the result then says so.
- **Text truncation** isn't detected by the audit.
- **Architecture:** Fabric only, with no Old Architecture. Errors before the provider mounts are missed.

## npm names and license

- **npm names:** `react-native-agent-devtools`, `react-native-agent-devtools-server` and `react-native-agent-devtools-protocol` all returned 404 (unclaimed) when checked in this pass. Nothing was published.
- **License:** MIT is compatible with every bundled and transitive dependency of the protocol package and the RN library.
  - The server's dependencies are MIT, ISC or BSD, **except `@anthropic-ai/claude-agent-sdk`**, which is "© Anthropic PBC. All rights reserved. Use is subject to Anthropic's Legal Agreements". It is installed from npm, not redistributed by this repo.
  - **Decision needed (owner + IT/legal):** whether publishing an MIT package that depends on it is acceptable, or whether to make it an optional peer dependency.
- **Branding:** generic. The Claude logo was removed, and "Claude" names the service only, with a trademark note.

## Release readiness

**Not ready for a public release yet.** The code, tests and docs are in place. These blockers remain:

| Blocker | Who |
|---|---|
| Push the branch (local commits only; push needs your credentials) and let CI run green once | Owner |
| Approve and run one real-model validation (in-app chat with `--auth console`/`api-key`, or the channel path once channels are enabled) | Owner (Jamie/Infra for channels) |
| Licensing decision on the Claude Agent SDK dependency | Owner + IT/legal |
| One physical-device run per platform (USB Android, LAN iPhone) | Owner (hardware) |
| One real Expo development build with the plugin | Owner or a contributor |
| Decide final package names and claim them on npm, then publish | Owner (not done: no publishing without approval) |

**Not blocking, recommended:**
- Benchmark on a 4 GB AVD.
- Expand the example app with a validation form, an RN `Modal` flow and nested navigation as a broader acceptance scenario.
