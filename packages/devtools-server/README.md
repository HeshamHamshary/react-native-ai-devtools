# react-native-agent-devtools-server

Local server for apps running [`react-native-agent-devtools`](../react-native-agent-devtools). It connects the app to a coding agent and gives that agent `mobile_*` tools.

```bash
npx react-native-agent-devtools-server --repo .
```

- **In-app chat**, with one of:
  - your own Claude Code (`… claude`, using Claude Code channels)
  - the built-in Claude Agent SDK agent, with credentials chosen explicitly (`--auth console|api-key|bedrock|vertex|foundry`)

  A personal claude.ai login is never used by the built-in agent.
- **Claude Code in the terminal:** `claude mcp add rn-agent -- npx react-native-agent-devtools-server mcp`.
- **Tools:** inspection with source locations, screen audits, actions with change reports, logs and network traffic, screenshots, native alerts, and replayable flows.
- **OS-level input** (optional): `adb` on Android, and XCUITest through a local Maestro on the iOS simulator.
- **CLI without a model:** `devices`, `call`, `tool`, `flows`, `bench`, `pair`, `unpair`, `token`.
- **Security:**
  - Loopback by default, with a bearer token for control endpoints.
  - `--lan` requires pairing, and control endpoints stay loopback-only.
  - Repo access is read-only and allowlisted (`--repo`), with no shell.

Run `--help` for all flags. Details: [setup](../../docs/setup.md), [API reference](../../docs/api.md), [security](../../docs/security.md).

Depends on `@anthropic-ai/claude-agent-sdk`, which npm installs under Anthropic's terms, not an open-source license. See the [root README](../../README.md#license).
