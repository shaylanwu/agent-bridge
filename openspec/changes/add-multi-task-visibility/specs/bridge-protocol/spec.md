## ADDED Requirements

### Requirement: 容量水位上报

bridge SHALL 在 `hello` 中携带 `capacity: { maxTasks, maxQueued }`（本次会话生效值），
并 SHALL 在每次调度状态变化（任务入队 / 启动 / 终态）后发送 `capacity_update` 上行消息：
`{ running, queued, maxTasks, maxQueued }`。平台与控制面两条通道 SHALL 共用同一调度器，
水位 SHALL 反映两条通道的合计占用。

#### Scenario: 握手即知上限

- **WHEN** 设备以 `--max-tasks=12 --max-queue=100` 启动并连上平台
- **THEN** `hello.capacity` 为 `{ maxTasks: 12, maxQueued: 100 }`（与环境变量/配置无关）

#### Scenario: 状态变化即上报

- **WHEN** 一个任务从队列启动（running 3→4，queued 5→4）
- **THEN** bridge 发送一条 `capacity_update { running: 4, queued: 4, ... }`，平台无需等待终态

### Requirement: 任务步骤上报

bridge SHALL 为具备结构化事件输出的工具（适配器逐项标注）把子进程的**动态步骤流**以
`task_step` 上行消息回传：`{ taskId, seq, action, label?, state, ok?, at }`。
`seq` SHALL 从 1 开始按发生顺序单调递增；`state` 为 `started | finished`，`finished` 时
SHALL 带 `ok`；`label` SHALL 截断（≤160 字符）并按日志同口径脱敏。
不具备结构化事件的工具 SHALL NOT 发送伪造步骤，且 SHALL 在 `agent_list` / `scan_result`
中逐项以 `steps: false` 如实标注。任务终态后的 `task_step` SHALL 被丢弃（与 `task_log` 同规则）。

#### Scenario: 结构化工具的步骤流

- **WHEN** 平台对一个 `steps: true` 的工具下发任务，CLI 依次执行 Read → Edit → Bash
- **THEN** 平台按序收到三条 `task_step`（seq 1/2/3，action 分别为 Read/Edit/Bash），
  步骤面板可实时渲染「当前在第几步」

#### Scenario: 纯文本工具如实降级

- **WHEN** 平台对一个 `steps: false` 的工具下发任务
- **THEN** 平台只收到 `task_status` / `task_log`，不会收到任何 `task_step`
