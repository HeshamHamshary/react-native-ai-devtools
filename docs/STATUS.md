# Status: first implementation session (2026-10-21)

## Environment

| Item | Value |
|---|---|
| Host | macOS 26.6.2 (arm64), Node 24.10, Xcode 26.0.1, JDK 17 |
| React Native | 0.86.2, New Architecture (Fabric, bridgeless), Hermes, debug builds |
| iOS | iPhone 17 Pro simulator, iOS 26.0 |
| Android | "Medium Phone API 36.1" emulator, Android 16, **2 GB RAM** |
| Physical devices | **None were used.** Nothing in this report was verified on a physical device. |

## Project structure

```
apps/example/                    SkyTrips example app (RN 0.86.2, React Navigation native stack)
  mockApi.js                     fake backend served by Metro middleware
  src/screens/                   Login, Home (+modal), BookingDetails, Itinerary, Playground (broken on purpose)
packages/protocol/               wire protocol, action schema/limits, redaction (+12 tests)
packages/react-native-agent-devtools/
  ios/                           RNADNative.swift (UIKit) + RNAgentDevTools.mm (TurboModule shim)
  android/                       RNAgentDevToolsModule.kt
  src/inspector/                 fiber walk, refs, matching, compact formatting
  src/executor/                  actions, settle, guards, sequences, commit tracking
  src/collectors/                logs, network, navigation
  src/transport/                 WebSocket client
  src/ui/                        launcher, chat panel, markdown, Claude mark (temporary)
  src/__tests__/                 27 tests
packages/devtools-server/
  src/agent/                     Agent SDK session, auth gate, Console sign-in, prompt, demo agent
  src/security/                  pairing, origin/host checks, repo allowlist
  src/transport/                 device registry/RPC, MCP endpoint
  src/tools/                     15 mobile_* tool definitions + formatting
  src/*.test.ts                  20 tests
docs/                            review, architecture, setup, capability matrix, security, this file
```

## Commands

```bash
node .yarn/releases/yarn-4.11.0.cjs install && (cd apps/example/ios && pod install)
node .yarn/releases/yarn-4.11.0.cjs server --repo apps/example        # devtools server (:8765)
node .yarn/releases/yarn-4.11.0.cjs example start                      # Metro
node .yarn/releases/yarn-4.11.0.cjs example ios | android              # build + run
node .yarn/releases/yarn-4.11.0.cjs test && node .yarn/releases/yarn-4.11.0.cjs build
```

**Connect Claude.** Tap "Set up Claude" in the app panel and finish signing in with your Anthropic Console account in your computer's browser. The chat turns on by itself. The alternative is to drive the app from your own Claude Code session:

```bash
claude mcp add --transport http rn-agent http://127.0.0.1:8765/mcp
```

## Test and build results (all run in this session)

| Check | Result |
|---|---|
| `packages/protocol`: `node --test` | **13/13 passed** |
| `packages/devtools-server`: `node --test` (pairing, origin/rebinding, repo allowlist, RPC, MCP, LAN pairing over a real interface, sign-in flow, auth gate, agent config isolation against the real Claude Code binary) | **20/20 passed** |
| `packages/react-native-agent-devtools`: jest (discovery, refs, hit coverage, pruning, matching, executor modes and refusals, sequences, collectors) | **27/27 passed** |
| `yarn typecheck` (all workspaces) | passed |
| `yarn build`: Bob (RN lib), tsc (protocol, server); compiled CLI runs from `bin/` | passed |
| iOS `xcodebuild` Debug (simulator), Swift + ObjC++ TurboModule | **BUILD SUCCEEDED** |
| Android `:app:assembleDebug` (arm64), Kotlin module | **BUILD SUCCESSFUL** |

## Feature checklist

### Implemented and verified on simulator/emulator

- Monorepo, example app, floating launcher (draggable, edge-snapping, safe area), chat panel (streaming markdown, tool rows with timing, stop, approvals, pairing, perf panel, "agent is controlling the app" indicator, Connect/Set up Claude card).
- WebSocket device bridge, loopback by default, with origin/rebinding defenses. LAN pairing is verified by an integration test over a real non-loopback interface.
- **Automatic UI discovery with no registration:**
  - roles, labels (including adjacent-label inference), state, bounds, secure-value redaction
  - route inference from React Navigation; native-stack screen pruning and transition detection
  - modals; off-screen elements; native hit-test coverage, which correctly flagged the playground's invisible overlay and LogBox toasts
