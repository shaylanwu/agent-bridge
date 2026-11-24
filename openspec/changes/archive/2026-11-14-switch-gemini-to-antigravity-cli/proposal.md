# 变更提案：gemini 适配器替换为官方继任者 Antigravity CLI（agy）

## Why

Google 已于 **2026-06-18** 停止为个人免费 / AI Pro / AI Ultra 账号提供 Gemini CLI 服务
（官方 release notes：受影响用户应迁移到 Antigravity 与 Antigravity CLI）。本机实测（2026-11-14）：

1. **gemini 适配器是稳定的假阳性**：`~/.gemini/oauth_creds.json` 仍在 ⇒ `agent_list` 报「就绪」，
   但上游服务已停，任何任务必然失败。这正是「探测说可用、真跑必失败」的最差组合——
   平台照常派任务，用户只看到一句上游登录报错。
2. 官方继任者 **Antigravity CLI**（`agy`，Go 编写，与 Antigravity 2.0 桌面版共享 agent harness）
   已安装在本机（1.4.10，`%LOCALAPPDATA%\agy\bin`），且提供一等 headless 通道
   （`-p` + `--output-format stream-json`，NDJSON 事件流）——具备接入的全部条件。

## What Changes

- **新增 `agy` 适配器，删除 `gemini` 适配器**（`src/adapters/agent-adapters.ts`，总数保持 12）：
  - `kind: 'agy'`（gemini 的 kind 随停服一并退役；平台 agentType 需同步映射到 `agy`，见 Impact）
  - `taskArgs: ['--output-format','stream-json','-p','{{prompt}}']`
    （⚠️ 实测 `-p` 吞值：prompt 必须紧跟其后、放在 argv 末尾，插旗标会被当 prompt 吞掉）
  - `fullArgs: ['--dangerously-skip-permissions']`（官方 headless 文档：always-proceed 权限模式）
  - `resumeArgs: ['--output-format','stream-json','--conversation','{{sessionId}}','-p','{{prompt}}']`
    ⇒ `executionModes[headless].continuation` 升为 `resume-session`
  - **不声明 ACP**（实测 1.4.10 无 `acp` 子命令）⇒ 内置 ACP 数 9 → 8
  - 凭据探测 `envs: []`、`files: []`：实测登录令牌存 **OS keyring**（binary 内 `Keyring SaveToken/LoadStoredToken`），
    磁盘无可探测凭据文件 ⇒ 探测保守报 `installed_no_cred`，不虚报「就绪」
  - `loginCommand: 'agy'`；`credentialSource` 缺省（真实登录态由任务期认证守卫兜底）
- **新增 `agy-json` 步骤解析器**（`src/adapters/step-parsers.ts`）：
  - 信封 `{"event":"init"|"step_update"|"result", …同名负载}`（官方 headless 文档 + 1.4.10 实测信封）
  - `step_update`：`step_type=tool` 产出步骤（ACTIVE→started / DONE→finished，`step_index` 配对，
    `tool_info.error` 判败）；`text_delta`/`result.response` 提取最终回答
  - 解析器新增可选 `finalOutcome()`：result `status !== 'SUCCESS'` 时即使退出码 0 也判失败
    （官方文档：`--print-timeout` 到期会**以退出码 0 结束**并给部分结果；只有 SUCCESS 算完成）
- **新增 headless 认证挂死守卫**（`AgentDef.authGuard` + `task-supervisor.ts` stderr 监视）：
  - 实测未登录时 agy 在 stderr 立即打 `Authentication required…` / `Waiting for authentication (timeout 60s)…`，
    60s 后吐出 `status:"ERROR"` 结果但**进程不退出**（timeout kill 实锤）；
  - 命中即 kill 并以 `tool_no_credentials` 结算（受控错误码已存在，不加码、不加 capability、不递增协议版本）
- **bin 目录探测**：`candidateBinDirs()` 增加 `%LOCALAPPDATA%\agy\bin`
  （实测 agy 安装器不写 PATH，`where agy` 找不到 ⇒ 不加会被误判「未安装」）
- 图标：`assets/agent-icons/agy.svg`（按图标规范），删 `gemini.svg`（站点经 sync-contracts 自动同步）
- 测试与文档同批更新（两份 README 工具清单/能力矩阵/ACP 清单/解析器族、站点 AgentWall 与 overview、
  gemini 解析器用例换成 agy 用例）

## Impact

- **平台可见变化（需平台侧同步）**：`agent_list` 不再出现 `gemini`，新增 `agy`
  （`kind` 即平台 `agentType` 精确匹配值）；平台需要把 Antigravity 的 agentType 指到 `agy`。
  wire 消息、错误码、capabilities、`PROTOCOL_VERSION` 全部不动（1.0 口径：工具增换不递增版本）。
- **能力面变化**：ACP 数 9 → 8（gemini 的 ACP 通道随适配器退役；agy 无 ACP 属官方 CLI 事实，
  不是能力缺口——`--acp` 子命令不存在）；headless 原生续接名单 4 → 5（+agy）。
- gemini-json 解析器与 `~/.gemini/oauth_creds.json` 凭据探测随适配器一并删除；
  `README` 中 gemini 行的「`--yolo` / ACP session」能力矩阵行替换为 agy 行
  （`--dangerously-skip-permissions` / native `--conversation`）。
- 平台代管 Key（envKey）**暂不开放**：`GEMINI_API_KEY` + `--settings '{"modelProvider":"gemini"}'`
  的注入链路未对 1.4.10 复验，按「未验证不声明」原则留作后续提案。
- 单测 / `doc:check` / `arch:check` / `contracts:check` 同批过门禁；归档时合并本提案。
