# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned

- `daemon` mode (systemd / launchd / Windows service) with start-on-boot.
- Self-update from the release channel.

## [0.1.0] - 2026-10-22

### Added

- `agent-bridge status` — probes 11 AI coding CLIs (Claude Code, Codex, DeepSeek Harness, Gemini CLI,
  opencode, Mimo Code, Qoder CLI, Grok CLI, Kimi Code, MiniMax Code, Trae CLI) and reports
  `ready` / `no credentials` / `not installed`, plus a `broken` flag when a binary exists but cannot run.
  Includes a 30-second cache with `--fresh` and machine-readable `--json` output.
- `agent-bridge connect <platformUrl>` — binds this machine over an outbound WebSocket. Authorization uses
  a loopback callback with PKCE S256 and reuses the existing browser session; `--no-browser` falls back to
  a device code, `--token` accepts a pre-issued device token.
- `agent-bridge logout` — clears local device credentials.
- WebSocket transport with bearer handshake, 15 s heartbeat, exponential backoff (1 s → 30 s), buffered
  status messages replayed after reconnect, and no reconnect loop once a device is revoked.
- Task execution with an adapter whitelist, argument arrays (no shell interpolation), working-directory
  validation, per-task timeout, graceful cancel (`SIGTERM` → 2 s → `SIGKILL`) and 4 KB log chunks.
- Protocol v1 with runtime validation. Bridge → platform: `hello`, `agent_list`, `scan_result`,
  `task_log`, `task_status`, `pong`. Platform → bridge: `run_task`, `cancel_task`, `scan`, `ping`.
- Configuration at `~/.agent-bridge/config.toml` (`%APPDATA%\agent-bridge\config.toml` on Windows) with
  `0600` permissions and token redaction in all output.
- Windows support for `.cmd` / `.bat` shims through an explicitly quoted command line.
- Unit tests covering protocol validation, log chunking, PKCE shape, the adapter registry and command-line
  quoting.

### Security

- API keys and credential files are never read or uploaded; only their presence is reported.
- The authorization callback listens on `127.0.0.1` only, accepts a single request, and authorization
  codes are single-use with PKCE S256 verification.

[unreleased]: https://github.com/shaylanwu/agent-bridge/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/shaylanwu/agent-bridge/releases/tag/v0.1.0
