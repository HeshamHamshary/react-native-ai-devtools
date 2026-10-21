# API reference

## The app library: `react-native-agent-devtools`

### `<AgentDevTools>`

Wrap your root component once. In release builds the package resolves to a stub that renders `children` unchanged (the runtime is not in the bundle). The `enabled` prop can only turn the tool off.

| Prop | Type | Default | |
|---|---|---|---|
| `children` | `ReactNode` | — | Your app |
| `enabled` | `boolean` | `__DEV__` | Always off when `__DEV__` is false |
| `serverUrl` | `string` | Metro host, port 8765 | WebSocket URL of the devtools server |
| `pairingCode` | `string` | — | Pre-fill a pairing code (usually entered in the panel) |
| `navigationRef` | React Navigation container ref | — | Exact route history; routes are otherwise inferred from the tree |
| `network` | `NetworkOptions` | `{}` | `captureBodies` (default `false`; bodies are redacted and truncated), `maxBodyBytes` (4096), `capacity` (300), `ignore(url)` |
| `confirmSensitiveActions` | `boolean` | `true` | Ask on the device before pay/delete/submit-like taps and alert buttons |
| `isSensitive` | `(el) => boolean` | built-in | Replace the sensitive-action classifier |
| `initiallyOpen` | `boolean` | `false` | Open the panel on mount |
| `launcherIcon` | `ReactNode` | crosshair mark | Replace the launcher icon |
| `theme` | `'system' \| 'light' \| 'dark'` | `'system'` | Panel theme |
| `hideLauncher` | `boolean` | `false` | Start with the launcher hidden (screenshot/UI tests). "Show Agent DevTools" in the dev menu brings it back; the server connection stays up |

### Other exports

| Export | |
|---|---|
| `reportRoute(name, params?)` | Report the current route for apps without React Navigation |
| `<AgentTarget id label role? onActivate?>` | Explicit instrumentation for the rare element discovery can't see or drive (canvas, Skia, custom gesture recognizers). Adds only standard accessibility props; harmless in production |
| types | `AgentDevToolsProps`, `AgentTargetProps`, `NavigationRefLike`, `NetworkOptions`, `ActionResult`, `InteractionMode`, `LogEntry`, `NetworkEntry`, `UIElement`, `UISnapshot` |

### Expo config plugin

```json
{ "expo": { "plugins": [["react-native-agent-devtools", { "localNetworkUsageDescription": "…" }]] } }
```

The plugin adds `NSLocalNetworkUsageDescription` when it's missing, which a physical iPhone needs to reach a `--lan` server. Pass `{ "localNetwork": false }` to skip it. It warns at prebuild when `expo-dev-client` isn't installed.

## Agent tools

The same tools reach the built-in agent, Claude Code (MCP or channel), and scripts (`tool` CLI / `POST /api/tool`). `kind: control` tools change app state: they show "Agent is operating the app" and are refused after Stop.

Targets accept an element ref from `mobile_get_ui` (`e12`), `#testID`, `text=…`, `label=…`, `role=…`, or visible text. `mobile_inspect` also accepts text refs (`t3`) and any view's `#testID`.

