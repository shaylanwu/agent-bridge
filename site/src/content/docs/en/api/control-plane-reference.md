---
title: Local control plane endpoints
description: Every endpoint of the optional loopback control plane — generated from the OpenAPI contract. Off by default.
---

> This page is generated from `contracts/openapi.control-plane.yaml` — do not edit by hand. Run `npm run build` in `site/` to refresh.

## Endpoint index

| Method | Path | Summary |
| --- | --- | --- |
| `GET` | [`/v1/health`](#op-get-v1-health) | Liveness / readiness / version |
| `GET` | [`/v1/capabilities`](#op-get-v1-capabilities) | Capabilities and endpoint index (same source as hello.capabilities) |
| `GET` | [`/v1/agents`](#op-get-v1-agents) | Installed agents and their credential state (`?fresh=true` to re-probe) |
| `POST` | [`/v1/agents:scan`](#op-post-v1-agents-scan) | Trigger a fresh scan (same as GET /v1/agents?fresh=true) |
| `GET` | [`/v1/tasks`](#op-get-v1-tasks) | Task ledger, cursor-paginated (cursor, not offset — the list keeps moving) |
| `POST` | [`/v1/tasks`](#op-post-v1-tasks) | Create a task |
| `GET` | [`/v1/tasks/{id}`](#op-get-v1-tasks-id) | Task state plus terminal artifacts (diff / changedFiles) |
| `GET` | [`/v1/tasks/{id}/events`](#op-get-v1-tasks-id-events) | SSE stream: log + status events for one task |
| `GET` | [`/v1/tasks/{id}/diff`](#op-get-v1-tasks-id-diff) | Terminal diff only — the task is never re-run to produce it |
| `POST` | [`/v1/tasks/{id}:cancel`](#op-post-v1-tasks-id-cancel) | Cancel a task (idempotent; already-settled tasks return 200 with alreadySettled) |


<a id="op-get-v1-health"></a>

### GET /v1/health

**Liveness / readiness / version**

The only route that needs no token — safe for container and CI probes.

**Auth**：No token required  (`abs_<kid>_<secret>`)

**Responses**

| Status | Meaning |
| --- | --- |
| `200` | OK |


**Example**

```json
{
  "status": "ok",
  "version": "string",
  "ready": true
}
```




<a id="op-get-v1-capabilities"></a>

### GET /v1/capabilities

**Capabilities and endpoint index (same source as hello.capabilities)**

**Auth**：Bearer service token required  (`abs_<kid>_<secret>`)

**Responses**

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `401` | Missing / invalid / expired token — Schema: Problem |


**Example**

```json
{
  "capabilities": [
    "string"
  ],
  "protocolVersion": 1,
  "scopes": [
    "string"
  ],
  "endpoints": [
    "string"
  ]
}
```




<a id="op-get-v1-agents"></a>

### GET /v1/agents

**Installed agents and their credential state (`?fresh=true` to re-probe)**

**Auth**：Bearer service token required  (`abs_<kid>_<secret>`)

**Parameters**

| Field | in | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `fresh` | query | `boolean` |  |  |


**Responses**

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `401` | Missing / invalid / expired token — Schema: Problem |


**Example**

```json
{
  "agents": [
    {
      "kind": "string",
      "display": "string",
      "status": "ready",
      "version": "string",
      "path": "string",
      "installedButBroken": true
    }
  ],
  "scannedAt": "string"
}
```




<a id="op-post-v1-agents-scan"></a>

### POST /v1/agents:scan

**Trigger a fresh scan (same as GET /v1/agents?fresh=true)**

**Auth**：Bearer service token required  (`abs_<kid>_<secret>`)

**Responses**

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `401` | Missing / invalid / expired token — Schema: Problem |


**Example**

```json
{}
```




<a id="op-get-v1-tasks"></a>

### GET /v1/tasks

**Task ledger, cursor-paginated (cursor, not offset — the list keeps moving)**

**Auth**：Bearer service token required  (`abs_<kid>_<secret>`)

**Parameters**

| Field | in | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `limit` | query | `integer` |  |  |
| `cursor` | query | `string` |  |  |


**Responses**

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `401` | Missing / invalid / expired token — Schema: Problem |


**Example**

```json
{
  "tasks": [
    {
      "taskId": "string",
      "agentType": "string",
      "cwd": "string",
      "state": "running",
      "phase": "queued",
      "error": "string",
      "errorCode": "string",
      "diff": "string",
      "requestedBy": "string",
      "purpose": "string",
      "createdAt": "string",
      "updatedAt": "string"
    }
  ],
  "nextCursor": "string"
}
```




<a id="op-post-v1-tasks"></a>

### POST /v1/tasks

**Create a task**

`Idempotency-Key` makes a retried submission return the same `taskId` instead of running twice. The task goes through the same `TaskSupervisor` as platform tasks, so `max_tasks` covers both channels, and it reports upstream through the same `Emitter`.

**Auth**：Bearer service token required  (`abs_<kid>_<secret>`)

**Parameters**

| Field | in | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `Idempotency-Key` | header | `string` |  |  |


**Request body**


| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `agentType` | `string` | ✓ |  |
| `cwd` | `string` | ✓ |  |
| `prompt` | `string` |  |  |
| `args` | array&lt;string&gt; |  |  |
| `timeoutMs` | `integer` |  |  |
| `captureDiff` | `boolean` |  |  |
| `requestedBy` | `string` |  |  |
| `purpose` | `string` |  |  |


**Example**

```json
{
  "agentType": "string",
  "cwd": "string",
  "prompt": "string",
  "requestedBy": "string",
  "purpose": "string"
}
```


**Responses**

| Status | Meaning |
| --- | --- |
| `200` | Idempotent replay (same Idempotency-Key) — Schema: TaskRecord |
| `201` | Created — Schema: TaskRecord |
| `400` | RFC 9457 problem details — Schema: Problem |
| `401` | Missing / invalid / expired token — Schema: Problem |
| `403` | Token valid but the required scope is missing — Schema: Problem |


**Example**

```json
"string"
```




<a id="op-get-v1-tasks-id"></a>

### GET /v1/tasks/{id}

**Task state plus terminal artifacts (diff / changedFiles)**

**Auth**：Bearer service token required  (`abs_<kid>_<secret>`)

**Parameters**

| Field | in | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | `string` | ✓ |  |


**Responses**

| Status | Meaning |
| --- | --- |
| `200` | OK — Schema: TaskRecord |
| `401` | Missing / invalid / expired token — Schema: Problem |
| `404` | RFC 9457 problem details — Schema: Problem |


**Example**

```json
{
  "taskId": "string",
  "agentType": "string",
  "cwd": "string",
  "state": "running",
  "phase": "queued",
  "error": "string",
  "errorCode": "string",
  "diff": "string",
  "requestedBy": "string",
  "purpose": "string",
  "createdAt": "string",
  "updatedAt": "string"
}
```




<a id="op-get-v1-tasks-id-events"></a>

### GET /v1/tasks/{id}/events

**SSE stream: log + status events for one task**

Late subscribers are backfilled from a bounded ring buffer before live events start.

**Auth**：Bearer service token required  (`abs_<kid>_<secret>`)

**Parameters**

| Field | in | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | `string` | ✓ |  |


**Responses**

| Status | Meaning |
| --- | --- |
| `200` | Event stream |
| `401` | Missing / invalid / expired token — Schema: Problem |




<a id="op-get-v1-tasks-id-diff"></a>

### GET /v1/tasks/{id}/diff

**Terminal diff only — the task is never re-run to produce it**

**Auth**：Bearer service token required  (`abs_<kid>_<secret>`)

**Parameters**

| Field | in | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | `string` | ✓ |  |


**Responses**

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `401` | Missing / invalid / expired token — Schema: Problem |


**Example**

```json
{
  "taskId": "string",
  "diff": "string",
  "changedFiles": [
    "string"
  ],
  "diffTruncated": true
}
```




<a id="op-post-v1-tasks-id-cancel"></a>

### POST /v1/tasks/{id}:cancel

**Cancel a task (idempotent; already-settled tasks return 200 with alreadySettled)**

Only tasks created through this channel can be cancelled here — tasks dispatched by the remote platform are owned by that session (409). Cancellation is SIGTERM, then SIGKILL after 2 s.

**Auth**：Bearer service token required  (`abs_<kid>_<secret>`)

**Parameters**

| Field | in | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | `string` | ✓ |  |


**Responses**

| Status | Meaning |
| --- | --- |
| `200` | OK — Schema: TaskRecord |
| `401` | Missing / invalid / expired token — Schema: Problem |
| `403` | Token valid but the required scope is missing — Schema: Problem |
| `409` | RFC 9457 problem details — Schema: Problem |


**Example**

```json
"string"
```



