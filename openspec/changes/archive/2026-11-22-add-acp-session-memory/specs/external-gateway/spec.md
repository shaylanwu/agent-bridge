# external-gateway 规格增量：ACP session/prompt 的 conversation 多轮

> 挂在 external-gateway 能力域上（add-a2a-acp-gateway 已归档的正式 spec 之上做增量）。

## MODIFIED Requirements

### Requirement: ACP session/prompt 的 conversation 多轮（替换 add-a2a-acp-gateway 的「session/prompt 一轮一任务」语义）

ACP `session/prompt` SHALL 走 bridge 的 conversation 编排：同一 acp 会话的首轮创建 bridge conversation
会话（`run_task` 语义），后续轮 `send_message` 续接**同一会话**（CLI 原生续接：resume / ACP session /
重放兜底，12 适配器续接矩阵；上下文由 CLI 持有，token 只传增量）。SSE 订阅 SHALL 先于发起
（dispatch 的同步事件零丢失）。「本轮结束」判定 SHALL 为 turn 终态语义：带本轮 turnId 的
`task_status{phase: waiting_user}` → result 帧（end_turn，会话保持开放）；turn failed/timeout/cancelled
→ 会话随之关闭（conversation 既有语义），后续 prompt SHALL 如实拒绝并提示 `session/new`。
conversation 编排未注入的进程 SHALL 回 -32004（能力未接入），不降级为单发任务。bridge 重启后
acp 会话绑定丢失（内存态）SHALL 走 sessionNotFound，不假装可续。

#### Scenario: 多轮续接

- **WHEN** 同一 acp 会话先「记住暗号 BANANA42」再问「暗号是什么」
- **THEN** 第二轮续接同一 bridge 会话（SSE `event: prompt` 的 taskId 相同、turn 标记为 continue），
  且回答引用第一轮内容（端到端断言见 `npm run e2e:gateway`）

#### Scenario: 会话终态后拒绝

- **WHEN** 轮次失败导致会话关闭后再次 prompt
- **THEN** 拒绝并提示「请 session/new 新建会话」，不静默换新会话（上下文已丢，不假装可续）

#### Scenario: 能力未接入诚实拒绝

- **WHEN** 进程未注入 conversation 编排（旧版本/只读模式）时收到 session/prompt
- **THEN** 回 -32004（能力未接入），不降级为「一轮一任务」的旧行为

## ADDED Requirements

### Requirement: ACP session/cancel 取消当前轮次

`session/cancel` SHALL 取消当前活动轮次（`cancel_turn` 编排，operationId 幂等）；无活动轮次时
静默成功（v1 notification 语义）。

#### Scenario: 取消进行中的轮次

- **WHEN** acp 会话有进行中的 turn 时收到 session/cancel
- **THEN** 走 cancel_turn 编排（经 Emitter 触发 prompt 流终帧），响应含 taskId 与 turnId
