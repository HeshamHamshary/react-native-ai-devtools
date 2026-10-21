# react-native-agent-devtools-server

Local bridge between apps running `react-native-agent-devtools` and Claude.

```bash
npx react-native-agent-devtools-server --repo .
```

- **In-app chat:** the Claude Agent SDK, one session per connected app.
  - Credentials: `ANTHROPIC_API_KEY`, a key pasted at `http://127.0.0.1:8765/setup` (the app's "Set up Claude" button opens it), or Bedrock/Vertex.
  - A personal claude.ai login is never used.
- **Claude Code:** `claude mcp add --transport http rn-agent http://127.0.0.1:8765/mcp`
- **CLI** (no model): `devices`, `call <method> [json] [--device ios|android]`, `bench`.
- **Security:** loopback by default; `--lan` adds pairing; control endpoints stay loopback-only. Repo access is read-only and allowlisted (`--repo`). There is no shell access.

Run `--help` for all flags. Details: [setup](../../docs/setup.md), [security](../../docs/security.md).