| Tool | Kind | Description | Parameters |
|---|---|---|---|
| `mobile_get_screen` | read | Fast summary of the current screen: route, title, open modals, keyboard state and the main interactive elements. Use first to orient. | — |
| `mobile_get_ui` | read | Compact UI snapshot of the running app from the React tree plus native hit-testing: every interactive element with a stable ref (e1, e2…), role, label, state, and whether a real touch could reach it ("covered by …"), plus visible text and off-screen elements. Prefer this over screenshots for navigation and interaction. | `bounds`?: Include element bounds (x,y,w,h in points) — use for layout questions<br>`max_elements`? |
| `mobile_inspect` | read | Everything known about one element, React-aware: the file:line where its JSX is written (mapped through Metro), the components that rendered it and where, props, event handlers present, layout style, accessibility, pointerEvents on it and its ancestors, whether a real touch reaches it (and where the covering view is written), plus static findings (disabled, covered, no handler, outside its container, misaligned, small target). Works on any view, not only interactive ones (element refs, text refs like t12, #testID or visible text). Omit target to inspect the element the developer picked in the app with inspect mode. Static: nothing is tapped. Use it first for "why doesn't this work", "why is this misaligned" and "which component/file is this". | `target`?: Element to inspect; omit for the developer's selection<br>`x`?: Or inspect what a real touch at this window point (points) would hit<br>`y`? |
| `mobile_audit_screen` | read | Static review of the current screen in milliseconds: elements a real touch cannot reach (and what covers them), disabled or handler-less buttons, overlapping touch targets, small targets, missing accessibility labels, text outside its container or misaligned in rows, and errors / failed requests recorded on this screen. Nothing is tapped. Use for "check this screen for bugs". | — |
| `mobile_tap` | control | Tap an element. The device verifies a real touch at the element center would reach it (refuses with NOT_HITTABLE if covered), scrolls it into view if needed, performs the tap and waits for the UI to settle, then reports what changed (route change, new elements, JS errors, failed requests). The result states the interaction mode actually used: Android uses synthesized touch events through the real view hierarchy; iOS uses a semantic press (no public in-process touch API) verified by native hit-testing. mode "os" injects a real touch through the OS (adb on Android, XCUITest via Maestro on the iOS simulator), slower but exercising gesture handling exactly like a finger; use it to test gesture behavior. | `target`: Element ref from get_ui (e.g. "e12"), "#testID", "text=Log in", "role=button", or visible text<br>`mode`?: auto (default). semantic = call the JS handler even if covered. touch = in-app touch synthesis (Android). os = real OS-level touch (fails if unavailable; never falls back)<br>`long`?: Long press instead of tap |
| `mobile_type` | control | Type into a text field through the native text input stack (React Native emits its normal change events). Replaces the current value by default. Empty text clears the field. Set submit to press the keyboard return/submit key afterwards. | `target`: Element ref from get_ui (e.g. "e12"), "#testID", "text=Log in", "role=button", or visible text<br>`text`<br>`replace`?: Replace existing text (default true); false appends at the cursor<br>`submit`?<br>`mode`?: os = tap the field and type key by key through the OS keyboard (onKeyPress fires per key); slower |
| `mobile_scroll` | control | Scroll a scroll view or list (the largest visible one by default) by a fraction of its viewport. | `direction`<br>`target`?: Scroll container ref, or any element inside it<br>`amount`?: Viewport fraction, default 0.75 |
| `mobile_scroll_to` | control | Scroll until the target element is visible (pages through virtualized lists if it is not rendered yet). | `target`: Element ref from get_ui (e.g. "e12"), "#testID", "text=Log in", "role=button", or visible text |
| `mobile_swipe` | control | Swipe gesture between two points in window coordinates (points). Android: synthesized touch by default; iOS needs OS-level input (used automatically when available, reported as os-injected). mode "os" forces OS-level input on both. | `from_x`<br>`from_y`<br>`to_x`<br>`to_y`<br>`duration_ms`?<br>`mode`? |
| `mobile_wait_for` | read | Wait (event-driven, no fixed sleeps) until a route is active, an element appears/disappears, or text appears/disappears. | `route`?<br>`target`?<br>`text`?<br>`gone`?<br>`timeout_ms`? |
| `mobile_back` | control | Navigate back (Android: in-app back dispatch; iOS: navigation.goBack()). | — |
| `mobile_execute_sequence` | control | Run several UI actions on the device in ONE call (no model round trip between steps). Steps run in order; each waits for the UI to settle. Stops at the first failure or when a step's `expect` condition is not met, so it never continues blindly after the UI diverges. Max 25 steps / 60 s. Action types: tap {target, mode?}, longPress {target}, type {target, text, replace?, submit?}, clear {target}, scroll {direction, target?, amount?}, scrollTo {target}, waitFor {route?\|target?\|text?, gone?, timeoutMs?}, assert {route?\|target?\|text?, gone?}, back {}, sleep {ms ≤ 2000, avoid}. Any action may include expect: {route?\|target?\|text?, gone?, timeoutMs?}. Example: [{"type":"type","target":"#email","text":"a@b.co"},{"type":"tap","target":"text=Log in","expect":{"route":"Home"}}] | `actions`<br>`timeout_ms`?<br>`continue_on_error`? |
| `mobile_screenshot` | read | Capture the app screen as an image (the devtools overlay is hidden). Use for visual questions (layout, alignment, colors, images) — not for routine navigation. annotate=true draws element refs on the image. | `annotate`?<br>`max_width`?: Output width in px (default 720) |
| `mobile_get_logs` | read | Recent console output and uncaught JS errors captured in the app since the devtools started (redacted). Error stacks are mapped to app source lines ("at fn (file:line)"). Use errors_only for a quick error check. | `errors_only`?<br>`levels`?<br>`limit`? |
| `mobile_get_network` | read | Recent fetch/XMLHttpRequest activity from the app JS (sanitized URLs, status, duration, failure reason, the screen it ran on, and the app code that started it as file:line). Native-originated requests are not captured. | `failures_only`?<br>`url_contains`?<br>`limit`? |
| `mobile_alert` | control | Answer the open native alert (Alert.alert) by pressing one of its buttons. Android presses the real dialog button (native). iOS has no public API for that: auto dismisses the alert and calls the button callback (semantic); mode "os" taps the button through XCUITest (os-injected). mobile_get_navigation lists the open alert and its buttons. | `button`: Button text, e.g. "OK" or "Cancel"<br>`mode`? |
| `mobile_dismiss_keyboard` | control | Hide the on-screen keyboard (Keyboard.dismiss(), semantic). Useful when the keyboard covers the element you need. | — |
| `mobile_dismiss_logbox` | control | Clear React Native LogBox notifications and the red error screen (LogBox.clearAllLogs()) when they cover the app. The errors stay available in mobile_get_logs. Look at them first: they are often the bug. | — |
| `mobile_native_logs` | read | Native log lines of the app's own process, read on the developer's computer: adb logcat for the app's pid (Android), the simulator's unified log (iOS). Use for native crashes, native module errors and OS warnings that never reach JS. Redacted; physical iPhones are not supported. | `errors_only`?: Only warnings/errors (default true)<br>`seconds`?: How far back (default 120)<br>`limit`? |
| `mobile_get_navigation` | read | Current route, recent navigation history, native alerts/dialogs that are not part of the React tree, and the open Alert.alert with its buttons. | — |
| `mobile_get_device` | read | Device/app info, the interaction capabilities of this platform (which actions are real touches vs semantic), whether OS-level input (mode "os") is available and why not, and device-side performance stats. | — |
| `mobile_save_flow` | read | Save the actions performed on this app (recently, by you or replays) as a replayable test flow. Refs become stable selectors (testID, or role + label), each navigation becomes a route expectation, secure-field text becomes an environment variable placeholder. Saved on the developer's computer (not in the repo). Use last_steps to keep only the end of the session, e.g. the login steps. | `name`<br>`last_steps`?: Only the last N recorded actions (default: all)<br>`description`? |
| `mobile_run_flow` | control | Replay a saved flow on the connected app and report each step. Stops at the first failed step or unmet expectation and takes a screenshot. Start from the screen the flow was recorded on. | `name`<br>`secrets`?: Values for ${NAME} placeholders (secure-field text) |
| `mobile_list_flows` | read | List the saved test flows for this app. | — |

### Action results

Every action returns:

- `ok`, `action` and `mode` (`semantic` | `native` | `synthesized-touch` | `os-injected`), plus `durationMs`
- `target`: ref, role, label, testID
- `settled`
- `changes`: route before and after, interactive elements added and removed, new JS errors, new failed requests, keyboard
- `detail`: for example the target's state change (`value=on → value=off`), new errors with source lines, failed requests, or the new screen after navigation

Refusals are structured errors:

| Error | Meaning |
|---|---|
| `NOT_HITTABLE` | A real touch would hit something else; the error names it |
| `DISABLED` | The element is disabled |
| `DENIED` | The developer declined a sensitive action |
| `BLOCKED` | Duplicate submit |
| `UNSUPPORTED` | For example `mode: "os"` without an OS backend; nothing else was tried |
| `THREW` | The handler threw (with the error) |
| `STALE` | The ref is gone; re-read the UI |

## Server CLI: `react-native-agent-devtools-server`

```
[start] [options]                         Run the server (default)
claude [--cwd DIR] [-- <claude args>]     Start your Claude Code with the app chat connected (channels)
mcp                                       Stdio MCP server with the tools (for `claude mcp add`)
call <method> [json] [--device ios|android|<id>]   Device RPC (no model)
tool <name> [json] [--device …]           Run an agent tool (no model)
flows [list | show <n> | run <n> | export <n> --maestro [--out f]]
bench [--iterations N]                    Device-side latency
devices | pair | unpair                   Connected apps, pairing code, revoke pairings
login | logout                            Anthropic Console sign-in for the built-in agent
token [--rotate]                          Print or replace the local API token
```

| Option | |
|---|---|
| `--port <n>` | Default 8765 |
| `--auth <mode>` | `console` \| `api-key` \| `bedrock` \| `vertex` \| `foundry`. Without it, only a completed Console sign-in is used |
| `--lan` | Listen on all interfaces for physical devices (pairing required; control APIs stay loopback-only) |
| `--require-pairing` | Require pairing for every device, simulators included |
| `--os-input` | Use OS-level input (adb / Maestro) for taps, typing and swipes by default; fail instead of falling back |
| `--repo <path>` | Let the agent read this source tree (secrets excluded). Repeatable |
| `--allow-edits` | Allow Edit/Write inside `--repo`, each approved on a paired device |
| `--project-instructions` | Add the repo's `CLAUDE.md` to the agent's instructions (text only) |
| `--model <id>` | Built-in agent model (the app can switch it too) |
| `--no-agent`, `--no-mcp` | Disable the built-in agent / the HTTP MCP endpoint |
| `--demo-agent` | Scripted replies, clearly labelled, no model |

Environment:

- `RNAD_AUTH`: same as `--auth`.
- `RNAD_SECRET_*`: values for secret placeholders when replaying flows.
- `XDG_CONFIG_HOME`: where the state directory lives (default `~/.config/react-native-agent-devtools`).

## HTTP API (loopback only)

Everything except `/health` needs `Authorization: Bearer <token>`. The token is in `~/.config/react-native-agent-devtools/server-token`, and `token` prints it.

| Endpoint | |
|---|---|
| `GET /health` | `{ ok, version }` (no token) |
| `GET /api/devices` | Connected apps (id, label, install id, platform, trust) |
| `POST /api/rpc` `{ method, params?, device?, timeoutMs? }` | Raw device RPC |
| `POST /api/tool` `{ name, args?, device? }` | Run an agent tool; returns MCP-style `{ content, isError? }` |
| `GET /api/pairing`, `POST /api/pairing/revoke` | Pairing code and paired devices; revoke all |
| `POST /mcp` | Streamable-HTTP MCP endpoint (stateless) |
| `WS /channel` | The Claude Code channel bridge (token required) |
| `WS /` | Device connections (Origin/Host checked; pairing for LAN devices) |

## Flow format

Flows are saved as JSON under `~/.config/react-native-agent-devtools/flows/<bundleId>/<name>.json`:

```json
{
  "version": 1,
  "name": "login",
  "app": { "bundleId": "com.example.app", "platform": "ios", "window": { "width": 402, "height": 874 } },
  "startRoute": "Login",
  "createdAt": "2026-10-21T19:20:00.000Z",
  "steps": [
    { "type": "type", "target": { "testID": "login-email" }, "text": "dev@example.com", "replace": true },
    { "type": "type", "target": { "testID": "login-password" }, "text": "${RNAD_SECRET_LOGIN_PASSWORD}", "replace": true },
    { "type": "tap", "target": { "testID": "login-submit" }, "expect": { "route": "Home" } },
    { "type": "waitFor", "condition": { "text": "Booking details" } }
  ]
}
```

- **Step types:**
  - the on-device sequence actions: `tap`, `longPress`, `type`, `clear`, `scroll`, `scrollTo`, `waitFor`, `assert`, `back`, `sleep`, each with an optional `expect`
  - plus `swipe`, `alert` and `dismissKeyboard`
- **OS input:** `os: true` replays the step with OS-level input.
- **Secrets:** `${NAME}` is filled from the environment at replay and never stored.
- **Validation:** `validateFlow` in `react-native-agent-devtools-protocol` checks a flow, and `toMaestro` (server package) exports one.
