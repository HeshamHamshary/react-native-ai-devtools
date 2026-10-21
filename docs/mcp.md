# Claude Code and MCP

Two ways to use the tools from Claude Code. Both run on your own Claude Code login; the devtools server holds no model credentials for them.

## 1. In-app chat answered by your Claude Code (channel)

```bash
npx react-native-agent-devtools-server           # terminal 1
npx react-native-agent-devtools-server claude    # terminal 2: starts Claude Code with the app chat connected
```

Messages typed in the app arrive in that Claude Code session with a screen snapshot, plus the element you picked when you used inspect mode. Claude answers in the app through a `reply` tool and works with the same `mobile_*` tools.

- **Requirements:** Claude Code ≥ 2.1.234 (channels are a research preview). On Team and Enterprise accounts an Owner must enable channels (Organization settings → Claude Code → Channels). Don't work around that policy.
- **What the launcher does:** it registers a stdio bridge for the project (`claude mcp add rn-agent -s local`), then starts `claude --dangerously-load-development-channels server:rn-agent --allowedTools mcp__rn-agent`. Only the bridge it starts carries the chat; other Claude Code sessions in the project get the tools only.
- **Permission prompts** are relayed only to a **paired** app. Unpaired apps are told to answer in the terminal.
- **Stop** in the app tells Claude Code to stop and blocks app actions until your next message.

## 2. Claude Code in the terminal drives the app (MCP)

```bash
claude mcp add rn-agent -- npx react-native-agent-devtools-server mcp
```

`mcp` is a small stdio MCP server. It reads the local API token from `~/.config/react-native-agent-devtools/server-token` itself, so no secret ends up in Claude Code's config. It acts on the app you last chatted from, else the most recently connected one.

Prefer HTTP? The server also exposes Streamable HTTP at `/mcp`, and it needs the token:

```bash
claude mcp add --transport http rn-agent http://127.0.0.1:8765/mcp \
  --header "Authorization: Bearer $(npx react-native-agent-devtools-server token)"
```

The token is stable across server restarts. `token --rotate` replaces it, and then you must update that config.

## What Claude gets

The tools in the [API reference](api.md#agent-tools), plus server instructions that explain the debugging workflow:

- `mobile_inspect` / `mobile_audit_screen` first
- source lines on errors and requests
- interaction modes
- app content treated as untrusted data

Typical prompts:

- "Log in with the demo account and open my booking."
- "Why doesn't the Claim promo button work?" Claude inspects it, finds the covering view and its file:line, and with `--repo` proposes a fix.
- "Check this screen for bugs."
- "Save what you just did as a test called login", then later "run the login flow".

## Other MCP clients

Anything that speaks MCP can use either the stdio command or the HTTP endpoint with the bearer token. Tool schemas are zod-defined and provider-neutral.
