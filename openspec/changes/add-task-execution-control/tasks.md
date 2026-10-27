# 实施清单：add-task-execution-control

> 状态：方案已于 2026-10-25 人工确认，作为 1.0.0 实施基线。分阶段实施。
> Phase 1 切片（2026-10-25）：包/协议版本 v1、better-sqlite3、SessionStore（事件幂等/快照/tombstone）、
> stateDbPath、harness/e2e 版本对齐；SessionStore 已接 bootstrap + task-dispatch（一次性任务落 Session/Turn/Event，
> 启动恢复中断会话）；新增 task_message/task_snapshot/get_task 与 eventSeq，e2e 已验证快照重建；
> 新增 close_session/cancel_turn/session_ack；本地 `/v1/sessions` 列表/快照/SSE 已接 SQLite；
> `send_message` 多轮 replay-session、message_ack、conversation waiting_user 已实现；
> 交互 request/response/result、task:approve/respond scope 已实现；入站附件分块上传/CAS、下载、重连续传、
> 超时临时传输 GC、artifact TTL/引用计数清理（`POST /v1/artifacts:gc`）、下载传输续传已实现；
> 本地 `/sessions` 会话 UI（列表/快照/SSE/附件下载）已落地；已具备 native session id 持久化与
> interactive stdin 管道（resume/steer 的底层）。CodeBuddy ACP 已验证：必须用
> `--serve --acp --port 0`，且启动前删除继承的 `SERVER__PORT`；`initialize` / `session/new` 成功，
> `session/prompt` 在本沙箱被平台要求登录（Authentication required）。已实现 CodeBuddy ACP 客户端
> （initialize/session/new/session/prompt、permission、fs 读写、取消、超时）与 `CODEBUDDY_AUTH_TOKEN`
> 自动认证：显式 `CODEBUDDY_AUTH_TOKEN` 优先，否则读取 CodeBuddyExtension 明文 `auth/*.info` 注入。
> 已接入 TaskSupervisor：`acp` 任务走 ACP，`session/load` 续接，permission 转
> `task_interaction_request` 并把 `task_interaction_response.optionId` 回送 ACP；无 token 仍回落 headless。
> 2026-10-26 实测 8 个原生 ACP：codebuddy / gemini / opencode / mimo / kimi / minimax / grok / trae；
> **2026-10-27 追加第 9 个：dsh**（`dsh --profile acp`，探针实测 initialize 回 protocolVersion=1、
> sessionCapabilities {close,list,resume}、session/prompt 回 end_turn；自动化通道不发权限请求）。
> 剩余 3 个（claude/qoder/codex）方案见 `research/non-acp-agents.md`：
> Codex app-server JSON-RPC 已接入（thread/resume、审批、turn/steer），Claude/Qoder 已接 `--resume`，
> DSH headless 已接 `--session-id` resume；Claude/Qoder conversation 已接常驻 stream-json 进程
> （Turn 间复用，不声明 same-turn steer）；仅剩 MCP Form/elicitation 未接。

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

- [x] 2.1 `PROTOCOL_VERSION=1`；新增 permission-mode/task-interaction/elicitation-form/session-feed/task-snapshot/artifact-inline capabilities
      （2026-10-27 补齐最后两个：`elicitation-form` —— 原先只认 CodeBuddy 扩展方法 `session/request_form`，
      标准 ACP 的 `elicitation/create` 根本没接，等于对非 CodeBuddy 工具空口声明；现在两条入口共用一段处理，
      并且只在真的接了表单回调（`onForm` 存在 = 交互开关开且任务允许交互）时才在 initialize 里声明
      `clientCapabilities.elicitation`，否则不声明也不假装能问。`session-feed` —— 12 个工具的 step parser
      已全覆盖（claude-json×5 / codex-json / dsh-json / gemini-json / opencode-json×2 / kimi-json / mcode-json），
      声明前置条件满足；canonical feed 早就在发，此前只是没在能力清单里说出来。PROTOCOL_VERSION 不递增
      —— 纯新增能力字符串，属「新增能力 = 加字符串」那条规则。目前 20 项能力。）
