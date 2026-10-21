# react-native-agent-devtools

An AI debugging assistant that lives inside your React Native **development build**. Tap the floating button and ask "why doesn't this button work?", "check this screen for bugs" or "log in and open my booking". A coding agent on your computer inspects the live React tree, operates the app, reads its errors and network traffic, and points you to the exact file and line.

```
┌──────── your app (debug build) ─────────┐          ┌──────────── your computer ──────────────┐
│ <AgentDevTools>                         │   WS     │ react-native-agent-devtools-server      │
│  • React-aware snapshot + inspection    │◀────────▶│  • chat: your Claude Code (channel) or  │
│  • native hit-testing, input, scroll    │ loopback │    the built-in Claude Agent SDK agent  │
│  • on-device multi-step execution       │ (or LAN, │  • mobile_* tools over MCP              │
│  • logs, errors, network, alerts        │  paired) │  • OS-level input: adb / XCUITest       │
│  • floating chat + inspect mode         │          │  • replayable test flows                │
└─────────────────────────────────────────┘          └─────────────────────────────────────────┘
```

It is a development and QA tool: release builds contain none of it (checked in CI), and the native module refuses to run in non-debuggable builds.

## What makes it different

Most mobile agents drive the app from outside, through screenshots or the accessibility tree. This one runs inside the app and reads React itself:

- **Inspect any element.** Tap it in inspect mode, or let the agent ask. You get the **file:line where its JSX is written** (mapped through Metro), the components that rendered it, props, handlers, layout style and accessibility. You also learn whether a real finger can reach it and, if not, **which view covers it and where that view is written**. When the source can't be mapped, it says why instead of guessing.
- **Audit a screen in milliseconds.** It flags covered or handler-less buttons, overlapping or tiny touch targets, missing accessibility labels, text outside its container or misaligned with its row, and errors and failed requests recorded on that screen.
- **Diagnose with source.** JS errors and failed requests come with the app code that threw or started them, plus the screen they happened on.
- **Honest interactions.** Every action reports how it was performed:

  | Mode | Meaning |
  |---|---|
  | `semantic` | A JS handler was invoked (iOS in-process taps, alert callbacks). Gated by a native hit-test, never presented as a finger touch |
  | `native` | A platform API on the view: typing, scrolling, Android dialog buttons |
  | `synthesized-touch` | Android: a MotionEvent dispatched through the app's own view hierarchy |
  | `os-injected` | Real OS input from outside the app: `adb` on Android, XCUITest (via Maestro) on the iOS simulator. Use `mode: "os"` or `--os-input` to require it |

- **Fast.** UI snapshots take 2–5 ms on device. Multi-step flows run on the device in one call, with event-driven settling and `expect` guards.
- **Tests from conversations.** Save what the agent just did as a replayable flow, with stable selectors, route expectations and no stored secrets. Replay it from the CLI, or export it to Maestro.

## Quick start (example app in this repo)

Requirements: macOS, Node ≥ 22.18, Xcode 26+, and Android SDK 35/36 with JDK 17. Yarn 4 is vendored.

```bash
node .yarn/releases/yarn-4.11.0.cjs install
(cd apps/example/ios && pod install)

node .yarn/releases/yarn-4.11.0.cjs server --repo apps/example   # terminal 1: devtools server
node .yarn/releases/yarn-4.11.0.cjs example start                 # terminal 2: Metro
node .yarn/releases/yarn-4.11.0.cjs example ios                   # terminal 3 (or: example android)
```

Tap the floating crosshair:

- **Inspect** works right away, with no model.
- **To chat,** connect a model (below). For UI work without any model, start the server with `--demo-agent`, a clearly labelled scripted assistant.

The demo login is any email plus `password123`. The **Debug playground** screen has deliberately broken things to investigate.

## Use it in your app

```bash
npm install --save-dev react-native-agent-devtools react-native-agent-devtools-server
cd ios && pod install            # then rebuild the app (Expo: development build, see below)
npx react-native-agent-devtools-server --repo .
```

```tsx
import { AgentDevTools } from 'react-native-agent-devtools';

export default function Root() {
  return (
    <AgentDevTools navigationRef={navigationRef /* optional, React Navigation */}>
      <App />
    </AgentDevTools>
  );
}
```

That's the whole integration: there's no per-element registration and no testIDs required.

- **Expo:** add `"react-native-agent-devtools"` to `plugins` in your app config and use a development build (`npx expo run:ios`). Expo Go cannot load the native module.
- **More detail:** see the [installation guide](docs/setup.md).

The packages are not published to npm yet; until then, use this monorepo.

## Connect a model

| Option | Uses | Command |
|---|---|---|
| **Your own Claude Code answers the in-app chat** | your existing Claude Code login (no API key) | `npx react-native-agent-devtools-server claude` |
| **Built-in agent** (Claude Agent SDK) | an Anthropic Console sign-in from the app ("Set up Claude"), or `--auth api-key` / `bedrock` / `vertex` / `foundry` | `npx react-native-agent-devtools-server --auth …` |
| **Claude Code in the terminal** drives the app | your Claude Code | `claude mcp add rn-agent -- npx react-native-agent-devtools-server mcp` |

Credentials are never picked up implicitly and never reach the app. A personal claude.ai subscription is never used by the built-in agent. See [security](docs/security.md).

The channel option uses Claude Code *channels*, a research preview. It needs Claude Code ≥ 2.1.234, and on company accounts an admin must enable channels.

## Documentation

- [Installation and setup](docs/setup.md): bare RN, Expo, simulators, physical devices, pairing, model options
- [Tools and API reference](docs/api.md): component props, agent tools, CLI, HTTP API, flow format
- [Claude Code / MCP integration](docs/mcp.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Architecture](docs/architecture.md) and [platform capability matrix](docs/capability-matrix.md)
- [Security and privacy](docs/security.md) · [Security policy](SECURITY.md)
- [Status, verified results, benchmarks and limitations](docs/STATUS.md)
- [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

## Packages

| Package | What it is |
|---|---|
| [`react-native-agent-devtools`](packages/react-native-agent-devtools) | The in-app library: provider, inspector, executor, collectors, chat and inspect UI, TurboModule (Swift/ObjC++, Kotlin), Expo config plugin |
| [`react-native-agent-devtools-server`](packages/devtools-server) | The local server: device bridge, chat backends, OS-level input, flows, MCP, CLI |
| [`react-native-agent-devtools-protocol`](packages/protocol) | Shared wire protocol, action and flow schemas, redaction rules |
| [`apps/example`](apps/example) | "SkyTrips" example app with an intentionally broken debug playground |

## License

MIT. See [LICENSE](LICENSE).

All bundled and transitive dependencies are permissively licensed (MIT, ISC, BSD), with one exception. The server depends on Anthropic's Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` and its platform binaries), which npm installs under [Anthropic's terms](https://code.claude.com/docs/en/legal-and-compliance), not an open-source license. This project does not include or redistribute it.

Not affiliated with or endorsed by Anthropic. "Claude" and "Claude Code" are Anthropic trademarks, used here to name the services the tool connects to.
