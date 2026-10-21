# Contributing

## Setup

```bash
node .yarn/releases/yarn-4.11.0.cjs install       # Yarn 4 is vendored; corepack also works
(cd apps/example/ios && pod install)
```

Run the example app the way the [README](README.md#quick-start-example-app) describes. For UI work without model credentials, start the server with `--demo-agent`. Its replies are scripted and labelled, and it calls real device tools.

## Checks

```bash
node .yarn/releases/yarn-4.11.0.cjs typecheck
node .yarn/releases/yarn-4.11.0.cjs test       # protocol + server (node:test), runtime (jest)
node .yarn/releases/yarn-4.11.0.cjs build
```

Native changes: build the example on both platforms.

```bash
cd apps/example/ios && xcodebuild -workspace AiDevtoolsExample.xcworkspace -scheme AiDevtoolsExample -sdk iphonesimulator build
cd apps/example/android && ./gradlew :app:assembleDebug
```

Drive the running app without a model:

```bash
cd packages/devtools-server
node --conditions=react-native-agent-devtools-source src/cli.ts call getUI '{"bounds":true}' --device ios
node --conditions=react-native-agent-devtools-source src/cli.ts bench --device android
```

## Ground rules

- **Never mislabel an interaction.** If an action took a shortcut, its result must say so (`mode`, `warnings`). Never fall back to a different mode silently.
- **Public platform APIs only** in native code. No private UIKit/XCTest APIs in-process.
- **Privacy:**
  - Redact before data leaves the device.
  - New collectors must be bounded (ring buffers) and must chain existing handlers.
- **Server security:**
  - Control endpoints stay loopback-only.
  - New device messages need validation in `packages/protocol` and a test.
- **Agent credentials:** never add a path that lets the agent run on a personal claude.ai login.
- **Licenses:** don't copy code from projects with incompatible licenses. See [docs/competitive-architecture-review.md](docs/competitive-architecture-review.md#4-license-and-reuse-considerations).
- **Commits:** small and per module, with what changed and how it was verified.
