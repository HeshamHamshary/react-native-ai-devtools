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

- **Production safety.** In release builds the package resolves to a stub that renders `children` unchanged, and Metro leaves the runtime out of the bundle entirely (`yarn check:release-bundle` verifies this). The native methods also refuse to run in non-debuggable builds (iOS `DEBUG`, Android `FLAG_DEBUGGABLE`). The `enabled` prop can only turn the tool *off*.
- **Navigation.** Routes are inferred automatically from React Navigation's `route` props. Passing `navigationRef` adds exact, event-driven history. Apps without React Navigation can call `reportRoute('Checkout')`.
- **Hard cases.** For components discovery can't see (canvas drawings, custom gesture recognizers), wrap them in `<AgentTarget id label onActivate>`.

## 2. Run the server

```bash
npx react-native-agent-devtools-server --repo .        # read-only source access for the agent (optional)
```

| Flag | Effect |
|---|---|
| `--repo <path>` | Lets the agent Read/Grep/Glob that tree. Secret files (`.env`, keys, keystores, `google-services.json`, …) are always excluded; symlinks can't escape. Repeatable. |
| `--allow-edits` | Additionally allows Edit/Write inside `--repo`. Each edit is approved on a paired device. |
| `--auth <mode>` | Credentials for the in-app agent: `console`, `api-key`, `bedrock`, `vertex` or `foundry`. Without it, only a completed "Set up Claude" sign-in is used; see below. |
| `--project-instructions` | Adds the repo's `CLAUDE.md` to the agent's instructions, as text only. |
| `--model <id>` | Model for the in-app agent. |
| `--lan` | Accept physical devices on your network (pairing required). |
| `--require-pairing` | Require pairing for every device, simulators included (shared machines). |
| `--demo-agent` | Scripted, clearly labelled replies. Use this for UI work without credentials. |
| `--no-agent`, `--no-mcp` | Disable the in-app agent, or the MCP endpoint. |

Debugging commands. They run no model, and they authenticate with the local token the server keeps in `~/.config/react-native-agent-devtools/server-token`:

```bash
npx react-native-agent-devtools-server devices
npx react-native-agent-devtools-server pair          # current pairing code and paired devices
npx react-native-agent-devtools-server unpair        # revoke every paired device
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
   - **Or** choose credentials explicitly when starting the server:
     - `--auth api-key` with `ANTHROPIC_API_KEY` in the environment
     - `--auth bedrock`, `vertex` or `foundry` with `CLAUDE_CODE_USE_*=1` and that provider's credentials

     A key that merely happens to be exported in your shell is never used; the banner tells you it was ignored.
   - **Sign out:** `react-native-agent-devtools-server logout`.

   Credentials never reach the app. Signing in with a Claude subscription (Pro, Max, Team or Enterprise chat plans) is not offered and is refused if found. Anthropic's Agent SDK terms don't allow products to use claude.ai login, which is the main difference from the Claude in Chrome extension. To use your subscription, take path 1 or 3. Before the first prompt, the server checks which credential source the agent would use (`accountInfo()`, no model call). It must be exactly the one you chose, or the agent doesn't start. See [security.md](security.md#credentials-for-the-in-app-agent).
3. **Claude Code in the terminal.** Uses your own Claude Code login; the conversation stays in the terminal.
   ```bash
   claude mcp add rn-agent -- npx react-native-agent-devtools-server mcp
   ```
   Then ask Claude Code to inspect or drive the app. It gets the same `mobile_*` tools. The `mcp` command is a small stdio server that reads the local token itself.

   Prefer HTTP? Use `claude mcp add --transport http rn-agent http://127.0.0.1:8765/mcp --header "Authorization: Bearer $(npx react-native-agent-devtools-server token)"`.

## 3. Connect a device

By default the app connects to the **same host it loads its JavaScript bundle from** (the Metro host), on port 8765. Override this with the `serverUrl` prop.

| Target | What to do | Notes |
|---|---|---|
| iOS simulator | Nothing | The simulator shares the Mac's loopback. |
| Android emulator | Nothing | `10.0.2.2` maps to the host's loopback; the server accepts that host name. |
| Android device over USB | `adb reverse tcp:8765 tcp:8765` (and `tcp:8081` for Metro) | Traffic stays on loopback; no pairing needed. |
| Android device over Wi-Fi | Start the server with `--lan`, then enter the pairing code shown in the terminal into the app's chat panel | See Pairing and LAN mode below. |
| Physical iPhone | Start the server with `--lan`; the app uses the Metro host IP; enter the pairing code | Verified only with the protocol test suite over a LAN interface, not on a physical iPhone. |

### Pairing

The server prints a pairing code. In the app, tap **⚿ Pair this app** in the panel and enter it.

- **Physical devices on the LAN must pair.**
- **Simulators connect without pairing,** but only a paired app can approve code edits or Claude Code permission prompts. An unpaired app is told to answer in the terminal instead.
- **Pairing persists.** The app stores its device token in the Keychain (iOS) or app-private storage (Android), and the server stores only a hash. Pairing survives reloads, app restarts and server restarts for 30 days.
- **Revoking:** `unpair` revokes every pairing at once. Connected apps are disconnected and come back unpaired.
- **Codes** are 8 characters, single-use, expire after 10 minutes, and lock out after 5 wrong attempts.

### LAN mode

`--lan` binds to all interfaces and prints a warning and the device URL. Devices must pair (see above).

Control endpoints (`/mcp`, `/api/*`, `/channel`) stay **loopback-only and token-authenticated** even in LAN mode, so another machine can't drive your app or read its data through the server. Traffic is plain `ws://`: only use LAN mode on networks you trust.

## Running the example app

See the [root README](../README.md#quick-start-example-app). The example's fake backend is Metro middleware ([`apps/example/mockApi.js`](../apps/example/mockApi.js)), so there's nothing else to start.

## Troubleshooting

- **"Native module RNAgentDevTools is not linked".** Rebuild the app after installing the package (`pod install`, then a full Xcode/Gradle build).
- **Yarn says the project is part of another project.** A `package.json` or `yarn.lock` in a parent directory confuses Yarn. This repo includes an empty `yarn.lock` for that reason; do the same in your app if needed.
- **The panel says "agent unavailable".** The server has no model credentials, or the credential check refused a claude.ai login. The panel explains both connection options.
- **Slow Android numbers.** The default "Medium Phone" AVD has 2 GB of RAM and swaps heavily with a debug RN app. Use an AVD with 4 GB or more when measuring.
