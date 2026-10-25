# 完整目标设计：Agent Session Gateway

> 本文件是本变更的**完整目标态**。`design.md` 保留协议内核和已复核细节；本文件补齐持久会话、多轮聊天、
> 双向附件、崩溃恢复、外部网关与运维治理。实施分阶段只是交付顺序，**不是能力删减**。

## 1. “无限制”的准确含义

- 不设产品级功能删减：权限、交互、多轮会话、双向附件、持久历史、外部协议适配、可观测性全部在目标范围内；
- 不对 CLI 能力造假：没有原生双向协议的 CLI 使用 resume/replay 策略，能力如实协商；
- 不承诺无限资源：文件、内存、磁盘、并发由部署方配置安全预算（quota），可调大或关闭，但必须有背压和失败语义；
- 不把 OS 提权、模型上下文长度、外部 IdP 权限伪装成 bridge 能力；
- 不允许无界队列/无界内存导致进程崩溃；所有“无限制”均指**无硬编码产品上限**，不是忽略物理容量。

## 2. 从 Task 到 Session

### 2.1 模型

`taskId` 保留为兼容标识，实际语义升级为持久 Session ID。Session 的存储唯一键是 `(tenantId, taskId)`；
单租户部署使用默认 tenant。一个 Session 包含多个 Turn：

```text
Session (taskId)
  ├─ Turn #1 (user message → agent response/tool calls)
  ├─ Turn #2 ...
  └─ Event log (messages/steps/artifacts/interactions/status)
```

字段：

- `sessionMode: "task" | "conversation"`：默认 task，回合结束即关闭；conversation 在回合间保持 `waiting_user`；
- `contextId`：持久稳定 UUID，用于 A2A 多轮/审计；缺省生成，不随 Turn 变化；
- `turnTimeoutMs`（每个 active Turn 的时限，缺省取配置，兼容旧 timeoutMs 语义）、`idleTimeoutMs`（waiting_user 空闲时限）、
  `maxQueuedTurns`（可配置）；
- `permissionMode`、`executionStrategy`、`tenantId`、`principalId`、`metadata`。

conversation 只能在 `continuation != single-turn` 时创建；否则创建时回 `session_not_continuable`，不能先接受再失败。
旧 `run_task.timeoutMs` 只约束第一个 Turn；后续 Turn 使用 turnTimeoutMs。

### 2.2 状态机

```text
queued → running ⇄ waiting_interaction
             │
             ├→ waiting_user ⇄ running   (conversation 下一轮)
             └→ settled(success/failed/cancelled/timeout/closed)
```

- `waiting_interaction` 属于 active Turn，继续占用 running slot；`waiting_user` 无 active Turn，释放执行并发名额；
- 对外 `status:"running"` 表示 Session 未关闭，具体并发状态由 phase 判定（queued/running/waiting_interaction/waiting_user）；
  任何调度器不得只看 status 统计 running；
- 一个 Session 同时最多一个 active Turn；后续用户消息默认排队（mode=queue），native adapter 可声明 steer；
- `run_task` 只创建 Session，不能续接已存在 taskId；续接只走 send_message；相同 taskId 重发 run_task 回原 Session 快照；
- `close_session {operationId}` 关闭会话；`cancel_turn {turnId,operationId}` 取消指定 queued/active Turn，
  conversation 回 waiting_user、task 模式关闭；`cancel_task {operationId}` 关闭整个会话；
- 终态 task_status 的 eventSeq 最后分配，关闭后不再新增 feed 事件；waiting_user 不写终态；
- 进程重启恢复持久 queued Turn 并继续调度；active Turn 标记 interrupted/failed，不自动重放半执行副作用；
- idleTimeout 到期关闭 Session，写终态/错误 idle_expired，并释放资源。

### 2.3 Turn

每个 Turn 保存 `turnId`、输入消息、策略快照、开始/结束时间、stopReason、结果状态。
新用户消息在持久化并分配 messageId/eventSeq 后才入队；`(tenantId,taskId,messageId)` 唯一。

- 同一 messageId + 相同规范化 parts/mode：返回原 ack，不重复执行；
- 同一 messageId + 不同 parts/mode：回 message_conflict，不覆盖原消息；
- 消息事件先分配 eventSeq 并持久化，ack 返回同一 eventSeq；队列顺序按 eventSeq；
- 不同客户端并发消息由单一 DB writer/会话串行器确定顺序，不依赖客户端时钟。

