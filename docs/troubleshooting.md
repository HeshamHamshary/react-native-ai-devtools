# Troubleshooting

## The app doesn't connect

- **"Native module RNAgentDevTools is not linked".** Rebuild the app after installing (`pod install`, then a full Xcode or Gradle build). Expo Go can't load native modules; use a development build.
- **The panel says it can't reach the server.**
  - **Simulator or emulator:** start the server on the same computer (`npx react-native-agent-devtools-server`). The app connects to the Metro host on port 8765.
  - **Android device over USB:** run `adb reverse tcp:8765 tcp:8765` (and `tcp:8081` for Metro).
  - **Phone on Wi-Fi:** start the server with `--lan`, then pair the app (menu → "Pair this app…", enter the code from the terminal). On iOS, allow the Local Network permission; the Expo plugin adds the description.
  - **Custom setups:** pass `serverUrl` to `<AgentDevTools>`.
- **"Pairing required" on a simulator.** The server runs with `--require-pairing`; enter the code from the server terminal.
- **`401` from the CLI or MCP.** The local token changed (`token --rotate`) or the server's state directory differs (`XDG_CONFIG_HOME`). Restart the server and Claude Code.

## The chat doesn't answer

- **"Model not set up".** Tap **Set up Claude** (Anthropic Console sign-in), start the server with `--auth …`, or run `npx react-native-agent-devtools-server claude`. For UI work, `--demo-agent` answers without a model.
- **"ANTHROPIC_API_KEY is set … but not used".** By design: pass `--auth api-key` to use it.
- **"expected Anthropic Console sign-in … but the agent would authenticate with …".** The credential source didn't match the mode you chose, so the agent refused rather than guess. Check `--auth` and your environment.
- **Claude Code channel: "No response from Claude Code yet".** Look at the Claude Code terminal:
  - The development-channel prompt is waiting for confirmation.
  - Channels are blocked by org policy (an Owner must enable them).
  - Claude Code is older than 2.1.234 (`claude update`).

## Actions fail or look wrong

- **`NOT_HITTABLE … covered by …`.** A real finger would hit that view. That's often the bug: `mobile_inspect` shows the covering view's source line. `mode: "semantic"` calls the handler anyway, and is reported as such.
- **"covered by another window or non-React view".** A dialog, the keyboard, LogBox or system UI is on top. `mobile_dismiss_logbox` / `mobile_dismiss_keyboard` / `mobile_alert` handle the common cases.
- **`UNSUPPORTED: no OS-level input for this device`.**
  - **Android:** adb must see the device, so check `ANDROID_HOME` and `adb devices`.
  - **iOS simulator:** install Maestro (Apache-2.0, https://maestro.dev).
  - **Physical iPhones:** not supported for OS-level input.
- **The first OS-level action on iOS takes ~10 s.** Maestro starts its XCUITest driver once per server run; later actions take about 1 s.
- **Source shows "unavailable".** The note says why:
  - The Metro URL is unknown.
  - React skipped creation stacks during a large render burst (inspect again).
  - Every creation site is in `node_modules`.

## Slow Android numbers

The default "Medium Phone" AVD has 2 GB of RAM and swaps heavily with a debug RN app. Use a 4 GB+ AVD when measuring. Typing through `adb input text` can drop characters when the app's JS thread is starved; the in-app `native` typing mode is unaffected.

## Yarn says the project is part of another project

A `package.json` or `yarn.lock` in a parent directory confuses Yarn. Keep an empty `yarn.lock` in your app root (this repo does).
