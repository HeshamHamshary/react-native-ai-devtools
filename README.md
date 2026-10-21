# react-native-agent-devtools

> Working name. The repository is `react-native-ai-devtools`, but that npm name is already taken (see [the competitive review](docs/competitive-architecture-review.md#11-execbro-igorzheludkovexecbro)).

An AI assistant that lives inside your React Native **development build**. Tap the floating button, ask it to log in, open a screen, or find out why a button doesn't respond. A Claude agent running on your computer inspects the live app, operates it, and reads its errors and network traffic.

```
┌──────── your app (debug build) ────────┐          ┌──────────── your computer ─────────────┐
│ <AgentDevTools>                         │  WS      │ react-native-agent-devtools-server     │
│  • React-aware UI snapshot (~2–20 ms)   │◀───────▶ │  • Claude Agent SDK session per app     │
│  • native hit-testing / input / scroll  │          │  • mobile_* tools, read-only repo tools │
│  • on-device multi-step execution       │          │  • MCP endpoint for Claude Code         │
│  • console / errors / network capture   │          └─────────────────────────────────────────┘
│  • floating chat                        │
└─────────────────────────────────────────┘
```

It is a development and QA tool. When `__DEV__` is false it renders only your app and installs nothing, and every native method refuses to run in non-debuggable builds.

## What it does

- **Automatic UI discovery.** It reads the committed React tree, so there's no per-element registration and no `testID` requirement. It finds buttons, text fields, switches, scroll views, lists, modals and visible text. It reads Fabric layout synchronously and uses real native hit-testing to tell you when something is covered by another view.
- **Real interactions, honestly labelled.** Every result reports the mode it used:

  | Mode | What it means |
  |---|---|
  | `synthesized-touch` | Android: a MotionEvent through the real view hierarchy and RN touch pipeline |
  | `native` | Typing via the platform text stack; native scrolling; UISwitch |
  | `semantic` | iOS taps. There is no public in-process touch API, so these are always gated by a native hit-test |

- **Fast autonomous flows.** `mobile_execute_sequence` runs up to 25 steps on the device in one call. Each step waits for the UI to settle using React commits, network idle and transition end, not fixed sleeps. Steps can declare `expect` conditions, so a sequence stops as soon as the UI diverges.
- **Debugging context:**
  - console output and uncaught JS errors, chained without replacing existing handlers
  - fetch/XHR traffic with redaction (bodies are opt-in)
  - the route and navigation history
  - native alerts
  - screenshots, with optional ref-labelled boxes
- **Three ways to talk to it:**
  - The in-app chat, answered by **your own Claude Code session** through a channel (Claude Code research preview), using your normal Claude Code login: `react-native-agent-devtools-server claude`.
  - The in-app chat, answered by the built-in agent (Claude Agent SDK). One tap on "Set up Claude" signs in with your Anthropic Console account in your computer's browser.
  - Your Claude Code terminal session, through the server's MCP endpoint.

## Quick start (example app)

Requirements: macOS, Node ≥ 22.18, Xcode 26+, and Android SDK 35/36 with JDK 17. Yarn 4 is vendored in `.yarn/releases`, so you don't need to install it.

```bash
# 1. Install. The empty yarn.lock keeps Yarn from attaching to a parent project.
node .yarn/releases/yarn-4.11.0.cjs install
(cd apps/example/ios && pod install)

# 2. Start the devtools server (terminal 1)
node .yarn/releases/yarn-4.11.0.cjs server --repo apps/example

# 3. Start Metro (terminal 2)
node .yarn/releases/yarn-4.11.0.cjs example start

# 4. Run the app (terminal 3)
node .yarn/releases/yarn-4.11.0.cjs example ios       # or: example android
```

Tap the ✦ button. To give the chat a brain, either run the command below so your own Claude Code answers, or tap **Set up Claude** and sign in with an Anthropic Console account. Then ask "What screen am I on?". The demo login is any email plus `password123`.

For UI work with no Claude at all, run the server with `--demo-agent`: a clearly labelled scripted assistant.

```bash
node .yarn/releases/yarn-4.11.0.cjs claude     # chat in the app, answered by your Claude Code
# or terminal only:
claude mcp add --transport http rn-agent http://127.0.0.1:8765/mcp
# then, in Claude Code: "log into the example app and open booking details"
```

## Use it in your app

```bash
yarn add -D react-native-agent-devtools        # needs a native rebuild (not Expo Go)
npx react-native-agent-devtools-server --repo .
```

```tsx
import { AgentDevTools } from 'react-native-agent-devtools';

export default function Root() {
  return (
    <AgentDevTools navigationRef={navigationRef /* optional */}>
      <App />
    </AgentDevTools>
  );
}
```

That's the whole integration. Details: [setup guide](docs/setup.md). The packages aren't published yet; until then, use the monorepo.

## Documentation

- [Setup: simulators, emulators, physical devices, credentials](docs/setup.md)
- [Architecture](docs/architecture.md)
- [Platform capability matrix](docs/capability-matrix.md)
- [Security and privacy](docs/security.md)
- [Status, verified results, performance and roadmap](docs/STATUS.md)
- [Competitive architecture review](docs/competitive-architecture-review.md)
- [Contributing](CONTRIBUTING.md)

## Packages

| Package | What it is |
|---|---|
| [`packages/react-native-agent-devtools`](packages/react-native-agent-devtools) | RN library: provider, inspector, executor, collectors, chat UI, TurboModule (Swift/ObjC++, Kotlin) |
| [`packages/devtools-server`](packages/devtools-server) | Node server: device bridge, Claude Agent SDK session, MCP endpoint, CLI |
| [`packages/protocol`](packages/protocol) | Shared wire protocol, action schema, redaction rules |
| [`apps/example`](apps/example) | "SkyTrips" example app with an intentionally broken debug playground |

## License and branding

MIT. The `LICENSE` file is a placeholder until the project owner picks a license.

Not affiliated with or endorsed by Anthropic. The launcher currently shows a Claude-style mark at the project owner's request during internal development ([`ClaudeMark.tsx`](packages/react-native-agent-devtools/src/ui/ClaudeMark.tsx)). Replace it, or get permission, before any public release. Apps can already override it with the `launcherIcon` prop.
