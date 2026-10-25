# 变更提案：Agent Session Gateway（1.0.0 完整目标态）

## Why

当前 bridge 是一次性、单向任务执行器：stdout/stderr 可回传，stdin 默认关闭；没有标准会话消息、双向附件、
多轮用户对话、持久恢复或跨会话查询。外部平台只能看到原始 CLI 日志和有限步骤，无法直接实现完整的 Web Agent
会话窗口，也无法在 bridge 重启后继续原会话。

本系统当前没有外部系统依赖，因此本提案采用一次干净的 **1.0.0 破坏性升级**，不维护旧协议双栈：

- 不设产品级功能删减；
- 不以“首版”排除大附件、多轮聊天、持久历史或持久授权；
- 资源上限全部由部署方配置，保留必要的安全与背压；
- 不伪造 CLI 没有的协议能力，通过 execution strategy 如实声明；
- 不为旧协议/旧 HTTP API 保留兼容层，平台与 bridge 同批升级。

## What Changes

### 1. 协议与会话模型

- 发布版本定为 **1.0.0**；`PROTOCOL_VERSION` 设为 **1**，不保留旧 0.2.x 协议；
- 一次性 task 语义扩展为持久 Session + 多 Turn；
- `taskId` 作为 Session ID；新增 `turnId`、`messageId`、`sessionMode: "task" | "conversation"`；
- 内部状态 `queued/running/waiting_interaction/waiting_user/settled`；waiting_user 释放执行并发但会话不关闭；
- 新增 `send_message`、`message_ack`、`close_session`、`cancel_turn`、`get_task`、`get_artifact`；
- `task_status` 增加 phase、turnId、interactionId、interactionKind、permissionMode、stopReason、eventSeq；
- 所有写命令使用 messageId/requestId/responseId/operationId 业务幂等键；
- hello 直接携带 v1 capabilities/execution，不做版本协商。

### 2. 权限与持久授权

- 12 个适配器全部提供 headless full 映射；
- `permission_policy = default | allow-full | full`，受管参数模式只接受空 args；
- CodeBuddy full 需本机 external_sandbox，固定注入唯一 env；DSH 使用官方 headless 参数；
- 权限选项支持 once/turn/session/workspace/always；持久授权来自鉴权回复 + approval ledger，可撤销；
- ledger 自动命中必须当前请求实际提供 persistent option、fingerprint 匹配且 permissionMode=default；
- full 不借人工/ledger 绕过静态 deny；权限 title/kind 不能作为自动批准依据；
- full 是 bridge 选择的命令策略，不是 OS 提权或配置/插件/环境沙箱。

### 3. 完整交互

- Permission 使用 ACP v1 request_permission 语义；
- 非敏感问题使用 Form Elicitation；秘密/支付/OAuth 使用 URL Elicitation，不通过 Form 收集 secret；
- URL 不进入事件流/DB/审计，只保留 host/hash/TTL，完整 URL 短期内存并通过 get_interaction_url 获取；
- 支持 accept/decline/cancel、selected/cancelled、超时、取消、single-flight、responseId 幂等、迟到/冲突/交付不确定；
- native ACP 可实时交互；无 live 协议的适配器可按能力使用回合边界问题或明确 unsupported；
- A2A auth-required 仅用于 URL/OAuth，不与工具权限/Form 混用。

### 4. 多轮对话

- conversation 会话在 Turn 完成后进入 waiting_user，平台可继续 send_message；
- 每会话串行执行，后续消息按 eventSeq 排队；native adapter 可声明 steer；
- 12 个适配器至少实现 replay-session 多轮底线，优先 native-session/resume-session；
- single-turn 仅在 CLI 物理上无法接受后续 prompt 时作为实测例外；
- 无 native live 交互时仍可用 full + replay 多轮，不伪造权限协议；
- replay 使用完整持久 transcript，超过模型上下文明确 context_exhausted，不静默截断。

### 5. Session Presentation Feed

- `task_message`：user/agent/system 文本，delta/complete；
- 富 `task_step`：ACP 风格 toolCall、位置、受控 text/diff/terminal 内容；
- `task_artifact`：附件元数据、SHA-256、inline 小文件或分块传输引用；
- 每任务单一 eventSeq 序列、显式 gaps、partialMessages、feedIncomplete；
- `get_task/task_snapshot` 支持 before/after 游标分页与历史重建；
- 终态 task_status 前必须有界 flush 最终消息和附件；
- task_log 仅调试，不作为稳定会话协议。

### 6. 双向附件与产物

- 统一 Artifact + tenant 分区 CAS，入站/出站都支持；
- 上传/下载独立状态机：start/ready/chunk/ack/complete/result/abort，offset+chunk SHA-256，断点续传，流控；
- 不设硬编码产品大小上限；部署方配置磁盘/单文件/会话/总预算；
- 入站附件隔离存放、不自动执行、可配置扫描/quarantine；
- 出站只来自 adapter 明确 artifact 事件或用户显式文件，不自动扫描工作区；
- 上传 commit 后返回 artifactId/eventSeq，消息 file part 通过 artifactId 关联。

### 7. 持久化与恢复

