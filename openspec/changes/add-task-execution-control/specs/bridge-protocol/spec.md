# bridge-protocol 规格增量：任务执行控制

## ADDED Requirements

### Requirement: 1.0 协议与执行能力

bridge SHALL 使用 `PROTOCOL_VERSION=1`，hello 直接声明完整 capabilities 与 execution，不发送/接受旧 0.2.x 协议，
不实现版本协商或双栈。capabilities SHALL 按实现声明 `permission-mode`、`task-interaction`、`elicitation-form`、
`session-feed`、`task-snapshot`、`artifact-inline`、`artifact-transfer`、`session-multi-turn`；execution SHALL 描述
permissionPolicy、interactionEnabled、interactionTimeoutMs、maxInteractionsPerTask。AgentListItem.executionModes
SHALL 按执行模式列出 permissionModes、interactionKinds、feedKinds，不声明未验证能力。

#### Scenario: 旧客户端连接 1.0

- **WHEN** 客户端发送旧 0.2.x hello/协议消息
- **THEN** bridge 明确拒绝并提示升级，不降级到旧任务/内存路径

#### Scenario: 本机允许 full 但关闭交互

- **WHEN** 本机为 allow-full 且 interaction_enabled=false
- **THEN** hello.execution 如实报告 allow-full/false；平台可为支持工具请求 full，但不得期待交互请求

#### Scenario: 工具在不同执行模式下能力不同

- **WHEN** 某工具 headless 支持 full，ACP 仅支持 default + permission
- **THEN** executionModes 分别列出这些能力；平台请求 full + ACP 时 bridge 在 spawn 前拒绝而不降级

### Requirement: 单任务权限模式

bridge SHALL 支持 `run_task.permissionMode: "default" | "full"`，按本机 permission_policy 解析缺省值。
`task_status.permissionMode` SHALL 只表示 bridge 选择并用于构造命令的策略，SHALL NOT 被解释为 CLI 实际权限证明。

#### Scenario: 本机 full 下的旧平台报文

- **WHEN** 本机显式为 full，旧平台下发不含 permissionMode 的 run_task
- **THEN** bridge 有意按 full 构造任务，不要求旧平台先理解新字段

#### Scenario: 工具不满足 full 运行条件

- **WHEN** 平台请求 full，但目标执行模式无映射或不满足本机隔离条件
- **THEN** bridge 回 failed/permission_mode_unsupported，不以 default 代替执行

### Requirement: 交互消息契约

bridge SHALL 定义 task_interaction_request（上行）、task_interaction_response（下行）、task_interaction_result（上行）。
每次交互 SHALL 使用 taskId + `ir_` + UUID requestId 关联，并包含 kind、createdAt、expiresAt。
每次下行响应 SHALL 另含 `rs_` + UUID responseId 标识 response occurrence；同 occurrence 重发必须复用，修正/新回答必须用新 ID。
permission SHALL 使用 ACP toolCall/options/outcome；elicitation SHALL 使用显式 `mode: "form"`、message、
requestedSchema 与 accept/decline/cancel。result SHALL 包含 requestState、responseStatus、resultSeq 和 at，并可选包含 responseId。

#### Scenario: 权限请求与选择

- **WHEN** adapter 产生工具权限请求
- **THEN** 上行包含规范化 toolCall 和 ACP options；平台以 selected optionId 或 cancelled 回复，
  bridge 校验后回 result 并恢复任务或按决定继续

#### Scenario: Form 问题与回答

- **WHEN** adapter 产生 elicitation/create Form 请求
- **THEN** 上行包含 message 和受限 requestedSchema；平台以 accept/decline/cancel 回复，
  accept content 经 schema 校验后交付 adapter，result 不回显 content

#### Scenario: 结果确认

- **WHEN** 响应被接受、重复、无效、冲突、迟到或交付不确定
- **THEN** result 分别表达 resolved/accepted、submitting 或 resolved/duplicate、pending/invalid、
  resolved/invalid + conflict、expired/cancelled + late、failed/interaction_delivery_unknown；
  同一 responseId 重放返回同一 resultSeq，新 response occurrence 使用新 resultSeq

### Requirement: 响应校验与幂等

