# 变更提案：控制面与 ACP 网关的按任务交互申请（allowInteractive 透传）

## Why

README（中英）与 `openspec/specs/external-gateway/spec.md` 都把 **ACP 交互闭环**写成已实现能力：
「`event: request`（权限/表单）→ 客户端响应报文 `POST /acp` → `task_interaction_response` 走同一条
dispatch 路径」。2026-11-27 逐个工具做模型级端到端时发现这条链路**在当前实现里不可达**：

1. `interactive` 的判定是三重合取（`src/app/conversation.ts` / `src/app/task-dispatch.ts`）：
   `turn.execution.allowInteractive === true` **且** 进程 `interactionEnabled === true`（`--interaction-enabled`）。
2. 控制面 `createTaskCore` 的 `CreateTaskInput` **没有** `allowInteractive`，构造 `startTask` 入参时也不传
   `interactive`；`POST /v1/tasks` 的请求体同样不接受该字段。
3. ACP 网关 `session/new` 只固化 `agentType`/`cwd`，`session/prompt` 首轮调 `conversation.run` 时不带
   `allowInteractive`。

于是网关与本地控制面发起的所有任务都是 `interactive=false`。而 supervisor 对非交互任务的 ACP
权限请求是**直接 decline**（`src/core/task-supervisor.ts`：`if (!entry.req.interactive || !hooks.onInteraction) return 'decline'`）——
不是报错、不是等待，是静默拒绝。表现就是「CLI 申请权限 → 被自动拒 → 任务按拒绝结果继续/失败」，
调用方永远收不到 `request` 帧。

`test/gateway-acp.test.ts` 之所以能过，是因为它**直接注入 pending 交互记录**，绕过了「谁来置
`allowInteractive`」这一段。这与我们本月踩过的另一类问题同构：**能力被写成已支持，但只有 mock 证据**。

## What Changes

把「按任务申请交互」这条既有机制（WS 通道早已支持 `run_task.allowInteractive`）接到另外两条通道上：

1. **控制面 HTTP**：`POST /v1/tasks` 请求体新增可选 `allowInteractive?: boolean`（严格布尔，其它类型 400）。
   生效仍需进程以 `--interaction-enabled` 启动 —— 这是**本地策略**，通道不得绕过。
2. **ACP 网关**：`session/new` 的 `params._meta.allowInteractive === true` 固化到该 ACP 会话，
   首轮 `conversation.run` 带上 `allowInteractive`（续轮由 turn.execution 继承，无需重复声明）。
3. **A2A 明确拒绝**：A2A 表面没有任何 agent→client 请求帧通道，`message.metadata.allowInteractive === true`
   时**直接报错**（`-32000` + `data.code='interaction_not_supported'`），而不是静默跑成非交互任务。
4. `defaults.interactionEnabled` 由 `BridgeSession` 暴露（单一真源，与 dispatch 判定同源），
   避免控制面自己再读一遍配置造成两套判定。
5. 文档与契约同批更新：README（中英）ACP/控制面章节、`contracts/openapi.control-plane.yaml`、
   `openspec/specs/external-gateway/spec.md`（能力边界如实写：A2A 不支持交互）。

**不做**：不新增 wire 消息、不改 `PROTOCOL_VERSION`（复用既有 `allowInteractive`）；不做 A2A 的
`input-required` 映射（需要 A2A 侧的应答通道设计，另立提案）。

## Impact

- 代码：`src/transport/control-plane.ts`、`src/transport/gateway.ts`、`src/app/session.ts`、
  `src/commands/{connect,serve}.ts`。**不涉及** `src/protocol.ts` / `src/runner.ts` / `src/infra/auth.ts`
  三个高风险文件，`PROTOCOL_VERSION` 保持 1。
- 契约：控制面 OpenAPI 增一个可选字段（向后兼容）；A2A 新增一个 JSON-RPC 错误（仅在被请求时出现）。
- 行为变化（正面）：控制面/ACP 调用方终于能拿到权限与表单请求；代价是**必须显式申请**，
  默认仍是「自动拒绝」，不改变现有调用方的行为。
- 验证：单测覆盖「未申请 → interactive=false」「申请但进程未开 → 仍 false」「申请且已开 → true」，
  以及 A2A 拒绝路径；端到端用真实 CLI 跑一次权限请求 → 响应报文 → 回合继续。
