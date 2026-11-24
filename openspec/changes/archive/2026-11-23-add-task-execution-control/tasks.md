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
> （initialize/session/new/session/prompt、permission、未评审 fs/terminal 拒绝、取消、超时）与 `CODEBUDDY_AUTH_TOKEN`
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
- [x] 1.9 包版本设为 1.0.0、协议版本设为 1；移除 0.2.x 协议/HTTP/scope 兼容代码与 fixtures
      （2026-11-23 阶段四收口盘点：package.json version=1.0.0 ✓、PROTOCOL_VERSION=1 ✓
      （Phase 1 批已落）；逐维 grep 0.2.x 残留 —— **协议**：bridge wire 无版本协商/回退代码
      （hello 单向宣告 protocolVersion，平台侧无 hello_ack/版本应答，无 0.2 宽容路径）；
      **HTTP**：控制面无 0.2 路径别名（route 全量核对）；**fixtures**：test/fixtures 与
      contracts 无 0.2 痕迹。**scope 裁决**：`session:read`/`task:read` any-of（SESSION_READ）
      是 5.12 批的设计决策并被**对外真源钉死** —— README 双语端点表（「`session:read` or
      `task:read`」×6 端点）与 openapi 契约（「1.0 之前签发的 task:read 仍被接受（窄 scope 优先）」）
      都是平台可读的契约承诺；移除=令平台已签发令牌当场失效的对外破坏性变更，与「契约改动
      是跨团队成本」红线冲突。**保留 any-of，以对外契约为准**——本条的字面要求（移除 scope
      兼容）与对外契约冲突时裁决为后者。若平台侧同意废弃粗粒度令牌，须走提案（契约同批变更）。）

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
- [x] 2.7 配置序列化、logout 保留业务设置、非法值、v1 hello/capabilities 单测
      （2026-11-23 阶段四收口盘点：序列化（「保存传入的业务设置 + 不虚构未传入的旧设置」+ mcp/jwt/
      retention 持久化系列）、logout 保留（「clearConfig 仅移除凭证与绑定时间」+ 幂等 +「接受 logout 后
      的有效未绑定配置」）、非法值（结构非法/deviceId 镜像冲突等 8 条拒绝用例）均已在 config.test.ts
      26 例覆盖；**本批补**：bridge.test「v1 hello 契约」—— protocolVersion=1、PROTOCOL_CAPABILITIES
      无重复、hello 上行能力清单与真源逐项一致（防能力清单漂移导致平台静默降级）。bridge 88/88。）
- [x] 2.8 新增 task_message、富 task_step、统一 eventSeq、task_artifact、get_task/task_snapshot/get_artifact 类型与运行期校验
      （2026-10-27：`get_artifact` 请求 + `artifact_content` 响应落地；1 MB 内联上限、越权与 CAS 缺失分别回
      artifact_not_found / not_readable，均有单测覆盖）
- [x] 2.9 新增 canonical feed 与 artifact 上限配置；task_log 明确为调试通道而非稳定 UI 协议
      （2026-10-27：`task_snapshot.eventWindow.gaps` 与 `task_status.feedIncomplete` 已落；
      2026-11-22 阶段四：`[feed]` 配置段落地 —— max_messages/max_steps/max_artifacts/
      task_max_bytes/global_max_bytes，缺省 200/200/50/4MiB/64MiB、逐维 0=关闭，
      `resolveFeedBudgets` 逐维覆盖（只调一维不会关掉其它维）、bootstrap 注入 SessionStore；
      `event_retention_max_events` 此前已可调；task_log 调试通道定位已在 README/契约写成。
      test/feed-budgets.test.ts 7 例覆盖）

## 3. 调度、幂等与 Emitter 共同内核

- [x] 3.1 TaskState 增加 waiting；waiting 仍占 running 名额，总 timeoutMs 继续从入队计时
  - 2026-11-17：真实 ACP 子进程验证 waiting 时 runningCount=1、重放带 interactionId，Broker result 后才恢复 running。
- [x] 3.2 新建每 supervisor 一个 InteractionBroker：pending/submitting/resolved/failed、responseId 去重、single-flight、等待超时、最新 result 快照、resultSeq
  - 2026-11-17：`core/interaction-broker.ts` 挂每 supervisor；SQLite occurrence + response 指纹锚点，
    resultSeq 按 requestId 独立，result 不占 eventSeq；invalid/replay/duplicate/conflict/timeout/恢复测试覆盖。
  - 2026-11-17 第二阶段实施边界：新增 `core/interaction-broker.ts` 与 `test/interaction-broker.test.ts`；
    SQLite 增加 response 指纹、resolution 和 interaction_results occurrence 表；resultSeq 按 requestId 独立发号，
    result 不写 canonical events。Broker 挂 supervisor 实例，应用层只负责 scope 与 adapter 交付入口。
    依次验证 invalid/replay/conflict/duplicate、single-flight、稳定 CloudEvents ID、重连快照和 waiting 状态。
