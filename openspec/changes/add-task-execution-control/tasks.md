# 实施清单：add-task-execution-control

> 状态：方案已于 2026-10-25 人工确认，作为 1.0.0 实施基线。分阶段实施。
> Phase 1 切片（2026-10-25）：包/协议版本 v1、better-sqlite3、SessionStore（事件幂等/快照/tombstone）、
> stateDbPath、harness/e2e 版本对齐；未接执行路径与新增 wire 消息。

## 1. 决策、标准与安全边界

- [x] 1.1 合并 full permission 与 task interaction 为同一总体提案，change-id 改为 add-task-execution-control
- [x] 1.2 核查 A2A v1.0.1、ACP v1 Tool Calls/Elicitation、MCP Elicitation、CloudEvents 官方语义
- [x] 1.3 12 个 CLI full 参数核查；确认 CodeBuddy ACP 与 DSH ACP 可作为 native-session 双向适配候选
- [x] 1.4 明确 canonical model、ACP/MCP/A2A 映射、JSON Schema 子集、AsyncAPI/OpenAPI 契约
- [x] 1.5 明确 executionModes 按执行模式声明能力，避免 headless full 与 ACP interaction 错误组合
- [x] 1.6 明确空 args 不是配置沙箱、Form 不收秘密、平台不能控制 external_sandbox/env
- [x] 1.7 人工批准 1.0、协议 v1、allowInteractive 生效、双向 stdio、Emitter 与执行器高风险改动（2026-10-25 确认方案）
- [ ] 1.8 人工维护 `.harness`：CodeBuddy 唯一固定 env 例外及交互适配器受控 stdin pipe（Agent 不改护栏）
- [ ] 1.9 包版本设为 1.0.0、协议版本设为 1；移除 0.2.x 协议/HTTP/scope 兼容代码与 fixtures

## 2. 共同协议与配置内核

- [ ] 2.1 `PROTOCOL_VERSION=1`；新增 permission-mode/task-interaction/elicitation-form/session-feed/task-snapshot/artifact-inline capabilities
- [ ] 2.2 新增 PermissionMode、ExecutionMode/InteractionKind/FeedKind、hello.execution、AgentListItem.executionModes
- [ ] 2.3 新增 task_interaction_request/response/result 联合类型与运行期校验；responseId 标识响应 occurrence，resultSeq 单调且可重放
- [ ] 2.4 run_task 接收 permissionMode/allowInteractive；task_status 增加 permissionMode、waiting_interaction、interactionId、可选 stopReason
- [ ] 2.5 新增 permission/interaction 受控错误码及 HTTP/JSON-RPC 映射表
- [ ] 2.6 增加 permission_policy/external_sandbox/interaction_enabled/interaction_timeout_ms/max_interactions_per_task
       及 connect/serve 启动参数；默认 default/false/false/900000/16
- [ ] 2.7 配置序列化、logout 保留业务设置、非法值、v1 hello/capabilities 单测
- [ ] 2.8 新增 task_message、富 task_step、统一 eventSeq、task_artifact、get_task/task_snapshot/get_artifact 类型与运行期校验
- [ ] 2.9 新增 canonical feed 与 artifact 上限配置；task_log 明确为调试通道而非稳定 UI 协议

## 3. 调度、幂等与 Emitter 共同内核

- [ ] 3.1 TaskState 增加 waiting；waiting 仍占 running 名额，总 timeoutMs 继续从入队计时
- [ ] 3.2 新建每 supervisor 一个 InteractionBroker：pending/submitting/resolved/failed、responseId 去重、single-flight、等待超时、最新 result 快照、resultSeq
- [ ] 3.3 所有权限/参数/交互同步拒绝创建并跟踪 settled Entry；同 taskId 改参重发不重新校验、不 spawn；
       SQLite 为唯一权威；不使用内存 MAX_TRACKED 淘汰
- [ ] 3.4 Emitter 以脱敏后终态指纹允许完全相同终态重放，拒绝不同终态及终态后 log/step/running；
       终态去重容量与 supervisor 协调，禁止通过静默淘汰产生可重复执行窗口
