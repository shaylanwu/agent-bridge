## ADDED Requirements

### Requirement: 工作区差异捕获

当 `run_task` 携带 `captureDiff: true` 时，bridge SHALL 在任务进入终态（success / failed / cancelled / timeout，
含启动前就被拒绝的情形）后，在任务的 `cwd` 上执行一次**只读**的 git 差异捕获，并把结果随 `task_status` 一并回传。
未携带该字段（或本地 `diff_default` 未开启）时 SHALL NOT 执行任何 git 子进程。

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
