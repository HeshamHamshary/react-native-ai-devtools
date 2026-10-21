# Security and privacy

This is a development tool with a lot of power. It can read the screen, operate the app, read logs and network metadata, and optionally read source code. This page describes the guarantees, the threat model and how each guarantee is tested.

## Threat model

| Party | Trusted? | What stops it |
|---|---|---|
| The developer at the computer | yes | — |
| Processes running as the developer's OS user | yes (they could read your files anyway) | — |
| Web pages in any browser | **no** | Host and Origin checks on every request and socket (DNS-rebinding safe) |
| Other machines on the network | **no** | Loopback bind by default. With `--lan`, devices must pair and control APIs stay loopback-only. |
| Other OS users, sandboxed processes, other apps inside a simulator/emulator (they can all reach `127.0.0.1`) | **no** | The local API needs the token from a 0600 file. They can connect as a device, but an unpaired device cannot approve anything. Use `--require-pairing` on shared machines. |
| Content inside the app (UI text, logs, network data) | **no** | Labelled untrusted for the model; never followed as instructions |
| A repository opened with `--repo` | partly | Read access only. Settings files, hooks and env are never loaded. |

## Development only

- **Release bundles contain none of the runtime.** The package entry requires the runtime only when `__DEV__` is true. Metro folds `__DEV__` to false in release builds and drops the branch before it resolves dependencies, so the socket, collectors, inspector and UI are not in the bundle at all.
  - `yarn check:release-bundle` builds the example app with Metro in both modes. It fails if runtime code appears in the release bundle, and also fails if it is missing from the dev bundle, so the check can't pass vacuously.
  - It caught the previous entry point shipping about 250 KB of runtime code into every release bundle (inert, but present).
- `<AgentDevTools>` also checks `__DEV__` at render time.
- **Every native method rejects in non-debuggable builds:** iOS checks `#if DEBUG`, Android checks `FLAG_DEBUGGABLE`. The native module is still autolinked into release builds, but it is inert.
- **Recommended:** add the package as a `devDependency`.

## Credentials for the in-app agent

The app never holds a credential and never talks to a model provider. The model runs on the developer's computer.

### Explicit choice, never ambient

The agent runs only on credentials the developer chose:

| `--auth` | Source | Verified as |
|---|---|---|
| *(none)* | A Console sign-in completed with "Set up Claude" or `react-native-agent-devtools-server login` | `apiKeySource: "/login managed key"` |
| `console` | same | same |
| `api-key` | `ANTHROPIC_API_KEY` in the server's environment | `apiKeySource: "apiKeyHelper"` (see below) |
| `bedrock` / `vertex` / `foundry` | `CLAUDE_CODE_USE_*=1` and that provider's credentials | `apiProvider` equals the mode |

- **An `ANTHROPIC_API_KEY` in your shell is never used unless you pass `--auth api-key`.** The banner tells you it was ignored. The same applies to `CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY`.
- **Exact match or nothing.** Before the first prompt, the server asks Claude Code which credentials it would use. This is `accountInfo()`, a local control request with no model call.
  - The answer must match the chosen mode exactly. Anything else is treated as ambiguous and the agent refuses to start.
  - Anything reporting a claude.ai subscription is refused in every mode, because Anthropic's terms don't allow products built on the Agent SDK to use one.
- **Mid-session rejection.** If the API rejects the credentials mid-session (a revoked key, an expired sign-in), the agent turns off and the app shows "Set up Claude" again.

### Isolation of the agent's Claude Code process

- **Its own config directory.** Every Claude Code process the server starts (sessions, sign-in, status) uses `CLAUDE_CONFIG_DIR=~/.config/react-native-agent-devtools/claude` (mode 0700), so your own `~/.claude` login, settings, plugins and hooks are invisible to it.
  - That directory's settings pin sign-in to the Anthropic Console (`forceLoginMethod: "console"`).
  - Your organization's managed settings still apply.
  - `ant` CLI profiles are hidden.
- **Every `ANTHROPIC_*`, `CLAUDE*` and `AWS_BEARER_TOKEN_*` variable is removed from its environment**, then only the chosen mode's variables are added back.
  - It matches by prefix, so new credential variables are covered automatically. Claude Code 2.1.306 reads more than 30 of them, including `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_SESSION_ACCESS_TOKEN`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and `CLAUDE_CODE_USE_GATEWAY`.
  - Nonessential traffic (telemetry, error reporting, auto-update) is disabled for that process.
- **API keys reach the agent through a helper.** With `--auth api-key`, the key goes to the agent under a private variable name and is read by an `apiKeyHelper` flag setting (`printf '%s' "$RNAD_AGENT_API_KEY"`).
  - This is the path Claude Code honours for non-interactive sessions. It ignores an `ANTHROPIC_API_KEY` it has not been told to trust; see the incident below.
