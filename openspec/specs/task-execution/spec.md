# task-execution 规格

## Purpose

定义 bridge 在本机执行远端任务时的边界。本能力规格**按提案增量逐步建立**，当前覆盖：
`add-cwd-allowlist`（目录白名单）、`harden-runner-env-and-concurrency` 与 `tune-concurrency-defaults`
（并发/排队与默认值）、`add-diff-capture`（终态差异捕获）、`add-multi-task-visibility`（任务幂等）。

仍未立规格的已实现行为（工具白名单、参数数组传递、超时与取消、平台报文形状校验）见
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

bridge SHALL 限制同时运行的任务数（默认 30，`max_tasks` 可调，夹 1–128），超出上限的任务 SHALL 进入
**先入先出**队列而非被拒绝；队列长度 SHALL 有上限（默认 60，`max_queue` 可调，夹 0–1024，0 表示不允许排队），
队列已满时 SHALL 立即回 `task_status: failed`。生效优先级 SHALL 为：
启动参数（`--max-tasks` / `--max-queue`）> 环境变量（`AGENT_BRIDGE_MAX_TASKS` / `AGENT_BRIDGE_MAX_QUEUE`）
> 配置文件 > 默认值。任务的 `timeoutMs` SHALL 从**入队**时刻开始计时。

#### Scenario: 排队后依次执行

- **WHEN** `max_tasks = 1`、`max_queue = 2`，平台连续下发 4 个任务
- **THEN** 第 1 个立即运行，第 2、3 个排队；前一个进入终态后队列头依次启动；
  第 4 个因队列已满立即回 `{ "status": "failed", "error": "任务队列已满（并发 1，排队 2）…" }`

#### Scenario: 启动参数覆盖

- **WHEN** 用户以 `agent-bridge connect <url> --max-tasks=12 --max-queue=100` 启动
- **THEN** 本次会话并发上限为 12、队列上限为 100，无论配置文件与环境变量取何值；
  不写参数则回落到「环境变量 > 配置 > 默认（30 / 60）」链

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

### Requirement: 工作区差异捕获

当 `run_task` 携带 `captureDiff: true`（或本地 `diff_default` 开启）时，bridge SHALL 在任务进入终态
（success / failed / cancelled / timeout，含启动前就被拒绝的情形）后，在任务的 `cwd` 上执行一次**只读**的
git 差异捕获，并把结果随 `task_status` 一并回传。两项都未开启时 SHALL NOT 执行任何 git 子进程。

差异 SHALL 为标准 unified diff（`git diff --no-color` 输出），供第三方系统直接做人工审核。

#### Scenario: 平台显式要求捕获

- **WHEN** 平台下发 `{ "type": "run_task", ..., "captureDiff": true }` 且 `cwd` 是 git 工作树
- **THEN** 终态 `task_status` SHALL 携带 `diff`（unified diff 文本）、`changedFiles`（仓库相对路径数组）

#### Scenario: 非 git 目录

- **WHEN** `captureDiff` 为真但 `cwd` 不在任何 git 工作树内
- **THEN** bridge SHALL 回传 `diff: ""`（或省略）与 `changedFiles: []`，SHALL NOT 报错、SHALL NOT 影响任务终态

#### Scenario: 未跟踪的新文件也要进 diff

- **WHEN** CLI 新建了一个尚未 `git add` 的文件
- **THEN** bridge SHALL 先对该文件 `git add -N`，取完 diff 后 SHALL 执行 `git reset -q -- <path>` 还原索引，
  使捕获过程对索引不留副作用

#### Scenario: diff 超过上限

- **WHEN** 差异文本超过 `diff_max_bytes`（默认 262144 字节）
- **THEN** bridge SHALL 按**行边界**截断（不得切断一行），并置 `diffTruncated: true`；
  `changedFiles` SHALL 仍给出完整清单（上限 500 条）

#### Scenario: 捕获失败不影响执行

- **WHEN** git 子进程超时、被杀或返回非预期输出
- **THEN** bridge SHALL 降级为空 diff（可带 `diffTruncated: false`），SHALL NOT 改变任务终态，
  SHALL NOT 因此把任务标记为失败

#### Scenario: 索引还原的幂等

- **WHEN** 捕获过程中途异常（如超时）
- **THEN** bridge SHALL 在 `finally` 中还原已 `git add -N` 的路径，不留 intent-to-add 残留

### Requirement: 任务幂等

bridge SHALL 按 `taskId` 去重：同一 `taskId` 的 `run_task` 重复到达时 SHALL NOT 重复 spawn。
任务未终态时 SHALL 回当前状态快照（`task_status`，含 `phase` / `queuePosition`）；
已终态时 SHALL 回放终态快照（含 `exitCode` / `errorCode`）。去重记录 SHALL 有界
（LRU，与 Emitter 的 `maxSettled` 同口径）。

#### Scenario: 网络重发不双跑

- **WHEN** 平台因断线重连重发同一 `taskId` 的 `run_task`，该任务仍在运行
- **THEN** bridge 回一条当前状态的 `task_status`（`running`），进程仍只有一个

#### Scenario: 终态重发放快照

- **WHEN** 平台重发一个已 `success` 的 `taskId`
- **THEN** bridge 立即回放 `{ status: 'success', exitCode: 0 }`，不产生任何子进程
