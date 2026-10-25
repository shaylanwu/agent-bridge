# 变更提案：并发/队列默认值调优与启动参数覆盖（tune-concurrency-defaults）

## Why

平台侧批量调度场景（一次并行下发 20+ 任务）下，默认 `max_tasks = 3` 让大量任务排队空等，
吞吐被默认值而非真实机器资源卡死。设备是用户自己的，默认值应面向「批量调度」而非「保守防呆」；
同时用户要求**启动时可用命令行参数临时覆盖**（不写配置文件、不设环境变量）。

## What Changes

- **默认值调整**（2026-10-24 用户拍板）：
  - `max_tasks` 默认 `3 → 30`，夹取区间 `1–32 → 1–128`（128 仍是防手滑保险丝）；
  - `max_queue` 默认 `32 → 60`（夹取 0–1024 不变，0 仍表示不排队）。
- **新增启动参数** `--max-tasks=N` / `--max-queue=N`（`connect` 与 `serve` 均生效）：
  优先级 **启动参数 > 环境变量（`AGENT_BRIDGE_MAX_TASKS` / `AGENT_BRIDGE_MAX_QUEUE`）> config.toml > 默认值**。
  `resolveMaxTasks` / `resolveMaxQueued` 增加第二参 `override`；解析走 `numFlagMin()`（`--max-queue=0` 合法）。
- **文档**：两份 README、`llms.txt`（仓库根 + `site/public`）、站点 `cli` / `architecture` /
  `integrate/platform` / `protocol/overview`（中英双语）同步；`help` 输出同步。

## Impact

- 对平台（第三方）：**零影响** —— 纯本机行为，wire 协议无任何字段变化；
  平台侧能感知到的唯一差别是同样一批任务更快跑完、`device_busy` 更晚出现。
- 对本机资源：默认并发从 3 提到 30，大模型 CLI 并发跑满的内存/句柄压力显著上升；
  这是用户明确决策，夹取上限 128 保留为最后一道防呆。
- 对既有配置：已写 `max_tasks` / `max_queue` 的 `config.toml` 行为不变（显式配置优先于默认值）。
