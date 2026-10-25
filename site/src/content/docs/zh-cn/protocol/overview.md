---
title: 协议总览
description: 版本规则、能力协商、消息方向、错误码与排队语义。
sidebar:
  order: 1
---

线协议版本为 1（`PROTOCOL_VERSION = 1`）。它刻意做得很小：一条出站 WebSocket，21 个消息类型。
规范性描述在 [`contracts/asyncapi-3.0.yaml`](/agent-bridge/asyncapi-3.0.yaml)，本页解释它周围的规则。

## 消息方向

| 方向 | 消息 |
| --- | --- |
| **上行**（bridge → 平台） | `hello`、`agent_list`、`scan_progress`、`scan_result`、`task_log`、`task_status`、`task_step`、`capacity_update`、`pong` |
| **下行**（平台 → bridge） | `run_task`、`cancel_task`、`scan`、`ping` |

所有上行报文都经唯一出口 `Emitter`，所以幂等、脱敏、审计这些保证一致成立。
下行遇到未知或畸形报文会被拒并回受控错误码 —— 不会静默忽略。

## 版本规则

- 新增**可选字段**不算版本变更：老平台忽略它，新平台使用它。
- 新增**状态值**是破坏性变更：不认识该值的平台无法渲染。正因如此，排队语义用 `phase` 而不是 `status: "queued"`。
- 握手时比对 `protocolVersion`，不一致即以 `protocol_incompatible` 失败。
- v2 收紧身份语义：`hello.deviceId` 必填、非空，匹配 `^bd_(?:[0-9a-f]{32}|[0-9a-f]{12})$`；
  必须与 WS URL query 和授权请求中的本地持久化 ID 同值。空 ID 与仅凭 Bearer 反查都不是降级路径。

## 能力协商

`hello.capabilities` 列出当前构建支持的能力。**按能力降级，不要按版本号猜。**

| 能力 | 解锁什么 |
| --- | --- |
| `diff` | 终态 `task_status` 可携带 `diff` / `changedFiles` |
| `service-token` | 接受 `run_task` / `cancel_task` 上的服务身份三件套 |
| `queue` | 上报 `phase: "queued"` + `queuePosition`，而不是拒绝 |
| `scan-progress` | 扫描期间流式推送 `scan_progress` |
| `cloud-events` | 上行报文带 CloudEvents 1.0 信封 |
| `capacity` | `hello.capacity` 上报额度上限，调度变化时推 `capacity_update` |
| `task-step` | 结构化工具实时回传 `task_step` 步骤流（`steps: false` 的工具降级为仅状态） |

## 受控错误码

15 个，与 AsyncAPI 契约镜像。客户端按 `code` 分支，文案只给人看。

| 错误码 | HTTP（RFC 9457） | 含义 |
| --- | --- | --- |
| `protocol_incompatible` | 400 | 握手版本不一致 |
| `tool_not_installed` | 400 | 请求的 agent 本机没装 |
| `tool_no_credentials` | 400 | 装了但没有凭据 |
| `tool_broken` | 400 | 装了但跑不起来 |
| `cwd_missing` | 400 | 工作目录不存在 |
| `cwd_not_allowed` | 403 | 工作目录不在允许范围 |
| `device_busy` | 409 | 并发已达上限 |
| `timeout` | 504 | 任务超过 `timeoutMs` |
| `cancelled` | 409 | 任务被取消 |
| `agent_error` | 502 | agent 自身失败 |
| `internal` | 500 | bridge 意外失败 |
| `unauthorized` | 401 | 没带凭据 |
| `invalid_token` | 401 | 令牌畸形或未知 |
| `token_expired` | 401 | 令牌过期或已吊销 |
| `insufficient_scope` | 403 | 令牌有效但 scope 不足 |

## 排队语义

暂时跑不起来的任务**仍然上报 `status: "running"`** —— v1 平台永远不会收到不认识的状态值。
排队的事实由两个可选字段表达：

```json
{ "type": "task_status", "taskId": "t_01", "status": "running",
  "phase": "queued", "queuePosition": 2 }
```

真正开始执行时 `phase` 变为 `"running"`。并发上限是 `max_tasks`（默认 30）。

## 容量水位与幂等

- `hello.capacity` 携带本次会话生效的 `{ maxTasks, maxQueued }`；此后每次调度状态变化
  （入队 / 启动 / 终态）都会推一条 `capacity_update { running, queued, maxTasks, maxQueued }`，
  平台据此做有水位线的派发，而不是靠 `device_busy` 试错。
- `run_task` 按 `taskId` 幂等：重复下发的同一 `taskId` 不会重复执行 —— 未终态回当前状态快照，
  已终态回放终态快照。平台断线重发是安全的。

## 步骤流

全部 12 个工具（2026-10-24 全量实测 + 官方文档核定）都会把子进程的 JSONL 事件
解析成动态步骤流上行：`task_step { taskId, seq, action, label?, state, ok?, ref?, at }`。
步骤由模型实时决定，没有预定义总步数 —— 平台渲染「已发生的步骤序列 + 当前步骤」。
事件格式分 6 族：claude 同构 5 个（claude-code / codebuddy-cli / grok-cli / qoder-cli / trae-cli）、
opencode 同构 2 个（opencode / mimo-code）、codex / gemini / kimi-code / ds-harness / minimax-code 各自一族。

## 服务身份

任何调用方都可以在 `run_task` / `cancel_task` 上带三个可选字段
（`requestedBy`、`purpose`、`serviceToken`）。只要带了 `serviceToken`，bridge **必须**校验；
终态 `task_status` 会回显 `requestedBy`，让平台记录到底是谁发起的。

三个都不带，行为与 v1 逐字节一致。

## 继续

- [协议消息](/agent-bridge/zh-cn/protocol/messages) —— 每个消息的每个字段
- [WebSocket 通道](/agent-bridge/zh-cn/protocol/websocket) —— 鉴权、心跳、退避、断线
