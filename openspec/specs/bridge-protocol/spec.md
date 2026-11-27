# bridge-protocol 规格

## Purpose

定义本机 bridge 与远程编排平台之间的 wire 契约。**平台侧是第三方独立实现**，因此本规格是双方唯一可对齐的承诺：
消息方向、字段必填性、鉴权方式、心跳与吊销语义、日志分片规则。

## Requirements

### Requirement: 出站长连接

bridge SHALL 主动向平台发起 WebSocket 连接（`/api/bridge/ws?deviceId=<id>`），握手携带
`Authorization: Bearer <device_token>`，且 SHALL NOT 监听任何**对外**入站端口。

仅有两类本机回环监听例外，且都必须只绑 `127.0.0.1` / `::1`：授权期的临时回调服务（拿到授权码后立即关闭），
以及本地控制面（`[control_plane] enabled` / `agent-bridge serve`，**默认关闭**，不回 `Access-Control-Allow-Origin`）。
回环监听不构成对外网络暴露。

#### Scenario: 握手成功

- **WHEN** 设备已绑定且网络可达
- **THEN** 连接建立后 bridge 立即发送 `hello`（含 `protocolVersion` / `deviceId` / `cliVersion` / `platform` / `hostname`）

#### Scenario: 凭证被吊销

- **WHEN** 平台以 close code `4401` 或 `4403` 关闭连接
- **THEN** bridge 记录提示并停止重连（不进入退避循环），用户需重新 `connect`

#### Scenario: 网络中断

- **WHEN** 连接异常断开（如 1006）
- **THEN** bridge 以 1s→2s→4s…→30s 指数退避重连，并在重连后补发状态类消息（`task_log` 不补发）

### Requirement: 工具状态上报

bridge SHALL 在每次连上后上报本机工具清单，并响应平台的 `scan` 指令。状态 SHALL 为三态之一：
`ready` / `installed_no_cred` / `not_installed`，找到二进制但无法执行时 SHALL 额外标记 `installedButBroken`。
每项 SHALL 包含工具名（`display`）、版本（`version`，探测不到时省略）、状态（`status`）与品牌图标（`logo`），
`logo` 为 `data:image/svg+xml;base64,…` 的 24×24 单色矢量，缺失时 SHALL 省略该字段。
扫描 SHALL 并发进行（同时探测不超过 6 个工具），且 SHALL 在扫描过程中**实时**推送已完成项。

#### Scenario: 实时进度

- **WHEN** 扫描开始且第一个适配器完成探测
- **THEN** bridge 立即发送 `scan_progress`（`items` 含该工具、`done: false`），不必等全部完成

#### Scenario: 终态全量

- **WHEN** 全部适配器探测结束
- **THEN** bridge 发送终态消息：首连为 `agent_list`、响应 `scan` 为带相同 `requestId` 的 `scan_result`，两者都含完整清单

#### Scenario: 工具装了但缺凭据

- **WHEN** 二进制存在、`--version` 可执行、但既无环境变量也无凭据文件
- **THEN** 该项上报 `installed_no_cred`，不报 `ready`

#### Scenario: 平台主动重扫

- **WHEN** 平台下发 `{ "type": "scan", "requestId": "r1" }`
- **THEN** bridge 绕过 30s 缓存重扫，先以 `requestId: "r1"` 流式回 `scan_progress`，最后回 `scan_result`（`requestId: "r1"`）

### Requirement: 远端任务执行

bridge SHALL 只接受适配器白名单内的 `agentType`，SHALL 要求 `taskId` / `agentType` / `cwd` / `args` 齐备，
且 SHALL 在不满足时回 `task_status: failed` 而不 spawn 任何进程。

#### Scenario: 未知工具

- **WHEN** 平台下发 `agentType: "not-a-real-agent"`
- **THEN** bridge 回 `{ "status": "failed", "error": "不支持的工具：…" }`，且不产生任何子进程

#### Scenario: 使用适配器默认参数

- **WHEN** 平台下发 `"args": []` 并给出 `prompt`
- **THEN** bridge 用适配器的 `taskArgs` 模板替换 `{{prompt}}` 后执行（参数仍以数组传递，不经 shell）

