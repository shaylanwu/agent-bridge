---
title: Architecture
description: Layers, dependency direction, and the three rules the harness enforces.
sidebar:
  order: 3
---

## One entry point, many modules

`src/cli.ts` does exactly one thing: hand `process.argv` to `dispatch()`. Every command lives in
`src/commands/`, every presentation concern in `src/cli/`, and the actual work in `src/app/`.

```
cli.ts                    entry: argv → dispatch()
  └─ cli/                 presentation: dispatch table, flags, rendering, help
       └─ commands/       one file per command
            └─ app/       use cases: session, task dispatch, service gate, control plane
                 ├─ core/       domain: emitter, task supervisor, device identity, errors, redaction, scan
                 ├─ transport/  outbound: bridge client, outbox
                 ├─ adapters/   edges: agent adapters, windows exec, logos
                 └─ infra/      platform: identity/config stores, profile lock, auth, git, audit, service tokens
```

Dependencies point **downward only** — `core` imports nothing from `transport`, `adapters`,
`infra`, or `app`. A harness rule (`npm run arch:check`) fails the build on a cycle or an upward
import, so the layering is enforced by code, not by convention.

## The three rules

### 1. One upstream exit: `Emitter.emit()`

Nothing may send a message to the platform except `core/emitter.ts`. That single choke point is
where four cross-cutting concerns live exactly once:

- **Terminal idempotency** — a task reaches a terminal state only once.
- **Redaction** — home directory → `~`, secrets ≥ 64 chars collapsed.
- **Audit** — a side channel writes what happened locally.
- **Envelope** — CloudEvents 1.0 framing when the capability is negotiated.

This is why the control plane and the platform see the same events: a task dispatched locally is
reported upstream through the very same path.

### 2. The entry point only dispatches

`cli.ts` is 31 lines. Adding a command means adding a file in `src/commands/` and one line in the
`COMMANDS` table — the entry file is untouched.

### 3. The control plane stays local

Loopback bind only, an `enabled` switch that defaults to off, and no CORS headers, ever. It is an
extension, not a second front door: tasks it creates still flow through the shared
`TaskSupervisor`, so `max_tasks` covers both channels.

## Scheduling

`core/task-supervisor.ts` owns the state machine: `queued → running → settled`.

- Concurrency cap: `max_tasks` in `config.toml` (default 30, ceiling 128); startup flags
  `--max-tasks` / `--max-queue` or `AGENT_BRIDGE_MAX_TASKS` / `AGENT_BRIDGE_MAX_QUEUE` override it.
- **Queuing is expressed with optional fields, not a new status value.** A queued task reports
  `status: "running"` plus `phase: "queued"` and `queuePosition`. A platform that has never heard of
  queuing keeps working; one that cares can read the extra fields.
- Cancellation is SIGTERM, then SIGKILL after 2 s.
- A watchdog marks long-silent tasks `lost`; that state exists for platforms, not on the wire.

## Stable identity and protocol 1.0

`infra/device-identity-store.ts` persists `identity.toml` before interactive authorization; `config.toml`
keeps only a same-value compatibility mirror plus credentials and settings. The parent of the configured
`config.toml` is the profile. A profile lock serializes identity migration, authorization, credential
writes, and logout without being held for the WebSocket lifetime.

Authorization requests, the WS URL query, and `hello.deviceId` all use this one local ID. Protocol 1.0
requires it to be non-empty and valid; a pre-issued token without a persisted, migratable, or explicit ID
fails instead of creating an identity. Logout removes credentials but keeps identity and settings.

## Contracts are the source of truth

Three machine-readable files describe everything the outside world can touch, and a gate
(`npm run contracts:check`) fails if code and contracts drift:

| Contract | Describes |
| --- | --- |
| `contracts/asyncapi-3.0.yaml` | The WebSocket channel: 11 message types, error-code enum |
| `contracts/openapi-3.1.yaml` | The 4 HTTP endpoints a platform must implement |
| `contracts/openapi.control-plane.yaml` | The 9 paths / 10 operations of the loopback control plane |

The docs site renders these rather than restating them, which is why the pages you are reading are
generated at build time.