### 2.4 进程与 Turn

所有策略均按 Turn 启动/回收进程；native-session 依靠官方 session id/load 在下一 Turn 恢复，不长期占用 running slot 或
隐式复用半死进程。若官方协议不支持 load，则降级 resume/replay。steer 只对声明支持且当前 Turn 活跃的 adapter 生效。

## 3. 十二适配器的会话策略

| 策略 | 语义 | 交互能力 |
| --- | --- | --- |
| native-session | 官方会话 id + session/load，多 Turn 同一逻辑会话；进程按 Turn 回收 | 可 live permission/elicitation |
| resume-session | 官方 session id/resume/load，新进程恢复上下文 | 视官方协议，可交替换回合 |
| replay-session | bridge 持久化 transcript，新进程携带历史上下文 | 无 live 权限；问题在回合边界处理 |
| single-turn | CLI 无法接受任何后续 prompt（需实测证明） | 只能 full 或明确拒绝交互 |

约束：

- 12 个适配器都有 headless full 映射；
- **12 个适配器至少提供 replay-session 作为会话底线**；native/resume 是增强，不是可用性的前提；
- single-turn 只允许在 CLI 物理上不能接受后续 prompt 时使用，必须有官方文档/测试证据并写入能力矩阵；
- 不允许用 PTY/正则猜权限实现“伪交互”；
- 每个适配器在 `executionModes[].continuation` 声明 `native/resume/replay/single-turn`；
- replay 使用完整持久 transcript；超过模型上下文时明确 `context_exhausted`，不得静默截断历史；
- 任何依赖特定 CLI 版本的 resume/load 参数必须由官方文档与适配器测试证明，不写开发机特判。

## 4. 多轮消息协议

### 4.1 下行 send_message

```json
{
  "type": "send_message",
  "taskId": "bt_7f3a",
  "messageId": "msg_user_2",
  "mode": "queue",
  "parts": [
    { "kind": "text", "text": "Please also update the docs." },
    { "kind": "file", "artifactId": "art_018f..." }
  ],
  "respondedBy": "user:example",
  "serviceToken": "abs_..."
}
```

- 需要 `session:write`；respondedBy/principal 通过签名断言或服务身份校验；
- 会话不存在回 session_not_found；不可继续回 session_not_continuable；终态回 session_closed；
- mode 缺省 queue；queue 创建新 Turn；steer 只允许 adapter 声明且当前 Turn active；
- 消息持久化成功后才回 `message_ack {messageId,eventSeq,turnId,delivery:"queued"|"steered"|"duplicate"}`；
- 用户消息以 task_message role=user 回显，eventSeq 与 ack 一致；
- 同一 Session 串行执行；排队满时回 backpressure/429，不丢消息；
- steer 不支持时回 steer_unsupported，不得静默改为 queue；客户端可显式重发 mode=queue；
- 不同 messageId 按 eventSeq 排队/steer 顺序交付；同一 messageId 重复/冲突规则见 §2.3。

### 4.2 关闭与取消

- close_session {operationId}：取消/等待 queued turns，结束 active turn，保存历史，发终态；
- cancel_turn {turnId,operationId}：可取消 queued 或 active Turn；conversation 回 waiting_user，task 模式关闭 Session；
  pending interaction 取消；重复 operationId 回原结果；
- cancel_task {operationId}：关闭整个 Session；scope 与 cancel_turn 分离；
- idleTimeout 到期：写终态/错误 idle_expired 并释放资源；不静默删除历史。

## 5. 权限与持久授权

- 12 个适配器 full 映射保持；
- PermissionOption 支持 once/turn/session/workspace/always 的 ACP kind 映射；
- 持久授权仅来自通过 `task:approve + approval:persist` 的鉴权人工回复，写入 approval ledger；
- 授权键包含 tenant/principal/agent/tool/action/resource scope/expiry，可撤销、可审计；scope 只能等于或小于本次展示范围，
  不得由模型扩大；
- **ledger 自动命中三条件缺一不可**：当前请求实际提供对应的 persistent allow option；当前规范化 tool fingerprint
  与 ledger scope 匹配；当前 permissionMode=default；