bridge SHALL 校验 taskId、requestId、responseId、kind、当前 pending/submitting、optionId、响应形状和 Form content。
无效响应 SHALL NOT 交付 adapter，pending 保留以便使用新 responseId 修正重试。同一 responseId 且规范化指纹相同 SHALL 返回同一 result occurrence；
同一 responseId 携带不同指纹 SHALL 返回 interaction_response_conflict 且不改变原交付；
不同 responseId 的相同规范化响应 SHALL 返回 duplicate 和新 resultSeq，不同响应 SHALL 返回 interaction_response_conflict。
pending SHALL 在任何 await 前转为 submitting；成功写入才可 resolved，交付不确定 SHALL 变为 failed 并禁止重试。
未知 taskId/requestId 的响应 SHALL NOT 改变任务或调用 adapter。迟到响应不得恢复 expired/cancelled/failed 任务。

#### Scenario: 无效 option 后修正

- **WHEN** 平台先发送未提供的 optionId，再发送有效 optionId
- **THEN** 第一次回 pending/invalid，adapter 未收到响应；第二次可正常 resolved/accepted

#### Scenario: 同一 responseId 重放与新 occurrence

- **WHEN** 平台因断线以同一 responseId 重发，又以新 responseId 发送相同规范化响应
- **THEN** 前者返回原 resultSeq；后者返回 duplicate 和新 resultSeq，adapter 只收到一次

#### Scenario: 并发响应与交付不确定

- **WHEN** 一个响应已进入 adapter 写入，另一个响应到达，或写入结果无法确定
- **THEN** broker 以 submitting 单 flight 阻止并发写入；不确定时回 failed/interaction_delivery_unknown 并结束任务，禁止重试

#### Scenario: 已解决后收到不同响应

- **WHEN** request 已 resolved，平台以同 requestId 发送不同 option 或 content
- **THEN** bridge 回 interaction_response_conflict，原 resolution 不变，不再次调用 adapter

### Requirement: 等待状态与 A2A 映射

等待交互 SHALL 使用 `status: "running"` 和 `phase: "waiting_interaction"`，携带 interactionId 与 interactionKind；
conversation 回合间 SHALL 用 `status:"running"` + `phase:"waiting_user"`。两个 waiting phase 的并发语义不同：
waiting_interaction 占 active slot，waiting_user 不占。ACP 任务终态可选携带 stopReason，但不替代 TaskStatus。
A2A 映射：waiting_user 与普通 permission/Form 等待映射 INPUT_REQUIRED；仅 URL/OAuth 等待映射 AUTH_REQUIRED，二者不得混用。

#### Scenario: 等待与恢复

- **WHEN** 任务进入 waiting，随后有效响应交付
- **THEN** 先出现 waiting_interaction/interactionId，响应结果完成后恢复 running 并移除 interactionId

#### Scenario: A2A 终态映射

- **WHEN** bridge 任务分别为 queued/running/success/failed/cancelled
- **THEN** 依次映射 SUBMITTED/WORKING/COMPLETED/FAILED/CANCELED；启动前策略拒绝映射 REJECTED，timeout 映射 FAILED

### Requirement: CloudEvents 与断线重放

可恢复交互事件 SHALL 在重放时保持 source + id。request 的事件 id SHALL 为 `interaction:<requestId>`；
result 的事件 id SHALL 为 `interaction-result:<requestId>:<resultSeq>`。resultSeq SHALL 按 requestId 单调递增，
同一 occurrence 重放不变，新 occurrence 使用新 id。重连恢复 SHALL 以 broker 的 pending 与最新 result 快照为准，
不得仅依赖 Outbox 是否曾发送成功。

#### Scenario: 断线后重发 pending

- **WHEN** 请求等待期间 WS 断开并恢复
- **THEN** bridge 以原 requestId 和 CloudEvents source+id 重发 pending；平台重复响应仍幂等

#### Scenario: 无效响应后产生新结果

- **WHEN** 同一 request 先以 responseId A 产生 invalid result，之后以 responseId B 产生 accepted result
- **THEN** 两次 resultSeq 不同，CloudEvents id 不同；重放 A 返回原 invalid occurrence，重放 B 返回 accepted occurrence

### Requirement: Web Agent 会话呈现 Feed