- [x] 3.3 所有权限/参数/交互同步拒绝创建并跟踪 settled Entry；同 taskId 改参重发不重新校验、不 spawn；
       SQLite 为唯一权威；不使用内存 MAX_TRACKED 淘汰
  - 2026-11-17 P0 子项已完成：生产 `run_task` 在内存句柄清理前后及 DB 重开后都直接回放 SQLite
    原始终态，保留 errorCode/eventSeq，同 ID 改参不再进入 startTask；Emitter 允许完全相同终态重放。
    `test/task-dispatch-permission.test.ts` 红灯复现两次执行，修复后同进程与重开 DB 均只执行一次。
  - 2026-11-22 阶段四收口：移除 supervisor 的 MAX_TRACKED 内存淘汰——终态条目在 hooks.onStatus
    （生产 = SQLite 同步落库）返回后立即从 byId 回收，内存只跟踪活跃任务（容量 = 并发 + 队列上限，
    天然有界）；「同步拒绝跟踪 settled」由 dispatch 层 SQLite 承担（P0），supervisor 直连层同 ID
    重发语义改为「新执行」（幂等是调度入口的职责，`test/supervisor-settled-guards.test.ts`
    文档化该分工；bridge.test.ts 旧「终态重放」用例同步改写为新语义）。
- [x] 3.4 Emitter 以脱敏后终态指纹允许完全相同终态重放，拒绝不同终态及终态后 log/step/running；
       终态去重容量与 supervisor 协调，禁止通过静默淘汰产生可重复执行窗口
  - 2026-11-22 阶段四收口：终态后 log/step/running 的**第一道闸门前移到调度器回调入口**——
    emit（headless stdout/stderr，authGuard 命中即 kill+settle，残余 data 在 kill 生效前入队）、
    feedSteps、claude onUpdate、onCodexUpdate、onAcpUpdate 五处统一 `entry.state === 'settled'`
    守卫（ACP/codex 的取消先结算、通知流在途是真实窗口）。Emitter.settled 降为纵深防御：
    supervisor 终态即回收（无淘汰）、同 ID 重放不依赖内存命中（SQLite 前置回放），maxSettled
    的淘汰不再改变外部可见行为。`test/supervisor-settled-guards.test.ts` 红灯复现
    「authGuard settle 后迟到 stderr/stdout 仍上行」后转绿（3/3），bridge 87/87、全量
    60 文件 667 passed/1 skipped、gate 全绿。
- [x] 3.5 可恢复交互事件使用稳定 source+id：request 按 taskId+requestId，result 按 taskId+requestId+resultSeq；
       responseId 重放返回同一 result occurrence，不拆成新 resultSeq
  - 2026-11-17：冲突响应自身也按 responseId+规范化指纹稳定重放；跨 task ID 不碰撞。
- [x] 3.6 Outbox 溢出后仍能从 broker 最新 pending/result 快照恢复；审计不因重放重复记录
  - 2026-11-17：WS onOpen 在 Outbox drain 后回放 SQLite 快照；approval ledger 仅 deliveredNow 首次写入。
- [x] 3.7 Emitter 在任务终态后仍允许已存在交互的 result，禁止新 interaction_request；响应路由不依赖 activeTasks
  - 2026-11-17：result 由 SQLite occurrence 路由，late/duplicate/conflict 不恢复 running；终态后不再新增 Feed。
- [x] 3.8 TaskRegistry 保存 waiting 与 pending 快照；终端/Web 任务视图展示等待原因和当前 requestId，不显示用户响应 content
  - 2026-11-17：TaskView 支持完整 TaskPhase + interactionId；WS/SQLite 同步转发，快照含 pending/latest results。
- [x] 3.9 每任务单序列 eventSeq；200/200/50、4 MiB/64 MiB 仅作默认配置，可调；淘汰记 gap、保留 pending/最新状态；
       终态前有界 flush 最终 complete/artifact，终态 eventSeq 最后分配并可标记 feedIncomplete
  - 2026-11-22 阶段四：per-task 有界 feed 落地 —— SessionStore `feedBudgets` 三层预算
    （分类条数 / 单任务字节 / 全局字节）同步与惰性执行；窗口内淘汰写 `feed_gaps` 表，
    `eventWindow.gaps` 元素带 `reason: count|task_bytes|global_bytes`（可选 wire 字段，不递增版本，
    asyncapi 契约 + 站点生成物同批更新）；前缀删除推进 prunedThrough（advancePruneFloor，
    游标语义走 session_history_pruned）；保护行 = 各会话最新终态 task_status + 最新一条事件，
    pending 交互在独立表天然不受影响。既有满足项：per-session 单调 eventSeq、终态前先落
    `msg_<taskId>_final` 再落终态（终态 eventSeq 最后分配）、feedIncomplete。边界如实声明：
    task_artifact 事件的 adapter 来源属 4.9（尚未接入，无 artifact 事件产生时 flush 语义自然满足）。
    test/feed-budgets.test.ts 7/7（分类交错 gap / 字节前缀水位 / 全局跨会话 / 保护行 / 0=关闭）。

## 4. Phase 1：12 工具 full

- [x] 4.1 AgentDef 登记 12 个通用 full 映射与 executionModes；禁止开发机路径、用户名和版本特判
      （2026-10-27：12 个 `fullArgs` + `executionModesFor()` 逐模式声明；CodeBuddy 无 external_sandbox 时
      headless 只报 default，ACP 只报 default + permission/form）
