# 变更提案：把 bridge 协议与实现通用化（面向任意编排系统，而非单一平台）

## Why

现状：`protocol.ts` 是一套自研的、`type` 判别式的私有报文；`runner.ts` 用**模块级单例状态**
（`runningTasks` / `queue` / `currentMaxTasks`）承载调度；`cli.ts` 是唯一编排点（已 347 行，
每加一个能力就再胖一圈）。它能服务好一个平台，但第三方要接入必须通读 README 中文散文，
没有机器可读的契约、没有能力协商、没有错误码体系、没有可实例化的领域对象 —— **不可测、不可扩展、不可发现**。

业界现状（对齐方向）：

| 关注点 | 业界标准 | 本提案的用法 |
| --- | --- | --- |
| 请求/响应语义 | **JSON-RPC 2.0** | 错误对象统一为 `{ code, message, data }` |
| Agent 互操作与任务模型 | **A2A**（Linux Foundation，Agent2Agent） | 任务状态与产物/事件的语义对齐 A2A Task |
| 事件信封 | **CloudEvents 1.0**（CNCF） | 上行事件带 `id/source/type/time/seq`，可被任意事件系统直接消费 |
| 异步（WS）API 描述 | **AsyncAPI 3.0** | WS 通道机器可读契约，替代"读 README" |
| 本地/同步 API 描述 | **OpenAPI 3.1** | 与外部系统的对接面（含 llms.txt 便于 AI 客户端消费） |
| 错误响应 | **RFC 9457** Problem Details | `application/problem+json` 形态 |
| 版本与兼容 | SemVer + 能力协商 | `hello.protocolVersion` + `hello.capabilities` |

目标不是"换个好看的信封"，而是让**任意第三方系统**在 30 分钟内接进来：读一份 AsyncAPI/OpenAPI，
按能力协商降级，拿到结构化事件，不需要问我们任何问题。

## What Changes

本提案**只做结构与契约改造，不改外部可观察行为**（v1 报文逐字兼容），分期落地：

### 第一期（本次）：收口与可协商

- `hello.capabilities` 能力协商（已在 `add-service-identity` 提案中落地 `capabilities` 字段本身）。
- **统一上行出口**：新增 `src/core/emitter.ts`，所有上行报文经单一 `emit()` 收口 ——
  幂等（终态后丢弃该 task 的后续事件）、脱敏、审计、断线缓冲只在这一处实现，
  **消除"每加一个能力就到处补一段"的重复代码**。
- **错误码体系**：新增 `src/core/errors.ts`，`BridgeError { code, message, data }`，
  错误码取自受控枚举（`tool_not_installed` / `cwd_not_allowed` / `device_busy` / `unauthorized` …），
  与 e2e-pilot design §7 的错误分类表一致；`task_status.error` 保留人类可读串，
  新增可选 `errorCode` 供平台做程序化处理。

### 第二期：领域对象可实例化

- `runner.ts` 的模块级状态抽成 `class TaskSupervisor`（并发/队列/超时/取消内聚，可注入、可单测）；
  现有 `startTask` 保留为默认实例的薄包装（v1 调用方零改动）。
- 任务状态机显式化：`queued → running → (settled)`，settled 后**只幂等丢弃**（对应 P1-1）。

### 第三期：标准信封与机器可读契约

- 上行事件提供 `envelope: 'cloud-events'` 可选包装（CloudEvents 1.0），由 `hello.capabilities` 协商；
  默认仍是现有扁平报文（v1 兼容）。
- 仓库内新增 `contracts/asyncapi-3.0.yaml`（WS 通道）+ 已规划的 `contracts/openapi-3.1.yaml`，
  由 `src/protocol.ts` 的类型经脚本生成骨架，人工补语义，**杜绝手写漂移**。
- 提供 `llms.txt` 与 Markdown 版文档路由，便于 AI 客户端直接消费。

### 第四期：A2A 兼容层（可选，按需）

- 在 bridge 侧提供 A2A `AgentCard` 描述与任务状态映射（A2A `TaskState` ↔ 本协议的 `TaskStatus`），
  使任何 A2A 客户端能按标准驱动本机 Agent。**这是可选项**，需要真实需求再启动。

## Impact

- 对平台（第三方）：v1 报文逐字兼容；新能力一律"协商后启用"，老客户端自动降级。
- 对实现：新增 `src/core/`（领域层）与 `contracts/`，`src/` 从 11 个平铺文件变为分层目录；
  迁移期保留 `src/*.ts` 的现有导出（重导出），避免一次性大爆炸重构。
- 风险：重构期间最容易坏的是"终态只发一次"与"断线补发顺序"，因此第一期就把 `emit()` 收口 +
  状态机单测补齐，再动其它。
