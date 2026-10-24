# 变更提案：服务间调用身份（scoped service token，P0-8）

## Why

编排平台的后端服务（e2e-pilot 的 `repair-orchestrator`）需要下发/查询/取消任务，但它**没有用户会话令牌**，
因此平台侧 `/api/bridge/*` 的用户态鉴权调不通 —— 服务进不来。同时平台要能把 `requested_by` 落进
`bridge_task_runs` 做审计。

**分工必须说清楚**：`/api/bridge/*` 端点的鉴权实现在**平台侧**（第三方仓库），bridge 改不到。
bridge 侧能且应该交付的是**通用、可校验、可轮换、可审计的服务身份机制**，使任何平台/系统：

1. 把服务身份随 `run_task` 透传给 bridge（`requestedBy` / `purpose` / `serviceToken`）；
2. bridge 按**最小权限 scope** 本地校验（`task:create` / `task:cancel` / `task:read` / `device:read`）；
3. 校验结果入**本地审计流水**（`~/.agent-bridge/audit.jsonl`），并随 `task_status.requestedBy` 回显，
   平台据此落 `requested_by`。

## Why（架构侧）：为什么不做"本地控制面"

护栏 `.harness/scripts/protocol-boundary-check.mjs` 明确：**`src/auth.ts` 之外任何文件不得 `listen(`**。
新增本地 HTTP 控制面会直接被架构门禁拦下。而这恰好守住了本项目的核心卖点 —— **零入站端口**。
因此服务令牌走"随下行报文携带 + 本地登记表校验"，不新增任何监听端口。

## What Changes

- **新增 `src/service-token.ts`**：服务令牌登记与校验（唯一实现）
  - 令牌形态 `abs_<kid>_<secret>`：`kid` 支持轮换（新旧并存一个宽限期），`secret` 32 字节 base64url。
  - 本地只存 **SHA-256**（`~/.agent-bridge/services.toml`，0600）；比对用 `timingSafeEqual`。
  - scope 集合：`task:create` / `task:cancel` / `task:read` / `device:read`；支持 TTL 与吊销。
  - **默认不强校验**（`require_service_token` 默认 false）：未配置任何服务令牌时行为与今天完全一致；
    一旦报文带了令牌就**必须**校验通过，否则拒绝。这样对老平台零破坏。
- **新增 `src/audit.ts`**：单行 JSONL 审计（0600），只记 id/scope/purpose/动作/结果，**永不记令牌明文**。
- **协议 `src/protocol.ts`**（仅新增可选字段，协议版本保持 1）：
  - `run_task.requestedBy?: string`（服务/主体标识，≤128 字符）
  - `run_task.purpose?: string`（业务意图，如 `repair` / `test` / `free`，≤64 字符）
  - `run_task.serviceToken?: string`；`cancel_task` 同样可带（取消也要鉴权）
  - `task_status.requestedBy?`：回显，供平台落 `requested_by`
  - `hello.capabilities?: string[]`：能力协商（本提案带 `service-token`）
- **新增 CLI `agent-bridge services issue|list|revoke|rotate`**（令牌生命周期，输出只打尾号）。
- **文档**：两份 README 新增"服务身份与作用域"章节 + 协议表 + 给平台侧的接入清单。

## Impact

- 对平台（第三方）：纯增量可选字段。不传 → 行为不变；传了 → 获得最小权限与审计。
- 对平台侧的**配套改动**（不属于本仓库，写在 README 里给对接方）：
  1. `/api/bridge/tasks`、`GET /api/bridge/tasks/:id`、`POST /api/bridge/tasks/:id/cancel` 接受
     `Authorization: Bearer <service-token>`（与用户令牌并列的第二套校验分支）；
  2. 服务令牌绑定 `projectId/userId` 范围，越权返回 403；
  3. 下发 `run_task` 时透传 `requestedBy`（服务标识）与可选 `serviceToken`，
     并把回显的 `requested_by` 写入 `bridge_task_runs`。
- 安全：新增文件一律 0600；令牌明文只在 `issue` 时打印一次；审计不含令牌与任何凭据内容。
