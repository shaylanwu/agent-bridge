---
title: Local control plane endpoints
description: Every endpoint of the optional loopback control plane — generated from the OpenAPI contract. Off by default.
---

> This page is generated from `contracts/openapi.control-plane.yaml` — do not edit by hand. Run `npm run build` in `site/` to refresh.

## Endpoint index

| Method | Path | Summary |
| --- | --- | --- |
| `GET` | [`/`](#op-get) | 内嵌 Web 任务面板（页面壳免令牌，数据仍走带鉴权的 /v1/* 端点） |
| `GET` | [`/v1/health`](#op-get-v1-health) | Liveness / readiness / version |
| `GET` | [`/v1/metrics`](#op-get-v1-metrics) | Minimal Prometheus metrics |
| `GET` | [`/v1/whoami`](#op-get-v1-whoami) | Current principal (JWT or service token) |
| `GET` | [`/v1/capabilities`](#op-get-v1-capabilities) | Capabilities and endpoint index (same source as hello.capabilities) |
| `GET` | [`/v1/agents`](#op-get-v1-agents) | Installed agents and their credential state (`?fresh=true` to re-probe) |
| `POST` | [`/v1/agents:scan`](#op-post-v1-agents-scan) | Trigger a fresh scan (same as GET /v1/agents?fresh=true) |
| `GET` | [`/v1/board`](#op-get-v1-board) | 面板聚合视图：任务注册表 + 计数 + 容量（与终端面板同源） |
| `POST` | [`/v1/artifacts:gc`](#op-post-v1-artifacts-gc) | 显式 TTL 清理 artifact（按 CAS 引用计数，不自动执行） |
| `GET` | [`/v1/sessions`](#op-get-v1-sessions) | 持久会话列表（按 created_at 升序，返回末尾 limit 条） |
| `GET` | [`/v1/sessions/{id}`](#op-get-v1-sessions-id) | 会话快照（Session + Turns + Events + Artifacts） |
| `GET` | [`/v1/sessions/{id}/artifacts/{artifactId}`](#op-get-v1-sessions-id-artifacts-artifactid) | 下载会话附件（流式，Content-Disposition attachment） |
| `GET` | [`/v1/sessions/{id}/events`](#op-get-v1-sessions-id-events) | 会话 SSE：先回放历史，再接实时事件 |
| `GET` | [`/v1/interactions`](#op-get-v1-interactions) | 交互列表（有界，按 created_at 倒序；`state=pending` 最常用） |
| `GET` | [`/v1/interactions/{requestId}`](#op-get-v1-interactions-requestid) | 单条交互快照（pending 请求 + 已结算结果） |
| `POST` | [`/v1/interactions/{requestId}:respond`](#op-post-v1-interactions-requestid-respond) | 响应一条交互（HTTP 通道，与 WS 共用同一套判定） |
| `GET` | [`/v1/tasks`](#op-get-v1-tasks) | Task ledger, cursor-paginated (cursor, not offset — the list keeps moving) |
| `POST` | [`/v1/tasks`](#op-post-v1-tasks) | Create a task |
| `GET` | [`/v1/tasks/{id}`](#op-get-v1-tasks-id) | Task state plus terminal artifacts (diff / changedFiles) |
| `GET` | [`/v1/tasks/{id}/events`](#op-get-v1-tasks-id-events) | SSE stream: log + status events for one task |
| `GET` | [`/v1/tasks/{id}/steps`](#op-get-v1-tasks-id-steps) | 步骤时间线（完整步骤序列 + 最终回答文本） |
| `GET` | [`/v1/tasks/{id}/file`](#op-get-v1-tasks-id-file) | 任务产物文件预览（锁任务 cwd + allowed_cwd 白名单，≤512KB） |
| `GET` | [`/v1/tasks/{id}/diff`](#op-get-v1-tasks-id-diff) | Terminal diff only — the task is never re-run to produce it |
| `POST` | [`/v1/tasks/{id}:cancel`](#op-post-v1-tasks-id-cancel) | Cancel a task (idempotent; already-settled tasks return 200 with alreadySettled) |


<a id="op-get"></a>

### GET /

**内嵌 Web 任务面板（页面壳免令牌，数据仍走带鉴权的 /v1/* 端点）**

终端面板（TTY 状态表）之外的交互表面：四态任务表 + 每行日志按钮 （执行中走 SSE 实时流，排队中置灰，终态看环形缓冲回放）。 EventSource 无法自定义请求头，故所有端点额外接受 `?token=` query 兜底 （与 Bearer 同口径校验；仅本机回环，令牌勿外发）。

**Auth**：No token required  (`abs_<kid>_<secret>`)

**Responses**

| Status | Meaning |
| --- | --- |
| `200` | text/html 页面壳 |




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




<a id="op-get-v1-metrics"></a>

### GET /v1/metrics

**Minimal Prometheus metrics**

Process uptime, registry task counts, sessions and memory; requires device:read.

**Auth**：Bearer service token required  (`abs_<kid>_<secret>`)

**Responses**

| Status | Meaning |
| --- | --- |
| `200` | Prometheus text exposition |




<a id="op-get-v1-whoami"></a>

### GET /v1/whoami

**Current principal (JWT or service token)**

**Auth**：Bearer service token required  (`abs_<kid>_<secret>`)

**Responses**

| Status | Meaning |
| --- | --- |
| `200` | OK |


**Example**

```json
{
  "authenticated": true,
  "principal": {
    "subject": "string",
    "tenantId": "string",
    "scopes": [
      "string"
    ]
  }
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
      "credentialSource": "string",
      "capability": "non_interactive",
      "logo": "string"
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




<a id="op-get-v1-board"></a>

### GET /v1/board

**面板聚合视图：任务注册表 + 计数 + 容量（与终端面板同源）**

**Auth**：Bearer service token required  (`abs_<kid>_<secret>`)

**Responses**

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `401` | Missing / invalid / expired token — Schema: Problem |


**Example**

```json
{
  "counts": {
    "running": 1,
    "queued": 1,
    "success": 1,
    "failed": 1
  },
  "capacity": {
    "running": 1,
    "queued": 1,
    "maxTasks": 1,
    "maxQueued": 1
  },
  "tasks": [
    {
      "taskId": "string",
      "agentType": "string",
      "cwdShort": "string",
      "source": "platform",
      "status": "running",
      "phase": "queued",
      "error": "string",
      "stepCount": 1,
      "createdAt": 1
    }
  ]
}
```




<a id="op-post-v1-artifacts-gc"></a>

### POST /v1/artifacts:gc

**显式 TTL 清理 artifact（按 CAS 引用计数，不自动执行）**

**Auth**：Bearer service token required  (`abs_<kid>_<secret>`)

**Request body**


| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `ttlDays` | `integer` |  |  |
| `dryRun` | `boolean` |  |  |


**Example**

```json
{
  "ttlDays": 1,
  "dryRun": true
}
```


**Responses**

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `400` | Invalid request body or parameters — Schema: Problem |
| `401` | Missing / invalid / expired token — Schema: Problem |
| `403` | Token valid but the required scope is missing — Schema: Problem |


**Example**

```json
{
  "ttlDays": 1,
  "dryRun": true,
  "scanned": 1,
  "deleted": 1,
  "filesRemoved": 1
}
```




<a id="op-get-v1-sessions"></a>

### GET /v1/sessions

**持久会话列表（按 created_at 升序，返回末尾 limit 条）**

**Auth**：Bearer service token required  (`abs_<kid>_<secret>`)

**Parameters**

| Field | in | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `limit` | query | `integer` |  |  |


**Responses**

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `401` | Missing / invalid / expired token — Schema: Problem |
| `403` | Token valid but the required scope is missing — Schema: Problem |


**Example**

```json
{
  "sessions": [
    {
      "sessionId": "string",
      "tenantId": "string",
      "contextId": "string",
      "mode": "task",
      "status": "running",
      "phase": "queued",
      "agentType": "string",
      "cwd": "string",
      "nativeSessionId": "string",
      "createdAt": "string",
      "updatedAt": "string",
      "closedAt": "string"
    }
  ]
}
```




<a id="op-get-v1-sessions-id"></a>

### GET /v1/sessions/{id}

**会话快照（Session + Turns + Events + Artifacts）**

**Auth**：Bearer service token required  (`abs_<kid>_<secret>`)

**Parameters**

| Field | in | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | `string` | ✓ |  |
| `afterEventSeq` | query | `integer` |  |  |
| `limit` | query | `integer` |  |  |


**Responses**

| Status | Meaning |
| --- | --- |
| `200` | OK — Schema: SessionSnapshot |
| `401` | Missing / invalid / expired token — Schema: Problem |
| `403` | Token valid but the required scope is missing — Schema: Problem |
| `404` | Session does not exist — Schema: Problem |


**Example**

```json
{
  "session": {
    "sessionId": "string",
    "tenantId": "string",
    "contextId": "string",
    "mode": "task",
    "status": "running",
    "phase": "queued",
    "agentType": "string",
    "cwd": "string",
    "nativeSessionId": "string",
    "createdAt": "string",
    "updatedAt": "string",
    "closedAt": "string"
  },
  "turns": [
    {}
  ],
  "events": [
    {
      "eventSeq": 1,
      "type": "string",
      "payload": {},
      "createdAt": "string"
    }
  ],
  "interactions": [
    {}
  ],
  "artifacts": [
    {}
  ]
}
```




<a id="op-get-v1-sessions-id-artifacts-artifactid"></a>

### GET /v1/sessions/{id}/artifacts/{artifactId}

**下载会话附件（流式，Content-Disposition attachment）**

**Auth**：Bearer service token required  (`abs_<kid>_<secret>`)

**Parameters**

| Field | in | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | `string` | ✓ |  |
| `artifactId` | path | `string` | ✓ |  |


**Responses**

| Status | Meaning |
| --- | --- |
| `200` | 附件字节流 |
| `401` | Missing / invalid / expired token — Schema: Problem |
| `403` | Token valid but the required scope is missing — Schema: Problem |
| `404` | Session does not exist — Schema: Problem |




<a id="op-get-v1-sessions-id-events"></a>

### GET /v1/sessions/{id}/events

**会话 SSE：先回放历史，再接实时事件**

event 类型：snapshot / event / wire / heartbeat / done。 afterEventSeq 之后的持久事件先回放；终态会话回放后立即 done。

**Auth**：Bearer service token required  (`abs_<kid>_<secret>`)

**Parameters**

| Field | in | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | `string` | ✓ |  |
| `afterEventSeq` | query | `integer` |  |  |


**Responses**

| Status | Meaning |
| --- | --- |
| `200` | text/event-stream |
| `401` | Missing / invalid / expired token — Schema: Problem |
| `403` | Token valid but the required scope is missing — Schema: Problem |
| `404` | Session does not exist — Schema: Problem |




<a id="op-get-v1-interactions"></a>

### GET /v1/interactions

**交互列表（有界，按 created_at 倒序；`state=pending` 最常用）**

只读。需要 `session:read`，1.0 之前签发的 `task:read` 仍被接受（窄 scope 优先）。 Form 的答案从不在此返回（只存字段名），auth-url 的完整 URL 只在进程内 vault 里。

**Auth**：Bearer service token required  (`abs_<kid>_<secret>`)

**Parameters**

| Field | in | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `taskId` | query | `string` |  |  |
| `state` | query | `pending` \| `accepted` \| `declined` \| `cancelled` \| `expired` \| `failed` |  |  |
| `limit` | query | `integer` |  |  |


**Responses**

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `400` | Invalid request body or parameters — Schema: Problem |
| `401` | Missing / invalid / expired token — Schema: Problem |
| `403` | Token valid but the required scope is missing — Schema: Problem |


**Example**

```json
{
  "interactions": [
    {
      "taskId": "string",
      "requestId": "string",
      "kind": "permission",
      "state": "pending",
      "turnId": "string",
      "expiresAt": "string",
      "responseId": "string",
      "createdAt": "string"
    }
  ]
}
```




<a id="op-get-v1-interactions-requestid"></a>

### GET /v1/interactions/{requestId}

**单条交互快照（pending 请求 + 已结算结果）**

**Auth**：Bearer service token required  (`abs_<kid>_<secret>`)

**Parameters**

| Field | in | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `requestId` | path | `string` | ✓ |  |


**Responses**

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `401` | Missing / invalid / expired token — Schema: Problem |
| `403` | Token valid but the required scope is missing — Schema: Problem |
| `404` | Session does not exist — Schema: Problem |


**Example**

```json
{
  "interaction": {
    "taskId": "string",
    "requestId": "string",
    "kind": "permission",
    "state": "pending",
    "turnId": "string",
    "expiresAt": "string",
    "responseId": "string",
    "createdAt": "string"
  }
}
```




<a id="op-post-v1-interactions-requestid-respond"></a>

### POST /v1/interactions/{requestId}:respond

**响应一条交互（HTTP 通道，与 WS 共用同一套判定）**

permission 交互需要 `task:approve`；form / auth-url 需要 `task:respond`。 同 `responseId` 重放是幂等的（回既有终态）；换 `responseId` 再答已结算的请求回 409。

**Auth**：Bearer service token required  (`abs_<kid>_<secret>`)

**Parameters**

| Field | in | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `requestId` | path | `string` | ✓ |  |


**Request body**


| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `state` | `accepted` \| `declined` \| `cancelled` | ✓ |  |
| `responseId` | `string` |  | 幂等键；缺省由服务端生成 |
| `payload` | `object` |  | permission 传 optionId；form 传 content（按 requestedSchema 校验） |


**Example**

```json
{
  "state": "accepted",
  "responseId": "string"
}
```


**Responses**

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `400` | Invalid request body or parameters — Schema: Problem |
| `401` | Missing / invalid / expired token — Schema: Problem |
| `403` | Token valid but the required scope is missing — Schema: Problem |
| `404` | Session does not exist — Schema: Problem |
| `409` | 已结算（responseId 与既有不同） — Schema: Problem |
| `410` | 交互已过期 — Schema: Problem |
| `501` | 该进程未启用交互响应通道（只读模式） — Schema: Problem |


**Example**

```json
{
  "taskId": "string",
  "requestId": "string",
  "state": "accepted",
  "responseId": "string"
}
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
| `permissionMode` | `default` \| `full` |  | 请求的权限模式。本机 `permission_policy` 同样适用（受管参数模式不会被本地通道绕过）： 不满足时返回 `permission_policy_denied` / `permission_mode_unsupported`，不会降级执行。 |
| `requestedBy` | `string` |  |  |
| `purpose` | `string` |  |  |


**Example**

```json
{
  "agentType": "string",
  "cwd": "string",
  "prompt": "string",
  "permissionMode": "default",
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




<a id="op-get-v1-tasks-id-steps"></a>

### GET /v1/tasks/{id}/steps

**步骤时间线（完整步骤序列 + 最终回答文本）**

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
| `404` | Session does not exist — Schema: Problem |


**Example**

```json
{
  "taskId": "string",
  "status": "string",
  "phase": "string",
  "stepCount": 1,
  "steps": [
    {
      "seq": 1,
      "action": "string",
      "label": "string",
      "state": "started",
      "ok": true,
      "at": 1,
      "finishedAt": 1
    }
  ],
  "plan": [
    {
      "text": "string",
      "state": "pending"
    }
  ],
  "finalText": "string"
}
```




<a id="op-get-v1-tasks-id-file"></a>

### GET /v1/tasks/{id}/file

**任务产物文件预览（锁任务 cwd + allowed_cwd 白名单，≤512KB）**

**Auth**：Bearer service token required  (`abs_<kid>_<secret>`)

**Parameters**

| Field | in | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | `string` | ✓ |  |
| `path` | query | `string` | ✓ | 相对任务 cwd 的路径 |


**Responses**

| Status | Meaning |
| --- | --- |
| `200` | 文件内容（content-type 按扩展名：md/html/图片/文本） |
| `400` | Invalid request body or parameters — Schema: Problem |
| `401` | Missing / invalid / expired token — Schema: Problem |
| `403` | 路径越出任务工作目录或不在 allowed_cwd |
| `404` | Session does not exist — Schema: Problem |
| `413` | 超过预览上限 |




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