bridge SHALL 提供 canonical 的 task_message、富 task_step 和 task_artifact 事件，供外部构建 Web Agent 会话窗口。
task_log SHALL 保留为调试通道，SHALL NOT 被文档宣称为稳定消息协议。**每任务只有一条 eventSeq 序列**，
覆盖 queued/running/waiting/终态 task_status、task_message、task_step、task_artifact 与 task_interaction_request；
task_log 与 task_interaction_result 不占 eventSeq，后者用 requestId+resultSeq 排序并可在任务终态后回传。
task_step 的 seq 仍表示步骤序号，不得与 eventSeq 混用。每个 feed 事件首次发出时分配一次，
重放保持，新事件严格 +1。终态 task_status 的 eventSeq 必须大于所有已发出的 canonical feed 事件。
task_message SHALL 支持 delta/complete，complete 携带权威完整 part；只有完整消息的适配器可只发 complete。

feed SHALL 同时受条数和字节预算限制。淘汰最旧事件时 SHALL 记录显式 gap（fromEventSeq/toEventSeq/reason），
SHALL NOT 静默造成时间线空洞。adapter 在终态前 SHALL 有界 flush 最终消息/附件，终态 task_status 的 eventSeq
SHALL 大于所有 feed 事件；收尾失败 SHALL 在终态标记 feedIncomplete。

#### Scenario: 文本增量与完成

- **WHEN** adapter 产生同一 messageId/partIndex 的文本增量
- **THEN** bridge 发 delta，最后发 complete 完整文本；客户端可用 complete 替换累积内容

#### Scenario: 富工具步骤

- **WHEN** adapter 提供工具调用元数据与安全内容
- **THEN** task_step 保留 legacy 字段并增加可选 ACP 风格 toolCall；rawInput/rawOutput 默认不上行，内容有界且脱敏

#### Scenario: 附件回传

- **WHEN** adapter 明确产生可信小文件
- **THEN** task_artifact 携带 name/mimeType/size/sha256 与可选 inline base64；超过上限只发元数据并明确不可下载；
  文件读取限制在任务 cwd realpath 子树，模型提供的路径不作为读取依据，符号链接/凭据路径拒绝

#### Scenario: 不支持的 feed 维度

- **WHEN** 某适配器无法可靠提取 assistant 文本或富工具内容
- **THEN** 其 executionModes/feed 能力如实缺省，不把 task_log 解析结果伪装成标准 task_message

### Requirement: 会话快照、附件补取与历史分页

bridge SHALL 支持 `get_task { taskId, include, afterEventSeq?, beforeEventSeq?, limit? }` 并回 `task_snapshot`。
游标三形态：不给游标回**尾部窗口**（最新 limit 条，刷新后重建当前状态）；afterEventSeq 用于实时补取
（严格大于游标、升序）；beforeEventSeq 用于历史回翻（严格小于游标的最新 limit 条，输出仍升序）。
afterEventSeq 与 beforeEventSeq 不得同时出现，同时出现回 `protocol_incompatible` 而不是静默挑一个。
limit 默认 200、上限 1000，单响应 1 MiB 是默认可配置安全策略。快照 SHALL 包含状态、permissionMode、
可选 stopReason、按 eventSeq 升序的 events、partialMessages、pendingInteraction、
eventWindow { oldestRetainedEventSeq, lastEventSeq, gaps }、hasMoreBefore、可选 prunedThrough 和 feedIncomplete，
SHALL NOT 包含 raw task_log、Form content 或大文件正文。任务不存在回 task_not_found（404，ID 从未存在）；
tombstone 命中回 session_deleted（410，会话被删除且 ID 永不复用，平台应放弃重试）；
游标落在已裁剪区间时仍回 `found: true`，但附 `errorCode: session_history_pruned`（410）与 prunedThrough，
表达「更早的部分已回收」，不得表现为「没有更早的历史」。close_session 只关闭会话、保留历史，
此类会话仍可读快照；「关了」与「没了」在协议层必须是两种结果。
1.0 不保留内存兼容路径。get_task 需要 session:read。

bridge SHALL 支持 `get_artifact { taskId, artifactId }`，返回同 eventSeq/artifactId 的保留 artifact；不得重新读取工作区。
未知或已淘汰 artifact 统一回 artifact_not_found；超过 inline 上限时返回元数据并标记 too_large，不返回二进制错误。

#### Scenario: Web 刷新后重建