- **Actions:**

  | Action | Verified behavior |
  |---|---|
  | Tap | iOS: semantic, hit-test gated. Android: synthesized touch, re-hit-tested at dispatch. A real uncaught error surfaced through Pressability → LogBox on Android. |
  | Type | Native |
  | Scroll / scroll-to | Native, including paging a FlatList |
  | Back | Android: native. iOS: `goBack` |
  | Wait-for | Passed |
  | Multi-step sequences | `expect` guards, stop on divergence, cancellation, timeout |
  | Refusals | `DISABLED`, `NOT_HITTABLE`, `THREW`, `UNSUPPORTED`, `DENIED`, `BLOCKED` |

- Screenshots (plain and annotated) on both platforms. RN modals are composited on Android.
- Collectors:
  - console and global errors (chained)
  - XHR/fetch with redaction; bodies opt-in
  - failed requests and new errors attached to action results
  - navigation history
- Claude Agent SDK session per device:
  - streaming deltas, tool status, interrupt, per-turn timing and cost
  - `app_state` attached to each message
  - the credential gate
- MCP endpoint for Claude Code (`tools/list` and `tools/call` verified against a device by test).
- One-tap "Set up Claude" sign-in, verified on the Android emulator with the browser launch stubbed:
  - The button started Claude Code's `auth login --console`, which produced the Anthropic sign-in URL with a localhost callback.
  - The app showed "Finish signing in on your computer".
  - Tapping again restarted the sign-in, with one process at a time.
  - A sign-in that didn't finish came back as a readable error.

  iOS shows the same panel. The live re-enable after a successful sign-in is verified by test with a stubbed sign-in.
- `<AgentTarget>` explicit instrumentation; gesture-handler button detection.

### Partial / not yet verified

- **In-app chat with a real model.** The in-app UI was verified end to end with the clearly labelled `--demo-agent`, which runs real device tools. A real model turn was verified once through a fake-device harness (see the incident below), but not in the app panel. *Needs you to complete the sign-in once.*
- **Screenshot → model visual analysis.** Images are produced and returned as MCP image content, which the SDK docs say reaches the model. No model has analyzed one yet.
- **Physical devices** (iPhone over LAN, Android over USB or LAN): code paths exist; untested.
- **Tapping the iOS chat panel:** the simulator can't be tapped from automation here, so the panel was verified visually (opened via `initiallyOpen`) and on Android via adb input.
- **Native alerts:** detected read-only; their buttons can't be tapped yet.
- **A completed sign-in.**
  - Not run here, because it needs your Anthropic account.
  - The gate expects `accountInfo().apiKeySource === '/login managed key'`. That label comes from Claude Code 2.1.306's own description of its credential sources: "an API key created and stored by /login with an Anthropic Console account".
  - That the CLI exits 0 on success is assumed.
  - Isolation is verified: a fresh agent config directory reports signed out while the developer is logged in to Claude Code.

### Not supported (by design or not yet built)

| Gap | Why, or what it would take |
|---|---|
| OS-level (`os-injected`) input | No XCUITest/adb backend yet. On iOS, taps are semantic and hit-test gated. |
| iOS swipe gestures | Needs OS-level input |
| Keystroke-level typing | `onKeyPress` doesn't fire per character |
| Native-originated network traffic, native logs | Not captured |
| Expo Go | Requires a development build |
| Old Architecture (Paper) | Not targeted |

## Measured performance (debug builds; device time excludes the model)

### iOS simulator

From `bench --iterations 15` plus action traces:

| Operation | p50 | p95 | Notes |
|---|---|---|---|
| `getUI` (Login, 134 fibers / 26 host views) | **2 ms** device, 3 ms round trip | 4 ms / 5 ms | |
| Snapshot (Playground, 912 fibers / 249 host views) | 14 ms (hit-test 1.5 ms) | — | single trace |
| Screenshot, 720 px JPEG (~90 KB) | **61 ms** device, 65 ms round trip | 98 ms | |
| Type into field (light settle) | 32–179 ms | — | first keyboard presentation ~0.5 s |
| Tap → navigate to Booking Details, incl. waiting for its 400 ms mock request | 769 ms | — | |
| Back | 194 ms | — | |
| Login sequence: 2 × type + tap + navigation, one call | 1.25 s | — | includes the mock API's 700 ms delay |