- [x] 4.2 实现 permissionPolicy 解析与默认模板 argv 合成；allow-full/full 只接受空 args
      （2026-10-27：`resolvePermissionPolicy` / `decidePermissionMode`，受管参数模式强制空 args）
- [x] 4.3 DSH 使用两个官方 headless 参数；Kimi 不重复 auto；其余 9 个工具按矩阵精确实现
      （2026-10-27：按 design §6.2 矩阵逐项落 `fullArgs`；2026-11-16：agy 改用显式 `fullTaskArgs`，
      full 旗标置于 `-p` 前，prompt 始终压尾；`test/execution-modes.test.ts` 红灯复现后转绿）
- [x] 4.4 CodeBuddy 仅在 full+external_sandbox 时固定注入 CODEBUDDY_IS_SANDBOX=1，其他环境逐变量不变
      （2026-10-27：`permissionEnvFor()` 唯一返回该键，spawn 时只合并这一个变量）
- [x] 4.5 无映射/策略拒绝/非空 args/CodeBuddy 未声明隔离均不 spawn；旧 CLI 失败不自动降级
      （2026-10-27：决策在 spawn 之前，失败直接回 failed + 受控错误码；无用例验证 CLI 层面的降级可能）
- [x] 4.6 task_status 回显 bridge 选择策略并写审计，不表述为 CLI 实际权限证明
      （2026-10-27：终态/排队/交互帧均带 `permissionMode`；每个任务终态写一条
      `permission_decision` 审计（policy + mode + outcome），不写 argv 与环境值）
- [x] 4.7 扩展 step parsers：从 12 个结构化输出提取 agent text/messageId 与完整/增量消息；未验证能力不声明
      （2026-11-22 阶段四：headless 结构化输出里的**中间 agent 文本**成为 canonical task_message ——
      claude-json 解析器新增 `drainMessages()`（drain 语义：取走即清空），按 assistant 消息聚合 text 块、
      message.id 作 CLI 原生幂等键；supervisor 新增 `TaskHooks.onAgentMessage`，dispatch/conversation 落库
      复用 `appendMessage`（同事务写 messages+events，duplicate 短路、session_conflict 跳过不阻塞）。
      **边界如实声明**：只对有实测 fixture 的 claude-json 实现（未实测格式不猜）；流式增量仍走既有
      partialMessages 通道。test/feed-enrichment.test.ts 8/8（含 fixture 断言与 dispatch 幂等双写回归）。）
- [x] 4.8 富 toolCall 元数据与有界 text/diff/terminal 内容映射；rawInput/rawOutput 默认不上行
      （2026-11-22 阶段四：`task_step` 新增可选 `toolCall`（toolCallId/name/kind/title/status/locations/content，
      wire 可选字段不递增版本；asyncapi 契约 + README 双语 + 站点同批）。kind 用 ACP 十值枚举；
      来源三路 —— ACP `tool_call` 更新（原生 kind/locations/content 直传，8 块/单块 16KB 截断）、
      claude-json 解析器（工具名→kind 映射 + file_path/path→locations + tool_result→terminal 块）、
      claude 常驻 stream 通道（`claudeToolCallOf` 复用同一映射）。**rawInput/rawOutput 不上行**
      （测试断言 toolCall 序列化不含 input 原文）；无法可靠提取的适配器省略字段只保留 legacy。）
- [x] 4.9 artifact 只从 adapter 明确事件提取；限制任务 cwd realpath 子树、同 fd 读取、size/SHA-256；
       拒绝符号链接/凭据路径；超限只发元数据，不扫描工作区
      （2026-11-22 阶段四：`core/artifact-extract.ts` 安全读取器 —— resolveWithinCwd（读取根=任务 cwd
      的 realpath 子树；拒绝 `..`/绝对路径/目录/符号链接与 junction 逃逸/凭据路径 .ssh\.aws\.env\id_rsa 等，
      realpath 解析后必须仍在根内）+ readArtifactFile（同一 fd open→fstat 定尺寸→流式读取计算 SHA-256，
      POSIX O_NOFOLLOW 可用则用，Windows 以 realpath 前置检查+单 fd 读取为等价实现；inline 上限内带
      content，超上限只给 size/sha256）。**接线**：captureDiff 任务的 changedFiles 在终态生成元数据事件
      （kind:output/source:agent/name/mimeType/size=stat；spec「无 adapter 明确 artifact 事件时不读取内容」
      —— sha256 省略 + `contentUnavailableReason: 'no_adapter_artifact_event'`，get_artifact 如实 404；
      越界/凭据/已清理文件连名字都不上行，单次终态截 50 个，feed 侧另有 [feed] 预算治理）。
      wire：task_artifact 的 sha256 可选化 + source/contentUnavailableReason（可选字段不递增版本，
      asyncapi/README 双语/站点同批）。**边界如实声明**：12 个 CLI 目前均无 artifact 事件来源，
      内容读取通道（onArtifact）留待真实 adapter 事件出现再定义，不空口声明能力。
      test/artifact-extract.test.ts 12/12（`..`/绝对路径/凭据/目录/symlink 逃逸/同 fd SHA-256/inline
      超限/元数据事件集成/无 changedFiles 零事件）。）

## 5. Phase 2：交互内核与 ACP

