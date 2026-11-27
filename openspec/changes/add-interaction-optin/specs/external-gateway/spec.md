# external-gateway 规格增量：ACP 会话的交互申请（allowInteractive）与 A2A 边界

> 挂在 external-gateway 能力域上（`add-a2a-acp-gateway` + `add-acp-session-memory` 已归档的正式 spec 之上做增量）。

## ADDED Requirements

### Requirement: ACP 会话的按任务交互申请

ACP `session/new` SHALL 接受可选扩展字段 `params._meta.allowInteractive`（严格布尔；非布尔值
SHALL 以 invalidParams 拒绝，不做类型猜测）。该会话随后每轮 `session/prompt`
发起的 bridge turn SHALL 带上 `allowInteractive`（首轮显式传，续轮由 turn.execution 继承）。
是否真正开放交互 SHALL 仍由**本机策略**二重决定：进程未以 `--interaction-enabled` 启动时，
即使客户端申请，turn 仍按非交互执行，ACP 权限请求被本机直接拒绝（不静默伪造选项，也不阻塞等待）。

#### Scenario: 申请后收到权限请求帧

- **WHEN** 进程以 `--interaction-enabled` 启动，客户端 `session/new` 带 `_meta.allowInteractive: true`，
  该轮 CLI 申请权限
- **THEN** `session/prompt` 的 SSE 流出现 `event: request`（`session/request_permission`，含 options），
  客户端以响应报文应答 `selected(optionId)` 后本轮继续，终帧为 `end_turn`

#### Scenario: 未申请时不产生请求帧

- **WHEN** 客户端未声明 `_meta.allowInteractive`（缺省）
- **THEN** turn 以非交互执行，CLI 的权限请求被本机直接拒绝，SSE 流不出现 `event: request`

### Requirement: A2A 表面的交互边界

A2A 表面 SHALL NOT 声称支持交互：其协议没有 agent→client 请求帧通道，`task_interaction_response`
也无从投递。因此 A2A `SendMessage` 的 `message.metadata.allowInteractive === true` SHALL 以
JSON-RPC error 拒绝（`-32000`，`data.code = 'interaction_not_supported'`），且 MUST NOT 创建任务
（幂等键不落账），而不是静默降级为非交互任务。

#### Scenario: A2A 请求交互被明确拒绝

- **WHEN** `SendMessage` 的 metadata 带 `allowInteractive: true`
- **THEN** 返回 -32000 + `data.code='interaction_not_supported'`，GetTask 对该 messageId 查不到任务
