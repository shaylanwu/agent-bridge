# external-gateway 规格

## Purpose

定义 A2A / ACP 外部网关（挂在本地控制面上的标准协议表面）的边界。本能力规格**按提案增量逐步建立**，
当前覆盖：`add-a2a-acp-gateway`（A2A 四方法、ACP v1 方法集、vendor HTTP 承载、安全与隔离）、
`add-acp-session-memory`（ACP session/prompt 的 conversation 多轮语义）。

网关是**适配层**：复用 `TaskSupervisor / SessionStore / Emitter` 与控制面的编排核心，不复制调度、
不复制持久化、不另开监听端口（listen 红线限定 `auth.ts`/`control-plane.ts`）。

## Requirements

### Requirement: 部署形态与单一编排

网关 SHALL 挂在本地回环控制面的 HTTP 服务器上，不另开监听端口（listen 红线限定 `auth.ts`/`control-plane.ts`），
回环绑定、鉴权、审计与 `/v1/*` 同一套。任务创建/取消 SHALL 复用控制面的同一编排核心（createTaskCore/cancelTaskCore），
并发上限、权限策略、幂等语义、上行出口（`Emitter.emit()`）对所有通道单一真源。网关 SHALL 默认关闭
（`[gateway] enabled` / `AGENT_BRIDGE_GATEWAY`），未启用时网关路由一律 404，不暴露存在性；
`a2a`/`acp` 子开关可单独关掉某个表面。网关 SHALL NOT 返回 CORS 头。

#### Scenario: 默认关闭

- **WHEN** 未配置 `[gateway]` 或 `AGENT_BRIDGE_GATEWAY` 非 1
- **THEN** `/a2a`、`/acp`、`/.well-known/agent-card.json` 全部 404，控制面行为与无网关时完全一致

#### Scenario: 非回环不可达

- **WHEN** 网关收到非回环来源请求（如被端口转发）
- **THEN** 控制面纵深防御拒绝该请求，网关层无需重复实现

#### Scenario: 跨租户不可见

- **WHEN** 请求方租户与目标任务租户不一致
- **THEN** 统一按「不存在」应答（A2A: JSON-RPC -32001；ACP: sessionNotFound），不泄露「存在但不是你的」

### Requirement: A2A 表面（agent card + 四方法）

网关 SHALL 提供 `GET /.well-known/agent-card.json`（静态描述、免鉴权、不含任务数据；capabilities 只声明
已实现项；skills 来自静态适配器表）。`POST /a2a` SHALL 为 JSON-RPC 2.0 单对象，方法名 v1.0 PascalCase
与 0.3 小写都接受，版本协商走 `A2A-Version` 头（空/缺省按 0.3；`1.0` 用 `TASK_STATE_*` 拼写；其余 -32009）。
`tasks/get` SHALL 返回当前快照（history 只含 complete 消息；`task_log` 不冒充标准消息，只在
`Task.metadata.bridge.taskLogEndpoint` 给指引；附件为 file part 指向控制面下载端点）。
`message/send` SHALL 用 `message.metadata` 的 bridge 扩展字段（`agentType` 受管白名单、`cwd` 必填），
`messageId` 即幂等键（同 id 重发返回同一 task），且立即返回不阻塞长任务。
`tasks/cancel` SHALL 与 `:cancel` 同一条取消编排（终态 -32002）。`tasks/resubscribe` SHALL 用
`eventSeq` 补洞（SSE 流：首帧快照 → 持久化回放 → 实时帧 → 终态 done；`afterEventSeq` 游标）。
未实现的方法 SHALL 回 -32004 而非降级或假成功。状态映射：queued→SUBMITTED、running→WORKING、
waiting_interaction/waiting_user→INPUT_REQUIRED、success→COMPLETED、failed/timeout→FAILED
（真实归因放 `metadata.bridge.statusDetail`）、cancelled→CANCELED。

#### Scenario: 版本协商

- **WHEN** 客户端带 `A2A-Version: 1.0`
- **THEN** TaskState 用 `TASK_STATE_*` 拼写、无 `kind` 判别字段、part 判别为 `kind`
- **WHEN** 头为空或 `0.3`
- **THEN** 连字符小写拼写、`kind: 'task'` 判别、part 判别为 `type`
- **WHEN** 头为 `2.0` 等未支持版本
- **THEN** JSON-RPC -32009，不猜语义

