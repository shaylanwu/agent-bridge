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

### Requirement: 并发上限与排队

bridge SHALL 限制同时运行的任务数（默认 3，`max_tasks` 可调，夹 1–32），超出上限的任务 SHALL 进入
**先入先出**队列而非被拒绝；队列长度 SHALL 有上限（默认 32，`max_queue` 可调，夹 0–1024，0 表示不允许排队），
队列已满时 SHALL 立即回 `task_status: failed`。`AGENT_BRIDGE_MAX_TASKS` / `AGENT_BRIDGE_MAX_QUEUE`
环境变量 SHALL 优先于配置文件。任务的 `timeoutMs` SHALL 从**入队**时刻开始计时。

#### Scenario: 排队后依次执行

- **WHEN** `max_tasks = 1`、`max_queue = 2`，平台连续下发 4 个任务
- **THEN** 第 1 个立即运行，第 2、3 个排队；前一个进入终态后队列头依次启动；
  第 4 个因队列已满立即回 `{ "status": "failed", "error": "任务队列已满（并发 1，排队 2）…" }`

#### Scenario: 取消排队中的任务

- **WHEN** 某任务尚在队列中，平台下发 `cancel_task`
- **THEN** 该任务从队列移除、立即回 `task_status: cancelled`，且从未 spawn 任何进程

#### Scenario: 排队超时

- **WHEN** 任务的 `timeoutMs` 在它被启动之前就已耗尽
- **THEN** bridge 将其从队列移除并回 `task_status: timeout`（错误说明为排队超时），不 spawn

#### Scenario: 终态释放名额

- **WHEN** 一个运行中的任务以 `timeout` 结束
- **THEN** 运行计数减一，队列头部的任务随即启动

#### Scenario: 通过配置放宽

- **WHEN** `config.toml` 写入 `max_tasks = 6`、`max_queue = 0`
- **THEN** 同时最多运行 6 个任务，且不允许排队（第 7 个立即失败）
