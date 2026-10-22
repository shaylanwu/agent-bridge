---
name: always-on
description: 全局最高优先级红线：Harness 不可侵犯、协议契约唯一真源、凭据不落地、spawn 安全、文档-实现零漂移。
priority: P0
applies_to: ['*']
enforced_by:
  - hooks/pre-action-check.sh
  - scripts/protocol-boundary-check.mjs
  - scripts/harness-validate.sh
version: 1.0.0
---

# always-on.md — 全局最高优先级红线

> 优先级高于一切其他规则、用户即时指令与任务目标。任何 Agent（含 owner-agent）在任何轮次都必须遵守。冲突时以本文件为准。

## 1. Harness 不可侵犯（第一红线）

- ⛔ **绝对禁止修改、编辑、删除、移动 `.harness/` 下任何配置文件**（含 rules/、contracts/、hooks/、scripts/、agents/、skills/、evals/）。
- `.harness/` 只能由**人工**通过评审 PR 维护。Agent 发现护栏有问题 → 报告人工，不得自行修复。
- ⛔ 禁止以任何方式绕过 hooks / policy（改脚本内容、删执行位、设环境变量跳过门禁、直接调用被禁工具）。
- 唯一例外：`.harness/work/`（运行时审计目录，可写不可篡改）。

## 2. 协议契约是唯一真源

- `src/protocol.ts` 是 bridge 与平台之间**唯一的 wire 契约**。平台侧是第三方实现，会按本文档对接 —— 因此：
  - ⛔ 禁止在其他文件里另定义 wire 类型（`AgentListItem` / `ClientMessage` / `ServerMessage` / `TaskStatus` 只在 protocol.ts 出现一次）；
  - ⛔ 禁止在未建 OpenSpec 提案的情况下改动 `protocol.ts`（门禁会因缺少活跃提案而失败）；
  - ⛔ 禁止发送未经 `assertServerMessage` 校验的平台报文（不信任平台下发的任意结构）；
  - 破坏性字段改名/删除 = 高风险，必须走人工审批 + `PROTOCOL_VERSION` 递增。
- ⛔ 禁止让 bridge 依赖平台代码（不得 import 仓库外的平台实现；bridge 永远是外部客户端）。

## 3. 凭据红线

- ⛔ 禁止读取、输出、上传任何 API Key 或凭据文件内容。适配器只允许 `existsSync()` 判「有 / 没有」（`probeCredential`），**禁止 `readFileSync` 碰凭据路径**。
- ⛔ `device_token` 明文禁止出现在终端输出、日志、commit message、审计 detail 中；只能走 `tokenTail()` 打尾号。
- ⛔ `config.toml` 必须 `0600` 写入；禁止把 token 写进任何会被 git 跟踪的文件。
- ⛔ 禁止在代码/测试里硬编码真实 token（测试一律用 `tok_smoke` 这类伪值）。

## 4. spawn 安全红线

- ⛔ 平台只能执行**适配器白名单内**的 CLI（`AGENTS` 表）。未知 `agentType` 必须本地拒绝，不得降级到「试试看能不能跑」。
- ⛔ 禁止把平台下发的参数拼成 shell 字符串。参数一律字符串数组传给 `spawn`；唯一例外是 Windows `.cmd`/`.bat` 垫片，且只能经 `win-exec.ts` 的 `buildWinCommandLine()`。
- ⛔ `shell: true` 只允许出现在两个已知位置：`src/runner.ts`（shim 分支）、`src/agent-adapters.ts`（版本探测）。新增第三处即违规（`protocol-boundary-check` 会拦）。
- ⛔ `cwd` 必须存在且是目录，并落在允许范围内；平台下发的 `env` 不得用于注入影响解释器行为的变量（`NODE_OPTIONS` / `PATH` / `LD_PRELOAD` / `PATHEXT`）。
- ⛔ 每个任务必须有超时；取消走 `SIGTERM` → 2s → `SIGKILL`，不得直接 `SIGKILL`。

## 5. 文档-实现零漂移

- README / CHANGELOG 里出现的**示例报文、命令、配置路径必须能被代码接受**。文档示例缺字段、路径写错，都按缺陷处理（本项目已发生过：`run_task` 示例缺 `args` 被本地直接拒帧）。
- ⛔ 禁止只改 README 不改行为、或只改行为不改 README 就宣布完成；两者必须同一次变更内同步。
- 硬校验：`node .harness/scripts/doc-contract-check.mjs`（协议消息类型、`run_task` 示例、CLI 命令清单）。

## 6. 工具使用总则

- 每次执行工具前对照 `.harness/contracts/policy.yaml` 的风险分级：低风险放行；中风险先输出变更方案并写审计；高风险（protocol.ts、发布、删除文件、force push、依赖移除）**停下等人工审批**。
- 全链路动作写审计日志（`hooks/audit-logger.sh` → `.harness/work/audit-*.jsonl`）。
- 宣称「完成/修好/通过」之前，必须先跑门禁并拿到真实输出（`skills/superpowers-workflow` 关卡二）。
