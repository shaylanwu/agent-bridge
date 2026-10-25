# task-execution 规格增量：任务执行控制

## ADDED Requirements

### Requirement: 本机策略与受管参数模式

bridge SHALL 提供 `permission_policy = "default" | "allow-full" | "full"`，默认 default。
allow-full/full SHALL 使用受管参数模式，WS 与控制面任务只接受 `args: []`；default 保留 legacy args。
该约束 SHALL 只用于 argv 确定性，SHALL NOT 被描述为 CLI 配置、插件或继承环境的隔离边界。

#### Scenario: 仅允许按任务申请

- **WHEN** 本机为 allow-full，两个任务分别省略 permissionMode 和请求 full
- **THEN** 前者按 default 执行，后者满足执行模式条件时按 full 执行

#### Scenario: 受管参数模式携带自定义参数

- **WHEN** 本机为 allow-full 或 full，任一通道下发非空 args
- **THEN** bridge 在 spawn 前回 permission_policy_denied，不因参数看似普通而放行

#### Scenario: 本机 full 与单任务降级

- **WHEN** 本机为 full，一个任务省略字段，另一个请求 default
- **THEN** 前者选择 full，后者选择 default；省略字段的旧平台任务也选择 full

### Requirement: 十二适配器 full 映射

bridge SHALL 为全部 12 个适配器登记 full 映射，SHALL NOT 给所有工具追加同一个参数，也 SHALL NOT 绑定开发机路径、
安装位置或本机版本。旧 CLI 与已声明参数不兼容 SHALL 由 CLI 失败，bridge SHALL NOT 静默退回 default。
除受控交互适配器外，子进程 stdin SHALL 保持 ignore，平台环境变量 SHALL 继续被忽略。

#### Scenario: DSH 完全权限

- **WHEN** DSH headless 任务选择 full
- **THEN** 加入 `--permission-mode danger-full-access --approval-policy never`，不注入环境变量；
  仍需审批的调用按 never 自动拒绝而不是自动批准

#### Scenario: Kimi 不追加互斥参数

- **WHEN** Kimi 任务选择 full
- **THEN** 保留 `-p` 的自动权限行为，不追加 `--auto`

#### Scenario: 旧版本 CLI 不接受权限参数

- **WHEN** 任一适配器有 full 映射但安装版本拒绝该参数
- **THEN** 任务以 CLI 错误失败并提示检查工具版本，bridge 不以 default 重试

### Requirement: CodeBuddy 外部沙箱声明与固定环境例外

bridge SHALL 提供默认关闭的 external_sandbox 本机配置/启动参数。只有该声明为 true 且本机策略允许 full 时，
CodeBuddy full SHALL 使用 `-y` 并由 bridge 固定注入 `CODEBUDDY_IS_SANDBOX=1`。平台与控制面请求
SHALL NOT 设置该声明。除这一固定键值外，其他工具与 default 任务的子进程环境 SHALL 保持不变。
该门控 SHALL NOT 被描述为能阻止 CodeBuddy 通过配置、插件或既有环境获得等效自动审批能力。

#### Scenario: 未声明外部沙箱

- **WHEN** external_sandbox=false，平台对 CodeBuddy 请求 full
- **THEN** bridge 在 spawn 前回 permission_mode_unsupported，不注入变量

#### Scenario: 已声明外部沙箱

- **WHEN** 使用者在真实隔离环境中以 external_sandbox=true 启动，CodeBuddy 任务选择 full
- **THEN** 使用 `-y` 且只追加固定变量；审计不记录其他环境值

### Requirement: 交互双开关与执行模式能力

bridge SHALL 提供默认关闭的 interaction_enabled。只有本机启用且 run_task.allowInteractive=true 时，
才可建立交互执行模式。allowInteractive 选择支持交互的执行模式；permissionMode 与该模式的
permissionModes/interactionKinds 必须同时匹配，否则在 spawn 前拒绝。feedKinds 独立声明该模式可提供的
canonical 会话维度，未声明维度不生成标准事件。

#### Scenario: 本机未启用交互

- **WHEN** interaction_enabled=false，平台下发 allowInteractive=true
- **THEN** bridge 回 interaction_disabled，不建立 stdin pipe、不 spawn

#### Scenario: 工具不支持交互

- **WHEN** 平台对 interactionKinds 为空的工具请求 allowInteractive=true
- **THEN** bridge 回 interaction_unsupported，不用 headless 日志模拟交互

#### Scenario: full 与 ACP 能力不匹配

- **WHEN** 工具 headless 支持 full，但 ACP 只声明 default
- **THEN** full + allowInteractive 在 spawn 前回 permission_mode_unsupported，不以 ACP default 执行