- [ ] 3.5 可恢复交互事件使用稳定 source+id：request 按 requestId，result 按 requestId+resultSeq；
       responseId 重放返回同一 result occurrence，不拆成新 resultSeq
- [ ] 3.6 Outbox 溢出后仍能从 broker 最新 pending/result 快照恢复；审计不因重放重复记录
- [ ] 3.7 Emitter 在任务终态后仍允许已存在交互的 result，禁止新 interaction_request；响应路由不依赖 activeTasks
- [ ] 3.8 TaskRegistry 保存 waiting 与 pending 快照；终端/Web 任务视图展示等待原因和当前 requestId，不显示用户响应 content
- [ ] 3.9 每任务单序列 eventSeq；200/200/50、4 MiB/64 MiB 仅作默认配置，可调；淘汰记 gap、保留 pending/最新状态；
       终态前有界 flush 最终 complete/artifact，终态 eventSeq 最后分配并可标记 feedIncomplete

## 4. Phase 1：12 工具 full

- [ ] 4.1 AgentDef 登记 12 个通用 full 映射与 executionModes；禁止开发机路径、用户名和版本特判
- [ ] 4.2 实现 permissionPolicy 解析与默认模板 argv 合成；allow-full/full 只接受空 args
- [ ] 4.3 DSH 使用两个官方 headless 参数；Kimi 不重复 auto；其余 9 个工具按矩阵精确实现
- [ ] 4.4 CodeBuddy 仅在 full+external_sandbox 时固定注入 CODEBUDDY_IS_SANDBOX=1，其他环境逐变量不变
- [ ] 4.5 无映射/策略拒绝/非空 args/CodeBuddy 未声明隔离均不 spawn；旧 CLI 失败不自动降级
- [ ] 4.6 task_status 回显 bridge 选择策略并写审计，不表述为 CLI 实际权限证明
- [ ] 4.7 扩展 step parsers：从 12 个结构化输出提取 agent text/messageId 与完整/增量消息；未验证能力不声明
- [ ] 4.8 富 toolCall 元数据与有界 text/diff/terminal 内容映射；rawInput/rawOutput 默认不上行
- [ ] 4.9 artifact 只从 adapter 明确事件提取；限制任务 cwd realpath 子树、同 fd 读取、size/SHA-256；
       拒绝符号链接/凭据路径；超限只发元数据，不扫描工作区

## 5. Phase 2：交互内核与 ACP

- [ ] 5.1 allowInteractive + interaction_enabled 双开关；无能力工具/组合在 spawn 前拒绝
- [ ] 5.2 实现通用 ACP stdio client：initialize/session/new/session/prompt/update/session/cancel/close、分片 JSONL、帧上限
- [ ] 5.3 ACP 任务以 session/prompt 回合响应结算；映射 end_turn/max_tokens/max_turn_requests/refusal/cancelled 与 JSON-RPC error；
       未决交互未结束时 agent_protocol_error，提前 close 与常驻进程分别处理，终态只 settle 一次
- [ ] 5.4 ACP fs/terminal 等未评审 client 方法返回 UnsupportedOperation，不自动执行
- [ ] 5.5 CodeBuddy ACP 与 DSH ACP 适配；只上报实际通过测试的 executionModes/interactionKinds
- [ ] 5.6 full + ACP 必须显式实现会话权限配置，未实现时拒绝，不借用 headless full 参数冒充
- [ ] 5.7 权限请求映射 toolCall/options/outcome；once 选项、取消、过滤 persistent、optionId 校验；
       超时/full 残余权限只有存在 reject_once 才可选择，否则 cancelled + interaction_timeout/interaction_denied
- [ ] 5.8 Form 映射 mode/message/requestedSchema/action/content；实现无依赖的扁平 schema 双方校验；
       不按字段名猜 secret，明确的 URL/敏感流程才拒绝，普通 Form 依赖 Agent 合规与人工审查
