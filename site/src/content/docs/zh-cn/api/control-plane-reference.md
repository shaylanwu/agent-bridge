---
title: 本地控制面端点
description: 可选的本地回环控制面全部端点 —— 由 OpenAPI 契约生成。默认关闭。
---

> 本页由 `contracts/openapi.control-plane.yaml` 生成 —— 请勿手工编辑。在 `site/` 下执行 `npm run build` 会自动刷新。

## 端点索引

| 方法 | 路径 | 摘要 |
| --- | --- | --- |
| `GET` | [`/v1/health`](#op-get-v1-health) | 存活 / 就绪 / 版本 |
| `GET` | [`/v1/capabilities`](#op-get-v1-capabilities) | 能力清单与端点索引 |
| `GET` | [`/v1/agents`](#op-get-v1-agents) | 已安装 AI Agent 及其凭据状态 |
| `POST` | [`/v1/agents:scan`](#op-post-v1-agents-scan) | 触发一次全新扫描 |
| `GET` | [`/v1/tasks`](#op-get-v1-tasks) | 任务台账（游标分页） |
| `POST` | [`/v1/tasks`](#op-post-v1-tasks) | 创建任务 |
| `GET` | [`/v1/tasks/{id}`](#op-get-v1-tasks-id) | 任务状态 + 终态产物 |
| `GET` | [`/v1/tasks/{id}/events`](#op-get-v1-tasks-id-events) | SSE 事件流 |
| `GET` | [`/v1/tasks/{id}/diff`](#op-get-v1-tasks-id-diff) | 仅取终态 diff |
| `POST` | [`/v1/tasks/{id}:cancel`](#op-post-v1-tasks-id-cancel) | 取消任务 |


<a id="op-get-v1-health"></a>

### GET /v1/health

**存活 / 就绪 / 版本**

唯一不需要令牌的路由 —— 容器与 CI 探活可直接用。

**鉴权**：无需令牌  (`abs_<kid>_<secret>`)

**响应**

| 状态码 | 含义 |
| --- | --- |
| `200` |  |


**示例**

```json
{
  "status": "ok",
  "version": "string",
  "ready": true
}
```




<a id="op-get-v1-capabilities"></a>

### GET /v1/capabilities

**能力清单与端点索引**

与 hello.capabilities 同源。

**鉴权**：需要 Bearer 服务令牌  (`abs_<kid>_<secret>`)

**响应**

| 状态码 | 含义 |
| --- | --- |
| `200` |  |
| `401` |  — 结构: Problem |


**示例**

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

**已安装 AI Agent 及其凭据状态**

`?fresh=true` 触发重新探测。

**鉴权**：需要 Bearer 服务令牌  (`abs_<kid>_<secret>`)

**参数**

| 字段 | in | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `fresh` | query | `boolean` |  |  |


**响应**

| 状态码 | 含义 |
| --- | --- |
| `200` |  |
| `401` |  — 结构: Problem |


**示例**

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

**触发一次全新扫描**

等同 GET /v1/agents?fresh=true。

**鉴权**：需要 Bearer 服务令牌  (`abs_<kid>_<secret>`)

**响应**

| 状态码 | 含义 |
| --- | --- |
| `200` |  |
| `401` |  — 结构: Problem |


**示例**

```json
{}
```




<a id="op-get-v1-tasks"></a>

### GET /v1/tasks

**任务台账（游标分页）**

用 cursor 而非 offset —— 列表一直在动，offset 会漏会重。

**鉴权**：需要 Bearer 服务令牌  (`abs_<kid>_<secret>`)

**参数**

| 字段 | in | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `limit` | query | `integer` |  |  |
| `cursor` | query | `string` |  |  |


**响应**

| 状态码 | 含义 |
| --- | --- |
| `200` |  |
| `401` |  — 结构: Problem |


**示例**

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

**创建任务**

`Idempotency-Key` 让重试返回同一个 taskId 而不是跑两次。任务走的是与平台任务同一个 TaskSupervisor，因此 `max_tasks` 对两个通道都生效，上行也走同一个 Emitter。

**鉴权**：需要 Bearer 服务令牌  (`abs_<kid>_<secret>`)

**参数**

| 字段 | in | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `Idempotency-Key` | header | `string` |  |  |


**请求体**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `agentType` | `string` | ✓ |  |
| `cwd` | `string` | ✓ |  |
| `prompt` | `string` |  |  |
| `args` | array&lt;string&gt; |  |  |
| `timeoutMs` | `integer` |  |  |
| `captureDiff` | `boolean` |  |  |
| `requestedBy` | `string` |  |  |
| `purpose` | `string` |  |  |


**示例**

```json
{
  "agentType": "string",
  "cwd": "string",
  "prompt": "string",
  "requestedBy": "string",
  "purpose": "string"
}
```


**响应**

| 状态码 | 含义 |
| --- | --- |
| `200` |  — 结构: TaskRecord |
| `201` |  — 结构: TaskRecord |
| `400` |  — 结构: Problem |
| `401` |  — 结构: Problem |
| `403` |  — 结构: Problem |


**示例**

```json
"string"
```




<a id="op-get-v1-tasks-id"></a>

### GET /v1/tasks/{id}

**任务状态 + 终态产物**

含 diff 与 changedFiles。

**鉴权**：需要 Bearer 服务令牌  (`abs_<kid>_<secret>`)

**参数**

| 字段 | in | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | path | `string` | ✓ |  |


**响应**

| 状态码 | 含义 |
| --- | --- |
| `200` |  — 结构: TaskRecord |
| `401` |  — 结构: Problem |
| `404` |  — 结构: Problem |


**示例**

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

**SSE 事件流**

单个任务的日志与状态事件；晚订阅先从有界环形缓冲补发。

**鉴权**：需要 Bearer 服务令牌  (`abs_<kid>_<secret>`)

**参数**

| 字段 | in | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | path | `string` | ✓ |  |


**响应**

| 状态码 | 含义 |
| --- | --- |
| `200` |  |
| `401` |  — 结构: Problem |




<a id="op-get-v1-tasks-id-diff"></a>

### GET /v1/tasks/{id}/diff

**仅取终态 diff**

不会为了取 diff 重跑任务。

**鉴权**：需要 Bearer 服务令牌  (`abs_<kid>_<secret>`)

**参数**

| 字段 | in | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | path | `string` | ✓ |  |


**响应**

| 状态码 | 含义 |
| --- | --- |
| `200` |  |
| `401` |  — 结构: Problem |


**示例**

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

**取消任务**

幂等；已终态返回 200 且带 alreadySettled。只有本通道创建的任务可以在此取消 —— 远端平台下发的任务归那个会话所有（409）。取消先 SIGTERM，2 秒后 SIGKILL。

**鉴权**：需要 Bearer 服务令牌  (`abs_<kid>_<secret>`)

**参数**

| 字段 | in | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | path | `string` | ✓ |  |


**响应**

| 状态码 | 含义 |
| --- | --- |
| `200` |  — 结构: TaskRecord |
| `401` |  — 结构: Problem |
| `403` |  — 结构: Problem |
| `409` |  — 结构: Problem |


**示例**

```json
"string"
```