#### Scenario: 超时

- **WHEN** 任务运行超过 `timeoutMs`（缺省 10 分钟）
- **THEN** bridge 发 `SIGTERM`，2s 后 `SIGKILL`，并回 `task_status: timeout`

### Requirement: 日志流

bridge SHALL 将子进程 stdout/stderr 以 `task_log` 分片即时回传，每个分片 SHALL ≤ 4096 字节 UTF-8，
且 SHALL NOT 切断多字节字符。连接断开期间产生的 `task_log` SHALL 被缓冲并在重连后按序补发，
缓冲 SHALL 有界（默认 256 KB）；超出上限时 SHALL 丢弃较早的分片，并在补发序列最前插入一条说明性
`task_log`（挂在同一 `taskId` 上）告知丢弃量。

#### Scenario: 大段中文输出

- **WHEN** 子进程一次输出 9000 字节中文
- **THEN** bridge 切成多个 ≤4096 字节的分片，逐片发送，平台按序拼接可无损还原

#### Scenario: 断线期间的输出

- **WHEN** 任务运行中连接断开 30 秒，随后重连
- **THEN** 这 30 秒内的 `task_log` 在重连后按原顺序补发，平台日志不出现空洞

#### Scenario: 缓冲超限

- **WHEN** 断线期间日志总量超过缓冲上限
- **THEN** bridge 丢弃较早的分片，并先发一条 `[agent-bridge] 断线期间日志超出缓冲上限（N KB），已丢弃较早部分`，
  再接上保留的最新分片；任务本身不受影响

### Requirement: 设备绑定授权

bridge SHALL 支持三种绑定方式：浏览器回环回调（PKCE S256）、设备码（无浏览器场景）、预签发 token（CI）。
回环回调 SHALL 只绑 `127.0.0.1`，且拿到授权码后立即关闭临时服务。

交互授权前，bridge SHALL 按 `device-identity` 能力取得并持久化本地稳定 `deviceId`。`POST /api/bridge/token` SHALL 携带 `code`、`codeVerifier`、`redirectUri`、`clientId`、`deviceId`、`hostname`、`platform`、`cliVersion`；`POST /api/bridge/device-token` SHALL 携带 `device_code`、`clientId`、相同的 `deviceId` 与元信息。两个成功响应中的 `device_id` SHALL 等于请求中的 `deviceId`，否则 bridge 不得保存凭证或建立连接。

预签发 token 模式 SHALL 复用已持久化身份，或在身份文件不存在时从旧配置、`--device-id`、`AGENT_BRIDGE_DEVICE_ID` 迁移已有 ID。无法取得合法 ID 时 SHALL 明确失败，不得生成随机 ID 或以空 ID 连接。所有 WS 连接 SHALL 在 URL query 与 `hello.deviceId` 中携带同一个本地身份。

本 Requirement 移除了旧版「省略 `deviceId` / `hello.deviceId` 空串」的兼容行为。1.0 是破坏性升级，
`PROTOCOL_VERSION = 1` 且不保留 0.2.x 双栈，平台与 bridge 同批升级。

#### Scenario: 浏览器授权

- **WHEN** 用户执行 `agent-bridge connect https://platform.example.com`
- **THEN** bridge 先持久化本地身份，再起临时回调服务并打开授权页；收到 `code` 后以携带该身份的 `POST /api/bridge/token` 换取 `device_token`，凭证保存成功后以同一身份建立 WS

#### Scenario: 设备码授权

- **WHEN** 用户以 `--no-browser` 执行 `connect`
- **THEN** bridge 复用授权前已保存的身份，轮询 `POST /api/bridge/device-token` 时持续携带该 ID 与元信息，成功后使用同一身份建立 WS

#### Scenario: 平台响应身份不一致

- **WHEN** token 成功响应中的 `device_id` 缺失、格式非法或不等于请求 ID
- **THEN** bridge 报协议错误，不保存 token、不建立 WS、不改写本地身份

#### Scenario: CI 场景（已知设备 ID）