- **No settings files.** `settingSources: []` always.
  - `--project-instructions` adds the repo's `CLAUDE.md` to the prompt as text. Settings files from a repository could otherwise run hooks, set `env` (for example `ANTHROPIC_BASE_URL`, which would send your key elsewhere) or define a credential helper.
- **Where the credential lives.** The Console sign-in's key is stored where Claude Code stores its own login (on macOS, the Keychain, in an entry scoped to the agent's config directory).
  - The server never reads, logs or sends a credential. Devices only learn the source's name ("Anthropic Console sign-in").
- **Tests:** `src/agent/auth.test.ts`. They include two that run the real bundled Claude Code binary with no login and no prompt.

### Incident: the in-app agent ran on the developer's Claude Code login (2026-10-21)

**What happened.** To test error handling, a second server was started with a deliberately invalid `ANTHROPIC_API_KEY`. A fake device sent "What screen am I on?". The agent answered correctly: 1 turn, 0 tool calls, `claude-opus-5-5`, 3.7 s of API time. A key that cannot authenticate could not have produced that answer.

| Question | Finding |
|---|---|
| **Which credential was used?** | The developer's stored Claude Code login: the default config directory and its macOS Keychain entry, which the agent's process could see because it had no isolated `CLAUDE_CONFIG_DIR` then. No credential environment variable was set; only this Claude Code session's own plumbing variables (names checked, values not read). `accountInfo()` was not recorded for that run, so whether the login is a claude.ai organization seat or a Console login is not known. The credential store was deliberately not inspected to find out. |
| **Why didn't the invalid key fail immediately?** | Claude Code only uses an `ANTHROPIC_API_KEY` it has been told to trust (the binary checks `customApiKeyResponses.approved`). The dummy key was never approved, so Claude Code fell through to its stored login and never sent the key at all. The server then had no pre-flight check of the credential source. Reproduced against 2.1.306 without any prompt: an unapproved key in an empty config directory reports `tokenSource: "none"`. |
| **Was anything billed?** | The `$0.0496` shown was Claude Code's client-side estimate (`total_cost_usd`, tokens × list price), not an invoice. The request counted as usage of the developer's own login. Whether it produced a charge depends on that account's plan (for an organization seat, for example, extra-usage settings), which only the account's admin can see. No further model calls were made. |
| **Were credentials exposed?** | No. The token was read only by the Claude Code subprocess itself. The server's log of that run contains the banner, the chat line and the cost estimate, with no credential. The app received only chat text and timing. The dummy key was never printed. |
| **Is it prevented now?** | Yes, by independent layers. The agent's process gets an isolated config directory, so your login is not visible. Ambient credential variables are stripped. The mode is chosen explicitly. The reported source must match that mode exactly. Subscriptions are refused. A regression test runs the real binary with a shell API key: Console mode is refused (`"none"`) and `--auth api-key` reports `apiKeyHelper`. |

The previous fix (an allowlist of acceptable sources) was safe, but it never actually made `ANTHROPIC_API_KEY` work: the key was ignored, so the gate always refused. The apiKeyHelper path fixes that.

## The local server

| Surface | Default | Protection |
|---|---|---|
| Device WebSocket | `127.0.0.1` only | Host allowlist (DNS rebinding); Origin must be absent or same-origin; `hello` within 5 s; size and type validation |
| Simulators/emulators | loopback (`localhost`, `10.0.2.2`) | as above; they connect without pairing unless `--require-pairing` |
| `--lan` (physical devices) | all interfaces, with a printed warning | Pairing required; see below. Plain `ws://`, so trusted networks only. |
| `/mcp`, `/api/*` | loopback only, **even with `--lan`** | `Authorization: Bearer <token>` from `~/.config/react-native-agent-devtools/server-token` (0600, 256-bit, stable across restarts; `token --rotate` replaces it). `/health` returns only `ok` and `version`. |
| `/channel` (Claude Code bridge) | loopback only, **even with `--lan`** | Same token. Only the bridge started by the `claude` launcher (which arms the server just before) carries the app chat; other bridges get tools only. |
| Sign-in | started only by a connected device's `setup.open` | Runs on the computer; one attempt at a time, 10-minute timeout, cancelled on shutdown |

**Claude Code integration.** `claude mcp add rn-agent -- npx react-native-agent-devtools-server mcp` starts a stdio MCP server that reads the token file itself, so the token never appears in Claude Code's config. HTTP MCP still works but needs the header (`token` prints it).

### Pairing and trust

