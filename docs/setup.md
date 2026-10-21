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

There are three supported paths. The first two put the chat in the app.

1. **In-app chat, answered by your own Claude Code (channels).** This uses the Claude Code login you already have, including a company-managed one, and creates no API key.
   ```bash
   react-native-agent-devtools-server claude            # in this repo: node .yarn/releases/yarn-4.11.0.cjs claude
   ```
   Run it in your project directory, with the devtools server running, and keep that terminal open. It does three things:
   - Checks that your Claude Code is recent enough (2.1.234 or later; run `claude update` otherwise).
   - Registers a small local bridge with Claude Code for this project (`claude mcp add rn-agent`, local scope).
   - Starts `claude --dangerously-load-development-channels server:rn-agent --allowedTools mcp__rn-agent`, plus any arguments after `--`.

   Confirm the development-channel prompt Claude Code shows. The app switches to "your Claude Code" by itself; messages you type there arrive in that session with a snapshot of the screen, and Claude answers in the app. The terminal shows the work as it happens. Claude Code's "allow this tool?" prompts appear in the app too, so you can answer them there.

   Things to know:
   - **Channels are a Claude Code research preview.** A custom channel like this one needs the development flag above until it's on an approved list.
   - **Company-managed accounts:** an organization Owner must enable channels (Organization settings → Claude Code → Channels, or `channelsEnabled` in managed settings). Until then Claude Code starts but says channels are blocked by org policy, and after 30 seconds the app says it's still waiting.
   - Replies arrive whole, not word by word. Stop in the app tells Claude Code to stop and blocks app actions until your next message; it can't interrupt a step already running in the terminal.
   - Only the Claude Code started by this command carries the app chat. Other Claude Code sessions in the project that load the bridge just get the `mobile_*` tools.
2. **In-app chat, answered by the built-in agent (Claude Agent SDK).**
   - **Tap "Set up Claude" in the app's panel.** Your computer's browser opens Anthropic's sign-in page. Sign in with your Anthropic Console account and approve; the chat turns on by itself. Nothing to copy or paste.

     Under the hood, the server runs Claude Code's documented `claude auth login --console`, using the Claude Code binary bundled with the Agent SDK. It runs in a config directory used only by the agent (`~/.config/react-native-agent-devtools/claude`), so it never touches your own Claude Code login. Approving creates an API key in your Console organization, managed by Claude Code. Usage is billed to that organization at API rates. If your organization controls who may create API keys, check with your admin first.
   - **No browser on this machine (SSH)?** Run `react-native-agent-devtools-server login` in a terminal. It prints a link and accepts the code back.
   - **Or** start the server with `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_USE_BEDROCK=1` / `CLAUDE_CODE_USE_VERTEX=1` and the cloud credentials) in its environment. The environment takes precedence over the sign-in.
   - **Sign out:** `react-native-agent-devtools-server logout`.

   Credentials never reach the app. Signing in with a Claude subscription (Pro, Max, Team or Enterprise chat plans) is not offered and is refused if found. Anthropic's Agent SDK terms don't allow products to use claude.ai login, which is the main difference from the Claude in Chrome extension. To use your subscription, take path 1 or 3. Before the first prompt, the server checks which credential source the agent would use (`accountInfo()`, no model call) and fails closed.
3. **Claude Code in the terminal.** Uses your own Claude Code login; the conversation stays in the terminal.
   ```bash
   claude mcp add --transport http rn-agent http://127.0.0.1:8765/mcp
   ```
   Then ask Claude Code to inspect or drive the app. It gets the same `mobile_*` tools. (Use a different name than `rn-agent` if you also use path 1 in the same project.)

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
