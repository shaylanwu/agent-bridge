---
title: Local control plane endpoints
description: Every endpoint of the optional loopback control plane — generated from the OpenAPI contract. Off by default.
---

> This page is generated from `contracts/openapi.control-plane.yaml` — do not edit by hand. Run `npm run build` in `site/` to refresh.

## Endpoint index

| Method | Path | Summary |
| --- | --- | --- |
| `GET` | [`/.well-known/agent-card.json`](#op-get-well-known-agent-card-json) | A2A agent card（add-a2a-acp-gateway 提案；默认关闭） |
| `POST` | [`/a2a`](#op-post-a2a) | A2A JSON-RPC 2.0 入口（GetTask / SendMessage / CancelTask / SubscribeToTask） |
| `POST` | [`/acp`](#op-post-acp) | ACP v1 over HTTP（vendor-specific：请求 POST + prompt 下行 SSE） |
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


<a id="op-get-well-known-agent-card-json"></a>

### GET /.well-known/agent-card.json

**A2A agent card（add-a2a-acp-gateway 提案；默认关闭）**

静态描述（name/version/skills/capabilities），不含任务数据——与面板页壳同口径免令牌。 `capabilities` 只声明真实已实现的能力（streaming/pushNotifications 当前为 false， 订阅实现后才会翻 true）。skills 来自静态适配器表（12 个 CLI），不触发扫描。 需 `[gateway] enabled = true`（或 `AGENT_BRIDGE_GATEWAY=1`）才会挂此路由，否则 404。

**Auth**：No token required  (`abs_<kid>_<secret>`)

**Responses**

| Status | Meaning |
| --- | --- |
| `200` | Agent Card（A2A v1.0 字段 + 0.3 兼容字段） |
| `404` | 网关未启用（默认关闭） |


**Example**

```json
{}
```




<a id="op-post-a2a"></a>

### POST /a2a

**A2A JSON-RPC 2.0 入口（GetTask / SendMessage / CancelTask / SubscribeToTask）**

JSON-RPC 2.0 单对象（不支持 batch）。方法名 v1.0 PascalCase 与 0.3 小写都接受。 版本协商走 `A2A-Version` 请求头（空/缺省按 0.3，`1.0` 用 TASK_STATE_* 拼写，其余 `-32009`）。 逐方法鉴权；跨租户/不存在统一 `-32001`；`task_log` 只在 `Task.metadata.bridge.taskLogEndpoint` 给指引，不冒充 A2A Message/Artifact。 - **GetTask**（`tasks/get`，scope `session:read`/`task:read`）：SQLite 快照 → A2A Task。 - **SendMessage**（`message/send`，scope `task:create`）：`message.parts`（仅 text）拼接为 prompt；**bridge 扩展字段在 `message.metadata`**——`agentType`（受管白名单内）与 `cwd` 必填，`timeoutMs` 可选。`messageId` 即幂等键：重发同 messageId 返回同一 taskId （`Task.metadata.idempotentReplay: true`），同 messageId 异参回 `-32000` + `data.code: idempotency_conflict`。**立即返回**（等价 returnImmediately）：长任务后续状态走 GetTask 轮询或 SubscribeToTask 订阅。 - **CancelTask**（`tasks/cancel`，scope `task:cancel`）：与 `POST /v1/tasks/{id}:cancel` 同一条编排（SIGTERM → 2s → SIGKILL）；终态任务回 `-32002`（规范语义）； 非网关通道创建的任务同样 `-32002`。 - **SubscribeToTask**（`tasks/resubscribe`，scope `session:read`/`task:read`）：SSE 流， `eventSeq` 补洞（起点 `params.metadata.afterEventSeq`，缺省 0）。帧格式为 bridge 网关 自定义：`task`（完整快照，首帧与终帧）/ `message` / `status` / `artifact`（各带 eventSeq）/ `log|step`（调试扩展）/ `done`。终态任务按规范回 `-32004`。

**Auth**：Bearer service token required  (`abs_<kid>_<secret>`)

**Parameters**

| Field | in | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `A2A-Version` | header | `string` |  | 空/缺省按 0.3 语义；patch 号不参与协商。 |


**Request body**


| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `jsonrpc` | `string` = `2.0` | ✓ |  |
| `id` | `any` |  | string 或 number；通知（无 id）按 null 回 |
| `method` | `GetTask` \| `tasks/get` \| `SendMessage` \| `message/send` \| `CancelTask` \| `tasks/cancel` \| `SubscribeToTask` \| `tasks/resubscribe` | ✓ |  |
| `params` | `object` |  |  |


**Example**

```json
{
  "jsonrpc": "2.0",
  "method": "GetTask"
}
```


**Responses**

| Status | Meaning |
| --- | --- |
| `200` | JSON-RPC 2.0（成功 result=Task；错误 error.code 如 -32001/-32002/-32004/-32005/-32009/-32601；SendMessage 成功亦 200） |
| `401` | 缺令牌（problem+json，与 /v1/* 同一套） |
| `403` | scope 不足 / 非回环来源 |
| `404` | 网关未启用（默认关闭） |


**Example**

```json
{}
```




<a id="op-post-acp"></a>

### POST /acp

**ACP v1 over HTTP（vendor-specific：请求 POST + prompt 下行 SSE）**

JSON-RPC 2.0 单对象。ACP v1 稳定方法集 + 本网关的 HTTP 承载约定 （ACP Transports RFD 未定稿期间的 vendor 选择）： - **initialize**：只声明真实能力（loadSession=false —— 会话不持久续接； prompt 只收 text block；fs/terminal 客户端能力不开放）。 - **session/new**（scope `device:read`）：固化 `params.cwd` 与 `params._meta.agentType`（12 个受管 CLI 必须显式选择，网关不猜）→ `{sessionId}`。 - **session/prompt**（scope `task:create`，conversation 多轮）：首轮创建 bridge conversation 会话（`run_task` 语义）；后续轮 `send_message` 续接同一会话（CLI 原生续接，上下文由 CLI 持有、token 只传增量）。响应是 SSE 流：`event: prompt`（taskId + first/continue）→ `event: update`（`session/update` 通知，agent_message_chunk）→ 交互时 `event: request`（agent→client 请求，见下）→ `event: result`（本轮 turn 结束： `{stopReason, content}`，`waiting_user → end_turn`；turn 失败/超时走 JSON-RPC error， 会话随之关闭）。会话空闲回收复用 conversation 的 `idleTimeoutMs`；bridge 重启后 ACP 绑定丢失（内存态）。 - **session/cancel**（scope `task:cancel`）：取消当前轮次（`cancel_turn` 编排， operationId 幂等）；无活动轮次静默成功（v1 notification 语义）。 - **交互应答（响应报文）**：无 `method`、带 `id` + `result` 的 body。`id` 必须是 网关在 `event: request` 帧里下发的出站请求 id。permission 的 result 是 `{outcome: {outcome: 'selected'|'cancelled', optionId}}`；elicitation 的 result 是 `{action: 'accept'|'decline'|'cancel', content?}`。网关转成 `task_interaction_response` 走与 `POST /v1/interactions/{id}:respond` **同一条** dispatch 路径（permission 要 `task:approve`，form/auth-url 要 `task:respond`）。

**Auth**：Bearer service token required  (`abs_<kid>_<secret>`)

**Request body**


| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `jsonrpc` | `string` = `2.0` | ✓ |  |
| `id` | `any` |  | string 或 number；交互应答时必须是网关下发的字符串 |
| `method` | `initialize` \| `session/new` \| `session/prompt` \| `session/cancel` |  |  |
| `params` | `object` |  |  |
| `result` | `any` |  | 交互应答结果（permission outcome / elicitation action） |


**Example**

```json
{
  "jsonrpc": "2.0",
  "method": "initialize"
}
```


**Responses**

| Status | Meaning |
| --- | --- |
| `200` | JSON-RPC 2.0 响应；session/prompt 是 text/event-stream（SSE 帧：prompt/update/request/result/heartbeat） |
| `400` | 非法信封 / 畸形应答（json body） |
| `401` | 缺令牌 |
| `403` | scope 不足 / 非回环来源 |
| `404` | 网关未启用或未找到出站请求 |
| `409` | 交互应答被 dispatch 拒绝（json body，含 errorCode） |


**Example**

```json
{}
```




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

The only route that needs no token — safe for container and CI probes. The state DB runs `PRAGMA quick_check` on open and refuses to start when it fails (a corrupt file that still opens would otherwise fail mid-task). Pass `?integrity=quick` to re-run that check now; it reads the whole DB, so it stays off the default probe path.

**Auth**：No token required  (`abs_<kid>_<secret>`)

**Parameters**

| Field | in | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `integrity` | query | `quick` |  | Re-run the state-DB integrity check and include `db` in the response. |


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
| `allowInteractive` | `boolean` |  | 本任务是否申请交互（权限/表单），等价 WS `run_task.allowInteractive`。 只接受布尔（字符串/数字 400）。生效还须本机以 `--interaction-enabled` 启动； 不满足时按非交互执行，CLI 的权限申请会被本机直接拒绝（不伪造选项、不阻塞等待）。 交互请求可经 `GET /v1/interactions` 查看、`POST /v1/interactions/{id}:respond` 应答。 |


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



