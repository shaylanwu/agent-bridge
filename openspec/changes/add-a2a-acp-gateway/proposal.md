# 变更提案：A2A / ACP 网关（独立立项）

## Why

bridge 目前只有两条通道：

- 平台出站 WebSocket；
- 本机回环 HTTP 控制面。

A2A 与 ACP 是两类外部编排/代理协议。现在没有标准入口，第三方只能自己实现 bridge 私有 wire，
造成三重复制：任务状态映射、交互映射、附件映射。

## What Changes

新增两个**可选、默认关闭**的网关，复用现有 TaskSupervisor / SessionStore / Emitter：

1. **A2A 网关**
   - `GET /.well-known/agent-card.json`
   - `POST /a2a` JSON-RPC：`message/send`、`tasks/get`、`tasks/cancel`、`tasks/resubscribe`
   - 映射 `TaskStatus` ↔ A2A `TaskState`，`task_message`/`task_artifact` ↔ A2A `Message`/`Artifact`
   - 不把 `task_log` 冒充标准消息

2. **ACP server 网关**
   - `initialize`、`session/new`、`session/prompt`、`session/cancel`
   - ACP permission / form / URL elicitation ↔ `task_interaction_request/response`
   - 只暴露已通过测试的 `executionModes` / `interactionKinds`

两个网关都：

- 只绑回环或显式配置的监听地址；
- 复用 scoped token / JWT principal / tenant；
- 不绕过 `eventSeq`、scope、租户与审计；
- 默认关闭，不与平台 WS 抢同一任务。

## Non-goals

- 不做公网暴露；
- 不把 A2A/ACP 作为平台通道替代；
- 不在本提案内做 UI。

## Impact

- 新增协议表面与契约（OpenAPI/AsyncAPI 或 JSON Schema）；
- 需要平台/第三方按能力协商接入；
- UI 冻结不受影响。

## Rollout

分阶段：映射表与测试 → A2A 只读（get/list）→ A2A 写（send/cancel）→ ACP server。
