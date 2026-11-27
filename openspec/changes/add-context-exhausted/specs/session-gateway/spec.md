# session-gateway 规格增量：`context_exhausted` 的识别与结算

> 挂在 session-gateway 能力域上（对 `openspec/specs/session-gateway/spec.md` 的「适配器会话策略」做修改，并新增一条 Requirement）。

## MODIFIED Requirements

### Requirement: 适配器会话策略

每个 AgentDef SHALL 按 executionMode 声明 continuation: native-session/resume-session/replay-session/single-turn，
以及 liveInteraction/steer 能力。12 个适配器 SHALL 至少实现 replay-session 多轮底线；single-turn 仅在 CLI 无法接受
后续 prompt 且有官方文档/实测证据时允许。replay SHALL 使用完整持久 transcript，**SHALL NOT 静默截断历史**；
模型上下文不足时 SHALL 以 `context_exhausted` 结算该回合（识别规则见下条 Requirement），
不得让平台从 `agent_error` 里猜。

#### Scenario: replay 会话

- **WHEN** 适配器声明 replay-session
- **THEN** 新 Turn 启动新进程并携带完整持久历史；超出上下文回 `context_exhausted`，
  **不裁剪、不静默截断**历史，也不自动改用「只带最后 N 条」的降级重放

#### Scenario: native-session 会话

- **WHEN** 适配器声明 native-session
- **THEN** 使用官方 `session/load` 续接，进程按 Turn 回收，不长期占用 running slot

#### Scenario: 伪造能力

- **WHEN** 适配器未声明某 live interaction/steer
- **THEN** 该能力不被宣布，请求相应互动时明确拒绝，不用 PTY/正则伪造

## ADDED Requirements

### Requirement: 上下文超限的反应式识别

bridge SHALL NOT 预测模型上下文预算（不维护「模型 → 窗口大小」映射表，也不自行估算 token 数）：
判定依据 SHALL 只来自**本轮失败输出里 CLI 自己给出的超限信号**（stderr / stream-json result 错误 /
ACP error 帧 / app-server JSON-RPC error 文本）。

识别命中时，该回合 SHALL 以 `status=failed` + `errorCode=context_exhausted` 结算，
`error` SHALL 保留 CLI 原文（覆盖原文会让用户失去可操作信息）。识别规则 SHALL 要求
「上下文或 token 量词」与「超限语义」同时出现，以避免把额度不足、认证失败、普通超时误判为超限。

无法识别时 SHALL 维持 `agent_error`：**宁可不报，不得虚报**。该错误码 SHALL 只替换
`agent_error`，SHALL NOT 改变成功路径、取消路径或超时路径的结算码。

#### Scenario: CLI 报告上下文超限

- **WHEN** 回合失败且失败文本同时包含上下文/token 量词与超限语义
  （如 `prompt is too long: 213456 tokens > 200000 maximum`、`context_length_exceeded`）
- **THEN** 终态为 `failed`，`errorCode=context_exhausted`，`error` 保留 CLI 原文；
  平台据此提示用户「开新会话/缩短历史」，而不是原样重试

#### Scenario: 无法识别为超限的失败

- **WHEN** 回合失败但文本只表达认证失败、额度用尽、普通崩溃或超时
- **THEN** `errorCode` 维持 `agent_error`（或各自的既有受控码），不出现 `context_exhausted`

#### Scenario: 成功与取消不受影响

- **WHEN** 回合以 success 或 cancelled 结算
- **THEN** 结算码不变，分类器不参与判定