- **WHEN** 用户执行 `connect <url> --token=<device-token> --device-id=bd_9f1c00000000`
- **THEN** bridge 将既有 ID 迁移或确认后跳过交互授权，WS URL 与 `hello.deviceId` 均为该 ID

#### Scenario: CI 场景（未提供设备 ID）

- **WHEN** 用户只给 `--token`，且本地没有任何可迁移身份
- **THEN** bridge 在建立 WS 前明确失败并提示提供 `--device-id`，不生成替代身份、不发送空 `deviceId`

#### Scenario: 协议版本

- **WHEN** 新实现发送 hello
- **THEN** `protocolVersion` 为 1，`deviceId` 符合固定正则且与 WS query 一致

### Requirement: 平台绑定错误处理

bridge SHALL 解析公开 orchestrator JSON 错误响应顶层的 `code` 与 HTTP 状态，并保留机器可读错误信息。bridge SHALL NOT 通过更换本地 `deviceId` 规避平台错误，也 SHALL NOT 把错误响应原文或敏感凭证写入日志。

授权码被用于交换后不得自动重放。设备码仅在 `428 authorization_pending` 期间按服务端间隔重复轮询；收到成功、终态错误或交换结果不可知后，重试 SHALL 获取新设备码并继续使用原身份。

#### Scenario: 本地身份被平台判定非法

- **WHEN** 平台返回 `400 invalid_device_id`
- **THEN** bridge 报本地身份格式错误并保留现场，不自动重建身份

#### Scenario: 跨账号或历史身份冲突

- **WHEN** 平台返回 `409 device_bound_to_other_account` 或 `409 device_identity_ambiguous`
- **THEN** bridge 显示对应的管理处理提示并停止授权，不自动换 ID、转移所有权或合并设备

#### Scenario: 凭证或授权失败

- **WHEN** 平台返回 `401` 或 `403`
- **THEN** bridge 按凭证/授权失败处理并保留原身份，不重放已消费的授权码或设备码

#### Scenario: 设备码等待用户确认

- **WHEN** 轮询返回 `428 authorization_pending`
- **THEN** bridge 按服务端 interval 继续轮询同一设备码，不重新生成本地身份

### Requirement: 能力协商

bridge SHALL 在 `hello` 中携带 `capabilities: string[]`，列出本设备支持的**可选能力**，
使任何第三方平台能在握手阶段判断可用功能，而不是靠客户端版本号猜。

当前清单以 `src/protocol.ts` 的 `PROTOCOL_CAPABILITIES` 为唯一真源（`npm run doc:check` 会机检一致性），
包含 `diff` / `service-token` / `queue` / `scan-progress` / `cloud-events` / `capacity` / `task-step` /
`task-message` / `task-snapshot` / `session-control` / `session-multi-turn` / `task-interaction` /
`artifact-upload` / `artifact-download` / `interaction-url`。

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

### Requirement: 容量水位上报

bridge SHALL 在 `hello` 中携带 `capacity: { maxTasks, maxQueued }`（本次会话生效值），
并 SHALL 在每次调度状态变化（任务入队 / 启动 / 终态）后发送 `capacity_update` 上行消息：
`{ running, queued, maxTasks, maxQueued }`。平台与控制面两条通道 SHALL 共用同一调度器，
水位 SHALL 反映两条通道的合计占用。

#### Scenario: 握手即知上限

- **WHEN** 设备以 `--max-tasks=12 --max-queue=100` 启动并连上平台
- **THEN** `hello.capacity` 为 `{ maxTasks: 12, maxQueued: 100 }`（与环境变量/配置无关）

#### Scenario: 状态变化即上报

- **WHEN** 一个任务从队列启动（running 3→4，queued 5→4）
- **THEN** bridge 发送一条 `capacity_update { running: 4, queued: 4, ... }`，平台无需等待终态

### Requirement: 任务步骤上报

