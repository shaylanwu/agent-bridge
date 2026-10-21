# agent-bridge-service

Bridge the AI coding CLIs installed on your machine to a remote orchestration platform — over a single
outbound WebSocket. No inbound ports, no reverse tunnels, no API keys leaving the host.

**English** · [简体中文](README.zh-CN.md)

---

## Overview

AI coding CLIs (Claude Code, Codex, Gemini CLI and friends) live on developers' laptops. A web platform
cannot inspect them: browsers are sandboxed and have no access to `PATH`, executable files or credential
stores. And a platform hosted elsewhere cannot reach a laptop behind NAT.

`agent-bridge-service` closes that gap. It runs on the machine that owns the CLIs, keeps an outbound
WebSocket to the platform, and answers three questions the platform can never answer on its own:

1. **What is installed here?** — a real probe of the local `PATH` and common install locations.
2. **Is it actually usable?** — distinguishes “installed”, “installed but missing credentials” and
   “installed but broken”.
3. **Can you run this for me?** — executes a whitelisted CLI in a guarded working directory and streams
   the output back in real time.

The package is self-contained: its only runtime dependencies are `ws` and `smol-toml`, and it speaks a
small JSON protocol over HTTP + WebSocket.

## Features

- **11 built-in adapters** — Claude Code, Codex, DeepSeek Harness, Gemini CLI, opencode, Mimo Code,
  Qoder CLI, Grok CLI, Kimi Code, MiniMax Code, Trae CLI.
- **Three-state probing** — `ready` / `installed without credentials` / `not installed`, plus a
  `broken` flag when a binary exists but cannot execute (`--version` fails).
- **Zero inbound network** — the bridge dials out; the platform never connects into your network.
- **Binding without copy-pasting tokens** — localhost callback + PKCE S256, reusing the browser session
  you already have. Device-code fallback for SSH/headless machines, `--token` for CI.
- **Guarded execution** — adapter whitelist, argument arrays (never a shell string), working-directory
  validation, per-task timeout, graceful cancel (`SIGTERM` → 2 s → `SIGKILL`).
- **Streaming logs** — output is chunked at 4 KB and forwarded as it is produced; finished runs can be
  replayed from the platform's history.
- **Resilient connection** — 15 s heartbeat, exponential backoff (1 s → 30 s), buffered status messages
  replayed after reconnect.
- **Secrets stay put** — the bridge never reads or uploads API keys or credential files; it only reports
  whether they exist.

## Installation

```bash
npm install -g agent-bridge-service
```

Requirements: **Node.js ≥ 20** on macOS, Linux or Windows.

From source:

```bash
git clone https://github.com/shaylanwu/agent-bridge.git
cd agent-bridge
npm ci
npm run build
npm link            # exposes the `agent-bridge` command
```

## Usage

```bash
# Bind this machine and keep the connection open (opens a browser to approve)
agent-bridge connect https://platform.example.com

# Headless / SSH: print a device code instead of opening a browser
agent-bridge connect https://platform.example.com --no-browser

# CI or scripted setup: use a device token issued by the platform
agent-bridge connect https://platform.example.com --token=<device-token>

# Inspect the local toolchain only (no connection required)
agent-bridge status
agent-bridge status --json --fresh     # --fresh bypasses the 30 s cache

# Remove the local device credentials
agent-bridge logout
```

Example `status` output:

```
Tool                Version              Status
──────────────────────────────────────────────────────────
Claude Code         2.1.282              ready
Codex               0.163.0              ready
DeepSeek Harness    0.1.5-rc.3           ready
Gemini CLI          0.64.0               no credentials
opencode            1.19.3               no credentials
Qoder CLI           1.1.75               ready
MiniMax Code        -                    broken
Kimi Code           -                    not installed

11 tools scanned, 4 usable
```

Configuration lives in `~/.agent-bridge/config.toml` (Windows: `%APPDATA%\agent-bridge\config.toml`)
with `0600` permissions. The device token is never printed in full.

## Security boundaries

| Concern                | Behaviour                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------- |
| API keys / credentials | Never read, never uploaded. Only “present / absent” is reported.                       |
| What can be executed   | Whitelisted agent kinds only; an unknown `agentType` is rejected locally.              |
| How it is executed     | Argument arrays, no shell interpolation (Windows `.cmd` shims are quoted explicitly).  |
| Where it runs          | `cwd` must exist and be a directory; an optional allow-list confines it further.       |
| Runaway processes      | Every task has a timeout; cancel sends `SIGTERM`, then `SIGKILL` after 2 s.            |
| Transport              | `wss://` only; handshake authenticated with `Authorization: Bearer <device_token>`.    |
| Token storage          | `0600` file in the user's home; the platform stores only a SHA-256 hash.               |
| Revocation             | A revoked device is rejected on the next handshake (`4401`/`4403`, no reconnect loop). |

