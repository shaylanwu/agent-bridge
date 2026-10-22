## ADDED Requirements

### Requirement: 平台不得下发环境变量

bridge SHALL NOT 把任何平台下发的环境变量传给子进程。`run_task` 报文中的 `env` 字段 SHALL 被忽略
（不拒帧、不断连、不报错，以兼容仍按旧文档实现的平台），且该字段 SHALL NOT 出现在协议类型定义中。
子进程环境 SHALL 仅由 bridge 自身进程环境决定。

#### Scenario: 平台试图注入解释器参数

- **WHEN** 平台下发 `run_task` 且带 `env: { "NODE_OPTIONS": "--require ./evil.js" }`
- **THEN** 子进程环境与不带 `env` 时完全一致，任务按白名单 CLI 正常执行

#### Scenario: 老平台仍带该字段

- **WHEN** 平台仍按旧版文档下发 `env`
- **THEN** bridge 忽略该字段，连接与任务均不受影响

### Requirement: 并发任务上限

bridge SHALL 限制同时运行的任务数，默认 3，可由本地配置 `max_tasks` 调整（夹在 1–32），
`AGENT_BRIDGE_MAX_TASKS` 环境变量 SHALL 优先于配置文件。达到上限时 SHALL 立即回 `task_status: failed`
并说明原因，SHALL NOT 排队；任务进入终态（`success` / `failed` / `cancelled` / `timeout`）后 SHALL 释放名额。

#### Scenario: 超限拒绝

- **WHEN** 上限为 3 且已有 3 个任务在运行，平台又下发第 4 个
- **THEN** bridge 不 spawn 新进程，立即回 `{ "status": "failed", "error": "并发任务已达上限（3）…" }`

#### Scenario: 终态释放名额

- **WHEN** 其中一个任务以 `timeout` 结束
- **THEN** 运行计数减一，下一个任务可以正常启动

#### Scenario: 通过配置放宽

- **WHEN** `config.toml` 写入 `max_tasks = 6`
- **THEN** 同时运行的任务数上限为 6；若同时设置 `AGENT_BRIDGE_MAX_TASKS=4`，则实际上限为 4