### Requirement: 权限与问题的组合语义

default + allowInteractive 时，bridge SHALL 允许权限与 Form 请求转交人工。full + allowInteractive 时，
bridge SHALL 只允许 Form 问题转交人工，残余权限请求 SHALL fail closed，不得借人工绕过 full 的静态 deny。
未启用交互时，结构化权限/问题请求 SHALL 明确失败或向 adapter 返回取消，不得无限等待。

#### Scenario: default 下人工批准

- **WHEN** default + allowInteractive 的任务收到权限请求，用户选择 allow_once
- **THEN** adapter 恰好收到一次允许，任务按 CLI 后续行为继续

#### Scenario: full 下模型澄清

- **WHEN** full + allowInteractive 的任务收到 Form 问题
- **THEN** 平台可回答；full 不得把问题自动当成“是”

#### Scenario: full 下残余权限请求

- **WHEN** full 任务仍收到权限请求
- **THEN** 若 options 含 reject_once，选择其原 optionId；否则回复 cancelled、取消回合并以 interaction_denied 结束；
  无论 allowInteractive 是否开启，都不转交人工提升权限，也不伪造 reject 选项

### Requirement: 等待状态、超时与取消

内部状态 SHALL 支持 queued/running/waiting_interaction/waiting_user/settled。waiting_interaction SHALL 继续占用
running 名额，waiting_user SHALL 释放名额；调度器不得只按 status 统计。每 Turn 使用 turnTimeoutMs，旧 timeoutMs
只约束首个 Turn；waiting_user 用 idleTimeoutMs，不占 Turn 时限。每次交互 SHALL 有 expiresAt，
取 interaction_timeout_ms 与当前 Turn 剩余时限的较小值。
权限超时只有在当前 options 提供 reject_once 时才选择其原 optionId；否则 SHALL 以 ACP cancelled outcome 完成原请求，
Form 超时 SHALL 映射 cancel；adapter 无法处理时任务以 interaction_timeout 结束，bridge SHALL NOT 伪造 optionId。

#### Scenario: 单次交互超时

- **WHEN** pending 到 expiresAt 仍未收到有效响应
- **THEN** broker 产生 expired 结果；若有 reject_once 则按原 optionId 拒绝，否则回复 cancelled/cancel 并结束回合；
  迟到响应不得恢复

#### Scenario: 总任务超时

- **WHEN** 当前 Turn 的 turnTimeoutMs（或首个 Turn 的旧 timeoutMs）在等待期间到期
- **THEN** bridge 先结算 pending 的 cancelled/expired 结果，再按 SIGTERM→2s→SIGKILL 结束该 Turn timeout

#### Scenario: 用户取消任务

- **WHEN** pending 期间收到有 session:close 权限的 cancel_task/cancel_turn
- **THEN** bridge 作为 ACP Client 发送 session/cancel，并以原 JSON-RPC id 对 pending 权限回复 cancelled、对 Form 回复 cancel；
  Agent 以 stopReason=cancelled 完成回合，broker 产生 cancelled 结果，supervisor 再结算任务 cancelled；迟到响应无效

### Requirement: ACP 适配器结算与能力限制

ACP 适配器 SHALL 使用受控 stdio JSON-RPC，支持 initialize/session/new/session/prompt/update/session/cancel/close。
取消回合 SHALL 使用 Client→Agent 的 session/cancel；对 Agent 发来的未决权限/Form 请求，SHALL 以原 JSON-RPC id
分别回复 cancelled/cancel，SHALL NOT 用 `$/cancel_request` 代替回合取消。
任务 SHALL 以 session/prompt 回合响应作为主要结算点；提前 close SHALL 视为异常，常驻进程 SHALL 在回合完成后关闭。
ACP fs/terminal 等未评审 client 方法 SHALL 返回 UnsupportedOperation，不得自动执行。

#### Scenario: 回合完成后进程常驻

- **WHEN** ACP 已返回 session/prompt 回合结果但进程仍存活
- **THEN** adapter 关闭进程，supervisor 按回合结果 settle 一次，不等待 close 才结算

#### Scenario: 回合完成前进程退出

- **WHEN** ACP 进程在 session/prompt 响应前 close
- **THEN** 任务 failed，除非 supervisor 已因取消/timeout settle

#### Scenario: ACP 回合结果映射

- **WHEN** session/prompt 分别以 end_turn、max_tokens、max_turn_requests、refusal、cancelled 或 JSON-RPC error 返回
- **THEN** end_turn 映射 success；max_tokens/max_turn_requests/refusal 映射 failed/agent_error 并保留 stopReason；
  cancelled 映射 cancelled；JSON-RPC error 映射 failed/agent_error。已有 cancelled/timeout 终态不得被改写为 success

