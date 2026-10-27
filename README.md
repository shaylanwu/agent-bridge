# agent-bridge-service

Give a remote orchestration platform control of the AI agents installed on your machine — over a single
outbound WebSocket. No inbound ports, no reverse tunnels, no API keys leaving the host.

**English** · [简体中文](README.zh-CN.md)

📚 **Documentation site (EN / 中文, with full-text search): <https://shaylanwu.github.io/agent-bridge/>**
— protocol reference, CLI reference, and two integration guides (platform builders / local programs).
Built from the same machine-readable contracts, so it cannot drift from the code.

---

## Overview

AI coding agents (Claude Code, Codex, Gemini CLI and friends) live on developers' laptops. A web platform
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

- **12 built-in adapters** — Claude Code, CodeBuddy CLI, Codex, DeepSeek Harness, Gemini CLI, opencode, Mimo Code,
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
- **Terminal task board** — `connect` / `serve` show a resident status table in a TTY (four-state dots,
  current step per task, elapsed, capacity water level); task logs never scroll the main window. Per-task
  logs live behind a button in the Web dashboard (address printed when `serve` starts the control plane),
  streamed live over SSE while a task is running.
- **Secrets stay put** — the bridge never reads or uploads API keys or credential files; it only reports
  whether they exist.

## Installation

```bash
npm install -g agent-bridge-service
```

Requirements: **Node.js 24.x** on macOS, Linux or Windows.

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
# A stable ID must come from local state, --device-id, or AGENT_BRIDGE_DEVICE_ID
agent-bridge connect https://platform.example.com --token=<device-token> --device-id=<device-id>

# Inspect the local toolchain only (no connection required)
agent-bridge status
agent-bridge status --json --fresh     # --fresh bypasses the 30 s cache

# Remove the local device credentials
agent-bridge logout

# Issue a scoped service token for an external system / backend service (P0-8)
agent-bridge services issue --label=repair-orchestrator --scopes=task:create,task:cancel --ttl-days=90
agent-bridge services list
agent-bridge services rotate svc_9f1c2a --grace-hours=24   # rotate: old token stays valid for 24h
agent-bridge services revoke svc_9f1c2a

# Persistent approvals (1.0): only written when approval_ledger_enabled = true
agent-bridge approvals list            # --all also shows revoked rows
agent-bridge approvals revoke ap_7c31f0d2a4b8   # stop auto-approving that fingerprint
agent-bridge approvals purge           # drop expired rows