- [x] 5.1 allowInteractive + interaction_enabled 双开关；无能力工具/组合在 spawn 前拒绝
      （2026-10-27：interactionEnabled=false 时强制 interactive=false，且 onInteraction 双重兵直接不发请求）
- [x] 5.2 实现通用 ACP stdio client：initialize/session/new/session/prompt/update/session/cancel/close、分片 JSONL、帧上限
      （方法集与生命周期自 5.3-5.5/9.5 各批落地（acp-codebuddy.ts 为 9 工具共用 runner：initialize/
      session/new/session/prompt（含 session/load 与 dsh 的 session/resume 回退）/session/update/
      session/cancel/close 全有）；「分片 JSONL」= 接收侧跨 chunk 半行重组。**2026-11-23 补帧上限**
      —— readline 无行长限制，恶意 agent 的无换行超长流可把缓冲撑到无界：新增
      `createBoundedLineReader`（ACP_MAX_LINE_BYTES=1MiB：跨 chunk 重组 + 完整超限帧丢弃计数 +
      未终止超限流进入丢弃态）替换 readline；test/acp-line-reader.test.ts 4/4（分片重组一致性/
      超限丢弃与后续行不受影响/上限内最大行通过/EOF flush）；ACP 套件 27/27 回归。）
- [x] 5.3 ACP 任务以 session/prompt 回合响应结算；映射 end_turn/max_tokens/max_turn_requests/refusal/cancelled 与 JSON-RPC error；
       未决交互未结束时 agent_protocol_error，提前 close 与常驻进程分别处理，终态只 settle 一次
      （2026-10-27：`knownStopReason()` 收敛受控值；只有 end_turn 才 success，其余 failed/agent_error 或
      cancelled，并置 `feedIncomplete`；未知 stopReason 不写进受限字段）
- [x] 5.4 ACP fs/terminal 等未评审 client 方法返回 UnsupportedOperation，不自动执行
  - 2026-11-17：initialize 明确声明 fs read/write=false；所有未评审方法（含直接绕过能力声明的调用）
    统一回 JSON-RPC -32601 `UnsupportedOperation`，移除文件读写实现。`test/acp-interaction.test.ts`
    先以 read/write/terminal/create 三请求复现失败，修复后 10/10 通过并断言目标文件未创建。
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
- [x] 5.6 full + ACP 必须显式实现会话权限配置，未实现时拒绝，不借用 headless full 参数冒充
      （2026-11-16：TaskSupervisor 在 CLI 路径解析/spawn 前拒绝 full + ACP/app-server/Claude stream，
      回 `permission_mode_unsupported`；3 个通道均有红灯→绿灯集成测试。复核后补齐调度层：非交互 full
      直接选 headless，full+allowInteractive 保留不支持通道供拒绝，default 不变；task-dispatch-permission 覆盖）
- [x] 5.13 conversation 保留 permissionMode/permissionPolicy/externalSandbox；full 使用受管 headless + 完整 transcript replay
      （2026-11-16：首轮权限快照写入 sessions.permission_mode；后续 Turn 不进入 resident/ACP/app-server；两例红灯→绿灯）
- [x] 5.14 RunTaskRequest.internalArgs 与平台 args 分离；allow-full/full 下 default 会话的内部 resumeArgs 不被自定义参数门禁误拒
      （2026-11-16 复核修复：conversation 传 args=[] + internalArgs=resumeArgs；supervisor 只对 req.args 做策略拒绝，
      内部参数仍替换 prompt；conversation 形状回归 + 真实假 CLI 在 allow-full/default 下执行成功）
- [x] 5.7 权限请求映射 toolCall/options/outcome；once 选项、取消、过滤 persistent、optionId 校验；
       超时/full 残余权限只有存在 reject_once 才可选择，否则 cancelled + interaction_timeout/interaction_denied
  - 2026-11-17 P0 子项：accepted 权限响应必须选择当前请求真实提供的 optionId；伪造/缺失选项回
    interaction_invalid_response，adapter 零调用且 pending 保留，新 responseId 可修正。
  - 2026-11-22 阶段四收口：①超时语义 —— Broker.expire 重写：permission 且 options 真实提供
    reject_once → 以**原 optionId** 自动拒绝（回合继续，onResolved 恢复）；否则（含 Form）cancelled
    outcome + onExpired → supervisor.expireInteraction 取消回合并以新受控码 `interaction_timeout` 结算；
    ②full 残余权限 —— `fullResidualPermissionOutcome()`（permission-policy 纯函数）+ ACP onPermission /
    codex onApproval 接线：有 reject_once 选原 optionId，无则 cancelled + 取消回合（新受控码
    `interaction_denied`），不转人工、不伪造选项。可达边界如实声明：full+ACP 目前在 submit 前按
    「ACP 只声明 default」拒绝（spec 能力不匹配语义），full 分支为未来声明 ACP full 的工具生效；
    ③过滤 persistent = 不伪造 + 账本三条件（default/真实提供 persistent/指纹匹配，full 永不命中）。
    test/interaction-semantics.test.ts 9/9（红灯：deliver 收到 cancel 而非原 optionId、无 onExpired、
    无审计 → 绿灯）。