#### Scenario: 回合完成仍有未决交互

- **WHEN** session/prompt 已返回但 broker 仍有 pending 或 submitting 交互
- **THEN** 任务 failed/agent_protocol_error，关闭进程，不把缺失回答当成成功

#### Scenario: Agent 请求未开放 client 能力

- **WHEN** ACP Agent 请求 fs/write 或 terminal/create
- **THEN** bridge 返回 UnsupportedOperation，不代为写文件或执行终端

### Requirement: 权限请求与 Form 校验

权限 options SHALL 来自 adapter，bridge 可过滤 persistent 项但 SHALL NOT 新增 allow。
once/turn/session/workspace/always 由本机 policy 决定是否开放；持久选项写 approval ledger，可撤销。
optionId 必须属于当前请求。Form schema SHALL 限于扁平对象和原始/enum 属性，content 由双方校验。
Form SHALL NOT 收集秘密；秘密/支付/OAuth 使用 URL Elicitation，URL/secret 不落 bridge 存储。

#### Scenario: 伪造 optionId

- **WHEN** 响应选择的 optionId 不在当前 options 中
- **THEN** 回 pending/invalid，adapter 不收到选择，pending 可继续等待有效回复

#### Scenario: Form 缺少必填字段

- **WHEN** accept content 缺少 requestedSchema.required 中的字段
- **THEN** 回 pending/invalid，不交付 adapter；补充正确 content 后可重试

#### Scenario: 敏感或 URL Form 请求

- **WHEN** 请求明确要求 URL Elicitation、秘密流程，或来源协议明确标记敏感类型
- **THEN** 不通过 Form 接收，改用 URL Elicitation 或明确失败；bridge 不按字段名/文案正则猜测 secret

#### Scenario: 普通 Form 的人工审查

- **WHEN** 普通非敏感 Form 被转交外部系统
- **THEN** 客户端展示请求来源、message 和字段，允许用户修改、明确 decline 或 cancel；合规不得只依赖 bridge 自动识别

### Requirement: 会话呈现提取与附件安全

bridge SHALL 从结构化 CLI 输出提取 agent/system 文本与富工具调用，生成 canonical task_message/task_step；
无法可靠提取的适配器 SHALL 不声明该 feed 能力，SHALL NOT 用 raw log/正则伪装标准消息。user 交互响应由平台渲染，
bridge SHALL NOT 回显 Form content 为用户消息。自由文本多轮使用 send_message，并按 Session/Turn 规格持久化。

#### Scenario: 结构化消息提取

- **WHEN** 适配器输出的 JSONL 包含 assistant 文本或工具调用
- **THEN** 解析器生成稳定 messageId 与 eventSeq、ACP 风格 toolCall；同一逻辑消息的 delta 复用 messageId

#### Scenario: 非结构化输出

- **WHEN** 工具仅输出自由文本或适配器无法可靠区分消息
- **THEN** executionModes 不声明 message feed；task_log 仅供调试，不宣称完整 Web 会话

#### Scenario: 附件路径安全

- **WHEN** adapter 明确声明 artifact 事件
- **THEN** bridge 仅从该事件读取文件；模型提供的 toolCall.location/title 不得作为读取依据；
  读取根限制为该任务 cwd 的 realpath 子树，拒绝 `..`、符号链接逃逸、目录和凭据路径；
  用同一 fd 读取并校验 size/SHA-256，超限只发元数据，不扫描整个工作区

### Requirement: 会话快照、预算与终态收尾

bridge SHALL 为每个任务维护有界 canonical feed；200 messages/200 steps/50 artifacts、4 MiB 单任务和 64 MiB 进程
是默认配置而非产品硬上限，可按部署调整。feed 按 eventSeq 排序，淘汰 SHALL 产生显式 gap，不得静默删除时间线。
task_snapshot SHALL 只包含状态、events、partialMessages、pending interaction、eventWindow/gaps、hasMoreBefore、
feedIncomplete，SHALL NOT 包含 raw task_log、Form content 或超过 inline 上限的文件正文。
生产模式 SQLite 为权威：任务不存在回 task_not_found，tombstone 回 session_deleted，历史裁剪回 session_history_pruned；
artifact 未知/淘汰回 artifact_not_found；保留窗口内事件缺失只用 gaps 表达。
SQLite 持久化后重启继续提供会话/事件，active turn 恢复为 interrupted；retention 删除按配置并可审计。
终态前 adapter SHALL 有界 flush 最终消息/附件，终态 eventSeq 最后分配；无法收尾时置 feedIncomplete。

#### Scenario: Web 会话重建

