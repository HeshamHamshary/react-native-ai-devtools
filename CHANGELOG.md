# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- In-app assistant for React Native development builds:
  - floating launcher and chat panel (streaming, tool rows with output previews and screenshot thumbnails, approvals, diagnostics, light/dark themes)
  - neutral crosshair branding
- Chat backends:
  - your own Claude Code session through a channel (`… claude`)
  - the built-in Claude Agent SDK agent (Console sign-in from the app, or `--auth api-key|bedrock|vertex|foundry`)
  - a scripted demo agent
- React-aware inspection:
  - tap any element (or let the agent ask) for the file:line of its JSX via Metro, the components that rendered it, props, handlers, style, accessibility, pointerEvents, hit-testing and the covering view's source
  - static findings
- Screen audit: covered/handler-less/disabled elements, overlapping and small targets, missing labels, text outside its container and row misalignment, and errors and failed requests on the screen.
- Diagnostics:
  - JS errors and request initiators mapped to app source lines
  - native logs (logcat / simulator unified log)
  - LogBox dismissal and keyboard dismissal
  - native alerts (Android native press; iOS semantic or OS-level)
- Automation:
  - automatic UI discovery
  - tap, long press, type, scroll, scroll-to, swipe, back, wait-for, on-device sequences with `expect` guards
  - OS-level input: adb on Android, XCUITest via Maestro on the iOS simulator; `mode: "os"` / `--os-input`, never a silent fallback
  - every result reports its interaction mode
- Replayable flows:
  - save what was done (stable selectors, route expectations, secrets as `${ENV}` placeholders)
  - replay with failure screenshots
  - export to Maestro
- Conversations resume after a JS reload or reconnect.
- Expo config plugin; CLI (`call`, `tool`, `flows`, `bench`, `devices`, `pair`, `unpair`, `token`, `login`, `logout`, `mcp`, `claude`); MCP over stdio and HTTP.
- CI: lint, typecheck, tests, build, release-bundle check, Android and iOS builds.

### Security

- Credentials for the built-in agent are chosen explicitly and must match exactly:
  - every `ANTHROPIC_*` / `CLAUDE*` variable is stripped from the agent's environment
  - an isolated Claude Code config directory is used
  - subscriptions are refused
  - no repo settings files are loaded
- The local API is token-authenticated.
- Pairing tokens are hashed and persisted. Only paired apps may approve edits or Claude Code permission prompts.
- The runtime is excluded from release bundles.
- Redaction catches well-known API key formats.
