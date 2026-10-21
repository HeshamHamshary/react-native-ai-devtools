# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately, not in public issues. Use GitHub's "Report a vulnerability" (Security → Advisories) on this repository, or email the maintainer listed in the repository profile. Include steps to reproduce and the affected version or commit.

You'll get an acknowledgement within a few days. Fixes for confirmed issues are released before details are made public.

## Supported versions

The project is pre-1.0; only the latest commit on the default branch is supported.

## Scope

In scope:

- the device bridge and its pairing
- the local HTTP/WebSocket API and its token
- credential handling for the built-in agent
- repository access for the agent
- redaction
- the Claude Code channel bridge
- anything that could let a web page, another machine, another OS user or an unpaired app control the app or approve actions

The design and its guarantees are documented in [docs/security.md](docs/security.md).

Out of scope:

- vulnerabilities in the apps you debug
- Anthropic's models and services
- the Claude Agent SDK and Claude Code themselves (report those to Anthropic)

## Using it safely

- It's a development tool: never ship it in production. Release bundles exclude it automatically, and CI checks that.
- Use `--lan` only on networks you trust, and `--require-pairing` on shared machines.
- Don't point the agent at screens with real customer data; screenshots and UI text are sent to the model.
