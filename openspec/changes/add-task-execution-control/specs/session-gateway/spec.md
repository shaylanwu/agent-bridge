# session-gateway 规格增量：完整目标态

## ADDED Requirements

### Requirement: 1.0 协议契约

bridge SHALL 使用 `PROTOCOL_VERSION=1`，不提供旧 0.2.x 协议/HTTP 兼容层。发布版本 SHALL 为 1.0.0；
session/附件 API SHALL 位于 `/v1/sessions`，旧 `/v1/tasks` 不再保留。平台、bridge、内置 UI 必须同批升级。

#### Scenario: 版本不匹配

- **WHEN** 客户端使用旧 0.2.x 协议或旧 `/v1/tasks`
- **THEN** 连接/请求被明确拒绝并提示升级，不做静默降级或双栈

#### Scenario: 1.0 启动

- **WHEN** bridge 1.0 启动
- **THEN** hello 直接声明 protocolVersion=1 和完整 capabilities/execution，无协商消息

### Requirement: Session 与 Turn 生命周期

bridge SHALL 将 taskId 作为持久 Session ID，Session 唯一键为 `(tenantId,taskId)`，并持久化稳定 contextId。
sessionMode 缺省 task；task 在回合结束且无 pending interaction 时关闭；conversation 仅对 continuation != single-turn 创建，
回合间进入 waiting_user。run_task 只创建 Session，不得续接已有 taskId；续接只走 send_message。

#### Scenario: conversation 回合结束

- **WHEN** conversation 的 Turn 完成且无 pending interaction
- **THEN** status=running、phase=waiting_user，释放 active slot，允许下一消息

#### Scenario: task 回合结束

- **WHEN** task 模式 Turn 完成
- **THEN** Session 终态关闭，后续 send_message 回 session_closed

#### Scenario: 不支持的 conversation

- **WHEN** 适配器 continuation=single-turn 却请求 conversation
- **THEN** 创建时回 session_not_continuable，不先接受再失败

### Requirement: 并发、超时与取消

waiting_interaction SHALL 占用 active slot，waiting_user SHALL NOT 占用；调度器不得只按 status 统计 active。
每 Turn 使用 turnTimeoutMs（旧 timeoutMs 仅约束首个 Turn），idleTimeoutMs 只约束 waiting_user。
close_session/cancel_turn/cancel_task SHALL 带 operationId 并持久化幂等；cancel_turn 带 turnId，可取消 queued/active Turn。

#### Scenario: 空闲会话

- **WHEN** conversation 进入 waiting_user
- **THEN** 不占 running slot；idleTimeoutMs 到期写 idle_expired 终态并释放资源

#### Scenario: 取消 queued turn

- **WHEN** cancel_turn 指向尚未开始的 Turn
- **THEN** 该 Turn 标记 cancelled 并写事件，不启动进程；同 operationId 重放返回原结果

#### Scenario: 崩溃恢复

- **WHEN** bridge kill -9 后重启
- **THEN** active Turn 标记 interrupted/failed，queued Turn 按持久顺序恢复调度；不自动重放未知副作用

### Requirement: 多轮消息与幂等

bridge SHALL 支持 `send_message {taskId,messageId,mode?,parts,respondedBy?}`，需要 session:write。消息唯一键为
`(tenantId,taskId,messageId)`；同 ID 同 parts/mode 返回原 ack，同 ID 不同内容回 message_conflict。
消息 SHALL 先持久化并分配 eventSeq，再回 message_ack {eventSeq,turnId,delivery:"queued"|"steered"|"duplicate"}。
mode 缺省 queue；steer 仅在 adapter 声明且当前 Turn active 时允许，不支持回 steer_unsupported，不静默改 queue。

#### Scenario: 多客户端同时发送

- **WHEN** 两个客户端并发发送不同 messageId
- **THEN** DB 串行器给它们确定 eventSeq/顺序，两方都能通过快照或事件流看到一致顺序

#### Scenario: 消息重复和冲突

- **WHEN** 同 messageId 重发相同/不同 parts
- **THEN** 相同返回原 ack；不同回 message_conflict，不覆盖原消息

#### Scenario: steer 不支持

- **WHEN** mode=steer 但 adapter 未声明 steer
- **THEN** 回 steer_unsupported，消息不悄悄变成 queued；客户端可显式改用 queue

### Requirement: 适配器会话策略