- [x] 2.2 新增 PermissionMode、ExecutionMode/InteractionKind/FeedKind、hello.execution、AgentListItem.executionModes
      （2026-10-27：`PermissionMode` / `ExecutionModeName` / `InteractionKind` / `FeedKind` 类型已入 protocol；
      `hello.execution` 上报 permissionPolicy/externalSandbox/interactionEnabled/interactionTimeoutMs/maxInteractionsPerTask；
      `AgentListItem.executionModes` 按 headless/acp-stdio 逐模式声明，未验证维度不列）
- [x] 2.3 新增 task_interaction_request/response/result 联合类型与运行期校验；responseId 标识响应 occurrence，resultSeq 单调且可重放
      （此前已落地并由 `session-store` / `task-dispatch-session` 用例覆盖）
- [x] 2.4 run_task 接收 permissionMode/allowInteractive；task_status 增加 permissionMode、waiting_interaction、interactionId、可选 stopReason
      （2026-10-27：`interactionId` 在 waiting_interaction 帧出现、回到 running/终态时消失；
      `stopReason` 按 ACP 结算原因收敛到五个受控值，取消靠 cancelled 而不是 JSON-RPC error 冒充）
- [x] 2.5 新增 permission/interaction 受控错误码及 HTTP/JSON-RPC 映射表（2026-10-27：`permission_mode_unsupported` 400、`permission_policy_denied` 403）
- [x] 2.6 增加 permission_policy/external_sandbox/interaction_enabled/interaction_timeout_ms/max_interactions_per_task
       及 connect/serve 启动参数；默认 default/false/false/900000/16
      （2026-10-27：五个键全部落地并真实生效 —— 交互关闭时不发请求；单次等待取本机上限与适配器
      expiresAt 的较小值；超次数的请求不转发）
- [ ] 2.7 配置序列化、logout 保留业务设置、非法值、v1 hello/capabilities 单测
- [x] 2.8 新增 task_message、富 task_step、统一 eventSeq、task_artifact、get_task/task_snapshot/get_artifact 类型与运行期校验
      （2026-10-27：`get_artifact` 请求 + `artifact_content` 响应落地；1 MB 内联上限、越权与 CAS 缺失分别回
      artifact_not_found / not_readable，均有单测覆盖）
- [ ] 2.9 新增 canonical feed 与 artifact 上限配置；task_log 明确为调试通道而非稳定 UI 协议
      （2026-10-27：`task_snapshot.eventWindow.gaps` 与 `task_status.feedIncomplete` 已落，配置化上限与
      eventSeq 淘汰阈值仍未做成可调项；task_log 定位已在 README/契约写成调试通道）

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

- [x] 4.1 AgentDef 登记 12 个通用 full 映射与 executionModes；禁止开发机路径、用户名和版本特判
      （2026-10-27：12 个 `fullArgs` + `executionModesFor()` 逐模式声明；CodeBuddy 无 external_sandbox 时
      headless 只报 default，ACP 只报 default + permission/form）
- [x] 4.2 实现 permissionPolicy 解析与默认模板 argv 合成；allow-full/full 只接受空 args
      （2026-10-27：`resolvePermissionPolicy` / `decidePermissionMode`，受管参数模式强制空 args）
- [x] 4.3 DSH 使用两个官方 headless 参数；Kimi 不重复 auto；其余 9 个工具按矩阵精确实现
      （2026-10-27：按 design §6.2 矩阵逐项落 `fullArgs`）
- [x] 4.4 CodeBuddy 仅在 full+external_sandbox 时固定注入 CODEBUDDY_IS_SANDBOX=1，其他环境逐变量不变
      （2026-10-27：`permissionEnvFor()` 唯一返回该键，spawn 时只合并这一个变量）
- [x] 4.5 无映射/策略拒绝/非空 args/CodeBuddy 未声明隔离均不 spawn；旧 CLI 失败不自动降级
      （2026-10-27：决策在 spawn 之前，失败直接回 failed + 受控错误码；无用例验证 CLI 层面的降级可能）
- [x] 4.6 task_status 回显 bridge 选择策略并写审计，不表述为 CLI 实际权限证明
      （2026-10-27：终态/排队/交互帧均带 `permissionMode`；每个任务终态写一条
      `permission_decision` 审计（policy + mode + outcome），不写 argv 与环境值）