# Session history (1.0): the only producer of session_deleted (410) — close_session keeps history
agent-bridge sessions list                        # sessions + event range + last update
agent-bridge sessions purge --session=tk_9f1c2a   # delete one terminated session
agent-bridge sessions purge --older-than=14       # delete terminated sessions idle for 14+ days
```

> `agent-bridge daemon start <platformUrl>` / `stop` / `status` provides lightweight background management
> (detached process + PID + `daemon.log`). `install` / `uninstall` registers a per-user service: Linux
> systemd user, macOS LaunchAgent, or a Windows logon scheduled task. Both support `--dry-run`.

With `--token`, the bridge must resolve a stable `deviceId` from `identity.toml`, the saved `config.toml`
mirror, `--device-id`, or `AGENT_BRIDGE_DEVICE_ID`. If no persisted, migratable, or explicit ID exists,
startup fails: the bridge never generates a random ID for a pre-issued token, sends an empty ID, or asks the
platform to reverse-lookup identity from Bearer. An explicit ID may migrate missing local state or confirm
the persisted ID; it cannot override a different identity that is already stored.

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

### Stable device identity and local state

| State | POSIX | Windows |
| --- | --- | --- |
| Identity (source of truth) | `~/.agent-bridge/identity.toml` | `%APPDATA%\.agent-bridge\identity.toml` |
| Credentials, settings, identity mirror | `~/.agent-bridge/config.toml` | `%APPDATA%\.agent-bridge\config.toml` |

`identity.toml` stores the stable `deviceId`; `config.toml` keeps the same value only as a compatibility
mirror. State files are private to the current user (`0600` on POSIX and a restricted ACL on Windows), and
the device token is never printed in full. `AGENT_BRIDGE_CONFIG` points to a profile's `config.toml`; its
**parent directory is the profile**, so `identity.toml` and the other state files live beside it. Use a
different parent directory for each profile.

Reauthorization, switching authorization methods, and uninstalling/reinstalling the package do not change
the ID while this state directory is preserved. Deleting only `identity.toml` restores the same ID from the
config mirror. Deleting the entire profile (or both the identity and every migratable mirror) makes the next
interactive bind a new installation with a new ID. `logout` removes credentials but preserves identity and
settings; after revocation, run `logout` → `connect` to bind the same ID again.

The platform returns `409 device_bound_to_other_account` for an ID owned by another account and
`409 device_identity_ambiguous` for duplicate platform history. Both require a platform administrator;
the bridge never changes its ID to evade the conflict and never automatically merges devices or transfers
cross-account ownership.

Optional working-directory allow-list — confine task execution to specific directories:

```toml
allowed_cwd = ["/Users/me/work", "/Users/me/repos"]
```

When set, a `run_task` whose `cwd` is outside every listed directory fails before anything is spawned
(`{"status":"failed","error":"工作目录不在允许范围内：…"}`). Entries are resolved to absolute paths and
compared by directory boundary, so `/Users/me/work-old` is **not** covered by `/Users/me/work`. Omit the key
to keep the default behaviour (only "exists and is a directory" is checked).

How many tasks may run at the same time, and how many may wait — defaults 30 and 60:

```toml
max_tasks = 30
max_queue = 60   # 0 = no queueing at all
```

Tasks beyond `max_tasks` wait in a FIFO queue and start as slots free up; only when the queue is full does a new
task fail immediately (`任务队列已满（并发 N，排队 M）`). `timeoutMs` is measured **from queueing**, so a task can
never sit in the queue for hours and then run for ten more minutes. Precedence: startup flags
`--max-tasks` / `--max-queue` (both `connect` and `serve`) > `AGENT_BRIDGE_MAX_TASKS` /
`AGENT_BRIDGE_MAX_QUEUE` > the config file > defaults.

**Permission mode** (`permissionMode`): the platform may ask for `default` or `full` per task — **whether it gets
it is a local decision**:

```toml
permission_policy = "default"   # default | allow-full | full
external_sandbox = false        # only CodeBuddy's full mode requires this
```

| permission_policy | omitted | requests default | requests full |
| --- | --- | --- | --- |
| `default` (default) | default | default | **denied** (`permission_policy_denied`) |
| `allow-full` | default | default | full when eligible |
| `full` | full | default | full when eligible |

`allow-full` / `full` also switch on **managed-argument mode**: the platform may only send empty `args`, and argv
comes entirely from the adapter template (non-empty args are denied outright). `full` only picks a different
argument set — it is **not** proof of OS privilege escalation, config isolation, or a sandbox. When a tool has no
verified full mapping, or CodeBuddy runs without `external_sandbox = true`, the request is rejected with
`permission_mode_unsupported` rather than silently downgraded to `default`. Startup flags
`--permission-policy=` / `--external-sandbox` override the config file for one session.

### Per-agent capability matrix

`agent_list` describes every tool honestly — an omitted capability means **not verified**, never "assume it works":

| agentType | full argv (appended to the task template) | modes | continuation |
| --- | --- | --- | --- |
| `claude-code` | `--dangerously-skip-permissions` | headless | native `--resume` |
| `codebuddy-cli` | `-y` (+ fixed `CODEBUDDY_IS_SANDBOX=1`, needs `external_sandbox = true`) | headless, ACP | native `--resume` |
| `codex` | `--dangerously-bypass-approvals-and-sandbox` | headless | app-server thread |
| `ds-harness` | `--permission-mode danger-full-access --approval-policy never` | headless | native `--session-id` |
| `gemini` | `--yolo` | headless, ACP | ACP session |
| `opencode` | `--auto` | headless, ACP | ACP session |
| `mimo-code` | `--dangerously-skip-permissions` | headless, ACP | ACP session |
| `qoder-cli` | `--dangerously-skip-permissions` | headless | native `--resume` |
| `grok-cli` | `--always-approve` | headless, ACP | ACP session |
| `kimi-code` | *(none — `-p` already runs auto)* | headless, ACP | ACP session |
| `minimax-code` | `--permission full` | headless, ACP | ACP session |
| `trae-cli` | `--yolo` | headless, ACP | ACP session |

ACP mode is always `default` (it uses native permission prompts instead of a bypass flag), so a `full` request
is either served by headless or rejected — never silently downgraded. A later `send_message` turn resumes
through the channel above; only a tool with no continuation channel replays the canonical transcript.

`AgentListItem.capability` (`non_interactive` / `interactive_only`) is a 0.x display label kept for old
platforms — most `interactive_only` entries do run headless here. **Treat `executionModes` as
authoritative** and use `capability` only for copy.

### `executionModes` field format

Each entry describes one execution mode of one agent. Absent field = "headless only, capability identical
to the legacy label"; every dimension is reported **per mode** because a tool's headless and ACP behaviour
differ:

| field | values | meaning |
| --- | --- | --- |
| `mode` | `headless`, `acp-stdio` | how the task is executed |
| `permissionModes` | `default`, `full` | permission modes this mode can actually serve; if `full` is missing, a `full` request is rejected before spawn (`permission_mode_unsupported`) — never downgraded |
| `interactionKinds` | `permission`, `form`, `auth-url` | interaction kinds this mode can relay; `[]` is a hard "cannot ask", not "unknown" — do not wait for a question |
| `feedKinds` | `messages`, `steps`, `artifacts` | canonical feed dimensions actually extracted in this mode |

`capabilities` in `hello` is build-level ("this binary can do it"), `execution` is machine-level policy
("this install allows it"), `executionModes` is per-agent ("this tool, in this mode, really can"). The
platform needs all three to pick a combination that will not fail mid-task.

**Interactions (permission prompts / forms / auth URLs) are off by default.** While off, the bridge never
sends a `task_interaction_request`; upstream sees no answer and settles the request as declined/cancelled —
which beats making the platform wait for a question that will never arrive:

```toml
interaction_enabled = false      # true to allow interaction round-trips
interaction_timeout_ms = 900000  # per-wait cap (15 min default, clamped 10s–2h)
max_interactions_per_task = 16   # per-task interaction budget (16 default, clamped 1–256)
```

An adapter-supplied `expiresAt` is capped by `interaction_timeout_ms` (the tighter value wins); requests
beyond the budget are dropped and logged rather than forwarded. Flags `--interaction-enabled` /
`--interaction-timeout-ms=` / `--max-interactions-per-task=` override for one session.

`hello.execution` reports the effective local policy (`permissionPolicy`, `externalSandbox`,
`interactionEnabled`, `interactionTimeoutMs`, `maxInteractionsPerTask`, `approvalLedgerEnabled`) so the
platform can decide whether to ask for full and whether to expect interactions at all.

**Persistent approvals are off by default** and only start from a human answer:

```toml
approval_ledger_enabled = false   # true to remember "always allow" answers
approval_ttl_ms = 604800000       # 7 days (clamped 1 min – 90 days)
```

When on, an interactive `allow_always` answer is stored with tenant/principal/agent/tool/resource/scope and
an expiry — but **only if the responder holds `approval:persist` in addition to `task:approve`**; without it
the answer still applies to the current session, it is just not remembered (audited as `approval_grant`
with `outcome=denied`). Later requests are auto-approved **only** when all three hold: the mode is
`default`, the request really offers a persistent allow option, and the fingerprint (agent + tool kind +
normalized resource) matches an unexpired record. `full` mode never uses the ledger, and model text or tool
titles never create or widen an approval. A request with no normalizable resource (no location, command or
URL in its `toolCall`) is **never** auto-approved and never written to the ledger — otherwise one approval
would silently cover every unnamed call of that tool. Inspect and revoke with `agent-bridge approvals list` /
`agent-bridge approvals revoke <approvalId>` (audited as `approval_hit` / `approval_revoke`).

**Event history is bounded by count, not by age**, so a long conversation cannot grow the state DB forever:

```toml
event_retention_max_events = 5000   # per-session event cap (0 = keep everything, ceiling 1000000)
```

Trimming is lazy — every 100th appended event trims the session back to the newest
`event_retention_max_events` rows. The high-water mark is persisted, so `eventSeq` stays monotonic and a
number is never re-issued after its row was reclaimed. Only events are trimmed: turns, artifacts and
interactions are the evidence that the task happened and stay. `--event-retention-max-events=` overrides for
one session.

`get_task` therefore has three cursor shapes, and they mean different things:

| request | returns | use it for |
| --- | --- | --- |
| no cursor | the newest `limit` events (tail) | rebuilding current state after a reload |
| `afterEventSeq` | ascending events **strictly after** the cursor | filling a gap after a reconnect |
| `beforeEventSeq` | the newest `limit` events **strictly before** the cursor, ascending | paging history backwards |

`hasMoreBefore` tells you whether anything exists before the returned window (the tail page sets it to
`true` on a long session). When a cursor points into reclaimed history, `get_task` still answers
`found: true` but adds `errorCode: "session_history_pruned"` plus `prunedThrough`, meaning "the older part is
gone, this is where retention starts" — not "the task ended there". Supplying both `afterEventSeq` and
`beforeEventSeq` is rejected with `protocol_incompatible` instead of silently picking one. Closed sessions
stay readable after `close_session`; only deleted ones answer `session_deleted` (410), and only
`agent-bridge sessions purge` deletes: `task_not_found` means the id never existed, `session_deleted` means
give up and stop retrying.

ACP: `codebuddy-cli`, `gemini`, `opencode`, `mimo-code`, `kimi-code`, `minimax-code`, `grok-cli`, and
`trae-cli` declare native ACP and prefer it for tasks/conversations. `codex` uses the
`codex app-server` JSON-RPC surface (thread/resume, turn/steer, approvals); Claude/Qoder
conversations keep a resident `stream-json` process across turns; the rest stay headless.
CodeBuddy prefers an explicit `CODEBUDDY_AUTH_TOKEN`; otherwise the bridge reads the plaintext
`auth/*.info` from the local CodeBuddyExtension and injects it into the ACP child. If neither exists it
keeps headless `codebuddy -p` and never starts an unauthenticated ACP child.

Re-sending a `run_task` with the same `taskId` is safe: the bridge is idempotent by `taskId` —
a live task gets a current-state snapshot, a settled task replays its terminal snapshot, and nothing
is spawned twice. The platform also gets a live water level: `hello.capacity` carries the effective
caps, and every scheduling change pushes a `capacity_update { running, queued, maxTasks, maxQueued }`.

Whether a finished task carries a diff, and whether a service token is mandatory:

```toml
diff_default = false          # true = capture even when the platform did not ask for it
diff_max_bytes = 262144       # cap for the diff text (default 256 KB); AGENT_BRIDGE_DIFF_MAX_BYTES overrides
require_service_token = false # true = reject any task without a valid service token (off by default for compatibility)
session_idle_ms = 0           # close waiting_user sessions after this idle time (0=off; AGENT_BRIDGE_SESSION_IDLE_MS overrides)

# Local MCP server host (stdio). Platform Form still needs an MCP proxy or ACP extension channel.
[mcp.servers.echo]
command = "node"
args = ["mcp-server.js"]
cwd = "."
[mcp.servers.echo.env]
NODE_ENV = "production"
```

## Security boundaries

| Concern                | Behaviour                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------- |
| API keys / credentials | Never read, never uploaded. Only “present / absent” is reported.                       |
| What can be executed   | Whitelisted agent kinds only; an unknown `agentType` is rejected locally.              |
| How it is executed     | Argument arrays, no shell interpolation (Windows `.cmd` shims are quoted explicitly).  |
| Env from the platform  | **Not accepted**: any `env` inside `run_task` is ignored; children always run with the bridge's own environment. |
| Concurrency            | `max_tasks` (default 30) run at once; the rest queue FIFO up to `max_queue` (default 60), then fail. `timeoutMs` counts from queueing. |
| Local control plane     | `connect` starts the Web panel on `127.0.0.1:8787` by default (falls forward if occupied); loopback only, scoped Bearer required, no CORS headers. |
| Diff capture           | One `git diff` per task, only when `captureDiff` is set; untracked paths are restored afterwards. Nothing is committed and the index is left as it was. |
| Service identity       | Service tokens are stored as SHA-256 only and checked per scope; `cancel_task` needs `task:cancel`, holding `task:create` is not enough. |
| Where it runs          | `cwd` must exist and be a directory; `allowed_cwd` (optional) confines it further.     |
| Runaway processes      | Every task has a timeout; cancel sends `SIGTERM`, then `SIGKILL` after 2 s.            |
| Transport              | `wss://` only; handshake authenticated with `Authorization: Bearer <device_token>`.    |
| Token storage          | `0600` file in the user's home; the platform stores only a SHA-256 hash.               |
| Audit trail            | `~/.agent-bridge/audit.jsonl` (`0600`, one JSON per line): id / scope / action / outcome only — never tokens or credentials. |
| Revocation             | A revoked device is rejected on the next handshake (`4401`/`4403`, no reconnect loop). |

The bridge holds no privileges beyond the OS user that started it, and it opens **no inbound port**: the only
listeners are the short-lived `127.0.0.1` callback used during authorization and — if you explicitly enable it —
the loopback control plane, which is bound to `127.0.0.1` and never reaches the network.

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
The source tree is layered. Dependencies point **inwards only**:

```
cli.ts → cli/ (flags · render · help · dispatch) → commands/ (one file per command)
       → app/ (use-case orchestration) → { core, transport, adapters, infra }
```

`core` (domain) sits in the middle; `transport` / `adapters` / `infra` are the three edges; only the entry point
and the wire contract stay at the root. `src/cli.ts` contains **no business logic** — it forwards argv to
`cli/dispatch.ts` and nothing else (548 → 31 lines on 2026-10-23).

| Module                       | Responsibility                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| `src/cli.ts`                 | Entry point only: `argv → dispatch()` + top-level error guard                       |
| `src/cli/dispatch.ts`        | Command registry (`COMMANDS`) — add a command here, not in the entry file          |
| `src/cli/render.ts`          | Terminal rendering: colors, tables, `out.{info,ok,warn,error}`                       |
| `src/cli/flags.ts`           | Flag parsing (`--k=v`, `--flag`, positional)                                        |
| `src/cli/help.ts` / `meta.ts`| Help text / package version read from `package.json`                                |
| `src/commands/*.ts`          | One file per command; thin: parse flags → call `app/` → print                       |
| `src/app/session.ts`         | Platform session: initial report, command routing, live task table                 |
| `src/app/task-dispatch.ts`   | `run_task` / `cancel_task` orchestration (gate → spawn → upstream)                  |
| `src/app/service-gate.ts`    | Service identity authorization + audit (P0-8)                                       |
| `src/protocol.ts`            | Wire contract — the single source of truth (wire types are only defined here)       |
| `src/runner.ts`              | v1 compatibility shim; new code should import `src/core/task-supervisor.ts`          |
| `src/core/errors.ts`         | Controlled error-code enum + `BridgeError`                                          |
| `src/core/redact.ts`         | Log redaction (home directory → `~`, long base64/hex runs folded)                    |
| `src/core/emitter.ts`        | **Single upstream exit**: idempotency, redaction, audit, CloudEvents envelope        |
| `src/core/task-supervisor.ts`| Task scheduling as an instantiable domain object (concurrency, queue, cancel)        |
| `src/core/scan.ts`           | Probe orchestration with a 30 s cache                                               |
| `src/transport/bridge-client.ts` | Outbound WebSocket: handshake auth, heartbeat, backoff, offline queue            |
| `src/transport/outbox.ts`    | Bounded replay buffer for disconnects                                               |
| `src/adapters/agent-adapters.ts` | Adapter table, binary resolution, version and credential probing                |
| `src/adapters/win-exec.ts`   | Correct quoting for Windows `.cmd` / `.bat` shims                                    |
| `src/adapters/agent-logos.ts`| Brand icons as base64 data URIs                                                      |
| `src/infra/config.ts`        | `config.toml` read/write with `0600`, token redaction                                |
| `src/infra/auth.ts`          | Localhost callback server, PKCE S256, token exchange, device-code fallback           |
| `src/infra/git.ts`           | Worktree diff capture (read-only, bounded, never fails a task)                       |
| `src/infra/service-token.ts` | Scoped service tokens: issue / verify / rotate / revoke, SHA-256 only                |
| `src/infra/audit.ts`         | Audit trail (`audit.jsonl`, one JSON per line, redacted)                             |

Protocol (JSON over one connection):

| Protocol | Handshake | Bridge release |
| --- | --- | --- |
| **v1** | `PROTOCOL_VERSION = 1` (`hello.protocolVersion = 1`); `deviceId` is a non-empty stable ID matching the WS URL query | **1.0.0** (Session/Turn gateway baseline) |

| Direction         | Messages                                                                |
| ----------------- | ----------------------------------------------------------------------- |
| bridge → platform | `hello`, `agent_list`, `scan_progress`, `scan_result`, `task_log`, `task_status`, `task_step`, `task_message`, `task_artifact`, `task_snapshot`, `artifact_content`, `session_ack`, `message_ack`, `task_interaction_request`, `task_interaction_result`, `interaction_url`, `artifact_upload_ready`, `artifact_upload_chunk_ack`, `artifact_upload_result`, `artifact_download_ready`, `artifact_download_chunk`, `artifact_download_result`, `capacity_update`, `pong` |
| platform → bridge | `run_task`, `send_message`, `task_interaction_response`, `get_interaction_url`, `get_artifact`, `artifact_upload_start`, `artifact_upload_chunk`, `artifact_upload_complete`, `artifact_download_start`, `artifact_download_chunk_ack`, `cancel_task`, `close_session`, `cancel_turn`, `get_task`, `scan`, `ping` |

### Capability negotiation (`hello.capabilities`)

`hello` carries `capabilities: string[]`, the **optional** features this device supports. A third-party platform
should degrade on this list rather than guessing from a CLI version:

| capability       | Meaning                                                                   |
| ---------------- | ------------------------------------------------------------------------- |
| `diff`           | Supports `run_task.captureDiff` and a unified diff on the terminal status  |
| `service-token`  | Supports scoped service tokens plus `requestedBy` / `purpose` passthrough  |
| `queue`          | Tasks beyond the concurrency limit queue instead of being rejected         |
| `scan-progress`  | Streams `scan_progress` while probing                                      |
| `cloud-events`   | Can wrap upstream messages in a CloudEvents 1.0 envelope (CNCF standard)    |
| `capacity`       | `hello.capacity` advertises the caps; `capacity_update` streams the water level on every scheduling change |
| `task-step`      | Structured agents stream `task_step` (dynamic step flow; grading below)                     |
| `task-message`   | Emits canonical final-answer `task_message` frames with eventSeq                            |
| `task-snapshot`  | Supports `get_task` / `task_snapshot` replay by eventSeq                                    |
| `session-control`| Supports `close_session` / `cancel_turn` with `session_ack`                                  |
| `session-multi-turn` | Supports `send_message` / `message_ack`; conversation stays in waiting_user between turns |
| `session-feed`   | `task_message` / `task_step` / `task_artifact` share one `eventSeq` feed across turns; `get_task` fills gaps and pages history — no need to parse `task_log` |
| `task-interaction` | Permission/Form/URL requests, responses, results and expiry |
| `elicitation-form` | Relays agent form requests (`session/request_form` and ACP `elicitation/create`) and returns the structured answer |
| `artifact-upload` | Inbound chunked upload with SHA-256, CAS and task_artifact |
| `artifact-download` | Chunked download from CAS (ready/chunk/ack/result) |
| `interaction-url` | `get_interaction_url`; URLs kept in process memory with a short TTL |
| `permission-mode` | `run_task.permissionMode` is understood (local `permission_policy` can still deny it) |
| `artifact-inline` | `get_artifact` can inline artifact content (over 1 MB returns `too_large`; use chunked download) |
| `approval-ledger` | Persistent approvals: an interactive "always allow" can be remembered (default mode, fingerprint match, expiry) and revoked with `agent-bridge approvals revoke` |

### Step stream (`task_step`)

Agents with structured event output stream a **dynamic step flow** (`seq` increments, `ref` pairs
started/finished, `label` redacted and truncated). Steps are decided by the model at runtime — there
is no predefined total count; the platform renders "steps so far + current step". Capability is graded
per agent and reported honestly via `steps: true/false` in `agent_list`:

| Grade | Agents | Behaviour |
| --- | --- | --- |
| Structured (`steps: true`) | all 12 agents | Steps parsed from JSONL event streams (6 format families: claude-style ×5, opencode-style ×2, codex / gemini / kimi / dsh / minimax) |
| Plain text (`steps: false`) | none | Kept for future agents without structured output |

⚠️ Behaviour change: `task_log` for claude-code / codebuddy-cli / kimi-code / qoder-cli / trae-cli /
ds-harness / minimax-code switches from plain text to the **stream-json event stream** (richer;
`task_step` provides the structured view). codex / opencode / mimo-code / grok-cli / gemini were
already JSONL.

Evolution rule: a new optional field keeps the protocol version; a semantic change or a new required field bumps it.

### Diff capture (P0-6)

When `run_task` carries `captureDiff: true`, the bridge takes one diff of `cwd` when the task **settles**
(success / failed / cancelled / timeout) and ships it with `task_status`:

```json
{ "type": "run_task", "taskId": "bt_7f3a", "agentType": "codex", "cwd": "/Users/me/work/api", "args": [], "prompt": "fix the failing login test", "captureDiff": true }
```

```json
{ "type": "task_status", "taskId": "bt_7f3a", "status": "success", "exitCode": 0, "changedFiles": ["src/login.ts"], "diffTruncated": false }
```

Constraints: a non-git directory yields an empty diff **without an error**; text beyond `diff_max_bytes`
(default 256 KB) is cut on a **line boundary** with `diffTruncated: true`; untracked files are `git add -N`-ed
for the duration of the capture and `git reset -q`-ed right after — **nothing is committed, the worktree is
untouched, and no intent-to-add entry is left behind**.

### Service identity and scopes (P0-8)

Any external system (orchestrator backend, CI, IDE plugin) can call the task capabilities with a scoped service
token. Tokens look like `abs_<kid>_<secret>`; only the SHA-256 of `secret` is stored locally and comparison is
constant-time:

| scope          | Allows                            |
| -------------- | --------------------------------- |
| `task:create`  | sending `run_task`                |
| `task:cancel`  | sending `cancel_task` / `cancel_turn` / `close_session` |
| `task:read`    | reading task / scan results       |
| `session:read` | reading sessions, events and interactions only (no task output, no diff) — the narrow scope for boards and approval UIs |
| `task:approve` | answering a `permission` interaction (`task_interaction_response`, `POST /v1/interactions/{id}:respond`) |
| `task:respond` | answering a `form` / `auth-url` interaction |
| `approval:persist` | letting that answer be written into the persistent approval ledger (affects future tasks, so it is separate) |
| `device:read`  | reading the local tool list (`scan`) |

`run_task` / `cancel_task` may carry `requestedBy` (≤128 chars), `purpose` (≤64 chars) and `serviceToken`;
the bridge **echoes `requestedBy` on the terminal `task_status`** so the platform can persist `requested_by`.

Compatibility: with no token registered locally and `require_service_token = false`, behaviour is identical to
v1. **But if a message carries a token, it must verify** — there is no "present but skipped" path.

> **Checklist for the platform side** (auth on `/api/bridge/*` lives in the platform repo, not here):
> 1. accept a service token on `POST /api/bridge/tasks`, `GET /api/bridge/tasks/:id` and
>    `POST /api/bridge/tasks/:id/cancel`, alongside the user token branch;
> 2. bind each service token to a project / user scope and answer 403 on cross-tenant access;
> 3. pass `requestedBy` through when sending `run_task`, and persist the echoed `requested_by` on
>    `bridge_task_runs`.

### Controlled error codes

`task_status.error` is a human-readable string (render it directly). `task_status.errorCode` is the
**controlled** code for programmatic branching, so a platform never has to match on prose:

| Code | Meaning |
| --- | --- |
| `tool_not_installed` | Kind unknown or the binary is missing on this host |
| `tool_no_credentials` | Installed but no credentials present |
| `tool_broken` | Installed but `--version` fails |
| `cwd_missing` / `cwd_not_allowed` | Working directory absent, or outside `allowed_cwd` |
| `device_busy` | Concurrency limit and queue both full |
| `timeout` / `cancelled` | Timed out (including while queued) / cancelled |
| `agent_error` | Non-zero CLI exit, or the process failed to start |
| `unauthorized` / `invalid_token` / `token_expired` / `insufficient_scope` | Service-token failures |
| `protocol_incompatible` / `internal` | Version mismatch / bridge-side fault |

The enum lives in `src/core/errors.ts` and is mirrored by `contracts/asyncapi-3.0.yaml`; `npm run contracts:check`
fails if the two drift.

### Queueing semantics

Tasks beyond the concurrency limit queue instead of failing. To stay v1-compatible the `status` value stays
`running`; queued tasks additionally carry `phase: 'queued'` and `queuePosition` (1-based). A platform that
ignores both still behaves exactly as before. `timeoutMs` is measured **from queueing**, so a task can never
wait for hours and then run for ten more minutes.

### Machine-readable contracts

Prose drifts; contracts are checked in CI.

| File | Describes |
| --- | --- |
| `contracts/asyncapi-3.0.yaml` | The WebSocket channel (both directions, every message, error codes) |
| `contracts/openapi-3.1.yaml` | The HTTP endpoints **a platform must implement** to drive this bridge |
| `llms.txt` | Entry points for AI clients |

`npm run contracts:check` verifies every wire type, capability, error code and platform endpoint in the code
is actually documented — drift fails the build.

### Local control plane (connect starts it by default)

`agent-bridge connect <platformUrl>` starts the local Web panel on `127.0.0.1:8787` by default and
falls forward when the port is occupied. `agent-bridge serve <platformUrl> [--port=8787]` still
lets you control it explicitly through config or flags.
It exists for **other programs on this machine** — IDE extensions, scripts, MCP servers, CI runners.
Remote platforms keep using the outbound WebSocket; this is a separate channel, not a replacement.

| Rule | Value |
| --- | --- |
| Bind | `127.0.0.1` / `::1` only — a non-loopback host is rejected at startup |
| Default | `connect` tries 8787..8806 and degrades only if all are taken; `serve` still follows `[control_plane]` / `--port` |
| Auth | scoped Bearer (`abs_<kid>_<secret>`, the same tokens as P0-8); `/v1/health` and the dashboard shell `/` are open; `?token=` is accepted for EventSource (loopback only — never share the URL). **Zero-setup dashboard**: `serve` mints a read-only in-memory token (`task:read`/`device:read`) at startup and embeds it in the printed dashboard URL; it dies with the process |
| CORS | never sent — a browser script cannot call it silently |
| JWT | optional `[jwt] jwks_url = "..."`; verified principals scope `/v1/sessions`, `/v1/board`, `/v1/tasks*` and artifacts by `tenant_id`; cross-tenant task reads return 404 |
| Scheduling | tasks go through the same `TaskSupervisor`, so `max_tasks` covers both channels |
| Upstream | control-plane tasks report through the same `Emitter`, so the platform view never half-disappears |
| Dashboard | `GET /` serves an embedded Web task board (structured log event cards for all 7 event families, tool calls and results merged, raw JSON collapsed; agent todo plans + step timeline + result preview; vw/vh modals with fullscreen; bounded 600-event log cache, frame-batched SSE rendering, polling paused in background tabs); `GET /v1/board` is its data source (same registry as the terminal panel) |

| Method | Path | Scope |
| --- | --- | --- |
| GET | `/` | — (Web dashboard shell; data flows through /v1/*) |
| GET | `/v1/health` | — (liveness/readiness/version) |
| GET | `/v1/metrics` | `device:read` (Prometheus text) |
| GET | `/v1/whoami` | `device:read` (JWT principal / service identity) |
| GET | `/v1/capabilities` | `device:read` |
| GET | `/v1/agents` | `device:read` |
| POST | `/v1/agents:scan` | `device:read` |
| GET | `/v1/board` | `task:read` (board aggregate: tasks + counts + capacity) |
| POST | `/v1/artifacts:gc` | `task:cancel` (explicit artifact TTL cleanup, dryRun supported) |
| GET | `/v1/sessions` | `session:read` or `task:read` (persistent sessions) |
| GET | `/v1/sessions/{id}` | `session:read` or `task:read` (session snapshot + eventSeq window) |
| GET | `/v1/sessions/{id}/events` | `session:read` or `task:read` (SSE: replay + live events) |
| GET | `/v1/sessions/{id}/artifacts/{artifactId}` | `task:read` (stream artifact download) |
| GET | `/v1/interactions?taskId=&state=&limit=` | `session:read` or `task:read` (bounded interaction list; `state=pending` is the common one) |
| GET | `/v1/interactions/{requestId}` | `session:read` or `task:read` (one interaction: pending request or settled result) |
| POST | `/v1/interactions/{requestId}:respond` | `task:approve` for permission, `task:respond` for form/auth-url (same rule and same code path as the WS `task_interaction_response`) |
| POST | `/v1/tasks` | `task:create` |
| GET | `/v1/tasks` | `task:read` (cursor-paginated) |
| GET | `/v1/tasks/{id}` | `task:read` |
| POST | `/v1/tasks/{id}:cancel` | `task:cancel` (idempotent) |
| GET | `/v1/tasks/{id}/events` | `task:read` (SSE: logs + status + steps) |
| GET | `/v1/tasks/{id}/steps` | `task:read` (step timeline + final answer) |
| GET | `/v1/tasks/{id}/file?path=` | `task:read` (artifact preview: confined to task cwd + allowed_cwd, ≤512KB) |
| GET | `/v1/tasks/{id}/diff` | `task:read` (artifact only, task is not re-run) |

```bash
agent-bridge services issue --label=vscode --scopes=task:create,task:read
curl --noproxy '*' -H "Authorization: Bearer abs_…" http://127.0.0.1:8787/v1/agents
curl --noproxy '*' -H "Authorization: Bearer abs_…" -H "Idempotency-Key: $(uuidgen)" \
  -d '{"agentType":"codex","cwd":"/work/api","prompt":"fix the failing login test","captureDiff":true}' \
  http://127.0.0.1:8787/v1/tasks
```

Errors are RFC 9457 `application/problem+json` carrying the same `code` enum as the wire protocol, so a
client branches on `code` instead of matching prose. `Idempotency-Key` makes a retried `POST /v1/tasks` return
the same `taskId` instead of running twice. Contract: `contracts/openapi.control-plane.yaml`.

### Live scan progress and brand icons

Probing 11 CLIs takes a few seconds, so results stream in instead of arriving as one batch: for every adapter
that finishes, the bridge sends `scan_progress` with the newly finished `items` and `done: false`; one final
`scan_progress` with `done: true` closes the probing phase, followed by the terminal list (`agent_list` on
connect, or `scan_result` carrying the same `requestId` when answering `scan`). A platform that ignores
`scan_progress` still gets the complete list.

Every item carries what a card needs: `display` (name), `version`, `status`, and `logo` — a
`data:image/svg+xml;base64,…` SVG on a uniform 24×24 canvas (artwork inset to 20×20, official brand colours
kept) taken from the brand marks in `assets/agent-icons/<kind>.svg`. The same logos repeat in each message
(~70 KB for all 12), so cache them by `kind` rather than re-parsing every frame. A missing asset just omits
the field.

### Logs while the socket is down

`task_log` frames produced during a disconnect are buffered, not dropped: up to 256 KB of log frames per
disconnect (oldest dropped first, control messages kept in a separate bounded queue). On reconnect everything
is replayed in order. If the buffer overflowed, the replay starts with
`[agent-bridge] 断线期间日志超出缓冲上限（N KB），已丢弃较早部分`, so a gap is never silent.

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
  "args": [],
  "prompt": "fix the failing login test"
}
```

`args` is required by the protocol, even when you want the adapter's default argument template: send `"args": []`
and the bridge expands its own template (here `codex exec --json {{prompt}}`) with the `prompt` above.

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
  cli.ts               entry point — argv → cli/dispatch.ts, nothing else
  protocol.ts          wire contract (single source of truth)
  runner.ts            v1 compatibility shim → core/task-supervisor.ts
  cli/                  flags · terminal rendering · help · command registry
  commands/             one file per command (connect/status/logout/services/daemon)
  app/                  use-case orchestration: session · task dispatch · service gate
  core/                 domain: scheduling · upstream emitter · redaction · errors · scan
  transport/            outbound WebSocket + bounded offline replay
  adapters/             12 CLI adapters · Windows shim quoting · brand icons
  infra/                config · auth · git diff · service tokens · audit
test/
  bridge.test.ts       unit tests
```

Adding an adapter: append one entry to `AGENTS` in `src/adapters/agent-adapters.ts` (binary name, display name,
capability, task argument template, credential signals). No transport or scheduling changes are needed.

### Releasing

Version numbers are decided by commit messages, not by hand. Merge a
[Conventional Commit](https://www.conventionalcommits.org/) into `main` and
[`.github/workflows/release.yml`](./.github/workflows/release.yml) does the rest:

| Commit | Bump |
| --- | --- |
| `feat: …` | minor |
| `fix: …` | patch |
| `feat!: …` / `BREAKING CHANGE:` | major — needs approval, and `PROTOCOL_VERSION` must be bumped in the same commit |
| `docs` `chore` `test` `refactor` `style` `ci` `build` | no release at all |

semantic-release then bumps `package.json`, writes `CHANGELOG.md`, tags `v<version>`, opens the GitHub Release
and publishes to npm. It needs two repository secrets: `AGENT_BRIDGE_NPM_TOKEN` (npm automation token) and the default
`GITHUB_TOKEN`. `commit-msg` runs commitlint locally, so a malformed message is rejected before it can
produce a wrong version.

**Never tag by hand** — a manual `v1.2.3` and a semantic-release tag will fight over the same version number.
The docs site (`.github/workflows/site.yml`) redeploys on every `main` push, and its changelog page is
rendered from the same `CHANGELOG.md` at build time — one source of truth, two places it shows up.
One wrinkle worth knowing: commits pushed with `GITHUB_TOKEN` don't trigger workflows, so `release.yml`
dispatches `site.yml` explicitly at the end; without that step the changelog page would lag one release behind.

Verify the release toolchain offline (no tokens, no network, nothing written to the repo):

```bash
node scripts/verify-release.mjs   # runs notes generation + CHANGELOG writing against the real v0.1.0..HEAD commits
```

## License

MIT — see [LICENSE](./LICENSE).
