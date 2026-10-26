---
title: Protocol overview
description: Versioning, capability negotiation, direction of messages, error codes, and queuing semantics.
sidebar:
  order: 1
---

The wire protocol is version 1 (`PROTOCOL_VERSION = 1`). It is deliberately small: 38 message
types over one outbound WebSocket. The normative description is
[`contracts/asyncapi-3.0.yaml`](/agent-bridge/asyncapi-3.0.yaml); this page explains the rules
around it.

## Direction

| Direction | Messages |
| --- | --- |
| **Up** (bridge → platform) | `hello`, `agent_list`, `scan_progress`, `scan_result`, `task_log`, `task_status`, `task_step`, `capacity_update`, `pong` |
| **Down** (platform → bridge) | `run_task`, `cancel_task`, `scan`, `ping` |

Every upstream message leaves through a single `Emitter`, so guarantees (idempotency, redaction,
audit) hold uniformly. An unknown or malformed inbound message is rejected with a controlled error
code — never silently ignored.

## Versioning rules

- Adding an **optional field** is not a version bump. Older platforms ignore it; newer ones use it.
- Adding a **new status value** *is* a breaking change, because a platform that does not know the
  value cannot render it. This is why queuing uses `phase` instead of `status: "queued"`.
- Bridge and platform compare `protocolVersion` at handshake time; a mismatch fails with
  `protocol_incompatible`.
- v2 tightens identity semantics: `hello.deviceId` is required, non-empty, and matches
  `^bd_(?:[0-9a-f]{32}|[0-9a-f]{12})$`. It must be the same locally persisted ID sent in the WS URL
  query and authorization requests. Empty IDs and Bearer-only identity lookup are not fallbacks.

## Capability negotiation

`hello.capabilities` lists what this build supports. **Degrade on capabilities, never on version
numbers.**

| Capability | What it unlocks |
| --- | --- |
| `diff` | Terminal `task_status` can carry `diff` / `changedFiles` |
| `service-token` | Accepts the service-identity triple on `run_task` / `cancel_task` |
| `queue` | Reports `phase: "queued"` + `queuePosition` instead of refusing |
| `scan-progress` | Streams `scan_progress` during a scan |
| `cloud-events` | Upstream messages carry a CloudEvents 1.0 envelope |
| `capacity` | `hello.capacity` advertises the caps; `capacity_update` streams the water level |
| `task-step` | Structured agents stream `task_step` (`steps: false` agents degrade to status only) |

## Controlled error codes

15 codes, mirrored in the AsyncAPI contract. Clients branch on `code`; prose is for humans only.

| Code | HTTP (RFC 9457) | Meaning |
| --- | --- | --- |
| `protocol_incompatible` | 400 | Handshake version mismatch |
| `tool_not_installed` | 400 | The requested agent is not on this machine |
| `tool_no_credentials` | 400 | Installed, but no credentials |
| `tool_broken` | 400 | Installed but fails to run |
| `cwd_missing` | 400 | Working directory does not exist |
| `cwd_not_allowed` | 403 | Working directory is not permitted |
| `device_busy` | 409 | Concurrency cap reached |
| `timeout` | 504 | Task exceeded its `timeoutMs` |
| `cancelled` | 409 | Task was cancelled |
| `agent_error` | 502 | The agent itself failed |
| `internal` | 500 | Unexpected bridge failure |
| `unauthorized` | 401 | No credentials presented |
| `invalid_token` | 401 | Malformed or unknown token |
| `token_expired` | 401 | Expired or revoked token |
| `insufficient_scope` | 403 | Token valid, scope missing |
| `tenant_not_supported` | 403 | Non-default tenant presented before tenant-scoped reads |

## Queuing semantics

A task that cannot start immediately is **still reported as `status: "running"`** — v1 platforms
never see a status value they do not know. Two optional fields carry the extra truth:

```json
{ "type": "task_status", "taskId": "t_01", "status": "running",
  "phase": "queued", "queuePosition": 2 }
```

When it actually starts, `phase` becomes `"running"`. The concurrency cap is `max_tasks`
(default 30).

## Capacity water level and idempotency

- `hello.capacity` carries the effective `{ maxTasks, maxQueued }` for the session; every
  scheduling change (enqueue / launch / settle) then pushes a
  `capacity_update { running, queued, maxTasks, maxQueued }`, so the platform dispatches against
  a known water level instead of probing with `device_busy`.
- `run_task` is idempotent by `taskId`: a re-sent command never spawns twice — a live task gets
  a current-state snapshot, a settled task replays its terminal snapshot. Reconnect retries are safe.

## Step stream

All 12 agents (verified 2026-10-24 via live runs plus official docs) parse their child's JSONL
events into a dynamic step flow: `task_step { taskId, seq, action, label?, state, ok?, ref?, at }`.
Steps are decided by the model at runtime — no predefined total; the platform renders "steps so far
plus the current one". Six format families: claude-style ×5 (claude-code / codebuddy-cli / grok-cli /
qoder-cli / trae-cli), opencode-style ×2 (opencode / mimo-code), plus codex / gemini / kimi-code /
ds-harness / minimax-code.

## Service identity

Any caller may attach three optional fields (`requestedBy`, `purpose`, `serviceToken`) to
`run_task` and `cancel_task`. If `serviceToken` is present, the bridge **must** validate it; the
terminal `task_status` echoes `requestedBy` so the platform can record who really asked.

Omit all three and behaviour is byte-for-byte the v1 default.

## Next

- [Protocol messages](/agent-bridge/en/protocol/messages) — every field of every message
- [WebSocket channel](/agent-bridge/en/protocol/websocket) — auth, heartbeat, backoff, reconnect
