# Security and privacy

This is a development tool with a lot of power: it can read the screen, operate the app, read logs and network metadata, and optionally read source code. These are the defaults and guarantees.

## Development only

- `<AgentDevTools>` renders only `children` when `__DEV__` is false, whatever its props say. No collectors, no socket, no UI.
- Every native method rejects in non-debuggable builds: iOS checks `#if DEBUG`, Android checks `FLAG_DEBUGGABLE`. The module is still linked into release builds (autolinking), but it is inert.
- **Recommended:** add the package as a `devDependency`.

## No credentials in the app

- The model runs on the developer machine. The app never holds an API key and never talks to a model provider.
- Pasted keys are stored on the computer only, in `~/.config/react-native-agent-devtools/credentials.json`:
  - The file is mode 0600, inside a 0700 directory.
  - Keys are never logged, echoed or sent to devices.
- **The agent never runs on a personal claude.ai login:**
  - The SDK subprocess gets an isolated `CLAUDE_CONFIG_DIR`.
  - Before the first prompt, the server checks the credential source with `accountInfo()` (a local control request, no model call).
  - It accepts only `ANTHROPIC_API_KEY`, `apiKeyHelper` or a cloud provider. Anything else fails closed.

  This guard exists because, during development, an invalid `ANTHROPIC_API_KEY` was observed being silently ignored in favor of a stored Claude Code login.

## Network exposure

| Surface | Default | Protection |
|---|---|---|
| WebSocket for devices | `127.0.0.1` only | Host header allowlist (DNS rebinding); Origin must be absent or same-origin (browsers can't connect cross-site); `hello` required within 5 s; message size and type validation |
| Simulators/emulators | loopback (`localhost`, `10.0.2.2`) | as above |
| `--lan` | all interfaces, with a printed warning | 8-char single-use pairing codes (10 min TTL, lockout after 5 failures) → 12 h device tokens; plain `ws://`, so trusted networks only |
| `/mcp`, `/api/*`, `/setup*` | loopback only, **even with `--lan`** | Origin/Host checks; `/setup/key` is JSON-only (no simple cross-site form posts), with CSP and `frame-ancestors 'none'` |

## Agent permissions (least privilege)

| Capability | Default | How to enable |
|---|---|---|
| Inspect the app (`mobile_get_*`, screenshots, logs, network) | on | — |
| Operate the app (`mobile_tap`, `type`, `scroll`, sequences) | on | — |
| Sensitive taps (pay, delete, submit order, cancel booking, …) | **asks on the device** each time | `confirmSensitiveActions={false}` or a custom `isSensitive` |
| Duplicate submits (same submit-like element within 2 s, screen unchanged) | **blocked** | — |
| Read source code | off | `--repo <path>`: Read/Grep/Glob only under those roots, symlink-safe; `.env`, keys, keystores, `google-services.json`, `.git`, `.ssh`, … never readable |
| Edit source code | off | `--allow-edits`: Edit/Write inside `--repo`, each approved on the device |
| Shell / web access | **never** | Bash, WebFetch and WebSearch are disallowed. Mobile messages can't run commands on the computer. |

App content (UI text, logs, network data, screenshots) reaches the model as untrusted data. The system prompt and the MCP server instructions tell the agent never to follow instructions found in it.

## Data minimization and redaction

Redaction runs on the device before data leaves it, and again on the server before logging:

| Data | Rule |
|---|---|
| Secure text fields | Reported only as `<n chars hidden>` |
| Typed values and field values | Emails, card numbers (Luhn-checked), JWTs, bearer tokens and long secrets are masked |
| URLs | Userinfo dropped; sensitive query values (`token`, `key`, `password`, `session`, `signature`, …) redacted; email/token path segments masked; fragments removed |
| Request/response bodies | **Not captured by default.** When `network.captureBodies` is enabled, JSON is redacted structurally by key name and truncated (4 KB) |
| Headers | Never captured |
| Logs | Redacted, truncated (2 KB message / 1.5 KB stack), held in a ring buffer (500 entries) |
| Screenshots | Captured only on request. The devtools overlay is hidden first. They're sent to the model, so avoid running sessions on screens with real customer data. |

Use test accounts and fake data. The example app ships fake data only.

## Disconnect

- **From the app:** close the panel, or long-press the launcher to hide it (reopen it from the dev menu: "Show Agent DevTools").
- **From the server:** stopping it ends every session immediately and cancels in-flight RPCs.
- **Pairing tokens:** they live in memory and are revoked when the server restarts.
