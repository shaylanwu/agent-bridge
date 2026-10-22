# task-execution 规格

## Purpose

定义 bridge 在本机执行远端任务时的边界。本能力规格**按提案增量逐步建立**：当前只覆盖
`add-cwd-allowlist`（2026-10-22）落地的目录白名单语义。

其余已实现但尚未立规格的行为（工具白名单、参数数组传递、超时与取消、平台报文形状校验）见
`.harness/rules/always-on.md` §4 与 `.harness/rules/protocol-contract-rules.md`；为它们补规格需各自走一次提案
（保持一致：`openspec/specs/` 的每条 Requirement 都必须能追溯到已获批的 delta）。

## Requirements

### Requirement: 工作目录白名单

bridge SHALL 支持通过本地配置 `allowed_cwd` 限定可执行任务的工作目录；配置生效时，`cwd` 不在任何白名单目录之下
的任务 SHALL 被拒绝执行（不 spawn 任何进程），并以 `task_status: failed` 回传原因。未配置 `allowed_cwd` 时
SHALL 保持原有行为（只校验目录存在）。

#### Scenario: 越界目录被拒

- **WHEN** `allowed_cwd = ["/Users/me/work"]` 且平台下发 `cwd = "/Users/me/.ssh"`
- **THEN** bridge 不 spawn 进程，回 `{ "status": "failed", "error": "工作目录不在允许范围内：…" }`

#### Scenario: 子目录放行

- **WHEN** `allowed_cwd = ["/Users/me/work"]` 且平台下发 `cwd = "/Users/me/work/api"`
- **THEN** 任务正常执行；白名单按目录层级包含，不做字符串前缀匹配（`/Users/me/work-old` 不属于白名单）

#### Scenario: 未配置白名单

- **WHEN** `config.toml` 没有 `allowed_cwd`
- **THEN** 仅校验 `cwd` 存在且是目录，其余行为与未引入该能力前一致

### Requirement: 白名单路径规范化

bridge SHALL 在读取配置时对 `allowed_cwd` 条目执行路径规范化，SHALL 丢弃空字符串条目，SHALL 在 Windows 上
按大小写不敏感语义比较路径。

#### Scenario: 相对路径与大小写

- **WHEN** 配置为 `allowed_cwd = ["./"]`（Windows 上为 `C:\Work`）
- **THEN** 条目被解析为绝对路径；`c:\work\api` 仍判定为在白名单内

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