- **WHEN** 客户端在运行中或重连后请求 task_snapshot
- **THEN** 可从 events、partialMessages、状态和 pending interaction 重建展示；
  eventWindow/gaps 明确保留缺口，hasMoreBefore 支持历史继续回翻

#### Scenario: 终态前收尾

- **WHEN** session/prompt 回合完成或 headless 即将 close
- **THEN** adapter 先处理已接收帧并发出最终 complete/artifact，再发终态 task_status；
  超出有界收尾预算则标记 feedIncomplete，终态后不再补 feed

#### Scenario: 快照或附件不可用

- **WHEN** 任务不存在/已删除/历史裁剪，或 artifact 未知/已淘汰
- **THEN** bridge 分别回 task_not_found/session_deleted/session_history_pruned/artifact_not_found；
  不返回空会话、不重新读取文件

### Requirement: 响应幂等、限流与审计

每任务 SHALL 同时最多一个 pending；16 次交互、64 KiB 单交互 wire、32 KiB Form content 是默认安全配置，可按部署调整。
permission 响应 SHALL 校验 task:approve，Form 响应 SHALL 校验 task:respond；session:create 不隐含这些权限，
持久授权另需 approval:persist。
broker SHALL 在任何 await 前执行 pending→submitting；写入成功才 resolved，写入不确定则 failed 且禁止重试。
审计 SHALL 记录 requestId/responseId/kind/optionId 或 action/respondedBy/结果，SHALL NOT 记录 Form content。

#### Scenario: 使用创建令牌审批

- **WHEN** 调用方只有 session:create，尝试 approve 或 respond
- **THEN** bridge 回 insufficient_scope，pending 不被改变

#### Scenario: 同一响应 occurrence 重发

- **WHEN** 平台因断线以同一 responseId 重发响应
- **THEN** 回该 responseId 的原 resultSeq/resolution，adapter 只收到一次；新 responseId 的相同响应才回 duplicate + 新 resultSeq

#### Scenario: 并发响应

- **WHEN** 一个响应正在 adapter 写入时另一个响应到达
- **THEN** 相同规范化响应回 submitting/duplicate 且不重复写；不同响应回 conflict，原交付不受影响

#### Scenario: 交付结果不确定

- **WHEN** adapter 写入可能已发生但无法确认结果
- **THEN** requestState=failed、errorCode=interaction_delivery_unknown，取消回合并失败任务，禁止自动重试

#### Scenario: 超过交互次数

- **WHEN** 单任务交互次数超过本机上限
- **THEN** 新请求以 interaction_rate_limited 拒绝，不无限占用任务与平台资源

### Requirement: 同步拒绝与终态幂等

所有权限、args 与交互同步拒绝 SHALL 创建并跟踪 settled Entry，保存失败与权限快照。
同一 taskId 重发 SHALL 复用首次快照；生产模式以 SQLite idempotency/tombstone 为权威，taskId 永不复用，
retention 删除内容后同 ID 回 session_deleted。SQLite 是唯一权威，不使用 MAX_TRACKED 内存淘汰。
Emitter SHALL 允许完全相同终态重放，其他冲突消息仍丢弃；任务终态后已存在交互的 result 仍可回传，不得再次交付 adapter。

#### Scenario: 同步拒绝后改参重发

- **WHEN** 首次因 permission/interaction 策略被拒后，平台以同 taskId 修改 args、permissionMode 或 allowInteractive
- **THEN** 回放首次 failed，不重新校验、不 spawn

#### Scenario: 终态后迟到或重复响应

- **WHEN** 任务已 cancelled/timeout/success 后收到已存在 request 的 late/duplicate 响应
- **THEN** bridge 回对应 result，不重新启动任务、不调用 adapter

#### Scenario: 历史已删除或裁剪

- **WHEN** taskId tombstone 存在但内容已删除，或历史被 retention 裁剪
- **THEN** 分别回 session_deleted/session_history_pruned，不重新 spawn、不返回伪空历史

#### Scenario: 完全权限或交互任务留痕

- **WHEN** full 或 interaction 被接受、拒绝或重放
- **THEN** 审计记录所选策略与结果，不记录敏感参数、Form content 或重复重放动作

### Requirement: 开源可移植性

实现与文档 SHALL 只依赖工具 kind、官方参数和使用者配置，SHALL NOT 绑定开发机绝对路径、用户名、安装位置或版本特判。
测试 SHALL 使用不同临时 HOME/cwd 证明配置可移植。

#### Scenario: 在不同用户环境运行

- **WHEN** 使用不同 HOME、cwd 和 CLI 安装位置执行同一适配器测试
- **THEN** full 与 interaction 的参数/协议行为一致，不需要修改源码
