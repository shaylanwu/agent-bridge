# 实施清单：switch-gemini-to-antigravity-cli

> 前置：2026-11-14 本机实测 agy 1.4.10（未登录路径全量探测：参数语义 / 事件信封 / 挂死行为 / keyring 存储）+
> 官方 headless 文档（antigravity.google/docs/cli/headless）与第三方 Go 契约库（maruel/genai providers/antigravity）
> 三方交叉确认流契约。证据细节见同目录 design.md。
> 状态：**已实施完成并归档**（gate 全绿 ×2 + e2e:smoke 14 项 PASS + 真机探测复核 +
> 守卫端到端 90ms 快速失败取证 + icon-audit 全绿）。

## 1. 适配器定义（src/adapters/agent-adapters.ts）

- [x] 1.1 新增 `agy` 条目：`kind/display/bin/taskArgs/fullArgs/resumeArgs/steps:'agy-json'/credential`（不含 acp 声明）
- [x] 1.2 `candidateBinDirs()` 增加 `%LOCALAPPDATA%\agy\bin`
- [x] 1.3 新增 `AgentDef.authGuard` 字段：`{ patterns: RegExp[]; hint: string }`，agy 声明两条实测 stderr 模式
- [x] 1.4 删除 `gemini` 条目（kind/display/taskArgs/fullArgs/steps/acp/credential 整条）

## 2. 认证守卫与解析器（task-supervisor.ts / step-parsers.ts）

- [x] 2.1 headless `emit('stderr')` 监视：命中 `entry.authGuard.patterns` 即 kill + 以 `tool_no_credentials` 失败结算（不干等总超时）
- [x] 2.2 `StepParser` 新增可选 `finalOutcome()`：`status !== 'SUCCESS'` → ok:false（防「退出码 0 + 部分结果」假成功）
- [x] 2.3 close(code 0) 分支接入 `finalOutcome`：解析器判败时按 failed 结算
- [x] 2.4 新增 `agy-json` 解析器：信封 event 路由；`step_update`（step_type=tool，ACTIVE/DONE 按 step_index 配对，CommandLine 摘要）；`text_delta` 累积 + `result.response` 最终回答；`init` 的 conversation_id 复用既有 onSession 正则
- [x] 2.5 删除 `gemini-json` 解析器与 `StepFormat` 联合类型中的 `'gemini-json'`

## 3. 测试（test/）

- [x] 3.1 新增 `test/fixtures/agy-stream.jsonl`（官方文档样例 + 本机实测信封），删 `gemini-stream.jsonl`
- [x] 3.2 `step-parsers.test.ts`：agy 用例（tool 步骤配对 / 失败判 ok:false / finalText / finalOutcome 非 SUCCESS 判败）；gemini 用例移除；`StepFormat` 联合同步
- [x] 3.3 认证守卫用例：stderr 命中 → `tool_no_credentials` 结算、进程被 kill（模拟 child）
- [x] 3.4 适配器面断言：`AGENTS` 含 agy 不含 gemini；agy 无 acp；resumeArgs 含 `--conversation`；`executionModesFor` headless `continuation === 'resume-session'`；full 准入 `fullModeAdmitted('agy')` 为 true
- [x] 3.5 存量用例里以 gemini 作任意 agentType 的处所（panel / task-registry / permission-* / dashboard-page）逐个复核：仅测注册机制的保留，测 gemini 专属行为的改为 agy 或 opencode

## 4. 文档与站点

- [x] 4.1 `README.md` / `README.zh-CN.md`：工具清单（Gemini CLI → Antigravity CLI）、能力矩阵行、ACP 清单（9→8）、解析器族（gemini → agy）、示例输出表、ASCII 图
- [x] 4.2 `assets/agent-icons/agy.svg` 新增（viewBox 0 0 24 24、墨迹 ≤20、居中），删 `gemini.svg`
- [x] 4.3 `site/src/components/home/AgentWall.astro`：NAMES 表 gemini → agy: 'Antigravity CLI'
- [x] 4.4 `site/src/content/docs/{en,zh-cn}/protocol/overview.md`：解析器族行 gemini → agy
- [x] 4.5 `site/src/assets/agents/gemini.svg` 删除（build 时 sync-contracts 重建该目录）

## 5. 取证

- [x] 5.1 `npm run typecheck` 通过
- [x] 5.2 `npm test` 全量通过（vitest 偶发超时按已知测速问题单独复跑复核）
- [x] 5.3 `npm run gate` 全绿（协议边界 / 文档一致 / 类型 / 单测 / 构建 / 提案格式 / site:check）
- [x] 5.4 真机复核：`node dist/cli.js status --fresh` 列表出现 Antigravity CLI（缺凭据口径）；未登录任务以 `tool_no_credentials` 快速失败

## 6. 归档

- [x] 6.1 `npm run openspec:validate` 通过
- [x] 6.2 变更目录移入 `openspec/changes/archive/2026-11-14-switch-gemini-to-antigravity-cli/`
- [x] 6.3 工作日志落 `.workbuddy/memory/2026-11-14.md`，MEMORY.md 适配器事实段更新（ACP 9→8、resumeArgs 4→5、gemini 停役）