- [ ] 4.7 扩展 step parsers：从 12 个结构化输出提取 agent text/messageId 与完整/增量消息；未验证能力不声明
- [ ] 4.8 富 toolCall 元数据与有界 text/diff/terminal 内容映射；rawInput/rawOutput 默认不上行
- [ ] 4.9 artifact 只从 adapter 明确事件提取；限制任务 cwd realpath 子树、同 fd 读取、size/SHA-256；
       拒绝符号链接/凭据路径；超限只发元数据，不扫描工作区

## 5. Phase 2：交互内核与 ACP

- [x] 5.1 allowInteractive + interaction_enabled 双开关；无能力工具/组合在 spawn 前拒绝
      （2026-10-27：interactionEnabled=false 时强制 interactive=false，且 onInteraction 双重兵直接不发请求）
- [ ] 5.2 实现通用 ACP stdio client：initialize/session/new/session/prompt/update/session/cancel/close、分片 JSONL、帧上限
- [x] 5.3 ACP 任务以 session/prompt 回合响应结算；映射 end_turn/max_tokens/max_turn_requests/refusal/cancelled 与 JSON-RPC error；
       未决交互未结束时 agent_protocol_error，提前 close 与常驻进程分别处理，终态只 settle 一次
      （2026-10-27：`knownStopReason()` 收敛受控值；只有 end_turn 才 success，其余 failed/agent_error 或
      cancelled，并置 `feedIncomplete`；未知 stopReason 不写进受限字段）
- [ ] 5.4 ACP fs/terminal 等未评审 client 方法返回 UnsupportedOperation，不自动执行
- [x] 5.5 CodeBuddy ACP 与 DSH ACP 适配；只上报实际通过测试的 executionModes/interactionKinds
      （2026-10-27 补齐 DSH ACP。**探针证据**（`.harness/work/probe-dsh-acp*.mjs`，dsh 0.2.1-rc.2）：
      ① `dsh --profile acp` 在 stdio 上讲 ACP，initialize → protocolVersion=1、agentInfo=deepseek-harness-acp、
         sessionCapabilities={close,list,resume}、authMethods=[]；
      ② session/new → {sessionId, configOptions}；session/update 给 `agent_message_chunk` + `tool_call(_update)`
         + `usage_update`；session/prompt → stopReason=end_turn；
      ③ **工具调用期从不发 `session/request_permission`**（automation-only）→ 新增 `AgentDef.acpInteractionKinds`，
         dsh 显式声明空数组，避免平台干等一个永远不来的确认；
      ④ 续会话：标准 `session/load` 回 `-32601 Method not found`，自家 `session/resume` 可用
         （会话已活跃时回 -32602 属正常）→ ACP 客户端改为 **先 load 后 resume** 依次尝试，
         否则 dsh 会静默退化成全新会话（历史丢了还看不出来）；
      ⑤ 用 bridge 自己的 `runAcpPrompt` 实跑：首轮 sessionId=ef35…/text=ok，带 nativeSessionId 续会话
         拿到同一个 sessionId 且答出「42」，证明续的是同一个 session。
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
- [x] 5.12 实现 get_task/task_snapshot/get_artifact 与 `/v1/sessions/{id}/snapshot`；session:read、
       before/after 游标、partialMessages、eventWindow/gaps、task_not_found/session_deleted/session_history_pruned/artifact_not_found
      （2026-10-27 已落 get_task / task_snapshot / get_artifact / eventWindow.gaps / artifact_not_found /
      **`session:read` 细分 scope**：新增第 8 个受控 scope，会话与交互的读端点改为「`session:read` 或
      `task:read`」任一命中（1.0 之前签发的粗粒度令牌不会当场失效），面板只读令牌也一并放行 session:read。
      查证方式：`SERVICE_SCOPES` 8 项、`verifyServiceToken` 支持 any-of、控制面 3 个会话读端点已切。
      **2026-10-27 补齐 before 游标 + 保留阈值 + 两个 410 码**：
      ① 游标三形态定型 —— 无游标回**尾部窗口**（最新的 limit 条，`hasMoreBefore` 因此才有意义）、
         `afterEventSeq` 升序补洞、`beforeEventSeq` 取 `< cursor` 最新 limit 条后 reverse 回升序；
         两者同时给回 `protocol_incompatible`（不静默挑一个）。
      ② `event_retention_max_events`（默认 5000，0 = 全留，上限 1e6，`--event-retention-max-events` 覆盖）：
         按条数惰性裁剪（每第 100 条触发一次），水位落 `event_prunes` 表；`appendEvent` 发号下界取
         `max(maxSeq, floor)`，避免裁光后从 1 重新发号撞历史。只裁 events，turns/artifacts 保留。
      ③ `session_deleted` 此前**不可达**（close_session 只写 tombstone 并保留会话，删除路径根本不存在），
         补 `SessionStore.deleteSession()` + `agent-bridge sessions list|purge`：拒绝删 running、保留 tombstone、
         显式清 `artifact_transfers`（无外键）、其余子表走 CASCADE。该码由此成为真实可达状态。
      ④ `get_task` 对 `cursor < prunedThrough` 回 `found: true` + `errorCode: session_history_pruned`
         + `prunedThrough`；对 tombstone 命中回 `session_deleted`，从未存在回 `task_not_found`。
      测试：`test/session-retention.test.ts`（19 例）+ `test/task-snapshot-cursors.test.ts`（11 例）。
      **2026-10-27 补齐 partialMessages（本项完成）**：
      `core/partial-messages.ts` 的 `PartialMessageTracker` 挂在 `TaskSupervisor` **实例字段**上（不是模块级），
      三条流式通道统一经 `recordPartialText()` 写入 —— ACP `agent_message_chunk`、codex
      `item/agentMessage/delta`、claude stream `text` block（文本提取各抽成纯函数便于单测）。
      **只在内存、绝不写 SQLite**：token 级 chunk 落库会把事件表淹掉、并让 retention 反过来挤掉真事件，
      而它本来就不是可恢复状态。每任务一个桶（`pm_<taskId>`，刻意区别于 `msg_*` 幂等键）、32 KiB 上限、
      终态与「同 taskId 重新提交」都清空。快照无该内容时**不带字段**（不假装"接了但没有文本"）。
      同时把契约里那句「bridge 发 delta」改成实际口径：**1.0 只发 complete，不推 delta 帧**，`delta` 是保留位。
      测试：`test/partial-messages.test.ts`（12 例）+ `test/supervisor-partials.test.ts`（5 例）
      + 快照 4 例。

