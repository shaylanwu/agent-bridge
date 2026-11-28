# bridge-protocol 规格增量：补齐 feed 缺口语义并校正字段名

## MODIFIED Requirements

### Requirement: Web Agent 会话呈现 Feed

bridge SHALL 提供 canonical 的 task_message、富 task_step 和 task_artifact 事件，供外部构建 Web Agent 会话窗口。
task_log SHALL 保留为调试通道，SHALL NOT 被文档宣称为稳定消息协议。**每任务只有一条 eventSeq 序列**，
覆盖 queued/running/waiting/终态 task_status、task_message、task_step、task_artifact 与 task_interaction_request；
task_interaction_result 不占 eventSeq，用 requestId+resultSeq 排序并可在任务终态后回传。
task_step 的 seq 仍表示步骤序号，不得与 eventSeq 混用。每个 feed 事件首次发出时分配一次，
重放保持，新事件严格 +1。终态 task_status 的 eventSeq 必须大于所有已发出的 canonical feed 事件。
task_message SHALL 支持 delta/complete 两种 state，complete 携带权威完整 part。**1.0 的实际口径**：
bridge 只发 complete（每条落库消息一条），**不推送 delta 帧** —— 正在生成中的文本改由
`task_snapshot.partialMessages` 暴露（只在内存、不落库、终态即清）。`delta` 为保留位，平台不得等它。

feed SHALL 同时受**条数**与**字节**预算限制，且两类裁剪 SHALL 用两种不同语义表达，不得混用：

1. **分类淘汰 = 窗口内缺口**：按类型（messages / steps / artifacts）计条数淘汰最旧同类，事件序号**水位不前移**，
   SHALL 在 `task_snapshot.eventWindow.gaps` 里以 `{ from, to, reason }` 显式给出，
   `reason` 取 `count` / `task_bytes` / `global_bytes`；无记录来源的缺口（如写入失败）SHALL 不带 `reason`。
2. **前缀删除 = `prunedThrough`**：按字节从最旧整段删除时推进水位，SHALL 用 `prunedThrough` 与
   `session_history_pruned` 表达「更早的部分已回收」，SHALL NOT 混入窗口内缺口。

各会话**最新终态 `task_status`** SHALL 作为保护行，SHALL NOT 被条数淘汰删除（结论比过程重要）；
adapter 在终态前 SHALL 有界 flush 最终消息/附件，终态 task_status 的 eventSeq SHALL 大于所有 feed 事件；
收尾失败 SHALL 在终态标记 feedIncomplete。缺口是**持久化事实**：SHALL NOT 因断线重连而消失或改变。

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

#### Scenario: 分类淘汰产生缺口

- **WHEN** 某任务的 step 条数超过预算上限，且类型交错导致序号不连续
- **THEN** `eventWindow.gaps` 非空、每段带 `reason`（如 `count`），平台据此知道「中间缺内容」而不是「序号连续」；
  同一快照里该任务的最新终态 `task_status` 仍在

#### Scenario: 前缀删除不产生窗口内缺口

- **WHEN** 某任务的 payload 字节超过预算，从最旧整段删除
- **THEN** `prunedThrough` 前移、`eventWindow.gaps` 为空；游标落在已删区间时回 `found:true` +
  `errorCode: session_history_pruned` + 同一 `prunedThrough`

#### Scenario: 断线重连后缺口不变

- **WHEN** 平台断开并重连，对同一任务再次 get_task
- **THEN** `eventWindow`（`oldestEventSeq` / `latestEventSeq` / `gaps`）与断线前完全一致 —— 缺口不会被「治好」

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
`eventWindow { oldestEventSeq, latestEventSeq, gaps }`、hasMoreBefore、可选 prunedThrough 和 feedIncomplete，
SHALL NOT 包含 Form content 或大文件正文。任务不存在回 task_not_found（404，ID 从未存在）；
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