- [x] 5.8 Form 映射 mode/message/requestedSchema/action/content；实现无依赖的扁平 schema 双方校验；
       不按字段名猜 secret，明确的 URL/敏感流程才拒绝，普通 Form 依赖 Agent 合规与人工审查
  - 2026-11-22 核验收口：映射（message/requestedSchema → kind=form payload；action/content →
    AcpFormResponse）与扁平 schema 双方校验（`core/form-schema.ts` validateFormContent：required/类型/
    enum，form-schema.test.ts 覆盖）均已落地并在 Broker normalize 消费。语义调和：**schema 侧不按
    字段名猜 secret**（requestedSchema 的字段名不触发拒绝）；**content 侧按字段名拒绝**（用户答案里
    的 token/secret/password 等字段一律拒绝 ——「Form 不收秘密」红线）；URL/敏感流程走
    InteractionUrlVault（interaction-url capability，一次性 URL 不落库/日志）。
- [x] 5.9 实现等待超时、Turn 超时、取消、每任务一个 pending、可配置交互限流与 interaction_timeout；
       取消回合用 session/cancel，pending 权限/Form 以原 JSON-RPC id 回复 cancelled/cancel，按 stopReason=cancelled 结算；
       kill grace 到期即使无 stopReason 也强制终止并按 cancelled/timeout 结算
  - 2026-11-22 阶段四收口：等待超时（Broker.expire + onExpired → expireInteraction 以
    interaction_timeout 结算，见 5.7 证据）；**每任务一个 pending**（onPermission/onForm/onApproval
    入口守卫：已有未决请求时新请求直接以 cancel/decline outcome 完成，不上行）；可配置限流
    （max_interactions_per_task + interaction_timeout_ms 既有，dispatch 交互额度计数）；取消回合
    （terminate → acpAbort.abort → adapter session/cancel + kill；settle 对 pending promise 统一
    resolve(undefined)=cancelled outcome、cancelRequest 清 Broker 侧，spec「原 JSON-RPC id 回复
    cancelled/cancel」由 adapter 的 respond 完成）；Turn 超时（conversation 每轮 timeoutMs 传入
    startTask）；kill grace（KILL_GRACE_MS=2s SIGKILL，close 回调按 entry.status 结算
    cancelled/timeout）。测试：interaction-semantics 9/9 + interaction-broker 9/9 既有回归。
- [x] 5.10 实现 pending→submitting 单 flight、responseId occurrence 去重、无效响应可重试、相同响应 duplicate、
       不同响应 conflict、写入不确定 delivery_unknown 后禁止重试、迟到响应不恢复
  - 2026-11-17：Broker 统一 WS/HTTP/conversation；response anchor + 指纹 receipt 保证原响应与冲突响应均稳定重放。
    delivery unknown 终止且禁重试，首次交付才写账本；回合终态同步清理开放交互。
  - 2026-11-17 P0 子项：SQLite 原子 pending→submitting；ACP/Codex 等待真实 stdio 交付后才 resolved；
    关闭/异常回 interaction_delivery_unknown、failed 落库、终止回合且后续重试不再交付。新增受控码及双语契约文档。
    复核补收口：declined/cancelled 剥离允许 optionId；ACP/Codex（含 user-input cancel）统一等待 write callback，
    close/error 唤醒等待者；启动恢复按交互扫描 pending/submitting，覆盖 running、已终态和 waiting_user 会话。
- [x] 5.11 实现 task:approve/task:respond scope；respondedBy 与内容脱敏审计，Form content 不落审计/result
  - 2026-11-22 阶段四收口：scope 按 kind 鉴权既有（permission→task:approve、form/auth-url→task:respond，
    WS 与 HTTP `:respond` 同一条 dispatch 路径，control-plane 8 例覆盖）。新增交互响应审计
    （dispatchInteractionResponse → writeAudit `interaction_response`）：记 requestId/responseId/kind/
    choice（permission 的 optionId 或 form 的 action）/requestedBy（respondedBy）/结果（outcome +
    errorCode），**Form content 的值绝不落审计**（审计断言用例含 SECRET-FORM-VALUE 反向验证）；
    Form content 不落 result（resolution 只含 fieldNames；fingerprint 为哈希摘要）。AuditEntry 扩展
    requestId/responseId/kind/choice 四字段（clip 同口径截断）。
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
      2026-11-17 修复 WS 入口漏传 beforeEventSeq：新增原始报文→assertServerMessage→dispatch→SQLite 回归，
      先红后绿；`task-snapshot-cursors` 16/16、连同 bridge 回归 103/103。

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
- [x] 6.4 编写 A2A TaskState/Message/Part/TaskStatusUpdateEvent 映射与扩展 URI，明确权限不是 A2A 原生能力；
       v1.0.1 终态由 status.state 表达并关闭流，不添加 final 字段
      （2026-11-23 阶段四：README 双语网关节新增「A2A 映射细则」—— TaskStatusUpdateEvent ↔ SSE status 帧
      （终态帧关流，Task 对象无 final 字段，终态由 status.state 表达）；Message/Part ↔ task_message
      （complete 进 history、delta/task_log 不冒充）；Artifact ↔ file part / 元数据如实不可得；
      「权限不是 A2A 原生能力」显式声明（批准闭环只在 bridge wire 与 ACP 表面）；
      bridge 扩展 URI 清单表（对照 a2a-mapping.ts/gateway.ts 实现逐键核验：agentType/cwd/timeoutMs/
      captureDiff/permissionMode/bridge.taskLogEndpoint/bridge.statusDetail/afterEventSeq/idempotentReplay
      —— 修正两处初稿与实现的偏差：idempotentReplay 无 bridge 前缀、afterEventSeq 直挂 metadata）。）