- 强制使用 better-sqlite3（WAL）；session/turn/message/event/interaction/artifact/approval/idempotency 持久化；
- 附件 CAS 独立目录，POSIX 0700/0600、Windows 受限 DACL，可选 at-rest 加密；
- eventSeq 与业务状态同事务提交，事件落库后再推送；delta 批量提交；
- kill -9 后：active turn 标记 interrupted，queued turn 恢复，waiting_user 保留，
  messageId/responseId 幂等继续生效，未完成 transfer 可续传；
- taskId 在 tenant 内永不复用；retention/delete_session 保留 tombstone；历史裁剪明确报错；
- 不静默重建或丢弃历史。

### 8. 外部系统与网关

| 标准 | 采用 |
| --- | --- |
| A2A v1.0.1 | Task/Message/Artifact、input-required/auth-required、tasks/get、resubscribe、可选 push |
| ACP v1 | request_permission、Elicitation Form/URL、session/cancel、可选 ACP server |
| MCP | Form/URL Elicitation、可选只读 session MCP server；权限用命名空间扩展 |
| JSON Schema 2020-12 | Form 扁平 schema；附件/消息结构运行期校验 |
| JSON-RPC 2.0 | ACP/MCP 网关；canonical WS 不强制改协议 |
| CloudEvents 1.0 | 事件信封、source+id 重放、traceparent 扩展 |
| AsyncAPI 3.0 / OpenAPI 3.1 | WS/HTTP 机器契约 |
| RFC 9457 / RFC 3339 | 错误与时间 |
| OAuth2/OIDC/JWT | scopes、principal assertion、tenant claim、mTLS 可选 |
| OpenTelemetry | trace/metrics/log 关联 |

### 9. 安全、租户与运维

- 权威 scopes：session:create/read/write/close、task:approve/respond、approval:persist、artifact:read/write、
  interaction:url、admin；不再保留旧 task:create/read/cancel 别名；
- 平台签发 principal JWT，bridge 校验 issuer/audience/JWKS；tenant/principal 写入事件与审计；
- 跨租户/不存在资源 404，同租户 scope 不足 403；订阅/推送按 tenant/session 过滤；
- secrets 不落 DB/log/audit；
- 文件真实路径限制在任务 cwd，拒绝符号链接逃逸/凭据路径；同 fd 读取+hash；
- 配置化 quota、背压、慢消费者断开可 cursor 恢复；
- OTel 指标/trace、审计、健康/就绪、DB/WAL/磁盘告警。

## HTTP/CLI

- 旧 `/v1/tasks` 与旧 HTTP API 不再保留；1.0 使用 `/v1/sessions` 与 `/v1/sessions/{id}/events`；
- 现有内置 Web 面板随 bridge 同批迁移；
- 现有 CLI 命令保留，新增参数全部可选；配置新增字段有默认；
- 不提供旧协议/旧 HTTP 兼容层，升级需 bridge、平台、内置 UI 同步发布。

## 标准与边界

- “无限制”指无硬编码产品功能/大小上限；物理容量、模型上下文、CLI 原生能力仍然存在，必须显式协商/报错；
- 不把 WS 强制改成 JSON-RPC，不强制外部平台实现 A2A/ACP/MCP；网关映射是可选适配层；
- 不将 stdin 继承为终端；交互只用受控结构化协议；
- 不声明 bridge 是 OS 沙箱/模型提供方/IdP。

## 设计文档

- `design.md`：协议内核、权限/交互/feed 细节、幂等、ACP 映射、错误语义；
- `design-full.md`：完整目标态：Session/Turn、多轮、附件传输、SQLite 恢复、网关、租户与可观测性；
- `specs/bridge-protocol`、`specs/task-execution`、`specs/session-gateway`：规范增量。

## Impact

- 高风险：protocol、TaskSupervisor、Emitter、TaskRegistry、12 adapters、WS/HTTP 控制面、配置、审计；
- 新增 SessionStore/ArtifactStore/TransferManager/ApprovalLedger；状态必须实例化，禁止模块级单例；
- better-sqlite3 成为必需依赖，需覆盖 Windows/macOS/Linux 与 Node LTS 安装验证；
- SQLite 默认单活实例/单 writer；多实例 HA 需另行分布式 lease/Postgres 适配；
- 数据库 schema、CAS、迁移、retention、backup 需要独立运维文档；
- 旧 `/v1/tasks` 被 `/v1/sessions` 取代，内置面板与平台同批更新；发布版本 1.0.0；
- 护栏需人工审批：CodeBuddy 固定 env、交互 stdin pipe、数据库/CAS 写入路径、本机 HTTP 网关。

## Phases（交付顺序）

1. **协议内核**：v1 Session/Turn、消息/交互/事件、幂等、SQLite schema、错误模型；
2. **执行与权限**：12 full、executionModes/strategy、ACP client、approval ledger；
3. **会话与 Feed**：send_message、message/step/artifact、snapshot/gaps、终态 flush；
4. **附件与持久化**：分块双向传输、CAS、崩溃恢复、retention/backup；
5. **网关与治理**：A2A/ACP/MCP、JWT/tenant、OTel、负载/故障注入；
6. **全量验收与归档**：协议一致性、断网/崩溃、大附件、并发、权限安全、真实 CLI 可选 E2E。