- `permissionMode=full` 时 ledger SHALL NOT 自动批准；full 的残余权限请求仍 fail closed；
- 请求只提供 allow_once 时，即使 ledger 有匹配项也不得伪造 allow_always/optionId，只能请用户再确认或取消；
- `allow_always` 是否开放由本机 policy 控制，默认关闭；不是协议不支持；
- 权限提示 title/kind/location 是不可信展示信息；匹配用 adapter 生成的规范化 tool/action/resource fingerprint，不用标题文案；
- 撤销/过期后立即失效；ledger 操作写审计，不记录 secret。

## 6. 交互完整能力

### 6.1 实时交互

- native ACP：session/request_permission + elicitation/create；
- 超时、取消、single-flight、responseId 幂等按 design.md；
- pending 可多个时按适配器能力排队，默认上限可配置；不丢请求。

### 6.2 URL Elicitation 与 secrets

- 支持 ACP/MCP URL mode：事件流/DB/审计/快照只保存 `urlHost`、`elicitationId`、`urlExpiresAt` 和 hash，不保存完整 URL；
- URL 作为短期敏感内容只存在进程内加密临时表（TTL、绑定 tenant/principal/session/requestId），
  通过 `get_interaction_url {requestId,operationId}` 在认证通道一次性/短期获取，带 no-store；进程重启则失效；
- 客户端必须展示完整 URL 并取得明确同意；非开发环境 HTTPS；防 prefetch/钓鱼；
- URL 完成由 elicitation/complete 或后续轮次确认；accept 仅表示同意打开，不代表外部流程完成；
- 只有 URL/OAuth 等待映射 A2A auth-required；权限/Form/普通输入映射 input-required；
- bridge 不落 secret 内容；Form 仍只允许非敏感数据；URL 过期回 interaction_url_expired，不重新构造旧 URL。

### 6.3 回合边界问题

- 无 live elicitation 的适配器可从结构化输出识别问题并结束当前 Turn；
- 问题作为 interaction 发给平台，用户回答成为下一 Turn 的第一条 user message；
- 若适配器无法结构化识别，不猜自由文本，声明 unsupported；
- 回合边界回答保留 requestId/responseId 幂等与审计。

## 7. 双向附件与大文件传输

### 7.1 统一 Artifact

- `artifactId`、sessionId、name、mimeType、size、sha256、kind（attachment/created/modified/output）、source（user/agent/workspace）；
- 内容存 tenant 分区的 content-addressed store：`state/artifacts/<tenant>/sha256/xx/<hash>`；
- 元数据存 SQLite；同一 tenant/hash 去重、引用计数，跨租户不共享存在性；
- 入站附件不自动执行、不自动信任；可配置扫描 hook（ClamAV/企业 API），未通过则 quarantine；
- 出站只来自 adapter 明确 artifact 事件或用户在会话中显式提供，不扫描整个工作区。

### 7.2 分块传输状态机

传输记录持久化到 `artifact_transfers`，`transferId` 由 bridge 生成并绑定 tenant/principal/session；
`operationId`（start/complete/abort）保证重发幂等。所有 start/status/abort 都要 artifact scope。

**上传 to_bridge**

```text
C→B artifact_upload_start {operationId,sessionId,name,mimeType,size,sha256,chunkSize?}
B→C artifact_upload_ready {transferId,artifactId,nextOffset,chunkSize}
C→B artifact_chunk {transferId,offset,data,chunkSha256}
B→C artifact_chunk_ack {transferId,nextOffset}
...
C→B artifact_upload_complete {operationId,transferId,size,sha256}
B→C artifact_upload_result {transferId,status:"committed",artifactId,eventSeq,sha256}
      或 {status:"failed",errorCode}
```

1. bridge 分配 artifactId/transferId，创建 temp 文件（tenant 目录，0700/ACL），返回 nextOffset；
2. 只接受 offset==nextOffset；offset<nextOffset 视为重复并重发当前 ack；offset>nextOffset 回 out_of_order 和 expected；
3. 每块校验 chunkSha256 后写入并持久化 nextOffset；磁盘不足回 insufficient_storage，不推进 offset；
4. complete 时校验 size/整文件 sha256，fsync，原子 rename 到 CAS，再在 DB 事务内写 artifact + task_artifact 事件；
5. 返回 committed 后消息才能引用 artifactId；崩溃恢复用 transfer 记录续传，最终 hash 不符则失败并重新上传。

**下载 from_bridge**

