## ADDED Requirements

### Requirement: 能力协商

bridge SHALL 在 `hello` 中携带 `capabilities: string[]`，列出本设备支持的**可选能力**，
使任何第三方平台能在握手阶段判断可用功能，而不是靠客户端版本号猜。

当前值：`["diff", "service-token", "queue", "scan-progress"]`。

#### Scenario: 平台按能力降级

- **WHEN** 平台收到的 `hello.capabilities` 不含 `diff`
- **THEN** 平台 SHALL NOT 下发 `captureDiff: true`，并按"无 diff 能力"渲染 UI

### Requirement: 服务身份透传

`run_task` / `cancel_task` SHALL 接受可选字段 `requestedBy`（≤128 字符）、`purpose`（≤64 字符）与
`serviceToken`（≤256 字符）。bridge SHALL 在终态 `task_status` 上回显 `requestedBy`，供平台落库审计。

#### Scenario: 回显给平台审计

- **WHEN** 平台下发 `run_task { requestedBy: "svc:repair-orchestrator" }`
- **THEN** 终态 `task_status` SHALL 携带同一个 `requestedBy`

#### Scenario: 超长/畸形字段

- **WHEN** `requestedBy` 超过 128 字符或不是字符串
- **THEN** bridge SHALL 忽略该字段（不报错），保持前向兼容
