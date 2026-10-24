# add-codebuddy-cli

## Why

用户（仓库所有者）要求支持腾讯 CodeBuddy CLI（`@tencent-ai/codebuddy-code`，命令 `codebuddy` / 别名 `cbc`）。
它是国内主流 AI 编码 CLI 之一，接口与 Claude Code 同构（`-p` 非交互 + `--output-format text`），
适配成本低、受众价值高。官网"支持的 AI Agent"清单也要求如实列出。

## What Changes

- `src/adapters/agent-adapters.ts`：新增 `codebuddy-cli` 适配器
  （`bin: codebuddy`，`altBins: ['cbc']`，`capability: non_interactive`，
  `taskArgs: ['-p', '{{prompt}}', '--output-format', 'text']`，
  凭据探测 `~/.codebuddy` 目录存在即 configured，无 envKey —— CodeBuddy 走交互式登录）。
- `assets/agent-icons/codebuddy-cli.svg`：品牌色（腾讯蓝 #0052D9）图标。
- 全链路口径 11 → 12：README ×2、llms.txt、AGENTS.md、help.ts、scan.ts 注释、
  站点（首页 tagline / 连接图 / quickstart）与 Agent 墙（AgentWall NAMES）。

## Impact

- 平台侧：`agent_list` 多一项（`kind: "codebuddy-cli"`）；`run_task` 可下发 `agentType: "codebuddy-cli"`。
  协议无变化（可选字段语义，平台无需升级）。
- 探测耗时：12 个工具并发探测（扫描并发上限 4 不变），增量可忽略。
- 本机未装 CodeBuddy 时如实上报 `not_installed`（本仓护栏规则：未实现/未安装不虚标）。
- 站点 Agent 墙自动出现第 12 项（site-check 校验墙 ↔ 适配器一致）。

## 验证

- `npm run gate` 全绿（typecheck / 单测 / build / doc:check / contracts:check）。
- `node dist/cli.js status` 输出含 `codebuddy-cli`（本机未装 → not_installed，不误报）。
- `npm --prefix site run build` + `site:check`：Agent 墙 12 项与适配器一致。
- 官方文档依据：codebuddy.cn/docs/cli/headless（`-p` / `--output-format text` / `~/.codebuddy` 登录态）。

## 风险

- CodeBuddy CLI 未在本机安装实测任务执行（headless 参数以官方文档为准，与 Claude Code 同构，风险低）；
  首次真机联跑如有出入只需调 `taskArgs`。
