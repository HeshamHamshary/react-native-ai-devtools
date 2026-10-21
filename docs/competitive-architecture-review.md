# Competitive architecture review

_Last updated: 2026-10-21. Written before most of this repository's code existed, then revised at the end of the first implementation session with measured results (see [§9](#9-status-after-the-first-implementation-session))._

This review looks at four existing projects that let AI agents inspect or drive React Native apps, checks their claims against their source code, and uses the findings to settle this project's architecture.

**Method.** Each repository was cloned read-only at a pinned commit and read, not run. Metadata came from the GitHub REST API and the npm registry. Claims are labelled:

- **[code]**: verified in source at the pinned commit.
- **[doc]**: stated in a README, docs page or ADR but not traced to code.
- **[evidence]**: a maintainer-published benchmark that we did not reproduce.

No benchmarks were invented. Where nobody has published a number, this document says "unknown".

---

## 1. Verified repository findings

### 1.1 ExecBro: `igorzheludkov/execbro`

- **Source:** https://github.com/igorzheludkov/execbro @ `b72fe225b382a8b545b9240d12d110866fbf4861` (v2.18.0, 2026-10-20). Companion SDK: `igorzheludkov/execbro-sdk` @ `ce17d1a`.
- **License:** dual. Everything outside `src/pro/` is MIT. `src/pro/` is proprietary and includes a non-compete clause ([src/pro/LICENSE](https://github.com/igorzheludkov/execbro/blob/b72fe225b382a8b545b9240d12d110866fbf4861/src/pro/LICENSE)). The npm `"license": "MIT"` field understates this, because the published build includes the compiled `src/pro`.
- **Activity:** 79 stars, about 1,200 commits, effectively one author. About 50 releases between 2026-07-31 and 2026-10-20.
- **npm and name collision:** published as `execbro`. It is mirror-published as **`react-native-ai-devtools`** (about 1.9k downloads/week) and `react-native-ai-debugger`. **This project cannot publish under `react-native-ai-devtools`.** The packages here use the working name `react-native-agent-devtools`. ExecBro's SDK also sets `globalThis.__RN_AI_DEVTOOLS__`, so our globals use an `__RNAD_` prefix to avoid colliding.

**Architecture.** An out-of-process MCP server (stdio) that connects to the app's Hermes runtime through Metro's inspector proxy (Chrome DevTools Protocol).

- **UI discovery [code].**
  - It walks the fiber tree via `__REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots()`, injected as ES5 strings over CDP `Runtime.evaluate`.
  - It identifies pressables by the `PressabilityDebugView` fiber that RN mounts inside every Pressable/Touchable in dev, falling back to `onPress` props.
  - Bounds come from `measureInWindow`, with separate paths for Paper, Fabric `canonical.publicInstance`, and `nativeFabricUIManager.measureInWindow`.
  - Measurement takes two passes: dispatch the async callbacks, **sleep `min(3000, 400 + 2·nodes)` ms**, then collect ([screenState.ts L1773-1845](https://github.com/igorzheludkov/execbro/blob/b72fe225b382a8b545b9240d12d110866fbf4861/src/core/screenState.ts#L1773-L1845)).
- **Control [code].**
  - Taps are physical but injected from the host: AXe/idb on the iOS simulator, `adb shell input tap` on Android. The tap code lives in the proprietary `src/pro/tap.ts`.
  - Typing mixes approaches: it calls `onChangeText` for controlled inputs and sends HID keystrokes otherwise, then reads the value back.
  - **Physical iPhones get screenshots only. Tap and type are not supported there.**
- **Observability [code].**
  - Console via CDP `Runtime.consoleAPICalled`.
  - Network via an XHR/fetch patch injected over CDP, or via the optional in-app SDK. Startup traffic is missed without the SDK.
  - Screenshots via `simctl`/`adb` on the host.
  - Native logs via `log show` and `logcat`.
- **Constraints [code].**
  - It holds **Metro's single debugger slot**, so it cannot run alongside React Native DevTools.
  - Hermes CDP limits force promise polling and fixed sleeps.
  - About 67 MCP tools.
  - Telemetry, license phone-home, and an opt-out upload of tap-failure screenshots. The README's privacy claims understate this.
- **Fabric/Bridgeless [code]:** supported. A comment records verification on RN 0.85 with the New Architecture.
- **App integration:** zero app code in the base case. Requires host tools (AXe or idb, adb).

### 1.2 Callstack agent-device: `callstack/agent-device`

- **Source:** https://github.com/callstack/agent-device @ `6ac6611ae793aa4801a502c52a4ec31d14b97602` (2026-10-21).
- **License:** MIT. The simulator accessibility bridge adapts MIT code from Meta's idb.
- **Activity:** about 5.1k stars, 76 contributors (about 90% of commits from one maintainer). Stable releases every 1–3 days. Pre-1.0 (`0.21.30`). About 191k npm downloads/week, probably inflated by CI.

**Architecture.** A persistent host daemon with on-device helpers. It reads the native accessibility tree and injects input at OS level. **It knows nothing about React Native internals by default.**

- **iOS discovery [code].**
  - On the simulator, an Objective-C bridge spawned inside the simulator uses private `XCTAccessibilityFramework` snapshot APIs.
  - It falls back to `XCUIElement.snapshot()` in an XCUITest runner. Physical devices always use the runner.
- **Android discovery [code].** A prebuilt instrumentation APK runs `UiAutomation` with interactive windows, so keyboards and system dialogs are visible. It runs as a persistent session over `adb forward`.
- **Input [code].**
  - iOS uses an XCUITest runner built with `xcodebuild build-for-testing` and synthesized events via private `XCSynthesizedEventRecord`, the same mechanism as WebDriverAgent. Every iOS interaction goes through the runner, including on the simulator.
  - Android uses `UiAutomation.injectInputEvent` with an `adb shell input` fallback. Text entry uses `ACTION_SET_TEXT`, which is not keystroke-level.
- **Physical devices [code].** Supported on both platforms. iOS needs a signing team, Developer Mode and `devicectl`.
- **Agent surface [code].**
  - The CLI is the primary surface, with an MCP server (`agent-device mcp`, stdio).
  - Node client: `createAgentDeviceClient`.
  - A Vercel AI SDK adapter exists. There is no Claude Agent SDK adapter.
- **Speed design [code].**
  - Warm daemon and helpers.
  - Compact line snapshots: `@e2 [button] "Add" [disabled]`, unlabeled groups dropped, off-screen items summarized.
  - `--settle` diffs the tree after an action (quiet window 300–500 ms).
  - `batch` runs many commands in one request.
  - Refs are positional (`e1…eN`) and re-minted every capture. They are protected by "ref frames" that expire on every mutation and return typed stale-ref errors.
- **Published latency [evidence].**
  - Android emulator p50: tap 52 ms, snapshot 28 ms, fill 275 ms, screenshot 69 ms.
  - iOS simulator medians: press ~816 ms, snapshot ~329 ms, fill 2.4–3.7 s, screenshot ~768 ms.
  - iOS cold start 7–20 s.
- **RN awareness [code].**
  - An optional CLI-only React DevTools bridge over Metro CDP.
  - **Network comes from regex scraping of native logs, not interception**, so JS fetch/XHR is largely invisible.
  - JS console requires an external `agent-cdp` package fetched at runtime.

### 1.3 MobileAIAgent: `MobileAIAgent/react-native`

- **Source:** https://github.com/MobileAIAgent/react-native @ `3920f8eab56d739283f00ee48b5500352158b56a` (2026-03-30). This is a one-time snapshot: 2 stars, 1 contributor.
- **License, with a caveat:** MIT at this snapshot. npm releases from 0.9.20 onward say "SEE LICENSE IN LICENSE". Active development moved to `mohamed2m2018/react-native-agentic-ai`, whose current LICENSE is a **proprietary EULA that prohibits building competing products**. Only the MIT snapshot was read, and only for ideas.
- **npm:** `@mobileai/react-native` (0.9.91, about 19 downloads/week), `react-native-agentic-ai`.

**Architecture.** Everything runs in-app, including the LLM loop. The app calls Gemini or OpenAI itself.

- **Integration [code].** An `<AIAgent>` wrapper with no native module. The chat overlay renders as a sibling outside the walked root, so it never appears in discovery or screenshots.
- **Discovery [code].**
  - It walks the fiber tree from `__reactFiber$` keys, with a DevTools-hook fallback.
  - Interactivity is decided by component name, role and handler props.
  - It prunes inactive screens (`activityState === 0`) and deduplicates pressables by `onPress` identity.
  - Output is a compact indexed text format.
- **Control [code].** Semantic only:
  - Taps call `props.onPress()` with no event argument.
  - Typing calls `onChangeText` or `setNativeProps`.
  - Scrolling reads private `_scrollMetrics`.
  - There is no hit-testing or occlusion check.
- **Screenshots [code].** `react-native-view-shot` output is sent to the cloud LLM **on every step**.
- **Security weaknesses [code].**
  - The LLM API key can be in the app bundle (README quick start).
  - The natural-language request path is not gated to `__DEV__`.
  - The MCP bridge WebSocket has no authentication and listens on all interfaces.
  - It replaces `ErrorUtils`' global handler during tasks and suppresses error reporting.
- **No log or network capture.**

### 1.4 Ceraph: https://ceraph.dev/ (publicly documented claims only)

- **Proprietary.** The license (Ike Studios LLC, v1.1) forbids reverse engineering and forbids using its software, docs or tool descriptions as a blueprint to reimplement Ceraph features. **This review therefore stays at market-context level, and nothing in this project's design was derived from Ceraph's documentation.**
- **Distribution:** npm `@ceraph/react-native-mcp` (1.1.2). Public GitHub holds only a community issues repo.
- **Pricing:** a free Starter tier, and Pro at $9/user/month.
- **Approach [doc]:** a local MCP server driven by the user's own coding agent. It uses native OS automation through the Appium stack (WebDriverAgent on iOS, UiAutomator2 on Android), reads accessibility-tree snapshots with element refs, and pulls runtime errors and console output. It supports real devices, simulators and emulators. No speed figures are published.

---

## 2. Feature comparison matrix

"This project" describes the architecture chosen in [§6](#6-recommended-architecture). What was actually verified at the end of the session is in [§9](#9-status-after-the-first-implementation-session).

| Capability | This project | ExecBro | agent-device | MobileAIAgent |
|---|---|---|---|---|
| Automatic UI discovery | In-app fiber walk plus native hit-test, no per-element registration | Fiber walk over CDP [code] | Native accessibility tree [code] | In-app fiber walk [code] |
| Real UI interaction | Android: in-app MotionEvent dispatch through the real view and RN touch pipeline. iOS: semantic tap guarded by native hit-test; native text and scroll APIs. Optional OS-level input via adb or agent-device | Yes, host-injected (AXe/idb/adb) [code] | Yes, OS-level (XCUITest synthesis / UiAutomation) [code] | No, semantic `onPress()` only [code] |
| iOS support | Simulator and device (in-app runtime) | Simulator full; device screenshots only [code] | Simulator and device (signing needed) [code] | Yes (JS only) |
| Android support | Emulator and device | Emulator and device [code] | Emulator and device [code] | Yes (JS only) |
| Physical device support | Yes over LAN with pairing, or `adb reverse`. No host automation tools needed | Android yes; iPhone screenshots only | Yes on both; iOS needs signing | Yes |
| React Native awareness | Deep: component names, handlers, routes, JS logs and network from startup | Deep (CDP, fibers, Redux, routes) [code] | Minimal by default; optional CLI DevTools bridge [code] | Medium (fibers, routes) |
| Screenshots | In-app (UIKit / PixelCopy) with optional ref-labelled overlay; host fallback | Host (`simctl`/`adb`) [code] | Host [code] | In-app via view-shot, sent every step [code] |
| Console logs | In-app ring buffer (console, global errors, LogBox), chained, redacted | CDP + native logs [code] | Native logs; JS console via external package [code] | None [code] |
| Network inspection | In-app XHR (and therefore fetch) interception from app start, redacted, bodies opt-in | CDP or injected patch; SDK for startup [code] | Native-log scraping [code] | None [code] |
| Claude Code integration | Claude Agent SDK for the in-app chat, plus an MCP endpoint for an existing Claude Code session | MCP stdio, multi-client [code] | MCP stdio + CLI + skills [code] | MCP that delegates to the in-app Gemini loop [code] |
| Interaction latency | Measured (iOS sim): UI snapshot p50 2 ms on device, screenshot 61 ms, type 30–180 ms, tap→navigate 0.2–0.8 s incl. settle ([STATUS](STATUS.md#measured-performance-debug-builds-device-time-excludes-the-model)) | Unknown end to end. Snapshot ≥ ~400 ms by design (fixed sleep) [code] | Android tap p50 52 ms; iOS press ~816 ms [evidence] | Unknown |
| In-app chat | Yes, floating draggable assistant | No | No | Yes (draggable chat bar) [code] |
| Integration complexity | One wrapper component + autolinked native module + `npx` server | Zero app code; host tools required | Zero app code; Xcode runner build / helper APK | One wrapper; LLM key or proxy |
| License | MIT (placeholder pending owner's choice) | MIT core + proprietary `src/pro` | MIT | MIT snapshot; proprietary upstream |

---

## 3. Technical architecture comparison

There are three ways to get the agent its "eyes and hands":

1. **Host-side via CDP (ExecBro).**
   - Strengths: zero app code, deep JS access.
   - Weaknesses: costs the Metro debugger slot (RN DevTools can't be open), Hermes `Runtime.evaluate` constraints (no `awaitPromise`, string-injected ES5, polling), and fixed sleeps for async measurement. Input still needs host tools, and iOS input stops at the simulator.
2. **Host-side via the OS accessibility layer (agent-device, Ceraph).**
   - Strengths: real OS-level input, sees system dialogs and keyboards, framework-agnostic.
   - Weaknesses: no React semantics (component names, handlers, routes, JS errors), iOS cost (XCUITest runner, private XCTest APIs, ~0.8 s taps, multi-second fills), signing for physical iPhones, and log-scraped network data.
3. **In-app runtime (MobileAIAgent, this project).**
   - Strengths:
     - Direct, synchronous access to the fiber tree and Fabric layout (no CDP hop, no sleeps).
     - Observability from the first line of app code.
     - Works on any device the app can reach the server from.
     - Coexists with RN DevTools.
     - Can host the chat UI.
   - Weaknesses: needs a native module for anything beyond JS (hit-testing, screenshots, native input), and cannot do OS-level input on iOS through public APIs.

Unlike MobileAIAgent, this project keeps the LLM on the developer's machine, never puts keys in the app, authenticates the bridge, and uses native APIs (hit-testing, text input, scrolling, Android touch dispatch) instead of calling handlers blindly.

**Interaction-mode honesty.** Every action result in this project carries `mode`:

| `mode` | Meaning |
|---|---|
| `semantic` | A JS handler was called |
| `native` | A public native view API was called |
| `synthesized-touch` | A MotionEvent was dispatched through the app's own window |
| `os-injected` | adb or XCUITest injected the input |

None of the other three projects reports the mechanism per action. ExecBro and agent-device are always OS-level; MobileAIAgent is always semantic but doesn't say so.

---

## 4. License and reuse considerations

| Project | Can we depend on it? | Can we copy code? | Notes |
|---|---|---|---|
| agent-device | **Yes**, as an optional peer, invoked as an external process | MIT; ideas are fine, but we chose not to copy code | Pin an exact version (pre-1.0, very fast release pace). Uses private Apple APIs, so keep it optional and simulator-scoped |
| ExecBro | Not recommended. Brings a CDP debugger-slot conflict, telemetry and an open-core license | **Only from MIT `src/core`, and only ideas.** Never touch `src/pro/` (non-compete) | Ideas adopted and re-implemented independently: `PressabilityDebugView` as a pressable marker, multi-path measurement, Metro `/symbolicate` for stacks |
| MobileAIAgent | No (tiny, unmaintained snapshot; proprietary upstream) | Ideas from the MIT snapshot only | Adopted ideas: render the overlay outside the walked root; prune `activityState === 0` screens; dedupe nested pressables |
| Ceraph | No | **No.** The license forbids using it as a blueprint | Market context only |
| Claude Agent SDK | **Yes** (`@anthropic-ai/claude-agent-sdk`, exact pin 0.3.306) | n/a | Auth via an Anthropic Console sign-in (Claude Code's `auth login --console`, started from the app), `ANTHROPIC_API_KEY` or Bedrock/Vertex/Foundry. The docs state that third-party products must not offer claude.ai login, so the in-app chat uses API billing. The MCP path lets developers use their own Claude Code session instead |
| MCP TypeScript SDK | Yes | n/a | Already a peer of the Agent SDK; used for the Claude Code MCP endpoint |

No code was copied from any of the reviewed repositories.

---

## 5. Performance analysis

### Where the time goes

An agent turn costs `model time × number of model round trips + device time + transport`. In practice:

- **Model round trip:** typically seconds per tool-using step. This dominates everything else, so the biggest win is **fewer round trips**, not faster taps.
- **Device time:** depends on the backend. In-app fiber snapshots and in-app actions can be tens of milliseconds. agent-device's iOS runner is ~0.8 s per press [evidence]. ExecBro's snapshot has a ≥400 ms sleep by construction [code].
- **Transport:** a localhost WebSocket costs well under 10 ms. A LAN WebSocket costs tens of ms.

### Techniques and who uses them

| Technique | ExecBro | agent-device | MobileAIAgent | This project |
|---|---|---|---|---|
| Compact text snapshots instead of screenshots | ✓ | ✓ | ✓ (but screenshot every step) | ✓ |
| Stable element refs | partial (index) | positional + ref frames | index | fingerprint-stable refs + stale detection + re-resolve |
| Persistent connection | ✓ (CDP) | ✓ (daemon + helpers) | ✓ | ✓ (single WS) |
| Local batching | – | ✓ (`batch`, runner `sequence`) | – | ✓ on-device `runSequence` with per-step `expect` guards |
| Event-driven waits | partial (polling) | settle quiet-window | – | React commit hook + quiet window, condition waits |
| Post-action diff in result (saves a snapshot round trip) | screenshot diff | ✓ `--settle` | screen-name check | ✓ route/screen-change summary + compact screen after navigation |
| Screenshots only when needed | ✓ | ✓ | ✗ | ✓ |

### Performance targets for this project

These are measured on a debug build. They are goals, not claims.

| Metric | Target (simulator / emulator) |
|---|---|
| `getUI` on device, ≤ 400 host nodes | p50 < 30 ms, p95 < 80 ms |
| In-app tap, device-side, excluding settle | p50 < 30 ms |
| Settle after an action | ≤ 300 ms quiet window, event-driven |
| Screenshot capture + JPEG encode | p50 < 150 ms |
| Localhost WS round trip | p50 < 10 ms |
| Model round trips for "fill login and submit" | ≤ 2 (snapshot → one `run_sequence`) |

### Benchmark methodology

1. Instrument every layer:
   - `UISnapshot.stats` (fiber walk, hit-test).
   - Each `ActionResult.durationMs`.
   - `rpc.result.deviceMs` vs. server-observed RPC wall time.
   - `chat.done.stats`: total, first-token, tool, device and model time.
2. `react-native-agent-devtools-server bench` drives the connected app without a model. It runs N iterations of `getUI`, `screenshot` and a tap/back loop, and reports p50/p95 for device time and round trip.
3. Record device model, OS, RN version, debug/release, and host node count with every result.
4. Report model time separately from device time. Never fold them into one "latency" figure.

---

## 6. Recommended architecture

**Hybrid: a fast in-process React Native runtime, an optional OS-level backend, a Claude agent on the host, and a floating in-app chat.**

```
┌────────────────────────── App (debug build) ─────────────────────────┐
│ <AgentDevTools> provider                                             │
│  ├─ collectors: console / ErrorUtils (chained) / XHR / navigation    │
│  ├─ inspector: fiber walk ─▶ compact snapshot (refs, roles, labels)  │
│  ├─ native module (TurboModule, Swift/ObjC++ + Kotlin):              │
│  │    hit-test, view frames, screenshot, text input, scroll,         │
│  │    Android MotionEvent dispatch, safe-area/device info            │
│  ├─ executor: tap/type/scroll/waitFor/runSequence + settle + guards  │
│  └─ floating assistant UI (outside the inspected subtree)            │
└───────────────▲──────────────────────────────────────────────────────┘
                │ single authenticated WebSocket (JSON RPC + chat stream)
┌───────────────┴────────────── Dev machine ───────────────────────────┐
│ react-native-agent-devtools-server                                   │
│  ├─ device registry, pairing, origin/host checks, redaction          │
│  ├─ Claude Agent SDK session per device (streaming input, mobile_*   │
│  │   tools as in-process MCP tools, read-only repo tools)            │
│  ├─ MCP endpoint (/mcp) for an existing Claude Code session          │
│  └─ optional backends: adb (Android OS input), agent-device (iOS sim)│
└──────────────────────────────────────────────────────────────────────┘
```

**What to build ourselves.** No existing project does these well:

- The in-app runtime: discovery, executor, collectors.
- The native helper module.
- The chat UI.
- The Agent SDK bridge with on-device approvals.

**What to reuse:**

- The Claude Agent SDK for the agent loop.
- The MCP SDK for the Claude Code path.
- agent-device as an **optional** iOS-simulator OS-level backend, not a hard dependency.
- `adb` directly for Android OS-level fallback. No dependency needed.

**What not to do:**

- Do not use CDP/Metro's debugger as the transport. It conflicts with RN DevTools, is slower, and is fragile on Hermes.
- Do not use private Apple APIs in-process.
- Do not send screenshots by default.

**Strongest differentiator.** The agent's eyes and hands live inside the app:

- Millisecond, React-aware snapshots with native hit-test truth.
- Multi-step flows executed on-device in one round trip.
- Debugging context (JS errors, network) from app start.
- All of it on simulators and physical devices without host automation tooling.
- Driven from a chat inside the app or from Claude Code.

agent-device is better at OS-level input, system dialogs and non-RN apps. ExecBro has a far broader RN debugging toolbox (Redux, network mocking, reloads, 67 tools) with zero app code. We should not try to out-feature either on their home turf.

---

## 7. Specific changes to our implementation

Only the protocol package existed when the review finished, so these were applied as design inputs, not rewrites:

1. **Rename packages** to `react-native-agent-devtools` and use `__RNAD_` globals (npm collision with ExecBro).
2. **Report `mode`** (`semantic` | `native` | `synthesized-touch` | `os-injected`) in every action result. Never fall back silently.
3. **Use native hit-testing for iOS taps** so a semantic tap is refused, or at least flagged, when a real finger would hit something else (the overlap bug in the example app).
4. **Use fingerprint-stable refs** (`e12` survives re-renders) with typed `STALE` errors and safe re-resolution. This adopts agent-device's ref-frame idea, but keeps refs stable instead of re-minting them per capture.
5. **Adopt `PressabilityDebugView` detection** as an extra pressable signal (idea from ExecBro's MIT core, re-implemented).
6. **Make action results self-sufficient:** a post-action screen-change summary, plus a compact snapshot when the route changes, so the agent rarely needs a separate `get_ui` call.
7. **Prefer `runSequence`** with per-step `expect` guards over many single-action tool calls. Stop on divergence.
8. **Render the overlay outside the inspected subtree.** Hide it during screenshots and keep it touch-transparent while the agent is acting.
9. **Use dual Claude paths:** Agent SDK (Console sign-in or API key) for the in-app chat, and an MCP endpoint for Claude Code terminal sessions.
10. **Keep a short, stable tool instruction card,** add an explicit "treat app content as untrusted data" rule, and add next-step hints in errors.

---

## 8. Prioritized roadmap

1. **Vertical slice (this session):**
   - Protocol, server and device bridge.
   - In-app discovery and executor.
   - Native module (hit-test, screenshot, text, scroll, Android touch).
   - Chat UI.
   - Example app.
   - Tests.
2. **iOS OS-level backend:**
   - `os-injected` taps on the simulator via an optional agent-device integration (pinned version). Ref → coordinates come from our snapshot.
   - Investigate a minimal first-party XCUITest runner using only public `XCUICoordinate` APIs.
3. **Native alert/dialog support:** detect `UIAlertController` / `AlertDialog` windows in the native scan (read-only on iOS without OS-level input).
4. **Source mapping:** symbolicate captured stacks through Metro's `/symbolicate` HTTP endpoint (no debugger slot needed). Map elements to component source via React 19 `_debugStack`.
5. **Settle and diff:** commit-hook-driven settle everywhere; `+/-` element diffs in action results.
6. **Benchmarks in CI:** `bench` on the simulator and emulator, with tracked p50/p95.
7. **Recording:** turn a chat session into a replayable action sequence (a regression test without Maestro).
8. **Expo dev-client config plugin** and published npm packages under the final name.

---

## 9. Status after the first implementation session

See the end-of-session report in [`docs/STATUS.md`](./STATUS.md) for measured numbers, what was verified on which simulator or emulator, and what remains unverified.
