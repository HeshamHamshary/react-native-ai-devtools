# Setup

## Requirements

- macOS (the iOS tooling needs it; Android-only work also runs on Linux)
- Node.js ≥ 22.18. The server runs its TypeScript sources directly with Node's type stripping during development.
- A **development build** of your app. The library includes a native module (TurboModule), so after installing it you must rebuild the app with `pod install` plus an Xcode/Gradle build. **Expo Go cannot load custom native modules.** Expo users need a development build (`expo prebuild` / `expo run:ios`).
- React Native New Architecture (Fabric). This is the default, and the only option, in recent React Native. Verified on React Native 0.86.2.

## 1. Add the library

```bash
yarn add -D react-native-agent-devtools
cd ios && pod install
```

Wrap your root component:

```tsx
import { AgentDevTools } from 'react-native-agent-devtools';

<AgentDevTools
  navigationRef={navigationRef}   // optional: React Navigation container ref, for exact route history
  network={{ captureBodies: false }} // default; bodies are opt-in and always redacted
  confirmSensitiveActions           // default true: ask on-device before pay/delete/submit-like taps
>
  <App />
</AgentDevTools>
```

Notes:

- **Production safety.** When `__DEV__` is false the component renders `children` only and installs nothing. The native methods also refuse to run in non-debuggable builds (iOS `DEBUG`, Android `FLAG_DEBUGGABLE`). The `enabled` prop can only turn the tool *off*.
- **Navigation.** Routes are inferred automatically from React Navigation's `route` props. Passing `navigationRef` adds exact, event-driven history. Apps without React Navigation can call `reportRoute('Checkout')`.
- **Hard cases.** For components discovery can't see (canvas drawings, custom gesture recognizers), wrap them in `<AgentTarget id label onActivate>`.

## 2. Run the server

```bash
npx react-native-agent-devtools-server --repo .        # read-only source access for the agent (optional)
```

| Flag | Effect |
|---|---|
| `--repo <path>` | Lets the agent Read/Grep/Glob that tree. Secret files (`.env`, keys, keystores, `google-services.json`, …) are always excluded; symlinks can't escape. Repeatable. |
| `--allow-edits` | Additionally allows Edit/Write inside `--repo`. Each edit is approved on the device. |
| `--model <id>` | Model for the in-app agent. |
| `--lan` | Accept physical devices on your network (pairing required). |
| `--demo-agent` | Scripted, clearly labelled replies. Use this for UI work without credentials. |
| `--no-agent`, `--no-mcp` | Disable the in-app agent, or the MCP endpoint. |

Debugging commands (these run no model):

```bash
npx react-native-agent-devtools-server devices
npx react-native-agent-devtools-server call getUI '{"bounds":true}' --device ios
npx react-native-agent-devtools-server call runSequence '{"actions":[{"type":"tap","target":"text=Log in"}]}'
npx react-native-agent-devtools-server bench --iterations 20 --device android
```

### Connecting Claude

There are two supported paths:

1. **In-app chat (Claude Agent SDK).** It needs an Anthropic API key or cloud credentials on your computer.
   - **Easiest: tap "Set up Claude" in the app's panel.** Your computer's browser opens `http://127.0.0.1:8765/setup`. Sign in to the Anthropic Console, create an API key, and paste it on that page. The key is validated, saved only on your computer (`~/.config/react-native-agent-devtools/credentials.json`, mode 0600), and the chat activates without a restart. You can also open that page yourself.
   - **Or** start the server with `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_USE_BEDROCK=1` / `CLAUDE_CODE_USE_VERTEX=1` and the cloud credentials) in its environment. The environment takes precedence over a saved key.

   API usage is billed to the Console account that owns the key. If your organization manages API keys, use the one it provides.

   The key never reaches the app. The server also refuses to run the agent on a personal claude.ai (Pro/Max) login. Anthropic's Agent SDK terms don't allow products to use it, and Claude Code can otherwise prefer a stored login over `ANTHROPIC_API_KEY`. Before the first prompt, the server checks which credential source the agent would use and fails closed.
2. **Claude Code.** Uses your own Claude Code login.
   ```bash
   claude mcp add --transport http rn-agent http://127.0.0.1:8765/mcp
   ```
   Then ask Claude Code in your terminal to inspect or drive the app. It gets the same `mobile_*` tools. The conversation lives in the terminal, because Claude Code has no documented API for an app to inject messages into an existing session.

## 3. Connect a device

By default the app connects to the **same host it loads its JavaScript bundle from** (the Metro host), on port 8765. Override this with the `serverUrl` prop.

| Target | What to do | Notes |
|---|---|---|
| iOS simulator | Nothing | The simulator shares the Mac's loopback. |
| Android emulator | Nothing | `10.0.2.2` maps to the host's loopback; the server accepts that host name. |
| Android device over USB | `adb reverse tcp:8765 tcp:8765` (and `tcp:8081` for Metro) | Traffic stays on loopback; no pairing needed. |
| Android device over Wi-Fi | Start the server with `--lan`, then enter the pairing code shown in the terminal into the app's chat panel | See LAN mode below. |
| Physical iPhone | Start the server with `--lan`; the app uses the Metro host IP; enter the pairing code | Verified only with the protocol test suite over a LAN interface, not on a physical iPhone. |

### LAN mode

`--lan` binds to all interfaces and prints a warning, the device URL and a pairing code.

- The code is 8 characters, single-use, expires after 10 minutes, and locks out after 5 wrong attempts.
- A successful pairing returns a device token valid for 12 hours. It's kept in memory, so after a full JS reload you pair again.
- Control endpoints (`/mcp`, `/api/*`) stay **loopback-only** even in LAN mode, so another machine can't drive your app or read its data through the server.

Only use LAN mode on networks you trust.

## Running the example app

See the [root README](../README.md#quick-start-example-app). The example's fake backend is Metro middleware ([`apps/example/mockApi.js`](../apps/example/mockApi.js)), so there's nothing else to start.

## Troubleshooting

- **"Native module RNAgentDevTools is not linked".** Rebuild the app after installing the package (`pod install`, then a full Xcode/Gradle build).
- **Yarn says the project is part of another project.** A `package.json` or `yarn.lock` in a parent directory confuses Yarn. This repo includes an empty `yarn.lock` for that reason; do the same in your app if needed.
- **The panel says "agent unavailable".** The server has no model credentials, or the credential check refused a claude.ai login. The panel explains both connection options.
- **Slow Android numbers.** The default "Medium Phone" AVD has 2 GB of RAM and swaps heavily with a debug RN app. Use an AVD with 4 GB or more when measuring.