```text
C→B artifact_download_start {operationId,artifactId}
B→C artifact_download_ready {transferId,nextOffset:0,size,sha256,chunkSize}
B→C artifact_chunk {transferId,offset,data,chunkSha256}
C→B artifact_chunk_ack {transferId,nextOffset}
...
B→C artifact_download_complete {transferId,sha256}
C→B artifact_download_result {transferId,status:"verified"|"failed"}
```

- 下载从 CAS 读取，不重新访问工作区；客户端校验 whole sha256；
- 慢客户端 ack 窗口流控；断线用 artifact_transfer_status 获取 nextOffset 或重新 start 同 operationId；
- 乱序统一拒绝，客户端从 expected offset 重发，不做不确定缓冲；
- `artifact_transfer_abort {transferId,reason}` 可由任一方发起；已提交 artifact 不受 abort 影响；
- task_snapshot 带 activeTransfers 摘要（transferId/direction/nextOffset/state），供 Web 恢复；
- 大文件边读边发/边收边写，不聚合内存；CAS 按 tenant 分区，删除按引用计数；
- TLS 由 WS/HTTPS 提供；附件可选 at-rest AES-256-GCM，密钥 keyfile/OS secret，权限 0600/受限 ACL；
- 崩溃在 rename 与 DB commit 之间产生的 CAS 孤儿由启动 GC（带 grace）清理，不产生 DB 有记录但内容缺失的 artifact。

### 7.3 消息附件

- 用户 send_message 的 file part 必须引用已 commit artifactId；
- bridge 将入站文件放入 session 工作区的隔离 attachments 目录，路径不可逃逸；
- ACP 支持 FilePart 时原样传输；其他 CLI 在 prompt 中给稳定路径和 MIME/size 元数据；
- 出站 generated file 以 task_artifact 事件 + 可续传下载提供；
- 不在 task_log 中 base64 内联大文件。

## 8. 持久化与崩溃恢复

### 8.1 存储

- 使用稳定的 `better-sqlite3`（成熟同步驱动，WAL、foreign_keys、busy_timeout）；不依赖实验性 `node:sqlite`；
- **SQLite 是唯一权威源**：session、idempotency、event window、approval、artifact 元数据都从 DB 读；
  不再保留生产用内存任务路径或 MAX_TRACKED 上限；测试可使用内存 SQLite；
- 生产模式无硬编码 task 数量上限；容量由 retention/quota 配置控制，删除后保留 tombstone 并审计；
- Storage 接口隔离 SQL 方言；SQLite 默认单活实例、单写者。多实例/HA 需要额外分布式 lease/Postgres 适配，
  **不能只换存储驱动就自动支持**；不放在本变更的可用性承诺内；
- message delta 不逐 token 写库：按 50ms/64 KiB（可配置）批量事务提交，eventSeq 在提交时确定；complete/终态强制 flush。
  主线程只做短事务；若基准显示阻塞，DB writer 迁到 worker，保持同一事务顺序；
- DB `state/agent-bridge.db`，附件 CAS 独立目录；POSIX 目录 0700/文件 0600，Windows 用受限 DACL（当前用户/SYSTEM），
  启动时检查权限并在不安全时拒绝或告警；
- 表：sessions、turns、messages、events、interactions、interaction_results、artifacts、artifact_transfers、
  approvals、idempotency、principals、audit、session_tombstones；所有业务表以 `(tenant_id, session_id)` 或 tenant 前缀隔离，
  主键/唯一键包含 tenant，禁止跨租户 taskId 复用；
- 每 session 的 eventSeq 与业务状态在同一事务中提交；事件落库后才推送；
- 事件日志 append-only；消息/交互/附件均为事件或可重建投影；
- message/event 正文 JSON 可选 AES-256-GCM 字段加密（密钥 keyfile/OS secret，支持轮换），metadata 保留明文供索引；
- audit 采用 prevHash/hash 链式摘要，定期锚定导出，便于检测篡改，不声称不可抵赖；
- 1.0.0 是全新库；旧 0.2.x 内存任务不迁移，升级后按 task_not_found 处理，需重新创建会话。

### 8.2 恢复语义