### Android emulator

Results depend heavily on AVD memory:

| Condition | getUI | Screenshot | Other |
|---|---|---|---|
| Before memory pressure | **3.6–5 ms** device, 6–8 ms round trip (Home, 203 fibers) | — | 5-step sequence (scroll-to + logout + 2 × type + login): **2.66 s** |
| After ~1 GB of swap on the 2 GB AVD | 47–121 ms | 480–580 ms | — |

Use a 4 GB+ AVD for benchmarking.

### Model

One turn, not a benchmark. It ran unintentionally on the owner's login; see the incident below.

- **Prompt:** "What screen am I on?"
- **Answer:** correct, from the attached `app_state`, with **0 tool calls**
- **Timing:** first token 5.97 s, total 6.86 s, API time 3.75 s
- **Model and cost:** claude-opus-5-5, estimated $0.05
- **Context:** cold subprocess

**Takeaway.** Device operations take milliseconds. Model round trips take seconds and dominate. Hence `app_state` on each message, self-contained action results, and on-device sequences.

## Acceptance scenario

| Step | Status | Evidence |
|---|---|---|
| 1. Launch on simulator/emulator | ✅ | iPhone 17 Pro sim and Android 16 emulator, both connected |
| 2. Floating icon visible | ✅ | simulator and emulator screenshots |
| 3. Tap opens chat | ✅ Android (adb tap); iOS shown via `initiallyOpen` | screenshots |
| 4–5. "What screen am I on?" → correct | ✅ real model in the harness; ✅ demo agent in the app UI; ⏳ real model in the app (needs a key) | — |
| 6–9. Fill login, press Login → Home, no registration | ✅ both platforms through the same tools the agent calls (device RPC) | sequence traces above |
| 10–11. Open Booking Details | ✅ | tap "Booking details" → route BookingDetails, data loaded |
| 12–13. Check for errors | ✅ | THREW, 500 failure, navigation error, LogBox fatal error captured and reported |
| 14–15. Screenshot and describe | ⚠️ screenshot captured and returned as image content; description by a model not yet run | — |

## Incident: unintended use of the owner's Claude login

**What happened.** To test error handling without real credentials, the server was started with a deliberately invalid `ANTHROPIC_API_KEY`. The Agent SDK's Claude Code subprocess ignored it, authenticated with the developer's stored Claude Code login instead, and answered one question (about $0.05 estimated).

**What changed.** The server now isolates the subprocess's config directory and checks the credential source with `accountInfo()` before any prompt, refusing anything except an API key or a cloud provider (commit `2dd40b7`). No further model calls were made in the session.

## Known platform limitations

**iOS:**

- No public in-process touch injection, so taps are semantic. They are always gated by `UIView.hitTest` and labelled as such. Swipes are unsupported until there's an OS-level backend.
- Native-stack header buttons aren't React elements; back goes through `navigation.goBack()`.
- Keyboard windows are skipped in screenshots.
- The first keyboard presentation blocks the main thread for about 0.5 s on the simulator.

**Android:**

- Touches are synthesized in-process: real view hit-testing and RN pipeline, but not OS-delivered.
- Another window (dialog, LogBox) is reported as "another window" without a name.
- Secure windows capture black. 2 GB AVDs swap heavily.

**Both:**

- Fabric only.
- JS-level network and console only.
- Errors thrown before the provider mounts are missed.
- Settling can't see native-only animations that don't commit React updates; there's a bounded wait.

## Next priorities

1. Complete "Set up Claude" once with a real Console account and finish acceptance steps 4–5 and 14–15 in the app. Confirm the gate reports `/login managed key`.
2. Optional OS-level backend:
   - Android: adb `input` and the UiAutomation helper.
   - iOS simulator: Callstack agent-device (MIT, pinned) or a minimal public-API XCUITest runner.
   - Results report `os-injected`.
3. Physical-device runs (USB Android, LAN iPhone), plus persisting the LAN pairing token across JS reloads.
4. Dismiss LogBox and tap native alert buttons.
5. Stack symbolication through Metro `/symbolicate`; source locations from React 19 `_debugStack`.
6. CI (GitHub Actions): tests, builds, simulator smoke test with `bench`.
7. Record a chat session as a replayable `runSequence` regression test.
8. Expo config plugin; publish under a final npm name; decide license and branding (replace the temporary Claude mark).