bridge SHALL 为具备结构化事件输出的工具（适配器逐项标注）把子进程的**动态步骤流**以
`task_step` 上行消息回传：`{ taskId, seq, action, label?, state, ok?, at }`。
`seq` SHALL 从 1 开始按发生顺序单调递增；`state` 为 `started | finished`，`finished` 时
SHALL 带 `ok`；`label` SHALL 截断（≤160 字符）并按日志同口径脱敏。
不具备结构化事件的工具 SHALL NOT 发送伪造步骤，且 SHALL 在 `agent_list` / `scan_result`
中逐项以 `steps: false` 如实标注。任务终态后的 `task_step` SHALL 被丢弃（与 `task_log` 同规则）。

#### Scenario: 结构化工具的步骤流

- **WHEN** 平台对一个 `steps: true` 的工具下发任务，CLI 依次执行 Read → Edit → Bash
- **THEN** 平台按序收到三条 `task_step`（seq 1/2/3，action 分别为 Read/Edit/Bash），
  步骤面板可实时渲染「当前在第几步」

#### Scenario: 纯文本工具如实降级

- **WHEN** 平台对一个 `steps: false` 的工具下发任务
- **THEN** 平台只收到 `task_status` / `task_log`，不会收到任何 `task_step`

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
task_message SHALL 支持 delta/complete 两种 state，complete 携带权威完整 part。**1.0 的实际口径**：
bridge 只发 complete（每条落库消息一条），**不推送 delta 帧** —— 正在生成中的文本改由
`task_snapshot.partialMessages` 暴露（只在内存、不落库、终态即清）。`delta` 为保留位，平台不得等它。

feed SHALL 同时受条数和字节预算限制。淘汰最旧事件时 SHALL 记录显式 gap（fromEventSeq/toEventSeq/reason），
SHALL NOT 静默造成时间线空洞。adapter 在终态前 SHALL 有界 flush 最终消息/附件，终态 task_status 的 eventSeq
SHALL 大于所有 feed 事件；收尾失败 SHALL 在终态标记 feedIncomplete。

#### Scenario: 半截文本（1.0 口径）

- **WHEN** 任务运行中平台重新 get_task
- **THEN** 快照带 `partialMessages`（本回合已累积但未定稿的助手文本，`pm_<taskId>`，上限 32 KiB 后置
  `truncated`）；终态之后该字段为空，平台以事件里的 complete 为准；bridge 不为此推送 delta 帧

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

**读回包 SHALL 与「事件」区别对待**：`task_snapshot`（get_task）与 `artifact_content`（get_artifact）
回答的是客户端请求、不产生新事件，因此 SHALL 在任务终态后仍然可发；把它们一起丢弃会让
「任务跑完再取产物」这一最常见路径永久无响应（平台只能等到超时）。该豁免 SHALL 只覆盖
回答请求的帧类型，SHALL NOT 被扩大为「终态后什么都发」。

生产模式 SHALL 以 SQLite idempotency/tombstone 为权威，taskId 永不复用；retention 删除内容后同 ID 再提交
SHALL 回 session_deleted 且永不 spawn。SQLite 是唯一权威，不使用 MAX_TRACKED 内存淘汰。历史裁剪导致 replay
不完整 SHALL 回 session_history_pruned。

#### Scenario: 终态后取产物

- **WHEN** 某任务已进入 success / failed / cancelled / timeout 终态，平台随后发 `get_artifact`
- **THEN** bridge SHALL 回 `artifact_content`（`found:true` 带元数据与可读内容，或
  `found:false` 带 `artifact_not_found` / `not_readable`），不因终态而静默丢弃

#### Scenario: 终态后取快照

- **WHEN** 任务终态后平台发 `get_task`
- **THEN** bridge SHALL 回 `task_snapshot`

#### Scenario: 同步拒绝后改参重发

- **WHEN** 首次任务因权限或交互策略被拒绝，平台以同 taskId 修改权限、args 或 allowInteractive 重发
- **THEN** 平台收到首次 failed 的相同终态回放，bridge 不重新校验、不 spawn

#### Scenario: 不同终态冲突

- **WHEN** 某 taskId 已终态后又出现不同内容的终态或新的 log/step/running
- **THEN** Emitter 丢弃这些冲突消息，不因新的 CloudEvents seq/id 而放行