The bridge holds no privileges beyond the OS user that started it, and it never opens a listening port
except the short-lived `127.0.0.1` callback used during authorization.

## Architecture

```
┌──────────────────────────┐          outbound WSS           ┌────────────────────────┐
│  Your machine            │  ───────────────────────────▶   │  Orchestration platform│
│                          │                                 │                        │
│  agent-bridge            │  ◀── run_task / cancel / scan ──│  device registry       │
│   ├─ auth   (PKCE)       │  ─── hello / agent_list / ───▶  │  task dispatch         │
│   ├─ scan   (adapters)   │      task_log / task_status     │  log storage           │
│   ├─ runner (spawn)      │                                 │                        │
│   └─ config (~/.agent-…) │  optional: 127.0.0.1 callback   │                        │
└──────────────────────────┘  (authorization only)           └────────────────────────┘
            │
            └── spawns ──▶ claude / codex / dsh / gemini / …  (the user's own CLI and credentials)
```

| Module                  | Responsibility                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `src/cli.ts`            | Command surface (`connect` / `status` / `logout` / `daemon`), wiring, terminal output |
| `src/auth.ts`           | Localhost callback server, PKCE S256, token exchange, device-code fallback            |
| `src/config.ts`         | `config.toml` read/write with `0600`, token redaction                                 |
| `src/bridge-client.ts`  | WebSocket client: handshake auth, heartbeat, backoff, offline queue                   |
| `src/scan.ts`           | Probe orchestration with a 30 s cache                                                 |
| `src/agent-adapters.ts` | Adapter table, binary resolution, version and credential probing                      |
| `src/runner.ts`         | Task lifecycle: validation, spawn, log chunking, cancel, timeout                      |
| `src/win-exec.ts`       | Correct quoting for Windows `.cmd` / `.bat` shims                                     |
| `src/protocol.ts`       | Wire types, runtime validation, 4 KB log chunking                                     |

Protocol (JSON over one connection):

| Direction         | Messages                                                                |
| ----------------- | ----------------------------------------------------------------------- |
| bridge → platform | `hello`, `agent_list`, `scan_result`, `task_log`, `task_status`, `pong` |
| platform → bridge | `run_task`, `cancel_task`, `scan`, `ping`                               |

## Examples

**Bind a laptop and confirm the device is online**

```bash
$ agent-bridge connect https://platform.example.com
[agent-bridge] starting device authorization…
[agent-bridge] browser opened; if nothing happens, visit:
  https://platform.example.com/bridge/authorize?code_challenge=…
device bound: bd_9f1c…  (credentials written to ~/.agent-bridge/config.toml)
[agent-bridge] connected
[agent-bridge] reported 11 tools, waiting for tasks…
```

**Scan without connecting** (useful when filing a support ticket)

```bash
$ agent-bridge status --json | jq -r '.agents[] | select(.status=="ready") | .display'
Claude Code
Codex
DeepSeek Harness
```

**Let the platform run a task on this machine**

The platform sends:

```json
{
  "type": "run_task",
  "taskId": "bt_7f3a",
  "agentType": "codex",
  "cwd": "/Users/me/work/api",
  "prompt": "fix the failing login test"
}
```

The bridge validates the adapter and directory, spawns the CLI, and streams:

```json
{ "type": "task_log",    "taskId": "bt_7f3a", "stream": "stdout", "data": "…", "isAnsi": true }
{ "type": "task_status", "taskId": "bt_7f3a", "status": "success", "exitCode": 0 }
```

**Unbind the machine**

```bash
$ agent-bridge logout
local device credentials cleared (bd_9f1c…)
```

## Development

```bash
npm ci
npm run build         # tsc → dist/
npm test              # unit tests (protocol, quoting, probing)
npm run typecheck
npm run dev status    # run TypeScript directly via tsx
npm start             # build, then run dist/ (same as a global install)
```

Project layout:

```
src/
  cli.ts               command surface
  auth.ts              authorization flows
  config.ts            local persistence
  bridge-client.ts     websocket transport
  scan.ts              probe orchestration
  agent-adapters.ts    adapter table + probing
  runner.ts            task execution
  win-exec.ts          windows shim quoting
  protocol.ts          wire protocol
test/
  bridge.test.ts       unit tests
```

Adding an adapter: append one entry to `AGENTS` in `src/agent-adapters.ts` (binary name, display name,
capability, task argument template, credential signals). No transport or scheduling changes are needed.

## License

Apache-2.0