- 启动时把进行中的 Turn 标记 interrupted，写事件并允许用户重试/继续；
- pending interaction 标记 expired/cancelled 并回 result；native 子进程不自动恢复；
- waiting_user Session 持久保留，下一条消息按 strategy 启动新 Turn；
- responseId/messageId/taskId 幂等记录持久化，进程重启后仍不重复 spawn；
- 未完成 transfer 保留临时文件和 offset，可续传；
- 无法恢复的 native 会话明确 `session_interrupted`，不假装成功；
- 数据库损坏：启动自检失败即拒绝服务并给恢复指引，不静默重建丢失历史。

### 8.3 保留与删除

- retention 可按租户/全局配置：时间、字节、session 数；到期删除可审计；
- taskId 在 tenant 内一经使用永不复用：删除内容后保留 tombstone（tenantId/taskId/closedAt/deletionReason），
  同 tenant/ID 再提交回 session_deleted，不重新 spawn；tombstone retention 至少覆盖业务幂等窗口；
- delete_session 删除事件/消息/附件引用，CAS 无引用回收；删除是逻辑标记 + 异步物理清理；
- 审计元数据与业务内容分离；删除请求本身留审计；
- 备份：SQLite online backup + CAS 清单；恢复校验 eventSeq 连续性与 tombstone 一致性。

## 9. 协议面与外部网关

### 9.1 原生面

- 平台 WS：canonical 全功能（会话/消息/交互/附件/snapshot）；
- 本地 HTTP/SSE/OpenAPI 3.1：同等能力，RFC 9457；
- 所有写命令带 service scope 和幂等键；
- 事件带 eventSeq、CloudEvents source/id/type/subject，traceparent。

### 9.2 A2A 网关

- Session ↔ A2A Task（稳定 contextId），Turn/消息 ↔ A2A Message，附件 ↔ FilePart/Artifact；
- waiting_user 与普通 permission/Form 等待 ↔ INPUT_REQUIRED；仅 URL/OAuth 等待 ↔ AUTH_REQUIRED；
  task_status 的 `interactionKind: permission | elicitation | auth-url` 明确映射，不能靠猜；
- A2A 入站消息：DataPart 带 requestId/responseId 且该请求 pending 时映射 interaction response；
  否则映射 send_message 新 Turn；二者同时出现按 conflict 拒绝，避免消息/回答歧义；
- 交互响应用 messageId 作为 responseId（需 session 内唯一）；普通消息用 messageId 作为 send_message 幂等键；
- get_task ↔ tasks/get；游标/缺口通过 agent-bridge 扩展 metadata 表达；
- permission/Form 用 DataPart + 扩展 URI，不冒充 A2A 原生；
- 可选 push notification/webhook，按 A2A 规范签名/鉴权，推送过滤 tenant/principal。

### 9.3 ACP 网关

- CLI 侧：通用 ACP client；
- 外部编辑器侧：可选 ACP server（stdio/HTTP），把 Session 暴露为 ACP session；
- permission/elicitation 原生映射；
- fs/terminal client 能力默认不开放，需单独本机授权，防 bridge 变成任意执行代理。

### 9.4 MCP

- Form Elicitation 映射 MCP elicitation/create；
- 权限使用 agent-bridge 命名空间扩展，不谎称 MCP 原生；
- 可选 MCP server 暴露只读 session/event/artifact 查询，写操作需显式启用；
- URL Elicitation 遵守 MCP/ACP Safe URL 规则。

## 10. 身份、租户与权限

- 设备 token 继续用于 connector；外部用户 principal 由平台签发 JWT，配置 issuer/audience/JWKS，bridge 只验证；
- 权威 scopes：`session:create/read/write/close`、`task:approve/respond`、`approval:persist`、`artifact:read/write`、
  `interaction:url`、`admin`；不再保留旧 task:create/read/cancel 别名；
- tenantId/principalId 写入 session/event/audit；session 唯一键 `(tenantId,taskId)`；
- 跨租户/不存在资源返回 404（不泄露存在性）；同租户但 scope 不足返回 403；401 仅认证失败；
- WebSocket 订阅按 tenant/session:read 过滤，禁止向连接广播未授权 session；所有 push/webhook 同样过滤；
- mTLS/反向代理身份可选用于 HTTP 网关；service token/principal JWT 不互相当作对方；
- 所有写操作幂等（messageId/requestId/responseId/operationId）；越权错误不返回资源内容；
- secrets 不落 DB/log/audit；URL Elicitation 只持久化 host/hash/TTL，完整 URL 短期内存，详见 §6.2；
- 文件路径、符号链接、凭据路径、上传恶意内容按 §7 处理。