#### Scenario: messageId 幂等

- **WHEN** 同一 `messageId` 重发 `message/send`
- **THEN** 返回同一 taskId 且 `metadata.idempotentReplay: true`，不重复调度
- **WHEN** 同 `messageId` 异参
- **THEN** 回 -32000 + `data.code: idempotency_conflict`，不覆盖原任务

#### Scenario: 订阅补洞

- **WHEN** `tasks/resubscribe` 带 `params.metadata.afterEventSeq: N`
- **THEN** 只回放 N 之后的事件，帧序列 task/message/status/artifact（带 eventSeq）→ done
- **WHEN** 目标任务已终态
- **THEN** 回 -32004（规范语义），不开流

### Requirement: ACP 表面（v1 方法集 + vendor HTTP 承载）

ACP 网关 SHALL 实现 `initialize`（只声明真实能力：`loadSession: false`、text-only prompt、
fs/terminal 客户端能力不开放）、`session/new`（固化 `params.cwd` 与 `params._meta.agentType`，
12 个受管 CLI 必须显式选择）、`session/prompt`（conversation 多轮语义，见下）、`session/cancel`
（取消当前轮次，`cancel_turn` 编排，operationId 幂等；无活动轮次静默成功——notification 语义）。
HTTP 承载 SHALL 采用 vendor 约定（ACP Transports RFD 未定稿期间）：请求走 `POST /acp`；
`session/prompt` 的下行走 SSE 流（`event: prompt` → `event: update`（session/update 通知）→
交互时 `event: request` → `event: result` 终帧）；turn 失败/超时 SHALL 以 JSON-RPC error 表达，
不产出假 stopReason。任务进入 `waiting_interaction` 时，prompt 流 SHALL 注入 agent→client 请求帧
（permission → `session/request_permission`；form/auth-url → `elicitation/create`，form/url 两种 mode），
出站请求 id 由网关生成且 MUST 与其它计数域隔离。客户端应答 SHALL 走另一条 `POST /acp` 的响应报文
（无 method、带网关下发 id + result），网关转成 `task_interaction_response` 走与
`POST /v1/interactions/{id}:respond` 相同的 dispatch 路径（permission 要 `task:approve`，
form/auth-url 要 `task:respond`，双重判定）。

#### Scenario: 交互闭环

- **WHEN** 任务进入 waiting_interaction 且 store 存在 pending permission 交互
- **THEN** prompt 流出现 `event: request` 帧（含 options），客户端 POST /acp 应答 selected(optionId) 后，
  dispatch 层收到 `task_interaction_response`（state=accepted、payload={optionId}），任务继续
- **WHEN** 应答的 id 不是网关下发的出站请求 id
- **THEN** 404，不猜关联

#### Scenario: 失败终态诚实

- **WHEN** prompt 对应轮次以 timeout/failed 结束
- **THEN** `event: result` 帧是 JSON-RPC error（code -32000 + data.bridgeStatus），不返回 end_turn 假成功

### Requirement: ACP session/prompt 的 conversation 多轮（add-acp-session-memory）

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

### Requirement: 端到端验证

网关 SHALL 附带端到端冒烟（`npm run e2e:gateway`）：真 bridge 进程 + 真服务令牌 + 真跑一次本机 CLI，
覆盖 A2A send/get/cancel、messageId 幂等、ACP prompt/cancel 与多轮记忆（两轮对话内容引用断言）；
permission/form 交互闭环由真 store + 真 SSE + 同一 dispatch 路径的单元测试覆盖。CLI 出网代理与
系统代理不一致时 SHALL 支持 `E2E_PROXY` 覆盖。

#### Scenario: 真 CLI 冒烟

- **WHEN** 运行 `npm run e2e:gateway`
- **THEN** A2A 任务真实执行到 COMPLETED 且 history 非空；CancelTask 真实 SIGTERM；
  ACP 同会话第二轮回答引用第一轮内容；任何一项失败即退出码非 0