## 6. 外部接口与文档

- [x] 6.1 `contracts/asyncapi-3.0.yaml` 完整描述 v1 消息、executionModes、交互联合类型和示例
      （2026-10-27：get_artifact / artifact_content / hello.execution / executionModes / interactionId /
      stopReason / feedIncomplete / eventWindow.gaps 均已写入契约；站点参考页由 gen-reference 重生成）
- [x] 6.2 `contracts/openapi.control-plane.yaml` 增加任务字段、交互查询/回复端点与 RFC 9457
      （2026-10-27：三个 `/v1/interactions*` 路径 + `InteractionSummary` schema 已写进契约；
      RFC 9457 早已落地 —— `problem()` 用 `application/problem+json`，`toProblem()` 输出 type/title/status/detail
      并带顶层 `code`（受控错误码，与 WS errorCode 同名同值）。实测断言见 control-plane 测试里的
      「错误体是 problem+json」一例）
- [x] 6.3 本地 HTTP：GET /v1/interactions、GET /v1/interactions/{id}、POST /v1/interactions/{id}:respond；SSE 复用
      （2026-10-27：三条端点已实现，且**不另写一套判定** —— 统一走 `session.respondInteraction` →
      `dispatchInteractionResponse`，与 WS 的 `task_interaction_response` 同一条代码路径、同一套 scope 规则
      （permission 要 task:approve，form/auth-url 要 task:respond）。为此把该函数的返回类型从 `void` 改成
      `InteractionOutcome`：HTTP 必须能区分「没找到 / 已结算 / 已过期 / 鉴权失败」，而回读 SQLite 在鉴权失败
      这类不落库的分支上会误判成 pending。映射：404 / 409 / 410 / 403 / 400，未注入响应通道回 501。
      测试：control-plane 新增 8 例（缺 scope、session:read 与 task:read 双通过、非法 state、按 kind 鉴权、
      form 回显、501、409/410、未知 requestId））
