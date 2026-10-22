## MODIFIED Requirements

### Requirement: 日志流

bridge SHALL 将子进程 stdout/stderr 以 `task_log` 分片即时回传，每个分片 SHALL ≤ 4096 字节 UTF-8，
且 SHALL NOT 切断多字节字符。连接断开期间产生的 `task_log` SHALL 被缓冲并在重连后按序补发，
缓冲 SHALL 有界（默认 256 KB）；超出上限时 SHALL 丢弃较早的分片，并在补发序列最前插入一条说明性
`task_log`（挂在同一 `taskId` 上）告知丢弃量。

#### Scenario: 大段中文输出

- **WHEN** 子进程一次输出 9000 字节中文
- **THEN** bridge 切成多个 ≤4096 字节的分片，逐片发送，平台按序拼接可无损还原

#### Scenario: 断线期间的输出

- **WHEN** 任务运行中连接断开 30 秒，随后重连
- **THEN** 这 30 秒内的 `task_log` 在重连后按原顺序补发，平台日志不出现空洞

#### Scenario: 缓冲超限

- **WHEN** 断线期间日志总量超过缓冲上限
- **THEN** bridge 丢弃较早的分片，并先发一条 `[agent-bridge] 断线期间日志超出缓冲上限（N KB），已丢弃较早部分`，
  再接上保留的最新分片；任务本身不受影响
