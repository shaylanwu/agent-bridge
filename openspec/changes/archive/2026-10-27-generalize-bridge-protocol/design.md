# 架构评审：当前实现的问题清单与演进设计

> 站在架构师视角通读 `src/`（11 个文件，约 2.1k 行）后的结论。
> 结论先行：**传输层与协议骨架是健康的，问题集中在"编排权都压在 cli.ts、领域状态是模块级单例、
> 契约没有机器可读形式"这三件事上** —— 它们决定了每加一个能力要复制多少代码。

## 1. 现状做得对的地方（不要动）

| 项 | 评价 |
| --- | --- |
| 出站 WS + 零入站端口 | 核心卖点，也是安全边界；护栏把 `listen()` 锁死在 `src/auth.ts` 是正确的 |
| `protocol.ts` 单一契约源 + `assertServerMessage` 运行期校验 | 契约先行的做法对，第三方对接靠得住 |
| `win-exec.ts` 把 Windows `.cmd` 引号问题隔离成一个模块 | 平台差异收敛得好 |
| `Outbox` 按"控制/日志"分桶限流 | 断线补发的取舍（控制优先、日志丢最旧）是对的 |
| 适配器表 `AGENTS` 声明式扩展 | 加一个 CLI 只改一张表，符合开闭原则 |
| 参数数组、白名单、`0600`、只存 SHA-256 | 安全边界贯彻得干净 |

## 2. 必须改的问题（按严重度）

### P1 — `cli.ts` 是唯一编排点，正在变成上帝对象

`cmdConnect` 里 `onMessage` 同时做了：协议校验、鉴权、任务创建、日志转发、状态转发、终端打印。
每加一个能力（step / diff / heartbeat）就要在这里再插一段 —— **能力越多越难改，且无法单测**（它闭包了
`client` 与 `tasks`）。今天已经 400+ 行。

**改法**：抽 `src/core/emitter.ts` 做**唯一上行出口**。`emit(msg)` 内统一做四件事：

1. 幂等（task 已 settled → 丢弃该 task 的后续 log/step）；
2. 脱敏（家目录 → `~`，长 base64/hex 折叠）；
3. 审计旁路；
4. 断线缓冲。

这样"终态后不再发日志"（P1-1）、"日志脱敏"（P1-2）这类横切需求只写**一遍**，
而不是每个能力各写一次 —— 这是避免重复代码的关键一刀。

### P1 — `runner.ts` 的调度状态是模块级单例

`runningTasks` / `queue` / `currentMaxTasks` 都是模块级变量，且 `currentMaxTasks` 由
"最近一次下发的请求"覆盖（`currentMaxTasks = maxTasks`）—— 这是隐式全局配置，两个测试会互相污染，
也无法在一台机器上跑两个独立调度域（P1-4 单机多实例的前置条件）。

**改法**：`class TaskSupervisor { submit(req, hooks): TaskHandle }`，并发/队列/超时/取消内聚在实例里；
`startTask` 降级为默认实例的薄包装（现有调用方零改动）。

### P1 — 契约没有机器可读形式

第三方要接入只能读中文散文。缺三样：

- **AsyncAPI 3.0**：WS 通道是本项目对外的**主要**通道，只有 OpenAPI 覆盖不到它；
- **错误码体系**：现在 `error` 是自由文本，平台无法程序化处理（e2e-pilot design §7 已经有分类表，
  应该上升为受控枚举 `errorCode`）；
- **能力协商**：已有 `hello.protocolVersion`，但缺 `capabilities`（本次已补）。

### P2 — 目录结构平铺，层次不可见

`src/` 11 个文件平铺，读代码看不出"领域 / 传输 / 适配器 / 基础设施"的边界。
目标是渐进分层，不做爆炸式迁移（现有导出全部保留）：

```
src/
  core/        领域：task 状态机、emit 出口、错误码、能力清单
  transport/   WS 客户端（对平台）
  adapters/    CLI 适配与结构化输出解析（P0-1 的落点）
  infra/       config / git / process / audit / tokens
```

### P2 — 适配器缺 `outputFormat` 声明

P0-1（步骤事件）要求每个 adapter 声明 `outputFormat: 'jsonl' | 'text'` 与解析器。
现在 `AgentDef` 没有该字段 —— 加字段是小事，**解析器**才是工作量，应按"声明 + 解析器"成对扩展，
解析失败一律降级（不影响执行），并在终态带 `stepsDegraded`。

## 3. 通用化设计：对齐哪些业界标准

| 关注点 | 标准 | 用法 |
| --- | --- | --- |
| 请求/响应与错误 | JSON-RPC 2.0 | 错误统一 `{ code, message, data }` |
| Agent 互操作 | A2A（Linux Foundation） | 任务状态/产物语义对齐；长期可选地提供 A2A 兼容层 |
| 事件信封 | CloudEvents 1.0（CNCF） | 可选 `envelope`，让任意事件系统直接消费 |
| 异步 API 描述 | AsyncAPI 3.0 | WS 通道契约，替代散文 |
| 同步 API 描述 | OpenAPI 3.1 | 对接面 + `llms.txt` |
| 错误响应 | RFC 9457 Problem Details | 形态对齐，平台可直接渲染 |
| 版本兼容 | SemVer + 能力协商 | 新增可选字段 = 同版本；语义变更 = +1 |
| 授权 | OAuth 2.1 / PKCE（已有）+ scoped token | 服务令牌的 scope 语义对齐 OAuth2 scopes |

**注意**：对齐不等于照搬。v1 报文逐字兼容是硬约束 —— 所有标准形态都走"能力协商后启用"，
老客户端自动降级。

## 4. 复用性核查（本次改动自查）

| 能力 | 复用点 | 状态 |
| --- | --- | --- |
| diff 捕获 | `src/git.ts` 一个函数，runner 与未来的 `prepare_workspace` 共用 | ✅ |
| 服务令牌校验 | `src/service-token.ts` 单一实现，run_task / cancel_task 都走 `verifyServiceToken` | ✅ |
| 审计 | `src/audit.ts` 单一 `writeAudit`，令牌/任务共用同一格式 | ✅ |
| 配置解析 | 新增 `resolveDiffMaxBytes` 与既有 `resolveMaxTasks / resolveMaxQueued` 同构（env > config > 默认 + 值域夹紧） | ✅ |
| 状态目录 | `stateDir()` 从 `configPath()` 派生，config/services/audit 三处口径一致 | ✅ |
| 令牌脱敏 | 复用 `config.ts` 的 `tokenTail()`，未另写一份 | ✅ |
| 截断不切多字节 | 复用 `chunkLog` 的按码点切分思路（同文件内 `chunkLogHead`） | ⚠️ 第二期抽成公共 util |

## 5. 护栏约束（架构决策的硬前提）

`.harness/scripts/protocol-boundary-check.mjs` 规定：**除 `src/auth.ts` 外任何文件不得 `listen(`**。
因此"本地 HTTP 控制面（让外部系统直接调 127.0.0.1）"在本仓库**不可行**，除非人工改护栏。
这条约束反而守住了"零入站端口"的卖点，所以本次 P0-8 走**协议内服务身份**（随下行报文携带、本地校验），
不新增任何监听端口。若确需本地控制面，需要人工评审并同时更新护栏与 README 的安全边界表。