- A device pairs by entering an 8-character code from the server terminal. The code is single-use, expires after 10 minutes, and locks out after 5 failures.
- In return it gets a device token, stored on the device in the Keychain (this device only) on iOS and in app-private SharedPreferences on Android. It survives reloads, restarts and server restarts.
- The server stores only SHA-256 hashes of device tokens (`paired-devices.json`, 0600, 30-day expiry). `unpair` revokes all of them.
- **Only paired devices may approve.** That covers code edits from the in-app agent and Claude Code permission prompts relayed through the channel.
  - An unpaired app is told why it was declined, and Claude Code's own terminal prompt still decides.
  - Without this rule, anything that can open a socket to `127.0.0.1` could approve commands in your Claude Code session.
- **Physical devices must pair.** On the LAN (`--lan`) pairing is required. With `--require-pairing` it's required for every device.
- Tests are in `src/server.test.ts` (token, persistence, hashing, revocation, `--require-pairing`, approvals) and `src/channel/channel.test.ts` (relay on unpaired versus paired apps).

## Chat through your own Claude Code (channels)

- The model runs inside your Claude Code session, on its own login. The devtools server and the bridge hold no credentials and never call a model.
- The launcher pre-allows only the bridge's tools (`--allowedTools mcp__rn-agent`). Everything else follows your normal Claude Code permissions.
- Permission prompts are relayed only to paired apps; see Pairing and trust.
- On-device safeguards still apply: confirmation of sensitive taps and the duplicate-submit guard.
- **Stop:** pressing Stop tells Claude Code to stop, and the bridge refuses app actions until your next message.
- **Untrusted content:** messages carry a screen snapshot that the bridge's instructions label as untrusted data.
- **Organization policy:** company-managed accounts need channels enabled by an Owner. Don't work around that policy.

## Agent permissions (least privilege)

| Capability | Default | How to enable |
|---|---|---|
| Inspect the app (`mobile_get_*`, screenshots, logs, network) | on | — |
| Operate the app (`mobile_tap`, `type`, `scroll`, sequences) | on | — |
| Sensitive taps (pay, delete, submit order, cancel booking, …) | **asks on the device** each time | `confirmSensitiveActions={false}` or a custom `isSensitive` |
| Duplicate submits (same submit-like element within 2 s, screen unchanged) | **blocked** | — |
| Read source code | off | `--repo <path>`: Read, Grep and Glob only under those roots, symlink-safe. `.env`, keys, keystores, `google-services.json`, `.git`, `.ssh`, … are never readable, enforced by a path check and by Claude Code `Read(...)` deny rules (which also cover Grep). |
| Edit source code | off | `--allow-edits`: Edit/Write inside `--repo`, each approved on a **paired** device |
| Shell / web access | **never** | Bash, WebFetch and WebSearch are disallowed. Mobile messages can't run commands on the computer. |

App content (UI text, logs, network data, screenshots) reaches the model as untrusted data. The system prompt and the MCP server instructions tell the agent never to follow instructions found in it.

## Data minimization and redaction

Redaction runs on the device before data leaves it, and again on the server before logging:

| Data | Rule |
|---|---|
| Secure text fields | Reported only as `<n chars hidden>` |
| Typed values and field values | Emails, card numbers (Luhn-checked), JWTs, bearer tokens, well-known API key formats (`sk-ant-…`, `ghp_…`, `AKIA…`, …) and long secrets are masked |
| URLs | Userinfo dropped; sensitive query values (`token`, `key`, `password`, `session`, `signature`, …) redacted; email and token path segments masked; fragments removed |
| Request/response bodies | **Not captured by default.** When `network.captureBodies` is on, JSON is redacted structurally by key name and truncated (4 KB). |
| Headers | Never captured |
| Logs | Redacted, truncated (2 KB message / 1.5 KB stack), held in a ring buffer (500 entries) |
| Screenshots | Captured only on request. The devtools overlay is hidden first. They're sent to the model, so avoid running sessions on screens with real customer data. |
| Server logs | Chat text is redacted before logging. A test starts the server with an API key and checks that neither the logs nor anything sent to the device contains it. |

Use test accounts and fake data. The example app ships fake data only.

## Disconnect and revoke

- **From the app:** close the panel, or long-press the launcher to hide it.
- **From the server:** stopping it ends every session immediately and cancels in-flight RPCs.
- `react-native-agent-devtools-server unpair` revokes every paired device.
- `token --rotate` replaces the local API token (restart the server and Claude Code afterwards).
- `logout` removes the agent's Console sign-in.

## Known limitations

- `--lan` uses plain `ws://`. Use it only on networks you trust; pairing protects against unauthorized control, not eavesdropping.
- Unpaired loopback devices can still chat and run read and app-control tools on themselves. That is the point of the tool, but on a shared machine use `--require-pairing`.
- `ANTHROPIC_BASE_URL`, gateways and `ANTHROPIC_AUTH_TOKEN` are not supported for the in-app agent (they are stripped). Use Claude Code itself (channels or MCP) behind a gateway.
- The `apiKeyHelper` runs through `/bin/sh`, so `--auth api-key` is supported on macOS and Linux.
