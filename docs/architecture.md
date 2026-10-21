# Architecture

```
App (debug build)                                         Developer machine
┌──────────────────────────────────────────────┐          ┌──────────────────────────────────────────────┐
│ <AgentDevTools>                               │          │ react-native-agent-devtools-server           │
│  Profiler(onRender) ─▶ CommitTracker          │          │                                              │
│  Anchor ─▶ your app            Overlay (chat) │          │  HTTP/WS :8765 (loopback; --lan opt-in)      │
│                                               │   JSON   │   ├─ Host/Origin checks, pairing tokens      │
│  Runtime                                      │◀────────▶│   ├─ DeviceRegistry → DeviceSession.rpc()    │
│   ├─ Inspector  (fiber walk → snapshot)       │    WS    │   ├─ AgentSession (Claude Agent SDK)          │
│   ├─ Executor   (actions, settle, guards)     │          │   │    mobile_* tools (in-process MCP)        │
│   ├─ LogCollector / NetworkCollector / Nav    │          │   │    Read/Grep/Glob (PreToolUse allowlist)  │
│   ├─ Connection (reconnect, hello, rpc)       │          │   ├─ /mcp  (Claude Code, stateless HTTP)       │
│   └─ native (TurboModule)                     │          │   ├─ sign-in (claude auth login --console)     │
│        iOS: Swift (UIKit) + ObjC++ shim       │          │   └─ /api/rpc, /api/devices (CLI/bench)        │
│        Android: Kotlin                        │          └──────────────────────────────────────────────┘
└──────────────────────────────────────────────┘
```

## Packages

- `packages/protocol`: message types and validators, the target selector syntax, the action/sequence schema with hard limits, and redaction. It has no dependencies and runs under Metro and Node.
- `packages/react-native-agent-devtools`: the in-app runtime and native module.
- `packages/devtools-server`: the bridge, the agent and the CLI. In the monorepo it runs straight from TypeScript (Node type stripping). Published builds use `lib/`.

## Discovery: how the app is "read"

1. `<AgentDevTools>` renders `Profiler → Anchor(class) → children`, plus the overlay as a sibling, so the devtools UI is never part of the inspected tree. A class instance's `_reactInternals` points at its fiber. From there the inspector climbs to the `HostRoot`, takes `root.current`, and finds the anchor's *current* fiber.
2. One depth-first walk of the committed tree:
   - **Composite fibers** contribute owner names (for example `<LoginButton>`), handler props (`onPress`, `onValueChange`) and React Navigation `route` props, which is how routes are inferred without an adapter.
   - **Host fibers** carry their type (`RCTView`, `RCTSinglelineTextInputView`, `RCTSwitch`/`AndroidSwitch`, `RCTScrollView`, `RCTModalHostView`, `RNSScreen`, …), props and native tag.
   - **Classification:**

     | Kind | Rule |
     |---|---|
     | Pressables | Pressability responder handlers on the host, `onPress` on owners, or gesture-handler buttons |
     | Inputs, switches, sliders | By host type |
     | Scroll containers and lists | `RCTScrollView` + `FlatList`/`VirtualizedList` owner |
     | Modals | `RCTModalHostView` |
     | Static text | `RCTText` |
     | Explicit targets | `<AgentTarget>` |

   - **Labels:** `accessibilityLabel` → text inside the element → placeholder → a label directly above or on the same row → `testID` → owner component name.
   - **State:** `accessibilityState`, `disabled`, `editable`, `value`/`on`, `secureTextEntry` (values are redacted).
   - **Layout:** `nativeFabricUIManager.getBoundingClientRect(node)`. This is synchronous, so no measurement sleeps.
   - **Visibility:** a viewport intersection, clipped by each enclosing scroll view; `opacity: 0` / `display: none`; inactive `RNSScreen`s are skipped.
3. **One batched native probe** (`probeViews(tags, offsets)`):
   - Is each view attached and shown? Detached native-stack screens are pruned, and two attached "push" screens means a transition is in progress.
   - Which React tag would a real touch at the element's visible center hit? iOS uses `UIView.hitTest` across app windows. Android uses RN's `TouchTargetHelper` plus window focus.
   - If the hit isn't the element or its descendant, the element is marked `covered by …`, naming the covering component, LogBox, the devtools overlay, or another window.
4. **Refs.** Each element gets a fingerprint: an FNV-1a hash of its structural path (component type and key/index). `RefRegistry` maps fingerprints to short refs (`e12`) that stay stable while the element persists. A stale ref is re-resolved by `testID`, then by a unique role+label, and is otherwise reported as `STALE`.
5. **Output:** a compact text snapshot (≈1–2 KB) for the model, or JSON.

## Execution: how the app is "operated"

`Executor.act()` wraps every action:

