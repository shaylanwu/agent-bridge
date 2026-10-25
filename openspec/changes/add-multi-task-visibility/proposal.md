# 变更提案：多任务实时可视（步骤流 / 容量水位 / 幂等 / 双表面面板）

## Why

平台批量调度场景（一次并行下发 20+ 任务）下，三方诉求在澄清后收敛为四块（2026-10-24 与用户两轮澄清确认）：

1. **实时状态回传**已有（逐条 `task_status` 即时上行），但平台**不知道设备还剩多少空位**，
   只能靠 `device_busy` 试错 —— 需要主动容量水位。
2. **平台页面的「步骤」面板没有数据**：`task_step` 消息在本仓库从未定义
   （澄清时核实：协议/契约/README 均无），是全新消息类型，**平台侧需实现消费端**。
3. **WS 重发会双跑**：`TaskSupervisor` 对重复 `taskId` 无去重（实测确认），
   网络抖动下平台重发同一 `run_task` 会重复 spawn —— 控制面有 `Idempotency-Key`，WS 通道没有。
4. **操作者看不到设备在跑什么**：主进程只有逐行日志，没有任务面板。

## What Changes

四个可独立验收的块（tasks.md 分批勾选）：

- **A1 任务幂等**：`TaskSupervisor` 增加按 `taskId` 去重（有界 LRU）。重复 `taskId` 且任务未终态：
  不重复 spawn，回当前状态快照；已终态：回放终态快照。纯本机行为，wire 无变化。
- **A2 容量水位**：`hello` 增加 `capacity: { maxTasks, maxQueued }`；新增上行消息
  `capacity_update { running, queued, maxTasks, maxQueued }`，在每次调度状态变化时发送
  （收口于 `TaskSupervisor` 观察者，平台/控制面两条通道共用同一调度器，天然都覆盖）。
  `capabilities` 加 `capacity`。
- **B 步骤流**：新增上行消息 `task_step { taskId, seq, action, label?, state, ok?, at }`。
  数据源分级：L1 codex/opencode（`--json` 事件流现成）；L2 claude/codebuddy（改 `stream-json`）；
  L3 其余 8 个纯文本工具**如实降级**（只报状态，不造假步骤），`agent_list` 逐项标注 `steps: true/false`。
  `capabilities` 加 `task-step`。
- **C 双表面面板**：终端启动后显示常驻状态表（四态圆点 + 步骤列，不再滚动日志；非 TTY 退化为日志）；
  本地 Web 面板挂在控制面（四态圆点、每行日志按钮：执行中走 SSE 实时流、排队中置灰、终态看缓冲）。

## Impact

- **对平台（第三方）**：wire 纯增量 —— 新消息类型与 hello 新字段均为可选，
  老平台收到不认识的 `task_step` / `capacity_update` 应忽略（能力经 `capabilities` 协商）。
  `task_step` 需要平台实现消费端才有 UI 价值，本提案给出完整字段定义与语义。
- **安全边界不变**：`task_step.label` 与日志同口径脱敏（家目录折叠、长串折叠）；
  面板不新增任何入站端口（Web 面板复用控制面回环监听，默认关闭红线不变）。
- **依赖极简不变**：终端状态表手写 ANSI，Web 面板为控制面内嵌静态页，均零新运行时依赖。