- **WHEN** 外部 Web 会话在任务运行中刷新并发送 get_task
- **THEN** bridge 回当前状态、保留 events、partialMessages（已累积半截文本）、pending interaction 和 eventWindow；
  客户端从窗口末端继续应用新 eventSeq，不依赖原始日志重建

#### Scenario: 增量补取与历史回翻

- **WHEN** 客户端以 afterEventSeq 或 beforeEventSeq 请求
- **THEN** bridge 返回对应范围的有界事件、hasMoreBefore 与 gaps；缺失区间必须显式，不得表现为无事件

#### Scenario: 关闭与删除必须可区分

- **WHEN** 客户端对已 close_session 的会话发 get_task，或对已删除的会话发 get_task
- **THEN** 前者回 found:true 与完整历史（关闭不等于内容消失）；后者回 found:false + session_deleted（410），
  且同一 taskId 不得再被创建或复用；两者都不得用 task_not_found 含糊表示

#### Scenario: 快照或附件不可用

- **WHEN** 任务不存在/已删除/历史裁剪，或 artifact 未知/已淘汰
- **THEN** bridge 分别回 task_not_found/session_deleted/session_history_pruned/artifact_not_found；
  不返回伪空会话、不重新读取文件

### Requirement: 外部标准映射

ACP 映射 SHALL 使用 request_permission 与 elicitation/create 的原生语义；MCP Form 映射 SHALL 隔离版本承载差异；
A2A 映射 SHALL 使用 Message 的结构化 Part 和 TaskStatusUpdateEvent。权限扩展 SHALL 使用明确扩展 URI 或
`agent-bridge/permission` 命名空间，SHALL NOT 宣称为 A2A/MCP 原生权限能力。A2A v1.0.1 终态 SHALL 由
status.state 表达并关闭生命周期流，SHALL NOT 添加 final 字段。

#### Scenario: A2A Form 请求与回复

- **WHEN** 外部系统使用 A2A
- **THEN** agent Message 的 Part.data 携带 requestId 与 elicitation，user Message 以同 taskId/contextId 回复；
  若该请求 pending，messageId 映射为 responseId；否则映射为 send_message messageId；同时满足两类时按 conflict 拒绝

#### Scenario: A2A 会话消息与附件

- **WHEN** A2A 映射 task_message、task_artifact 或 task_snapshot
- **THEN** complete task_message 映射 agent Message/TextPart；小 artifact 映射 Artifact raw Part，
  大文件只映射元数据；kind/source/sha256/size/contentUnavailableReason 放在 Artifact.metadata 的 agent-bridge 命名空间；
  task_snapshot 对应 tasks/get + 扩展分页语义；system 消息不作为 A2A agent role 冒充，使用扩展 DataPart；
  delta 与 raw task_log 不作为 A2A 标准 Message

#### Scenario: MCP 敏感输入

- **WHEN** 请求涉及密码、token 或其他秘密
- **THEN** 不得降级到 Form；使用 URL Elicitation/安全外部流程，bridge 不接收或持久化 secret content

### Requirement: 终态幂等重放与终态后交互结果

所有同步拒绝与正常终态 SHALL 保留可重放快照。Emitter SHALL 允许同一 taskId 的完全相同终态 task_status 重放，
并 SHALL 拒绝不同终态及终态后的日志、步骤、running 和新 interaction_request。
已存在 request 的 task_interaction_result SHALL 即使在任务终态后也允许按 requestId+resultSeq 回传，
响应路由 SHALL 使用 broker 历史而不是 activeTasks，且不得再次交付 adapter。

生产模式 SHALL 以 SQLite idempotency/tombstone 为权威，taskId 永不复用；retention 删除内容后同 ID 再提交
SHALL 回 session_deleted 且永不 spawn。SQLite 是唯一权威，不使用 MAX_TRACKED 内存淘汰。历史裁剪导致 replay
不完整 SHALL 回 session_history_pruned。

#### Scenario: 同步拒绝后改参重发

- **WHEN** 首次任务因权限或交互策略被拒绝，平台以同 taskId 修改权限、args 或 allowInteractive 重发
- **THEN** 平台收到首次 failed 的相同终态回放，bridge 不重新校验、不 spawn

#### Scenario: 不同终态冲突

- **WHEN** 某 taskId 已终态后又出现不同内容的终态或新的 log/step/running
- **THEN** Emitter 丢弃这些冲突消息，不因新的 CloudEvents seq/id 而放行