每个 AgentDef SHALL 按 executionMode 声明 continuation: native-session/resume-session/replay-session/single-turn，
以及 liveInteraction/steer 能力。12 个适配器 SHALL 至少实现 replay-session 多轮底线；single-turn 仅在 CLI 无法接受
后续 prompt 且有官方文档/实测证据时允许。replay 使用完整持久 transcript；模型上下文不足回 context_exhausted，不静默截断。
native-session 使用官方 session/load，进程按 Turn 回收，不长期占用 running slot。

#### Scenario: replay 会话

- **WHEN** 适配器声明 replay-session
- **THEN** 新 Turn 启动新进程并携带完整持久历史；超出上下文回 context_exhausted

#### Scenario: 伪造能力

- **WHEN** 适配器未声明某 live interaction/steer
- **THEN** 该能力不被宣布，请求相应互动时明确拒绝，不用 PTY/正则伪造

### Requirement: 持久授权账本

permissionMode=full SHALL 对所有 12 个适配器提供官方映射。持久授权 SHALL 仅由通过 `task:approve + approval:persist`
的鉴权人工响应创建，包含 tenant/principal/agent/tool/action/resource/scope/expiry，可撤销并写审计。
模型文本、tool title/kind、平台任务描述 SHALL NOT 创建授权或扩大 scope。ledger 自动命中必须同时满足：
当前请求提供 actual persistent allow option、tool fingerprint/scope 匹配、permissionMode=default。
full 下 SHALL NOT 用 ledger 自动批准，残余权限请求 SHALL fail closed；只有 allow_once 时不得伪造 optionId。

#### Scenario: allow_always

- **WHEN** 用户对提供 allow_always 的权限请求选择持久允许、具备 approval:persist 且本机 policy 允许
- **THEN** 写 approval ledger；后续 default 模式下实际提供对应 option 且 fingerprint 匹配时可自动命中，审计记录来源和期限

#### Scenario: ledger 与 full/only-once 冲突

- **WHEN** full 模式收到残余权限请求，或 default 请求只提供 allow_once 但 ledger 有匹配项
- **THEN** 不自动批准；full 走 fail closed，default 重新询问用户或取消，不构造不存在的 optionId

### Requirement: URL Elicitation 与秘密

bridge SHALL 支持 ACP/MCP URL Elicitation。事件流/DB/审计/snapshot SHALL 只保存 urlHost、elicitationId、TTL 和 hash，
不得保存完整 URL/secret；完整 URL 只存在短期加密内存，通过 `get_interaction_url` 在认证通道返回，进程重启即失效。
URL/OAuth 等待 SHALL 映射 A2A auth-required；其他等待映射 input-required。Form SHALL NOT 收集秘密。

#### Scenario: URL 过期/重启

- **WHEN** URL 的 TTL 到期或 bridge 重启
- **THEN** 回 interaction_url_expired，不重新构造旧 URL；会话仍可按策略取消/重试

#### Scenario: Form 请求 secret

- **WHEN** Form 试图收集密码/API Key/token/支付凭据
- **THEN** 拒绝并改用 URL/安全流程，不落 secret

### Requirement: 双向附件传输

bridge SHALL 支持 artifact_upload_start/ready/chunk/ack/complete/result 与 artifact_download_start/ready/chunk/ack/complete/result，
以及 status/abort。transferId 由 bridge 生成并绑定 tenant/principal/session；operationId 幂等。传输 SHALL 使用
offset、chunkSha256、整文件 sha256 和可续传 ack；offset 必须连续，重复 chunk 重发当前 ack，乱序回 out_of_order+expected。
内容 SHALL 存入 tenant 分区 CAS，大小/磁盘预算配置化，无硬编码产品上限。上传 commit 后才生成 artifactId/eventSeq；
下载从 CAS 读取，不重新读工作区。入站文件隔离、不自动执行，可配置扫描/quarantine。

#### Scenario: 上传断线续传

- **WHEN** 上传中断后以 status/同 transferId 重连
- **THEN** 返回 persisted nextOffset，客户端从该 offset 继续；最终整文件 hash 不符则失败，不生成半个 artifact

#### Scenario: 下载流控

- **WHEN** 客户端 ack 变慢
- **THEN** bridge 按窗口暂停发送，不无限缓存；断线后可按 nextOffset 继续

#### Scenario: 磁盘不足

- **WHEN** storage quota 不足
- **THEN** 回 insufficient_storage，不推进 nextOffset，不提交 artifact；已确认 chunk 可续传

### Requirement: 持久化、恢复与保留