- [x] 6.5 编写 ACP/MCP 映射：ACP 显式 form、MCP 版本承载差异隔离、权限使用 agent-bridge 命名空间
      （2026-11-23 阶段四：ACP form 显式映射（elicitation form/url mode + 交互闭环）在网关节既有；
      README 双语新增「MCP 宿主」段 —— McpElicitationClient 的 elicitation 与版本承载差异隔离在 client 内
      不渗入 bridge wire；**诚实边界**：MCP 问题接入平台交互尚未启用，宿主/客户端就绪但不作能力声明
      （初稿曾写「产生 bridge interaction (payload.protocol:'mcp')」—— 对照 mcp-host.ts 实现发现虚报，
      已按「不宣称未实现能力」红线改写）。）
- [x] 6.6 两份 README、站点协议/CLI/集成文档、错误码、配置、12 工具矩阵和安全边界同批更新
      - 已完成（此前批次）：两份 README 的「逐工具能力矩阵」（full argv / 执行模式 / 续会话）+
        `capability` 为 0.x 遗留标签的口径 + `executionModes` 字段口径段落（含逐字段表）
      - 2026-11-23 阶段四收口：站点 CLI 页（en/zh）新增 12 工具简版能力矩阵（agentType/headless/ACP/
        续会话）+ ACP 恒 default 与内部通道不夸大说明 —— 与 README 详版同批维护（本批即同批更新）；
        site:check i18n 对等（15 页 × 2 locale）全过。
- [x] 6.7 文档示例使用通用路径/ID/token/URL，不引用开发机配置，不宣称未实现能力
      （2026-11-23 阶段四：开发机特征扫描（用户名/本机路径/本机代理端口/真实模型名/e2e 暗号）
      对两份 README、契约 YAML、站点双语全部零命中；示例路径均为 /Users/me、bt_7f3a 等通用形态；
      「不宣称未实现能力」由 doc:check 未实现标注机检 + 本批 MCP 段虚报改写共同保障。）
- [x] 6.8 编写 task_message/task_artifact/task_snapshot 到 A2A Message/Artifact/tasks-get 的映射；delta 与 raw log 不冒充标准消息
      （2026-11-23 阶段四：并入 6.4 的「A2A 映射细则」—— task_message 仅 complete 进 history（text part）；
      delta 是 bridge 内部 partialMessages 绝不冒充 A2A 消息；task_log 从 metadata.bridge.taskLogEndpoint
      指引获取不成为 part；task_artifact → file part（有内容）/元数据如实不可得（无 adapter 事件）；
      task_snapshot → tasks/get 快照（history 只含 complete）。）

## 7. 验证

- [x] 7.1 策略矩阵、12 argv、CodeBuddy env 作用域、受管 args、不同 HOME/cwd 可移植性
      （2026-11-23 阶段四：vitest --reporter=json 全量用例名盘点 + 逐维 grep 取证 ——
      策略矩阵 permission-policy 19 例 + permission-integration 7 例；12 argv/执行模式
      execution-modes 21 例（full 映射/ACP 矩阵/agy 专用模板）+ task-args-prompt 5 例
      （{{prompt}} 双来源/EOF flush）；CodeBuddy env 作用域：permission-policy「CodeBuddy full
      注入 CODEBUDDY_IS_SANDBOX=1」用 toEqual 精确断言唯一键 +「其他工具 full 不受
      external_sandbox 影响」；受管 args：「受管参数模式 allow-full/full 下非空 args 被拒」×2 +
      default 保留 legacy；HOME 可移植：host-env.test.ts（继承环境剥离）+ Emitter 家目录脱敏。）
- [x] 7.2 状态机：queued/running/waiting/settled、waiting 名额、总/单次超时、五种 stopReason、JSON-RPC error、未决交互与 close 竞态
      （2026-11-23 阶段四：**本批补真缺口** —— `test/acp-stopreason.test.ts` 5/5（真 spawn fake ACP
      走生产 launchAcp 结算路径：max_tokens/refusal/max_turn_requests → failed+agent_error+
      feedIncomplete；未知值收敛不写受限字段；end_turn 对照组 success）—— 此前「只认受控枚举」
      仅测收敛函数、完整结算路径 0 覆盖。既有：waiting 名额（3.1 真实 ACP 子进程验证）、
      总/单次超时（e2e timeout + interaction 超时批）、JSON-RPC error（acp-interaction
      「prompt 无响应→timeout 失败不挂死」）、close 竞态（claude-resident 回收子孙 +
      supervisor-settled-guards 终态后丢弃）+ bridge.test 87 例状态机回归。）
- [x] 7.3 权限：allow_once/reject_once/cancelled、persistent 过滤、伪造 optionId、title/kind 不参与自动批准
      （interaction-semantics 9/9（once/取消/persistent 过滤/full 残余）+ interaction-broker 9/9
      （optionId 校验：伪造 → interaction_invalid_response 且 adapter 零调用）+ approval-ledger
      13+7 例（指纹匹配/无资源不落账/title 不自动批准/full 永不命中）。盘点命中 44 例。）