- [ ] 5.9 实现等待超时、Turn 超时、取消、每任务一个 pending、可配置交互限流与 interaction_timeout；
       取消回合用 session/cancel，pending 权限/Form 以原 JSON-RPC id 回复 cancelled/cancel，按 stopReason=cancelled 结算；
       kill grace 到期即使无 stopReason 也强制终止并按 cancelled/timeout 结算
- [ ] 5.10 实现 pending→submitting 单 flight、responseId occurrence 去重、无效响应可重试、相同响应 duplicate、
       不同响应 conflict、写入不确定 delivery_unknown 后禁止重试、迟到响应不恢复
- [ ] 5.11 实现 task:approve/task:respond scope；respondedBy 与内容脱敏审计，Form content 不落审计/result
- [ ] 5.12 实现 get_task/task_snapshot/get_artifact 与 `/v1/sessions/{id}/snapshot`；session:read、
       before/after 游标、partialMessages、eventWindow/gaps、task_not_found/session_deleted/session_history_pruned/artifact_not_found

## 6. 外部接口与文档

- [ ] 6.1 `contracts/asyncapi-3.0.yaml` 完整描述 v1 消息、executionModes、交互联合类型和示例
- [ ] 6.2 `contracts/openapi.control-plane.yaml` 增加任务字段、交互查询/回复端点与 RFC 9457
- [ ] 6.3 本地 HTTP：GET /v1/interactions、GET /v1/interactions/{id}、POST /v1/interactions/{id}:respond；SSE 复用
- [ ] 6.4 编写 A2A TaskState/Message/Part/TaskStatusUpdateEvent 映射与扩展 URI，明确权限不是 A2A 原生能力；
       v1.0.1 终态由 status.state 表达并关闭流，不添加 final 字段
- [ ] 6.5 编写 ACP/MCP 映射：ACP 显式 form、MCP 版本承载差异隔离、权限使用 agent-bridge 命名空间
- [ ] 6.6 两份 README、站点协议/CLI/集成文档、错误码、配置、12 工具矩阵和安全边界同批更新
- [ ] 6.7 文档示例使用通用路径/ID/token/URL，不引用开发机配置，不宣称未实现能力
- [ ] 6.8 编写 task_message/task_artifact/task_snapshot 到 A2A Message/Artifact/tasks-get 的映射；delta 与 raw log 不冒充标准消息

## 7. 验证

- [ ] 7.1 策略矩阵、12 argv、CodeBuddy env 作用域、受管 args、不同 HOME/cwd 可移植性
- [ ] 7.2 状态机：queued/running/waiting/settled、waiting 名额、总/单次超时、五种 stopReason、JSON-RPC error、未决交互与 close 竞态
- [ ] 7.3 权限：allow_once/reject_once/cancelled、persistent 过滤、伪造 optionId、title/kind 不参与自动批准
- [ ] 7.4 Form：accept/decline/cancel、required/default/enum/格式/大小、秘密与 URL 模式明确拒绝
- [ ] 7.5 响应：responseId 重放保持 resultSeq、修正用新 responseId、invalid 重试、submitting/resolved duplicate、
       conflict、late、delivery_unknown、断线重放保持 source+id
- [ ] 7.6 同步拒绝后同 ID 改参不 spawn；相同终态重放、不同终态与后续日志丢弃；任务终态后 late/duplicate result 仍可回传；
       tombstone/session_deleted/session_history_pruned 语义
- [ ] 7.7 scope：create 不能 approve/respond；approve 不能 respond；cancel 独立；HTTP/WS 一致
- [ ] 7.8 mock ACP 端到端：permission 与 Form 全生命周期、断线、超时、取消、帧分片/畸形报文
- [ ] 7.9 真实 CLI 可选 E2E：CodeBuddy/DSH ACP 在临时工作区验证；不执行破坏性命令，不读取真实密钥
- [ ] 7.10 `npm run gate`、`npm run harness:validate`、`npm run openspec:validate` 全绿并贴真实输出
- [ ] 7.11 build 后 `npm run e2e:smoke`；full 使用无害 mock，默认流程回归通过
- [ ] 7.12 session feed：delta/complete、半截消息快照、统一 eventSeq/gaps、终态 flush、富 toolCall、
       artifact 同 fd/hash/路径安全、分页快照与 get_artifact