生产模式 SHALL 以 SQLite（better-sqlite3/WAL）为权威源，持久化 Session/Turn/Message/Event/Interaction/Approval/Idempotency/
Artifact/Tombstone。eventSeq 与业务状态同事务提交。进程重启后 active Turn 标记 interrupted，queued Turn 恢复，
waiting_user 保留，pending interaction 取消/过期，messageId/responseId/taskId 幂等继续生效，未完成 transfer 可续传。
taskId 在 tenant 内永不复用；retention 删除内容后保留 tombstone，同 ID 回 session_deleted；历史裁剪回 session_history_pruned。

#### Scenario: kill -9 恢复

- **WHEN** bridge 在 Turn 执行中崩溃并重启
- **THEN** 原 Turn 标记 interrupted 并写事件，Session 可按策略继续/关闭；不重复 spawn 原 Turn，不丢失已提交消息

#### Scenario: 删除后同 ID 重提

- **WHEN** 会话内容已删除但 tombstone 存在
- **THEN** 同 tenant/taskId 回 session_deleted，不创建新执行；tombstone 不可清理到可复用窗口

#### Scenario: 数据损坏

- **WHEN** SQLite 完整性检查失败
- **THEN** bridge 拒绝启动业务并给出恢复指引，不静默重建空库

### Requirement: 外部网关映射

bridge SHALL 提供 canonical WS/HTTP；A2A/ACP/MCP 网关 SHALL 映射同一 Session/Turn/Event/Artifact 模型。
A2A waiting_user/普通 permission/Form ↔ INPUT_REQUIRED，仅 URL/OAuth ↔ AUTH_REQUIRED。A2A 入站 DataPart 含
requestId/responseId 且 pending 时走 interaction response，否则走 send_message；二者同时出现按 conflict 拒绝。
ACP permission/elicitation 用原生语义；MCP 权限用命名空间扩展。所有网关不得绕过 scope、tenant、eventSeq 或订阅过滤。

#### Scenario: A2A 多轮

- **WHEN** A2A 客户端在 input-required 后用同 taskId/contextId 发送普通 Message
- **THEN** 映射为 send_message 新 Turn，返回同一 Session 的更新 Task/Message

#### Scenario: A2A 交互回复

- **WHEN** Message DataPart 带 pending requestId/responseId
- **THEN** 映射为 interaction response；若同时像普通消息则拒绝歧义，不重复执行

#### Scenario: 跨租户订阅

- **WHEN** 连接订阅未授权/其他租户 Session
- **THEN** 返回 not found/forbidden，且任何广播/webhook 不包含该 Session 事件

### Requirement: 身份、租户与授权

bridge SHALL 校验 service scopes 和可选 principal JWT（issuer/audience/JWKS）。权威 scopes 为 session:create/read/write/close、
task:approve/respond、approval:persist、artifact:read/write、interaction:url、admin；不保留旧 task:create/read/cancel 别名。
tenant/principal 写入 Session/Event/Audit。跨租户/不存在资源回 404，不泄露存在性；
同租户 scope 不足回 403；401 仅认证失败。所有写命令幂等。

#### Scenario: 旧 token

- **WHEN** 旧 token 只有 task:create/read/cancel
- **THEN** 1.0 不映射旧 scope；调用 session API 被拒绝，必须重新签发 session/artifact scopes

#### Scenario: 审批 scope

- **WHEN** 只有 session:create 的令牌尝试 approve/respond/persist
- **THEN** 拒绝并保持 pending 不变；持久授权还要求 approval:persist

#### Scenario: 跨租户读取

- **WHEN** 租户 A 读取租户 B 的 taskId
- **THEN** 统一返回 not found，不泄露资源或附件

### Requirement: 可观测性与容量治理

bridge SHALL 生成 OpenTelemetry trace/metrics，指标包含 active sessions/turns、queue、interaction、artifact、DB/WAL；
traceparent 贯穿 Turn/Tool/Interaction/Artifact。quota、retention、backpressure SHALL 配置化；队列/缓存满 SHALL fail closed
并保留 cursor，不得静默丢事件。慢消费者 SHALL 可断开并用 eventSeq 恢复。SQLite 为唯一权威，不使用 MAX_TRACKED 限制 task 数量。

#### Scenario: 慢客户端

- **WHEN** WebSocket 客户端消费过慢导致缓冲超限
- **THEN** 断开该订阅，任务继续；客户端用 lastEventSeq + get_task 恢复，不阻塞其他客户端

#### Scenario: 配额调整

- **WHEN** 部署方提高附件/会话/队列预算
- **THEN** 无需改代码即可生效；达到预算时有明确错误和可恢复 cursor