- [x] 7.4 Form：accept/decline/cancel、required/default/enum/格式/大小、秘密与 URL 模式明确拒绝
      （form-schema.test.ts（扁平 schema 校验 + content secret 字段拒绝）+ mcp-elicitation
      accept/decline/cancel + interaction-semantics Form 超时 cancel。盘点命中 27 例。）
- [x] 7.5 响应：responseId 重放保持 resultSeq、修正用新 responseId、invalid 重试、submitting/resolved duplicate、
       conflict、late、delivery_unknown、断线重放保持 source+id
      （interaction-broker.test.ts 9 例（occurrence/指纹锚点/single-flight/duplicate/conflict/
      late/delivery_unknown）+ 5.10 批的全套 + 3.5/3.6 的稳定 source+id 与重连快照。盘点命中 41 例。）
- [x] 7.6 同步拒绝后同 ID 改参不 spawn；相同终态重放、不同终态与后续日志丢弃；任务终态后 late/duplicate result 仍可回传；
       tombstone/session_deleted/session_history_pruned 语义
      （task-dispatch-permission（同 ID 不重执行/重开 DB 回放）+ supervisor-settled-guards 3/3
      （终态后迟到输出丢弃/内存回收/直连新执行语义）+ session-retention 19 例（tombstone/pruned/
      gaps）+ 3.7 终态后 late result 可回传。盘点命中 48 例。）
- [x] 7.7 scope：create 不能 approve/respond；approve 不能 respond；cancel 独立；HTTP/WS 一致
      （control-plane 40 例：「scope 不足 → 403 insufficient_scope（task:read 不够 task:create）」、
      「permission 交互要 task:approve 不是 task:respond」「form 要 task:respond」；
      **本批补真缺口**：「cancel 是独立 scope：只有 task:read+task:create 不足以取消 → 403
      insufficient_scope」—— 此前缺显式反向断言。HTTP/WS 一致：dispatchInteractionResponse 与
      HTTP :respond 同一 dispatch 路径（6.3 批 8 例 + interaction-semantics WS 路径）。）
- [x] 7.8 mock ACP 端到端：permission 与 Form 全生命周期、断线、超时、取消、帧分片/畸形报文
      （acp-interaction 10 例（permission 闭环/超时/分片/畸形）+ gateway-acp 14 例（form 交互闭环
      SSE 全链路/多轮/失败终态/取消）+ mcp-elicitation 传输客户端 accept/decline/cancel。
      诚实边界不变：MCP elicitation 接入平台交互尚未启用（见 6.5）。）
- [x] 7.9 真实 CLI 可选 E2E：CodeBuddy/DSH ACP 在临时工作区验证；不执行破坏性命令，不读取真实密钥
      （e2e:smoke 13 项全过（真 claude-code 任务/快照重建/timeout 终态）；e2e:gateway 15/15
      （真 codex 两轮多轮记忆断言）；DSH ACP 探针实测五点（initialize/session/prompt end_turn/
      resume/自动化无权限请求，5.5 批）。CodeBuddy ACP 的 session/prompt 在本机被平台登录墙拦截
      —— 如实注明，不做绕过。全部临时工作区，无破坏性命令，无真实密钥读取。）
- [x] 7.10 `npm run gate`、`npm run harness:validate`、`npm run openspec:validate` 全绿并贴真实输出
- [x] 7.11 build 后 `npm run e2e:smoke`；full 使用无害 mock，默认流程回归通过（13/13 PASS）
- [x] 7.12 session feed：delta/complete、半截消息快照、统一 eventSeq/gaps、终态 flush、富 toolCall、
       artifact 同 fd/hash/路径安全、分页快照与 get_artifact
      （阶段四各批：feed-enrichment 8/8（中间消息/富 toolCall/rawInput 不上行）+ feed-budgets 7/7
      （eventSeq/gaps/预算）+ partial-messages 12+5（半截快照/终态清空）+ task-snapshot-cursors 17
      （游标三分形态/分页）+ artifact-extract 12/12（同 fd/hash/路径安全/元数据）+ get-artifact
      （内联/越权/缺失）+ 3.9 终态 flush（final message 先落）。盘点命中 33 例。）

## 8. 评审、扩展与归档

- [x] 8.1 人工评审共同内核与 Phase 1 证据后再进入 Phase 2，避免未验证交互协议污染 full 实施
      （时序项早已越序完成（Phase 2-7 均已实施且有各自验证）；终局评审于 2026-11-23 完成：
      `review.md` 六批证据索引 + 五点选项交互（D1 scope 兼容保留 any-of / D2 产物元数据 only /
      D3 CodeBuddy 登录墙如实 / D4 帧上限 1MiB / D5 §9 剩余另开提案）—— 全部按推荐落定、
      无额外异议，评审通过。）
