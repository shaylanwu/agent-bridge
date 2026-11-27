# task-execution 规格增量：声明式外部代理扩到 codex，且失败不再静默

## MODIFIED Requirements

### Requirement: 声明式外部代理解析（agy / codex）

声明了 `preferSystemProxy` 的适配器，其外部请求 SHALL 优先使用 `AGENT_BRIDGE_EXTERNAL_PROXY`；
未指定时，Windows SHALL 读取当前用户系统代理；显式设为 `off`/`none` SHALL 关闭代理注入（逃生口）。
codex 的 app-server 子进程 SHALL 使用与其他通道同一套环境构造（清掉宿主注入变量 + 代理解析），
SHALL NOT 直接继承 `process.env`。bridge SHALL NOT 把开发机端口写死到适配器，也 SHALL NOT
为未声明该行为的其他工具改变代理环境。

#### Scenario: codex 的 responses WebSocket 直连不可用

- **WHEN** 宿主环境没有代理变量，系统代理可用，codex 0.171 的 responses WebSocket 直连被丢
- **THEN** codex 子进程拿到系统代理，回合在数十秒内就开始产出 token，而不是先空转约 113s 再回退 HTTPS

#### Scenario: 系统代理配错

- **WHEN** 用户设置 `AGENT_BRIDGE_EXTERNAL_PROXY=off`
- **THEN** 不再读取系统代理、也不再注入任何代理变量；用户自带的 `HTTPS_PROXY` 保持原样

## ADDED Requirements

### Requirement: CLI 子进程 stderr 必须被消费

打开 `stderr` 管道的适配器 SHALL 持续读走子进程 stderr，SHALL NOT 只写不读。读到的内容 SHALL
保留有界尾部（约 4 KiB）用于错误消息诊断，SHALL NOT 无界累积。这样既不丢失失败原因，也避免
pipe 缓冲写满后子进程阻塞在 `write` 上造成的「回合挂死」。

#### Scenario: 子进程写满 stderr 缓冲

- **WHEN** codex app-server 在回合中持续往 stderr 写重连/回退提示
- **THEN** 子进程不会阻塞，协议流继续；失败时错误消息带上 stderr 尾部

### Requirement: 回合 Promise 不得产生未处理拒绝

适配器内部用于表示「回合结束」的 Promise SHALL 在被 `await` 之前就已是「已处理」状态；
握手阶段（initialize / thread / turn 启动）失败时 SHALL NOT 触发未处理拒绝 —— 那会按 Node
默认策略终止整个 bridge 进程。

#### Scenario: 子进程在握手期退出

- **WHEN** codex app-server 在 `initialize` 阶段就退出（例如命令不存在、配置损坏）
- **THEN** `runCodexPrompt` 以带 stderr 尾部的错误 reject，bridge 进程继续运行
