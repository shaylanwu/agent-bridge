## ADDED Requirements

### Requirement: 平台环境变量白名单

bridge SHALL 把平台下发的 `env` 视为不可信输入：在合并进子进程环境前 SHALL 剔除影响解释器、加载器或
可执行文件解析的键（至少包含 `NODE_OPTIONS`、`PATH`、`PATHEXT`、`COMSPEC`、`LD_PRELOAD`、
`LD_LIBRARY_PATH`、`DYLD_INSERT_LIBRARIES`、`DYLD_LIBRARY_PATH`、`BASH_ENV`、`ENV`、`PYTHONSTARTUP`、
`PYTHONHOME`、`GIT_SSH_COMMAND`、`SSH_ASKPASS`），键名比较 SHALL 大小写不敏感。其余键 SHALL 原样透传。

#### Scenario: 试图注入解释器参数

- **WHEN** 平台下发 `env: { "NODE_OPTIONS": "--require ./evil.js" }`
- **THEN** 该键不进入子进程环境，任务仍按白名单 CLI 正常执行，本机 stderr 记录被剔除的键名

#### Scenario: 正常变量透传

- **WHEN** 平台下发 `env: { "HTTPS_PROXY": "http://127.0.0.1:7890", "TZ": "UTC" }`
- **THEN** 两个键都进入子进程环境

#### Scenario: 不回传本机环境

- **WHEN** 有键被剔除
- **THEN** bridge 不向平台回传任何本机环境变量名或值（只在本地记录）

### Requirement: 并发任务上限

bridge SHALL 限制同时运行的任务数（默认 3，可由 `AGENT_BRIDGE_MAX_TASKS` 覆盖）。达到上限时 SHALL
立即回 `task_status: failed` 并说明原因，SHALL NOT 排队等待；任务进入终态（`success` / `failed` /
`cancelled` / `timeout`）后 SHALL 释放名额。

#### Scenario: 超限拒绝

- **WHEN** 上限为 3 且已有 3 个任务在运行，平台又下发第 4 个
- **THEN** bridge 不 spawn 新进程，立即回 `{ "status": "failed", "error": "并发任务已达上限（3）…" }`

#### Scenario: 终态释放名额

- **WHEN** 其中一个任务以 `timeout` 结束
- **THEN** 运行计数减一，下一个任务可以正常启动
