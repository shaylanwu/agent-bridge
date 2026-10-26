---
title: For local programs
description: Drive the agents on this machine from an IDE extension, script, MCP server, or CI step.
sidebar:
  order: 2
---

You are writing a program that runs **on the same machine** as the developer: an IDE extension, a
shell script, an MCP server, a CI runner. You want to run a coding agent right here.

Use the **loopback control plane** — a small HTTP API on `127.0.0.1`.

## Read this first

:::caution
`connect` starts the local Web panel by default, but it is not a network surface
- `agent-bridge connect` starts on `127.0.0.1:8787` and falls forward when the port is taken;
  `serve` still lets you set it explicitly.
- It binds **loopback only** (`127.0.0.1` / `::1`) — never `0.0.0.0`.
- It **never** returns CORS headers, so a web page cannot reach it silently.
- Every route except `/v1/health` requires a scoped Bearer token.

If you were asked to "open a port" — that is not this. The device still makes no inbound
connection; this is a local API for local programs.
:::

## Start it

```bash
agent-bridge services issue --label=my-extension --scopes=task:create,task:read,task:cancel
agent-bridge serve https://your-platform.example.com --port=8787
```

Without `--port`, `serve` behaves exactly like `connect` and opens **no port at all**.

## Get a token

```bash
agent-bridge services issue --label=my-extension --scopes=task:create,task:read
# → abs_<kid>_<secret>   (shown once)
```

Four scopes exist: `task:create`, `task:cancel`, `task:read`, `device:read`. Ask for the smallest
set that works. Rotate with `--grace-hours` so a deploy never breaks mid-flight.

## Create a task

```bash
curl -X POST http://127.0.0.1:8787/v1/tasks \
  -H "Authorization: Bearer abs_…" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"agentType":"claude-code","cwd":"/home/you/repo",
       "prompt":"Add tests for the tokenizer","captureDiff":true}'
```

`Idempotency-Key` matters: retrying after a timeout returns the **same** `taskId` instead of
running the work twice.

## Follow it

Two ways, pick per use case:

```bash
# Poll
curl -H "Authorization: Bearer abs_…" http://127.0.0.1:8787/v1/tasks/t_01

# Stream (SSE) — late subscribers are backfilled from a bounded ring buffer first
curl -N -H "Authorization: Bearer abs_…" http://127.0.0.1:8787/v1/tasks/t_01/events
```

## Collect the result

```bash
curl -H "Authorization: Bearer abs_…" http://127.0.0.1:8787/v1/tasks/t_01/diff
```

The diff is the terminal artifact — the task is **never** re-run to produce it.

## Cancel — and one boundary worth knowing

```bash
curl -X POST -H "Authorization: Bearer abs_…" \
  http://127.0.0.1:8787/v1/tasks/t_01:cancel
```

Cancellation is idempotent; an already-finished task returns `200` with `alreadySettled`. But:

> You can only cancel tasks **created through this channel**. Tasks dispatched by the remote
> platform belong to that session and return **409** — the control plane will not kill another
> channel's work. Cancellation is SIGTERM, then SIGKILL after 2 s.

The task ledger (`GET /v1/tasks`) shows **all** tasks, including platform ones — single view,
read-only for the ones you do not own.

## Pagination

The ledger is cursor-paginated, not offset-paginated:

```bash
curl -H "Authorization: Bearer abs_…" \
  "http://127.0.0.1:8787/v1/tasks?limit=50&cursor=eyJ…"
```

A list that keeps moving cannot be paginated by offset without skipping or repeating entries.

## Errors

RFC 9457 `application/problem+json`, with the same controlled `code` enum as the wire protocol:

```json
{ "type": "about:blank", "title": "Insufficient scope", "status": 403,
  "detail": "服务令牌缺少 scope：task:create", "code": "insufficient_scope" }
```

Branch on `code`. `401` means missing/expired/invalid, `403` means valid but out of scope.

## Full reference

- [Local control plane endpoints](/agent-bridge/en/api/control-plane-reference) — every endpoint,
  every field (static, searchable)
- [Interactive try-it page](/agent-bridge/en/api/control-plane) — Scalar
- Contract: [`/openapi.control-plane.yaml`](/agent-bridge/openapi.control-plane.yaml)
