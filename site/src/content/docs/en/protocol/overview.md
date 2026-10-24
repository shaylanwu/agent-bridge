---
title: Protocol overview
description: Versioning, capability negotiation, direction of messages, error codes, and queuing semantics.
sidebar:
  order: 1
---

The wire protocol is version 1 (`PROTOCOL_VERSION = 1`). It is deliberately small: 11 message
types over one outbound WebSocket. The normative description is
[`contracts/asyncapi-3.0.yaml`](/agent-bridge/asyncapi-3.0.yaml); this page explains the rules
around it.

## Direction

| Direction | Messages |
| --- | --- |
| **Up** (bridge → platform) | `hello`, `agent_list`, `scan_progress`, `scan_result`, `task_log`, `task_status`, `pong` |
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

## Queuing semantics

A task that cannot start immediately is **still reported as `status: "running"`** — v1 platforms
never see a status value they do not know. Two optional fields carry the extra truth:

```json
{ "type": "task_status", "taskId": "t_01", "status": "running",
  "phase": "queued", "queuePosition": 2 }
```

When it actually starts, `phase` becomes `"running"`. The concurrency cap is `max_tasks`
(default 3).

## Service identity

Any caller may attach three optional fields (`requestedBy`, `purpose`, `serviceToken`) to
`run_task` and `cancel_task`. If `serviceToken` is present, the bridge **must** validate it; the
terminal `task_status` echoes `requestedBy` so the platform can record who really asked.

Omit all three and behaviour is byte-for-byte the v1 default.

## Next

- [Protocol messages](/agent-bridge/en/protocol/messages) — every field of every message
- [WebSocket channel](/agent-bridge/en/protocol/websocket) — auth, heartbeat, backoff, reconnect