1. **Snapshot**, then **resolve** the target.
2. If the target is off-screen, **scroll it into view** (native scroll of its container).
3. Refuse when the element is **disabled** or **covered**; a hit on the devtools overlay hides the overlay instead.
4. Ask on the device before **sensitive** taps (pay/delete/submit-order/…).
5. **Duplicate-submit guard:** refuse the same submit-like element twice within 2 s if the screen didn't change.
6. **Perform:**

   | Action | Android | iOS |
   |---|---|---|
   | Tap | Synthesized MotionEvents, re-hit-tested natively at dispatch | Pressability responder sequence (`onStartShouldSetResponder` → `onResponderGrant` → `onResponderRelease`, honoring `disabled`), or a native UISwitch toggle |
   | Text | `insertText` / `Editable.replace` | `insertText` / `Editable.replace` |
   | Scroll | Native offset | Native offset |

7. **Settle** (event-driven):
   1. React commit quiet (60 ms)
   2. Wait for requests started by the action (≤ 4 s)
   3. Commit quiet again
   4. Repeat snapshots every 80 ms until the screen signature is stable and no stack transition is running (≤ 5 s)

   Typing uses a light settle (commit quiet only).
8. **Report** `ok`/`error.code`, `mode`, `durationMs` and `changes`: route before/after, added and removed elements, new JS errors, new failed requests, keyboard state. After navigation the report includes the **new screen**, so the agent rarely needs another snapshot.

`runSequence` runs these on the device without model round trips. Each step may carry `expect`, and the sequence stops on failure, unmet expectation, cancellation or timeout. Hard codes (`BLOCKED`, `DENIED`, `CANCELLED`, `STALE`) always stop it.

## Agent integration

- **In-app chat:**
  - One persistent Agent SDK `query()` per device in streaming-input mode, so prompt caching works and `interrupt()` is available.
  - The `mobile_*` tools are an in-process SDK MCP server (`alwaysLoad`).
  - Each user message carries an `<app_state>` block captured at send time and labelled untrusted, so simple questions need no tool call.
  - Partial messages stream to the device as `chat.delta`. Tool calls become `chat.tool` start/end rows; control tools flip the UI into the "agent is controlling the app" state.
  - `chat.done` carries timing: total, first token, tool, device and model time, plus the cost estimate.
- **Credentials:**
  - Sources: the Anthropic Console sign-in started by "Set up Claude" (Claude Code's `auth login --console`, run by the server), `ANTHROPIC_API_KEY`, or Bedrock/Vertex/Foundry.
  - Every Claude Code process the server starts uses a dedicated `CLAUDE_CONFIG_DIR` (`~/.config/react-native-agent-devtools/claude`). Before the first prompt, `accountInfo()` must report an API-key or cloud source and no subscription; otherwise the session fails closed.
  - Sign-in progress reaches the device as `setup.status` (`waiting` / `failed`); success arrives as a fresh `welcome` with the agent available.
- **Claude Code:** `/mcp` exposes the same tool definitions over stateless Streamable HTTP and acts on the most recently connected device.
- **Repository access:** the built-in tools are limited to `Read`/`Grep`/`Glob` (plus `Edit`/`Write` with `--allow-edits`). A PreToolUse hook enforces the root allowlist and the secret-file denylist, and resolves symlinks. Bash and web tools are disallowed.

## Protocol (JSON over one WebSocket)

| Direction | Messages |
|---|---|
| device → server | `hello` (device info, capabilities, token or pairing code), `chat.send`, `chat.cancel`, `chat.reset`, `rpc.result`, `approval.response`, `setup.open`, `ping` |
| server → device | `welcome`, `auth.required`, `chat.status`, `chat.delta`, `chat.text`, `chat.tool`, `chat.done`, `chat.error`, `rpc.call`, `rpc.cancel`, `approval.request`, `setup.status`, `pong` |

Device RPCs: `getScreen`, `getUI`, `resolve`, `tap`, `longPress`, `typeText`, `clearText`, `scroll`, `scrollTo`, `swipe`, `waitFor`, `back`, `runSequence`, `screenshot`, `getLogs`, `getNetwork`, `getNavigation`, `getPerf`, `getCapabilities`.

Both sides validate every message: only known types and methods, size limits, and field stripping.

## Why not CDP / an OS automation daemon?

See [competitive-architecture-review.md](competitive-architecture-review.md). In short:

- **CDP via Metro** takes the single debugger slot (RN DevTools can't run alongside), must inject ES5 strings into Hermes, and needs async measurement sleeps.
- **OS automation** (XCUITest/UiAutomator) is blind to React semantics. On iOS it costs about 0.8 s per tap through an XCTest runner.

The in-app runtime is faster and React-aware. Its price is a native module and, on iOS, no OS-level touches. An optional OS-level backend is on the roadmap.