## 11. 可观测性与审计

- OpenTelemetry：W3C traceparent 贯穿 turn/tool/interaction/artifact/DB；span 不含敏感正文；
- 指标：active sessions/turns、queue depth、interaction latency/expiry、artifact throughput/errors、DB/WAL、dropped subscribers；
- 结构化日志带 taskId/turnId/requestId/responseId，不记录 Form content/secret；
- 审计：谁在何时创建/批准/回答/取消/下载，结果和 scope；append-only，可导出；
- 健康/就绪端点；DB/磁盘/quota 告警；无静默丢事件。

## 12. 非功能目标与容量

- 所有 quota 配置化：session 数、active turn、queue、event bytes、artifact bytes、retention、subscriber buffer；
- 默认值偏保守，部署方可按容量调整；不允许“无限”作为内存承诺；物理/OS/DB 限制始终存在，必须有 backpressure；
- 背压：WS 慢消费者断开并可 cursor 恢复，不阻塞任务写库；artifact 窗口流控；
- 默认单实例 SQLite、单活 writer；多实例/HA 不因“换存储”自动成立，需独立分布式 lease/ownership 设计；
- 负载目标由验收基准定义，不在提案硬编码虚假数字；
- 任何队列/缓存满必须 fail closed 并留可恢复 cursor，不静默丢消息。

## 12.1 统一错误分类

| code | 场景 | HTTP/JSON-RPC |
| --- | --- | --- |
| session_not_found/task_not_found | 会话不存在/已不可查询 | 404 / -32001（data.code 原文） |
| session_closed | 终态后 send_message | 409 |
| session_deleted | tombstone 存在但内容已删除 | 410 |
| session_not_continuable | 策略不支持下一 Turn | 409 |
| message_conflict | 同 messageId 内容不同 | 409 |
| steer_unsupported | mode=steer 但适配器不支持/无 active Turn | 409 |
| interaction_url_expired | URL Elicitation 的短期 URL 已失效 | 410 |
| context_exhausted | replay 超模型上下文 | 422 |
| backpressure | 队列/订阅缓冲满 | 429 |
| insufficient_storage | 附件/DB 磁盘配额不足 | 507 |
| artifact_not_found | artifact 未知/已回收 | 404 |
| transfer_aborted | transfer 主动取消/超时 | 409 |
| unauthorized/forbidden | 缺 token/scope/租户隔离 | 401/403 |
| conflict | 幂等键冲突/状态竞争 | 409 |
| interaction_* | 已有权限/交互错误分类 | 按 bridge-protocol |
| db_unavailable | SQLite 损坏/锁不可用/启动失败 | 503 |
| quota_exceeded | 可配置容量上限 | 507/429 |

所有错误使用同一 canonical code；A2A/ACP/MCP 映射只改承载，不改变语义。禁止用成功状态承载失败。

## 13. 交付阶段（能力不删减）

1. **协议内核**：v1、Session/Turn、消息/交互/事件、幂等、SQLite schema、错误模型；
2. **执行与权限**：12 工具 full、executionModes/策略、ACP client、permission ledger；
3. **会话与 Feed**：多轮 send_message、消息/步骤/附件事件、snapshot/gaps、终态 flush；
4. **附件与持久化**：分块双向传输、CAS、崩溃恢复、retention/backup；
5. **外部网关**：A2A/ACP/MCP 映射、JWT/租户、OTel、负载/故障注入；
6. **全量验收**：协议一致性、断网/崩溃、超大附件、并发会话、权限安全、真实 CLI 可选 E2E。

## 14. 验收基线

- 12 个 full 参数与 executionModes 精确测试；
- 所有适配器至少声明真实 session strategy；不支持的能力必须明确协商；
- 大文件上传/下载断点续传、整文件 SHA-256、乱序/重复 chunk、磁盘满；
- 进程 kill -9 后恢复：会话/消息/幂等/附件 transfer 状态可解释；
- 多客户端并发回复同一 interaction：仅一次交付；
- A2A/ACP/MCP 互操作样例通过；
- 所有写命令 authorization/tenant 隔离测试；
- feed eventSeq 连续/缺口、snapshot 分页、终态顺序；
- `npm run gate`、harness、OpenSpec、e2e smoke 的真实输出。
