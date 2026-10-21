# Architecture

```
App (debug build)                                         Developer machine
┌──────────────────────────────────────────────┐          ┌──────────────────────────────────────────────┐
│ <AgentDevTools>   (release builds: a stub)    │          │ react-native-agent-devtools-server           │
│  Profiler(onRender) ─▶ CommitTracker          │          │                                              │
│  Anchor ─▶ your app     Overlay (chat/inspect)│          │  HTTP/WS :8765 (loopback; --lan opt-in)      │
│                                               │   JSON   │   ├─ Host/Origin checks, bearer token,       │
│  Runtime                                      │◀────────▶│   │   hashed pairing tokens, device trust     │
│   ├─ Inspector  (fiber walk → snapshot)       │    WS    │   ├─ DeviceRegistry → DeviceSession.rpc()    │
│   ├─ details/audit/source (Metro symbolicate) │          │   ├─ chat backends: AgentSession (Agent SDK, │
│   ├─ Executor   (actions, settle, guards,     │          │   │   explicit --auth), ChannelHub (your     │
│   │             external OS-action handoff)   │          │   │   Claude Code), DemoSession              │
│   ├─ Log/Network/Nav/Alert collectors         │          │   ├─ TOOLS: mobile_* + flows (one registry)  │
│   ├─ Connection (reconnect, hello, rpc)       │          │   ├─ Automation: adb / Maestro (XCUITest)    │
│   └─ native (TurboModule)                     │          │   ├─ FlowRecorder / FlowStore / runner       │
│        iOS: Swift (UIKit) + ObjC++ shim       │          │   ├─ conversations (resume after reloads)    │
│        Android: Kotlin                        │          │   └─ /mcp, /channel, /api/{rpc,tool,...}     │
└──────────────────────────────────────────────┘          └──────────────────────────────────────────────┘
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
  - The source is chosen explicitly: `--auth console|api-key|bedrock|vertex|foundry`, or a Console sign-in completed with "Set up Claude" (Claude Code's `auth login --console`, run by the server).
  - Every Claude Code process the server starts gets a dedicated `CLAUDE_CONFIG_DIR` (`~/.config/react-native-agent-devtools/claude`). Its environment has every `ANTHROPIC_*`/`CLAUDE*` variable stripped and only the chosen mode's variables restored. API keys go through an `apiKeyHelper` flag setting.
  - Before the first prompt, `accountInfo()` must report exactly the chosen source and no subscription, or the session fails closed. Details: [security.md](security.md).
  - Sign-in progress reaches the device as `setup.status` (`waiting` / `failed`); success arrives as a fresh `welcome` with the agent available.
- **Conversations survive reloads.** The app sends a stable install id. The server keeps the session and a compact transcript for 3 minutes after a disconnect, re-attaches the session to the new connection and replays `chat.history`.
- **Provider-neutral tools.** Tools are zod-defined in `TOOLS` (`src/tools/registry.ts`) and run with a `ToolContext` (device, OS input, flows). A non-Anthropic backend would implement the same chat-session shape (`send`, `interrupt`, `close`, `attach`, `busy`) and register those tools with its own tool-calling API.
- **Claude Code, chat in the app (channels):**
  - `react-native-agent-devtools-server claude` registers a stdio MCP server (`… channel`) with Claude Code and starts `claude --dangerously-load-development-channels server:rn-agent`.
  - That bridge declares `claude/channel` and `claude/channel/permission`. It connects to the devtools server over a loopback WebSocket (`/channel`) and serves:
    - `mobile_*` tools, executed by the devtools server on the device that asked
    - a `reply` tool
    - app messages, pushed into the session as `notifications/claude/channel` with an `<app_state>` snapshot and a `chat_id`
    - Claude Code's permission prompts, forwarded to the device as `approval.request` and answered back with `notifications/claude/channel/permission`
  - The server shows tool calls as tool rows. A `reply` ends the turn.
  - Only the bridge started by the launcher carries the chat. The launcher arms the server just before starting Claude Code, and it also sets an env flag.
- **Claude Code in the terminal:** `/mcp` exposes the same tool definitions over stateless Streamable HTTP and acts on the device you last chatted from, else the most recently connected one.
- **Repository access:** the built-in tools are limited to `Read`/`Grep`/`Glob` (plus `Edit`/`Write` with `--allow-edits`). A PreToolUse hook enforces the root allowlist and the secret-file denylist, and resolves symlinks. Bash and web tools are disallowed.

## Inspection, audit and source mapping

- **Element details** (`inspector/details.ts`): owners via `_debugOwner` (who rendered whom), nesting path, the props of the component the app wrote, event handlers, layout style, accessibility, `pointerEvents` on the view and its ancestors, disabled state and who set it, hit-test result. Findings are computed statically.
- **Source** (`inspector/source.ts`):
  - React 19 records each element's creation stack (`_debugStack`) in development.
  - The first frame after React's JSX factory is the line where the JSX is written. React's own `formatOwnerStack` drops the same frame.
  - Walking the owner chain gives the first site in the app's own code, which is mapped through Metro's `/symbolicate` (the endpoint LogBox uses) in one request. Results are cached.
  - Nothing is reported unless Metro mapped it. React's per-second stack budget (`UnknownOwner`), a missing dev server and library-only sites become a `sourceNote`.
- **Picking** uses the platform hit-test at a window point (from the topmost modal's root when a modal is open) with the inspect layer made touch-transparent for that frame.
- **Audit** (`inspector/audit.ts`): per-element findings plus overlap, duplicate labels, text overflow, row alignment (outside the container, vertical offset in a row, column drift between rows that share a layout), and errors and failed requests recorded on the screen. Inspect and audit wait for native transitions and hide the devtools panel for one frame, so it never counts as covering the app.
- **Errors and requests:** error stacks and request initiator stacks (captured synchronously when XHR `send` runs) are symbolicated the same way and reported as app frames.

## OS-level input

`src/automation/osInput.ts` picks a backend per device:

- **Android:** `adb shell input`. The adb device is the one whose `pidof <package>` equals the app's reported pid; it is never guessed.
- **iOS simulator:** a long-lived `maestro mcp` process, whose XCUITest driver stays warm, addressed by the app's `SIMULATOR_UDID`. Only local devices are used; Maestro's cloud tools are never called.

An OS action:

1. `prepareExternal` on the device resolves and checks the target like an in-app tap (visible, not covered, sensitive and duplicate guards), scrolls it into view, hides the overlay and records a baseline.
2. The server converts the point with the root view's screen frame (`getRootFrame`: px on Android, pt on iOS) and injects the input.
3. `finishExternal` settles and reports changes with mode `os-injected`.

If no backend exists, the tool returns `UNSUPPORTED` and does nothing else.

## Flows

- **Recording:** `FlowRecorder` keeps the successful actions per app install. Targets come from each action's own result (testID, else role + exact label), so per-session refs never enter a flow. Navigation becomes `expect: { route }`, and secure-field text becomes `${RNAD_SECRET_*}`.
- **Storage:** `FlowStore` writes JSON to the state directory, never the repo.
- **Replay:** `runFlow` sends consecutive in-app steps as one `runSequence` RPC and OS steps through the automation layer. It stops at the first failure and saves a screenshot.
- **Export:** `toMaestro` exports Maestro YAML.

## Protocol (JSON over one WebSocket)

| Direction | Messages |
|---|---|
| device → server | `hello` (device info incl. simulator UDID and pid, capabilities, install id, token or pairing code), `chat.send` (with the picked element as `context.selection`), `chat.cancel`, `chat.reset`, `chat.config` (model), `rpc.result`, `approval.response`, `setup.open`, `ping` |
| server → device | `welcome` (incl. `trusted`), `auth.required`, `chat.status`, `chat.delta`, `chat.text`, `chat.tool` (incl. output preview), `chat.done`, `chat.error`, `chat.notice`, `chat.history`, `rpc.call`, `rpc.cancel`, `approval.request`, `setup.status`, `pong` |

Between the server and the Claude Code channel bridge (loopback `/channel`): `hello`/`welcome`, `tool.call`/`tool.result`, `reply`/`reply.result`, `message`, `stop`, `permission.request`/`permission.verdict`.

Device RPCs: `getScreen`, `getUI`, `resolve`, `tap`, `longPress`, `typeText`, `clearText`, `scroll`, `scrollTo`, `swipe`, `waitFor`, `back`, `runSequence`, `screenshot`, `getLogs`, `getNetwork`, `getNavigation`, `getPerf`, `getCapabilities`, `inspect`, `audit`, `getSelection`, `prepareExternal`, `finishExternal`, `dismissKeyboard`, `dismissLogBox`, `pressAlertButton`.

Both sides validate every message: only known types and methods, size limits, and field stripping.

## Why not CDP / an OS automation daemon?

See [competitive-architecture-review.md](competitive-architecture-review.md). In short:

- **CDP via Metro** takes the single debugger slot (RN DevTools can't run alongside), must inject ES5 strings into Hermes, and needs async measurement sleeps.
- **OS automation** (XCUITest/UiAutomator) is blind to React semantics. On iOS it costs about 0.8 s per tap through an XCTest runner.

The in-app runtime is faster and React-aware. Its price is a native module, and on iOS in-process taps are semantic. OS-level input is an optional layer on top (adb, XCUITest through Maestro) for when real touches matter. It reuses the in-app checks and change reports, so it is never the only source of truth.