## 8. 评审、扩展与归档

- [ ] 8.1 人工评审共同内核与 Phase 1 证据后再进入 Phase 2，避免未验证交互协议污染 full 实施
- [ ] 8.2 URL Elicitation、持久授权、进程重启恢复按 session-gateway spec 实施并纳入同一安全验收
- [ ] 8.3 大附件分块/续传、自由文本多轮、持久会话全部纳入完整目标，不作为后续另案
- [ ] 8.4 全部任务完成、人工验收后合并 specs 并归档

## 9. 完整目标：Agent Session Gateway

- [ ] 9.1 引入必需依赖 better-sqlite3/WAL（不依赖实验性 node:sqlite），Storage 接口 + migration + 完整性自检；
       启动失败必须拒绝 1.0，不降级 memory
- [ ] 9.2 新增 SQLite 表：sessions/turns/messages/events/interactions/results/artifacts/transfers/approvals/idempotency/principals/audit
- [ ] 9.3 eventSeq 与业务状态同事务提交；事件先落库再推送；崩溃恢复 active turn 为 interrupted、waiting_user 保留
- [ ] 9.4 Session/Turn：conversation/task 模式、waiting_user、send_message/message_ack/close_session/cancel_turn
- [ ] 9.5 每 Session 串行 Turn + 可配置排队/背压；native steer 只有声明才启用；重复 messageId 幂等
- [ ] 9.6 12 适配器至少实现 replay-session 多轮底线；native/resume 增强；single-turn 仅实测例外；
       replay 用完整 transcript，超限 context_exhausted；live interaction 如实声明
- [ ] 9.7 持久 approval ledger：scope/expiry/tenant/principal，撤销与审计；不因模型文本自动授权
- [ ] 9.8 ACP/MCP URL Elicitation、auth-required、Safe URL、secret 不落库/日志；Form 仍禁 secret
- [ ] 9.9 Artifact CAS、元数据 SQLite、引用计数、删除回收；入站隔离/可选扫描/quarantine；出站仅可信事件
- [ ] 9.10 artifact_transfer_start/ack/chunk/complete/result/abort；offset+chunkSha256+整文件 sha256，断点续传/流控/磁盘不足
- [ ] 9.11 大文件不经内存聚合；慢消费者断开 + eventSeq 恢复；quota/retention/backup 配置化
- [ ] 9.12 A2A 网关：Task/Message/Artifact/input-required/auth-required/tasks-get/resubscribe，多轮与附件映射
- [ ] 9.13 ACP server 可选网关与 MCP Form/URL/只读 session server；不绕过 scope/租户/eventSeq
- [ ] 9.14 principal JWT/JWKS/tenant claim、mTLS 可选、跨租户拒绝、统一 403；session:write/artifact scopes
- [ ] 9.15 OpenTelemetry traceparent/metrics/audit/health；队列/DB/WAL/磁盘/交互/附件指标
- [ ] 9.16 故障注入：kill -9、DB 锁/损坏、WS 断线、慢消费者、chunk 乱序/重复、磁盘满、HTTP/网关限流
- [ ] 9.17 完整验收：12 策略矩阵、多轮/附件/恢复/多客户端并发审批、A2A/ACP/MCP 互操作、负载基准
- [ ] 9.18 tenant 分区 CAS、引用计数删除、消息/事件可选 AES-256-GCM、key rotation、audit hash 链
- [ ] 9.19 0.2.x 内存任务不迁移、taskId tombstone 永不复用、session_deleted、升级/回滚/备份恢复文档
- [ ] 9.20 idleTimeout/waiting_user 资源释放、session close 终态、慢消费者断开与 cursor 恢复测试
- [ ] 9.21 URL Elicitation 短期内存 URL + get_interaction_url + interaction_url_expired；日志/DB/snapshot 不出现完整 URL
- [ ] 9.22 tenant 过滤订阅/webhook、跨租户 404、message_conflict/steer_unsupported