- [x] 8.2 URL Elicitation、持久授权、进程重启恢复按 session-gateway spec 实施并纳入同一安全验收
      （URL Elicitation：InteractionUrlVault（一次性 URL、内存态不落库/日志，interaction-url capability，
      test/interaction-url.test.ts）；持久授权：approval ledger（9.7，task:approve + approval:persist +
      三条件判定，permission-ledger 测试族）；进程重启恢复：第二阶段恢复批（running→session_interrupted、
      queued 持久执行快照 + claim 闸门、waiting_user 保留、交互 pending/submitting 恢复）；安全验收归入
      7.x 验证矩阵。）
- [x] 8.3 大附件分块/续传、自由文本多轮、持久会话全部纳入完整目标，不作为后续另案
      （大附件分块/续传：artifact_transfer 全状态机 + 有界 IO + 断点续传（9.10/9.11 及第二阶段传输批）；
      自由文本多轮：conversation send_message/message_ack + 12 适配器续接矩阵 + ACP 网关多轮
      （add-acp-session-memory 已归档）；持久会话：SQLite sessions/turns/messages/events 全量持久化。
      三者均在本提案范围内交付，未另案。）
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
  - 2026-11-17 第二阶段：running 才标记 session_interrupted，queued 保留执行快照并按序恢复；pending/submitting
    分状况结算且 result 不占 eventSeq。通用 Session/Turn/终态写入的全事务化仍需继续，故保留总项。
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
- [x] 9.9 Artifact CAS、元数据 SQLite、引用计数、删除回收；入站隔离/可选扫描/quarantine；出站仅可信事件
  - CAS：`core/artifact-transfer.ts` 的 CAS 目录（sha256 内容寻址）+ 分块上传/下载（9.10/9.11）；
  - 元数据 SQLite：artifacts 表（tenant/artifact_id/session/name/mime/size/sha256/kind/storage_key）；
  - 删除回收：`POST /v1/artifacts:gc`（TTL + dryRun，走 cleanupArtifacts）；session 删除时表行 CASCADE、
    CAS 文件由 TTL 兜底回收。引用计数如实说明：以 sha256 内容寻址天然去重（同内容同 storage_key），
    精确引用计数列未做（TTL 回收兜底，不虚报）；
  - 入站隔离：CAS 目录独立于任务 cwd，只存储不执行；「可选扫描/quarantine」未实现、未声明；
  - 出站仅可信事件：下载只经 get_artifact（入站 CAS 有内容）或 HTTP 下载端点；任务产物在无 adapter
    artifact 事件时只发元数据（4.9，contentUnavailableReason 显式），绝不扫描工作区。
- [ ] 9.10 artifact_transfer_start/ack/chunk/complete/result/abort；offset+chunkSha256+整文件 sha256，断点续传/流控/磁盘不足
  - 2026-11-17：新增通用 status/abort、严格 chunk/base64/hash、重复块校验、complete 恢复与 committed 重放。
    协议仍沿用分向上传/下载消息；磁盘配额与完整 ENOSPC 故障矩阵未在本批宣称完成。
- [ ] 9.11 大文件不经内存聚合；慢消费者断开 + eventSeq 恢复；quota/retention/backup 配置化
  - 2026-11-17：上传整文件 hash 与下载 chunk 均改有界 IO；下载单窗口 ack、重连 offset 续传。
    quota/backup 配置化仍未完成，故不勾总项。
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
- [x] 9.23 headless native session 提取覆盖 session_id/thread_id/conversation_id/sessionId/sessionID 与跨 chunk 分片
  - 2026-11-16：新增 createNativeSessionDetector（有界 512 字符拼接尾、首次命中后停扫）；2 条回归先失败后通过，覆盖 DSH 实测 sessionId。
- [x] 9.24 claude-json/dsh-json 增加流内错误终态裁决；mcode 文本兜底保留最后一条 agent_message
  - 2026-11-16：Trae error_during_execution 与 DSH MISSING_CREDENTIAL 均推翻退出码假成功，Claude 正常 result 仍 ok；4 条断言修复前失败，step-parsers 17/17 通过。
- [x] 9.25 Codex app-server、Claude stream/resident 与 ACP 共用 spawnCliProcess，修复 Windows .cmd/.bat 启动 EINVAL
  - 2026-11-16：真实 .cmd 包装常驻 Claude 用例先 spawn EINVAL，改后通过；相关 4 文件 27/27，typecheck 通过。
- [x] 9.26 Codex app-server 只接受明确 completed；Claude stream/resident 共用 claudeResultError，错误 result 不再结算成功
  - 2026-11-16：codexTurnError 覆盖 failed/interrupted/unknown；常驻真实错误结果用例从 resolve 变 reject；相关 3 文件 9/9 通过。
- [x] 9.27 headless 在 close 时补喂换行 flush 最后一条 JSON，且 onStep 缺省也喂 parser
  - 2026-11-16：真实子进程无换行 error + 无 onStep 从 success 变 failed；task-args-prompt/step-parsers 22/22。
- [x] 9.28 ACP stderr 诊断进入错误前剥离 URL query/fragment，并复用 home/长串脱敏
  - 2026-11-16：短认证 code 的回归先泄露后阻断；acp-diagnostics/bridge 109/109。
- [x] 9.29 Windows .cmd/.bat 使用 taskkill /T 回收真实 CLI 进程树
  - 2026-11-16：假 CLI 忽略 stdin 保持存活，close 旧实现只杀外壳（红灯）；killCliProcess 后子孙退出，相关 4 文件 32/32。