- [ ] 6.4 编写 A2A TaskState/Message/Part/TaskStatusUpdateEvent 映射与扩展 URI，明确权限不是 A2A 原生能力；
       v1.0.1 终态由 status.state 表达并关闭流，不添加 final 字段
- [ ] 6.5 编写 ACP/MCP 映射：ACP 显式 form、MCP 版本承载差异隔离、权限使用 agent-bridge 命名空间
- [ ] 6.6 两份 README、站点协议/CLI/集成文档、错误码、配置、12 工具矩阵和安全边界同批更新
  - 已完成：两份 README 的「逐工具能力矩阵」（full argv / 执行模式 / 续会话）+ `capability` 为 0.x 遗留标签的口径
  - 待办：站点协议页与 CLI 页的同一份矩阵、`executionModes` 字段说明（两份 README 仍无该字段段落）
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
      （permission/断线/超时/分片/畸形已覆盖；bridge 侧 form 持久化/幂等已测；
       MCP elicitation 传输客户端已实现并有 accept/decline/cancel 测试，尚未接入平台交互）
- [ ] 7.9 真实 CLI 可选 E2E：CodeBuddy/DSH ACP 在临时工作区验证；不执行破坏性命令，不读取真实密钥
- [x] 7.10 `npm run gate`、`npm run harness:validate`、`npm run openspec:validate` 全绿并贴真实输出
- [x] 7.11 build 后 `npm run e2e:smoke`；full 使用无害 mock，默认流程回归通过（13/13 PASS）
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
  - 已落地：`core/session-store.ts`（WAL / `foreign_keys` / `busy_timeout` / `user_version` 迁移 + 事务）、
    打开时 `PRAGMA quick_check` 自检（`integrityCheck`，缺省开启）、构造失败释放句柄并抛出、**不降级内存库**。
    健康检查 `GET /v1/health?integrity=quick` 可随时重跑并回 `db: { ok, detail? }`。
  - 口径：`quick_check` 抓**结构**损坏（页头/b-tree/索引），正文被改写的字节抓不到 —— 实测 22 MB 库 19 ms（跳过 1.7 ms）。
- [ ] 9.2 新增 SQLite 表：sessions/turns/messages/events/interactions/results/artifacts/transfers/approvals/idempotency/principals/audit
- [ ] 9.3 eventSeq 与业务状态同事务提交；事件先落库再推送；崩溃恢复 active turn 为 interrupted、waiting_user 保留
- [ ] 9.4 Session/Turn：conversation/task 模式、waiting_user、send_message/message_ack/close_session/cancel_turn
- [ ] 9.5 每 Session 串行 Turn + 可配置排队/背压；native steer 只有声明才启用；重复 messageId 幂等
- [ ] 9.6 12 适配器至少实现 replay-session 多轮底线；native/resume 增强；single-turn 仅实测例外；
       replay 用完整 transcript，超限 context_exhausted；live interaction 如实声明
  - 已落地 `executionModes[].continuation`：headless 有 `resumeArgs` 的 4 个（claude/codebuddy/dsh/qoder）声明
    `resume-session`，其余 8 个声明 `replay-session`；9 个 ACP 工具一律 `native-session`。`single-turn` 目前无工具声明。
  - conversation 准入：未知工具回 `tool_not_installed`，没有任何可续模式的工具回 `session_not_continuable`，
    都在建 Session 之前拒绝（`agentCanContinue()` + `conversation.ts`）。
  - 未覆盖：`context_exhausted` 未实现 —— 没有模型上下文预算表就无法判定「超限」，宁可不报也不虚报。
- [x] 9.7 持久 approval ledger：scope/expiry/tenant/principal，撤销与审计；不因模型文本自动授权
  - `core/permission-ledger.ts`（判定纯函数）+ `approvals` 表读写 + `agent-bridge approvals list|revoke|purge`
  - 默认关闭（`approval_ledger_enabled`）；写入需 `task:approve + approval:persist`；命中需 default 模式 +
    请求真实提供 persistent 选项 + 指纹匹配；full 一律不用账本
  - 未覆盖：codex app-server 的审批尚未接账本（目前只接 ACP 通道）
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
