# 技术设计：任务执行权限与人机交互

> 目标：形成一套不依赖具体 CLI、具体平台或具体传输的通用执行控制契约。平台只面对 canonical model；
> CLI 私有协议由适配器翻译，A2A/ACP/MCP/HTTP 由映射层对接。

## 1. 目标、非目标与术语

### 1.1 目标

- 12 个 CLI 都有通用 full 参数映射；
- 支持工具权限审批、模型问题澄清、持久授权和 URL Elicitation；
- 支持持久 Session、多轮用户消息、双向附件、完整会话 Feed 与崩溃恢复；
- 外部系统可以获得一致的能力协商、消息、状态、错误、超时、鉴权、重试与审计语义；
- 同一 taskId/messageId/requestId/responseId 在重连、重发和重启后都不会产生重复副作用；
- 默认配置不改变现有任务，所有实现不包含开发机路径或版本特判。

### 1.2 范围与真实边界

本文件覆盖协议内核；完整多轮会话、双向附件、持久恢复和网关见 `design-full.md`，同属本变更，不是后续另案。

- 不把 WS 整体改成 JSON-RPC，不强制外部平台实现 A2A/ACP/MCP；
- 不把 stdin 继承给终端，不用正则从自由文本日志猜权限或问题；
- Form 不收集秘密；秘密/支付/OAuth 使用 URL Elicitation，不在日志/DB 落 sensitive content；
- 不承诺每个 CLI 都有 native 双向协议：按 native/resume/replay/single-turn 如实声明，禁止伪交互；
- 不把空 args、permissionMode 或工具 title/kind 当成沙箱或实际权限证明；
- 不承诺无限物理资源；quota/retention/并发全部配置化，但必须有背压和明确失败。

### 1.3 术语

- **PermissionMode**：bridge 为任务选择的 CLI 权限策略，default/full；
- **Interaction**：一次需要外部响应的权限或 Form 请求；
- **requestId**：交互的全局关联 ID，`ir_` + UUID，与 JSON-RPC id 映射；
- **responseId**：平台为一次响应 occurrence 生成的幂等键，`rs_` + UUID；重发同一 occurrence 必须复用；
- **interactionId**：`task_status` 中暴露的当前 pending requestId；
- **Pending**：请求已产生、尚未被有效响应、过期或取消；
- **Submitting**：响应已通过初检并进入 single-flight 交付，其他响应不能并发写入；
- **Resolved**：响应已通过校验并恰好一次成功交付给适配器；不等于用户选择了 allow/accept；
- **Failed（交互）**：适配器交付结果不确定或协议失败，任务按失败处理，禁止盲目重试；
- **受管参数模式**：allow-full/full 下只接受空 args，用默认模板构造 argv，不是配置沙箱；
- **持久幂等**：taskId/messageId/requestId/responseId 的无副作用保证落到 SQLite；进程重启后继续生效。

## 2. 标准基线与映射原则

| 标准 | 采用内容 | 不采用/边界 |
| --- | --- | --- |
| A2A v1.0.1 | TaskState、Message/Part、TaskStatusUpdateEvent、同 taskId/contextId 多轮输入 | A2A 核心没有工具审批消息，使用扩展 Part |
| ACP v1 | request_permission 的 toolCall/options/outcome；Elicitation form/action/content/capability | 不把 ACP 的 fs/terminal client 能力自动放开 |
| MCP Elicitation | 非敏感 Form、扁平 schema、accept/decline/cancel；URL mode 处理 secret | URL 不落 secret，遵守 Safe URL 规则 |
| JSON Schema 2020-12 | 受限 Flat Object Schema | 不支持任意嵌套、对象数组、$ref、oneOf 任意组合 |
| JSON-RPC 2.0 | id 关联、无效参数、取消和错误分离 | 不改变 bridge 外层 WS 报文风格 |
| CloudEvents 1.0（spec 1.0.2） | source/id/type/subject/time/data、重试保持 source+id | 不以传输重发声称 exactly-once |
| AsyncAPI 3.0 / OpenAPI 3.1 | WS/HTTP 机器契约 | 不用文档代替运行期校验 |
| RFC 9457 / RFC 3339 | Problem Details、时间格式 | 不复制一套不同错误/时间格式 |
| OAuth2 风格 scope | approve/respond 分离 | 不把 session:create 当成审批授权 |

标准化原则：**语义复用，传输解耦**。`taskId` 可映射 ACP sessionId/A2A taskId；`requestId` 可映射 JSON-RPC id；
但不要求这些 ID 在不同协议中字面相同，映射表负责保存对应关系。

## 3. 总体架构与职责

```text
External platform / local HTTP client
        │ canonical WS / HTTP
        ▼
Protocol validation + service scopes
        ▼
Task dispatch ────────────────┐
        │                     │
        ▼                     ▼
TaskSupervisor          InteractionBroker（每 supervisor 一个实例）
进程/队列/总超时          pending/响应去重/等待超时/结果快照
        │                     │
        ▼                     ▼
Agent adapters  ◀───────  canonical permission / elicitation
        │                     │
        ▼                     ▼
headless argv             ACP stdio JSON-RPC / 后续双向协议
        │                     │
        └──────── Emitter ────┘
             脱敏/稳定事件 ID/重放/审计
```

职责约束：

- `protocol.ts` 是唯一 wire 类型真源，适配器不得另定义平台报文；
- TaskSupervisor 只拥有进程、队列、总超时、取消和任务终态；
- InteractionBroker 只拥有请求生命周期、响应去重、交互超时和结果快照；禁止模块级 pending map；
- Adapter 只翻译 CLI 私有事件，不自行决定平台鉴权、超时或审计；
- 所有上行都经 Emitter；所有下行都经 `assertServerMessage`；
- ACP `fs/*`、`terminal/*` 等 client 能力默认关闭，只有单独本机授权与显式 capability 才开放，不因支持权限交互自动获得执行能力。

## 4. 配置与能力协商

### 4.1 本机配置

```toml
permission_policy = "allow-full" # default / allow-full / full
external_sandbox = false
interaction_enabled = false
interaction_timeout_ms = 900000   # 单次交互默认 15 分钟
max_interactions_per_task = 16   # 防交互风暴
```

对应 connect/serve 启动参数：

```text
--permission-policy=default|allow-full|full
--external-sandbox
--interaction
--interaction-timeout-ms=900000
--max-interactions=16
```

启动参数优先于配置。`interaction_timeout_ms` 必须为正且有上限；实际请求还会被任务剩余总时限夹取。

### 4.2 hello

1.0 直接使用 v1 协议，无版本协商：

```json
{
  "type": "hello",
  "protocolVersion": 1,
  "deviceId": "bd_0123456789abcdef0123456789abcdef",
  "cliVersion": "1.0.0",
  "platform": "win32",
  "hostname": "host-example",
  "capabilities": ["diff", "queue", "permission-mode", "task-interaction", "elicitation-form",
                   "session-feed", "task-snapshot", "artifact-inline", "artifact-transfer", "session-multi-turn"],
  "execution": {
    "permissionPolicy": "allow-full",
    "interactionEnabled": true,
    "interactionTimeoutMs": 900000,
    "maxInteractionsPerTask": 16
  }
}
```

capabilities 表示 bridge build/协议支持；execution 表示当前本机策略。平台不得仅根据 capabilities 假设每个工具都能交互。

### 4.3 AgentListItem

```json
{
  "kind": "codebuddy-cli",
  "display": "CodeBuddy CLI",
  "status": "ready",
  "capability": "non_interactive",
  "executionModes": [
    {
      "mode": "headless",
      "permissionModes": ["default", "full"],
      "interactionKinds": [],
      "feedKinds": ["messages", "steps", "artifacts"]
    },
    {
      "mode": "acp-stdio",
      "permissionModes": ["default"],
      "interactionKinds": ["permission", "elicitation-form"],
      "feedKinds": ["messages", "steps", "artifacts"]
    }
  ]
}
```

- `executionModes` 是按执行模式的能力描述，避免把 headless full 错当成 ACP 也支持 full；
- feedKinds 只列该模式实际能提取的 canonical 维度（messages/steps/artifacts）；未验证维度不得声明；
- CodeBuddy 未声明 external_sandbox 时，headless permissionModes 仅 `["default"]`；
- interactionKinds 只列该模式下已实现且通过测试的种类；空数组或缺省表示不能交互；
- legacy `capability` 仅为旧平台保留，新平台以 executionModes 为准；
- 字段表示 bridge 映射能力，不是任意旧 CLI 的版本保证；旧版拒绝参数时任务明确失败；
- `allowInteractive=true` 选择交互执行模式；若同时请求 full，必须该模式的 permissionModes 也包含 full，否则在 spawn 前拒绝。

## 5. 统一任务状态机

内部：

```text
submit → queued → running ⇄ waiting → settled(success/failed/cancelled/timeout)
           │          │        │
           └──────────┴────────┴──→ settled
```

规则：

1. waiting 是进程仍活着的非终态，running 名额不释放；
2. `TaskStatus` 不新增枚举，等待上行 `status: "running", phase: "waiting_interaction", interactionId`；
3. 有效响应交付后先发 `task_interaction_result`，再恢复 `phase: "running"`；
4. 总 `timeoutMs` 从入队起算，包含排队、执行和等待，防止永久占用；
5. 每请求另有 `expiresAt`，取 `now + min(interaction_timeout_ms, 剩余总时限)`；
6. ACP 任务以 `session/prompt` 回合响应为主要结算依据；close 先于回合完成为异常，常驻进程在回合完成后由 adapter 关闭；
7. headless 仍以 close 结算。两种结算路径都只能通过 supervisor.settle 一次。

A2A 映射：

| bridge | A2A v1 语义 |
| --- | --- |
| queued | TASK_STATE_SUBMITTED |
| running | TASK_STATE_WORKING |
| waiting_interaction | TASK_STATE_INPUT_REQUIRED |
| success | TASK_STATE_COMPLETED |
| failed / timeout | TASK_STATE_FAILED（errorCode 保留细分） |
| cancelled | TASK_STATE_CANCELED |
| 启动前策略拒绝 | TASK_STATE_REJECTED |
| URL/OAuth 凭据等待 | TASK_STATE_AUTH_REQUIRED，不能与普通工具权限/Form 混用 |

## 6. 权限模式设计

### 6.1 策略解析

| permission_policy | 未指定 | 请求 default | 请求 full |
| --- | --- | --- | --- |
| default | default | default | permission_policy_denied |
| allow-full | default | default | 满足条件则 full |
| full | full | default | 满足条件则 full |

full 会有意提升旧平台缺省任务；allow-full 才是仅按任务放开。default 的 legacy args 保持现状。
受管参数模式只接受空 args，消除 argv 位置与冲突；它不隔离 CLI 自动加载的配置、插件或继承环境。

### 6.2 12 工具映射

| agentType | full 映射 | 条件/说明 |
| --- | --- | --- |
| claude-code | `--dangerously-skip-permissions` | 非 OS 提权 |
| codebuddy-cli | `-y` + 固定 `CODEBUDDY_IS_SANDBOX=1` | 仅 external_sandbox=true |
| codex | `--dangerously-bypass-approvals-and-sandbox` | 同时绕过审批与 Codex 沙箱 |
| ds-harness | `--permission-mode danger-full-access --approval-policy never` | never 拒绝仍需审批项，不是自动批准 |
| gemini | `--yolo` | 沙箱是另一维度 |
| opencode | `--auto` | 显式 deny 仍有效 |
| mimo-code | `--dangerously-skip-permissions` | 显式 deny 仍有效 |
| qoder-cli | `--dangerously-skip-permissions` | 使用 Qoder 官方旁路语义 |
| grok-cli | `--always-approve` | 沙箱是另一维度 |
| kimi-code | 不追加 | `-p` 已使用 auto，禁止重复 `--auto` |
| minimax-code | `--permission full` | 使用 exec full policy |
| trae-cli | `--yolo` | 不夸大不同版本的沙箱语义 |

CodeBuddy 固定 env 是唯一例外，且只在 full + external_sandbox 时注入。平台不得设置 external_sandbox 或 env。
该声明不创建沙箱，也不阻止 CLI 从其他配置路径获得自动审批能力。

## 7. Canonical 交互消息

### 7.1 公共字段

```text
taskId: string
requestId: "ir_" + UUID
kind: "permission" | "elicitation"
createdAt / expiresAt: RFC 3339 string
```

每任务最多一个 pending；requestId 由 bridge 生成，不能由平台或模型指定。响应必须同时匹配 taskId、requestId、kind 和当前状态。

### 7.2 权限请求（ACP v1 语义）

```json
{
  "type": "task_interaction_request",
  "taskId": "bt_7f3a",
  "requestId": "ir_018f0d3c-7a2b-4c1d-9e2f-1234567890ab",
  "kind": "permission",
  "createdAt": "2026-10-25T10:00:00.000Z",
  "expiresAt": "2026-10-25T10:15:00.000Z",
  "permission": {
    "toolCall": {
      "toolCallId": "call_001",
      "title": "Edit src/app.ts",
      "kind": "edit",
      "status": "pending",
      "locations": [{ "path": "src/app.ts" }]
    },
    "options": [
      { "optionId": "allow-once", "name": "Allow once", "kind": "allow_once" },
      { "optionId": "reject-once", "name": "Reject once", "kind": "reject_once" }
    ]
  }
}
```

约束：

- toolCall 只传规范化子集；rawInput/rawOutput 默认不上行，避免密钥进入日志；
- title/kind/locations 是不可信展示信息，脱敏但不能用于自动批准；
- options 来自适配器，bridge 可移除 persistent 项但不得凭空新增 allow；
- once/turn/session/workspace/always 由本机 policy 决定是否开放；持久选项必须写 approval ledger，可撤销；
- optionId 必须属于当前请求提供过的集合。

### 7.3 Form 问题（ACP v1 / MCP Elicitation）

```json
{
  "type": "task_interaction_request",
  "taskId": "bt_7f3a",
  "requestId": "ir_018f0d3c-7a2b-4c1d-9e2f-1234567890ac",
  "kind": "elicitation",
  "createdAt": "2026-10-25T10:01:00.000Z",
  "expiresAt": "2026-10-25T10:16:00.000Z",
  "elicitation": {
    "mode": "form",
    "message": "Which refactoring strategy should be used?",
    "toolCallId": "call_002",
    "requestedSchema": {
      "type": "object",
      "properties": {
        "strategy": {
          "type": "string",
          "title": "Strategy",
          "enum": ["conservative", "balanced", "aggressive"]
        },
        "note": { "type": "string", "maxLength": 500 }
      },
      "required": ["strategy"]
    }
  }
}
```

Portable Form schema 子集：扁平 object、string/number/integer/boolean、enum、required、title/description/default、
minLength/maxLength/minimum/maximum、email/uri/date/date-time format。禁止 $ref、嵌套对象、对象数组和任意组合关键字。
Form 不得请求密码、API Key、token、私钥、恢复码、支付凭据等秘密；URL 模式与敏感流程未启用。

### 7.4 下行响应

权限：

```json
{
  "type": "task_interaction_response",
  "taskId": "bt_7f3a",
  "requestId": "ir_018f0d3c-7a2b-4c1d-9e2f-1234567890ab",
  "responseId": "rs_118f0d3c-7a2b-4c1d-9e2f-1234567890ab",
  "response": {
    "kind": "permission",
    "outcome": { "outcome": "selected", "optionId": "allow-once" }
  },
  "respondedBy": "user:example",
  "serviceToken": "abs_smoke_tok_smoke"
}
```

Form：

```json
{
  "type": "task_interaction_response",
  "taskId": "bt_7f3a",
  "requestId": "ir_018f0d3c-7a2b-4c1d-9e2f-1234567890ac",
  "responseId": "rs_118f0d3c-7a2b-4c1d-9e2f-1234567890ac",
  "response": {
    "kind": "elicitation",
    "action": "accept",
    "content": { "strategy": "balanced", "note": "Keep the public API unchanged" }
  },
  "respondedBy": "user:example"
}
```

权限也允许 `{ "outcome": "cancelled" }`；Form 允许 decline/cancel。decline/cancel 的 content 按 ACP 语义忽略。
accept 时若 schema 有 required，content 必须存在并通过校验；无必填字段时省略 content 等价于空对象。

**responseId 是必需的响应幂等键**：平台为每次新的响应尝试生成 `rs_` + UUID；同一响应因重连/重试而重发时必须复用。
修正无效响应、选择不同答案或再次回答已 resolved 的请求属于新 occurrence，必须使用新 responseId。
A2A 映射可使用用户 messageId 作为 responseId；HTTP 可用 Idempotency-Key，body 与 header 同时存在时必须一致。

### 7.5 上行结果确认

```json
{
  "type": "task_interaction_result",
  "taskId": "bt_7f3a",
  "requestId": "ir_018f0d3c-7a2b-4c1d-9e2f-1234567890ac",
  "responseId": "rs_118f0d3c-7a2b-4c1d-9e2f-1234567890ac",
  "requestState": "resolved",
  "responseStatus": "accepted",
  "resultSeq": 1,
  "resolution": { "action": "accept" },
  "at": "2026-10-25T10:03:00.000Z"
}
```

组合语义：

| requestState | responseStatus | 含义 |
| --- | --- | --- |
| submitting | duplicate | 另一个 responseId 的相同响应正在 single-flight 交付，不重复写入 |
| resolved | accepted | 新响应已校验并恰好一次交付 adapter |
| resolved | duplicate | 不同 responseId 的相同规范化响应，返回原 resolution，无二次副作用 |
| resolved | invalid + interaction_response_conflict | 已 resolved 后收到不同响应，原结果不变 |
| pending | invalid | 响应无效，pending 保留，可使用新 responseId 修正重试 |
| failed | invalid + interaction_delivery_unknown | 交付结果不确定，任务失败，禁止重试 |
| expired | late / 缺省 | 已超时，迟到响应不交付 |
| cancelled | late / 缺省 | 已取消，迟到响应不交付 |

**响应 occurrence 规则**：同一 responseId 且规范化指纹相同，返回该 responseId 已保存的同一 resultSeq/result；
同一 responseId 携带不同指纹属于幂等键冲突，返回 interaction_response_conflict 且不得改变原交付或结果。
不同 responseId 的相同规范化响应可产生 duplicate + 新 resultSeq；不同 responseId 的不同响应产生 conflict。
规范化指纹包含 kind/outcome/action/content 的规范 JSON 哈希，不包含 serviceToken/respondedBy；
Form 原文只在交付所需周期内保留，指纹用于判断相同与不同响应。
未知 taskId/requestId 的响应不得调用 adapter 或改变任务，记录受控拒绝；HTTP 直接返回对应 Problem Detail。
`resultSeq` 从 1 开始、按 requestId 单调递增，标识每次响应处理或本地过期/取消产生的 result occurrence；
同一 occurrence 重放保持原值。

### 7.6 Session Presentation Feed

原始 task_log 是 CLI stdout/stderr，可能混有 ANSI、JSONL、推理文本和工具结果，不是稳定 UI 模型。外部 Web 会话窗口需要独立的 canonical feed；task_log 继续保留为调试通道。

#### 事件序列

- **每任务只有一条 eventSeq 序列**，覆盖 queued/running/waiting/终态 task_status、task_message、task_step、task_artifact
  与 task_interaction_request；task_log 不占 eventSeq；
- `task_interaction_result` 是控制确认，不占 eventSeq，使用 requestId + resultSeq 排序；它可在任务终态后到达，
  只更新交互卡片，不允许据此重开任务或新增 feed 事件；
- 每个 canonical feed 事件首次发出时分配一次，重放同一事件保持 eventSeq，新事件严格 +1；
- task_step 既有 seq 仍表示步骤序号，与 eventSeq 独立；
- 同一任务最终只能有一个终态 task_status，且其 eventSeq 必须大于该任务所有已发出的 canonical feed 事件。

#### 保留、预算与缺口

- 每任务保留 200 messages / 200 steps / 50 artifacts、4 MiB 单任务、64 MiB 进程总预算是**默认策略**，
  可由部署配置调整；生产模式不以硬编码常量作为产品上限；
- 超限时淘汰最旧 canonical 事件，绝不淘汰当前 pending interaction 或最新状态；
- 淘汰形成显式 gap：`{ fromEventSeq, toEventSeq, reason: "count" | "task_bytes" | "global_bytes" }`；
  缺口不得被 UI 解释为“没有发生”；
- task_snapshot 返回 `eventWindow { oldestRetainedEventSeq, lastEventSeq, gaps }`；
- Form content、raw task_log、diff 全文不进入 feed；小附件 inline 受独立配额。

#### task_message

```json
{
  "type": "task_message",
  "taskId": "bt_7f3a",
  "messageId": "msg_agent_1",
  "eventSeq": 12,
  "role": "agent",
  "partIndex": 0,
  "part": { "kind": "text", "text": "I found the failing test." },
  "state": "delta",
  "at": "2026-10-25T10:05:00.000Z"
}
```

- live state=delta 追加到相同 messageId/partIndex；state=complete 携带该 part 的完整权威文本，客户端替换累积内容；
- 仅有完整消息的适配器可只发 complete，不伪造 delta；
- role 支持 user/agent/system；用户 send_message 以 user 消息回显，Form content 不回显；
- part 支持 text/data/file；文件通过 artifactId 引用，不把秘密或大文件塞进 text；
- messageId 优先使用 CLI 原生 ID，否则由适配器为逻辑消息生成稳定 ID；同一消息的 delta 必须复用。

**快照中的半截消息**：task_snapshot 不重放所有历史 delta，而是用独立 `partialMessages` 数组携带当前未完成消息的
`messageId/partIndex/part(已累积权威文本)/lastEventSeq`。客户端重建后，从 lastEventSeq 之后继续应用新 delta；
一旦收到 complete 则替换该 part。这样即使早期 delta 已被淘汰，快照也能恢复当前文本。

#### 富 task_step

在既有 action/label/state/ok/ref/at 上增加可选字段：

```json
{
  "type": "task_step",
  "taskId": "bt_7f3a",
  "seq": 3,
  "eventSeq": 13,
  "action": "Edit",
  "label": "src/app.ts",
  "state": "finished",
  "ok": true,
  "ref": "call_001",
  "toolCall": {
    "toolCallId": "call_001",
    "name": "Edit",
    "title": "Edit src/app.ts",
    "kind": "edit",
    "status": "completed",
    "locations": [{ "path": "src/app.ts" }],
    "content": [{ "kind": "text", "text": "Updated 2 lines" }]
  },
  "at": "2026-10-25T10:05:03.000Z"
}
```

toolCall.kind 使用 ACP 的 read/edit/delete/move/search/execute/think/fetch/switch_mode/other。content 支持有界 text/diff/terminal 块；
单块和总量必须有上限、走脱敏，rawInput/rawOutput 默认不上行。无法可靠提取的适配器省略 toolCall，只保留 legacy 字段。

#### task_artifact

```json
{
  "type": "task_artifact",
  "taskId": "bt_7f3a",
  "eventSeq": 14,
  "artifactId": "art_018f0d3c-7a2b-4c1d-9e2f-1234567890ad",
  "name": "report.txt",
  "mimeType": "text/plain",
  "size": 5,
  "sha256": "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  "kind": "output",
  "source": "agent",
  "inline": { "encoding": "base64", "data": "aGVsbG8=" },
  "at": "2026-10-25T10:06:00.000Z"
}
```

- inline 阈值与单任务预算配置化；超过 inline 时发元数据并由 artifact transfer 分块传输，不设硬编码产品上限；
- **只接受 adapter 明确声明的 artifact 事件**读取文件；模型给的 toolCall.location/title 不得直接作为读文件依据。
  无结构化 artifact 时仅从 changedFiles 生成元数据，不读取内容；
- 读取根是**该任务 cwd 的 realpath 子树**，不是整个 allowed_cwd；`allowed_cwd` 只决定任务能否启动；
- 解析 realpath 后必须仍在根内，拒绝 `..`、符号链接逃逸、目录、凭据路径（如 `.ssh`、`.aws`、`.env`）；
  可能时用 O_NOFOLLOW 打开，fstat 后从同一 fd 读取并计算 SHA-256；Windows 用 realpath+文件身份检查的等价实现；
- inline 数据必须与 size/hash 一致；metadata-only 可省略 sha256 并写 contentUnavailableReason；
- 大文件使用 design-full.md 的 artifact transfer 分块/续传/流控，内容存 CAS；
- changedFiles/diff 仍保留，不扫描或上行整个工作区。

#### get_task 与 task_snapshot

```json
{
  "type": "get_task",
  "taskId": "bt_7f3a",
  "include": ["status", "feed", "interaction"],
  "beforeEventSeq": 43,
  "limit": 200
}
```

```json
{
  "type": "task_snapshot",
  "taskId": "bt_7f3a",
  "status": "running",
  "phase": "waiting_interaction",
  "permissionMode": "default",
  "stopReason": null,
  "events": [],
  "partialMessages": [],
  "pendingInteraction": null,
  "interactionResults": [],
  "eventWindow": {
    "oldestRetainedEventSeq": 1,
    "lastEventSeq": 42,
    "gaps": []
  },
  "hasMoreBefore": false,
  "feedIncomplete": false
}
```

- get_task 需要 session:read；include 缺省 status/feed/interaction；
- `afterEventSeq` 用于实时补取；`beforeEventSeq` 用于历史回翻；两者不可同时出现；
- limit 默认 200、上限 500、单响应 1 MiB 均为默认安全策略，可配置；events 按 eventSeq 升序；
- 无游标时返回最新一页；`hasMoreBefore` 表示还能向前翻；
- `interactionResults` 携带该任务保留窗口内每个 requestId 的最新 result，供终态后 late/duplicate/invalid result 重建；
  它不占 eventSeq，也不重开任务；
- 快照不包含 raw task_log、Form content、diff 全文；大 artifact 只含元数据；
- `feedIncomplete=true` 表示适配器输出未完整收尾或保留缺口导致会话不完整，UI 必须展示该状态；
- 生产 SQLite 模式下任务不存在回 task_not_found；历史事件缺失用 eventWindow.gaps 表达；retention 已删除内容则回
  session_history_pruned/session_deleted，不返回伪空会话；
- 进程重启后从 SQLite 恢复 sessions/turns/events；active turn 标记 interrupted，waiting_user 保留，幂等与未完成 transfer 继续；

#### get_artifact

```json
{ "type": "get_artifact", "taskId": "bt_7f3a", "artifactId": "art_018f0d3c-7a2b-4c1d-9e2f-1234567890ad" }
```

需要的 session:read。bridge 从持久/CAS 保留窗口返回**同一 eventSeq/artifactId** 的 task_artifact；
超过 inline 上限时返回元数据并置 contentUnavailableReason=too_large；未知或已淘汰统一回 artifact_not_found。
不得为了补取 artifact 重新读取工作区，避免 TOCTOU 和内容漂移。

#### 终态前 flush

adapter 在 session/prompt 回合完成或 headless close 时 SHALL 先执行有界 `finalizeFeed()`：处理管道中已接收的完整帧、
发出最终 task_message complete 与 artifact，再由 supervisor 发终态 task_status。终态 eventSeq 必须最后分配。
若 adapter 超时或输出损坏导致无法收尾，终态 task_status 置 feedIncomplete=true；不得在终态后再补发 feed 事件。
取消/强制终止时先 flush 可用事件并在有界预算内结束，拒绝无限等待。

## 8. 生命周期、超时、取消与断线

### 8.1 正常顺序

```text
adapter event
→ broker 创建 pending
→ task_status(phase=waiting_interaction, interactionId)
→ task_interaction_request
→ platform 回复 task_interaction_response
→ scope + schema + option + 状态校验
→ adapter 恰好一次接收响应
→ task_interaction_result(resolved/accepted)
→ task_status(phase=running，移除 interactionId)
```

### 8.2 超时

- 单次等待到期：只有当前 options 确实提供 reject_once 时，才以原 optionId 选择该选项；否则以 ACP cancelled outcome 完成原请求，
  并取消回合、以 interaction_timeout 结束，**不得伪造 reject_once 或 optionId**；
- Form 超时按 cancel 处理，发 requestState=expired；adapter 无法接收取消/拒绝时同样以 interaction_timeout 结束；
- 总任务 timeout 到期：先完成 pending 的 cancelled/expired 结果，再按现有 SIGTERM→2s→SIGKILL 结束；
- 等待不暂停总超时，也不释放并发名额。

### 8.3 取消

`cancel_task`/`cancel_turn` 需要 session:close。bridge 作为 ACP Client 先向 Agent 发送 `session/cancel` 取消当前 turn；
对仍 pending 的权限请求，还必须以原 JSON-RPC id 回复 `{ outcome: { outcome: "cancelled" } }`，对 Form 回复 `action: "cancel"`。
`$/cancel_request` 只能由请求发起方撤销自己发出的请求，不能用来代替 Client→Agent 的回合取消。
Agent 以 `session/prompt` 的 `stopReason=cancelled` 结算；broker 产生 requestState=cancelled 的结果，supervisor 再结算任务 cancelled。
取消/超时都不等待 Agent 无限响应：现有 kill grace 到期仍强制终止，即使未收到 stopReason 也按 cancelled/timeout 结算。
迟到响应不得恢复已取消回合。

### 8.4 断线与恢复

- 上行采用 at-least-once；pending request 与可重放 result 存在 broker/supervisor 有界快照中；
- 重连后重发当前 pending 和尚未确认的可重放结果，requestId 不变；
- CloudEvents 重放保持 source+id：request 使用 `interaction:<requestId>`；每个 result occurrence 由 broker 分配
  单调 `resultSeq` 并写入报文，事件 id 为 `interaction-result:<requestId>:<resultSeq>`；新 occurrence 必须新 id；
- Outbox 即使发生控制溢出，broker 仍保存 pending 与每个 request 的最新 result 快照，重连后按最新状态恢复，
  不依赖“曾经发出过”作为唯一真源；
- 下行响应以 requestId 幂等，重复响应不会二次调用 adapter；
- 进程正常退出时 pending 取消；进程重启由 SQLite 持久状态恢复：active turn 标记 interrupted，waiting_user 保留，
  幂等记录与未完成 transfer 继续生效，详见 design-full.md。

**终态后的交互结果**：任务终态只禁止新 interaction_request，不禁止已存在 request 的 late/duplicate/invalid result。
响应路由使用 broker 历史而不是 activeTasks；Emitter 对 task_interaction_result 独立于 task 终态做 requestId+resultSeq 去重，
允许 duplicate、conflict、late、delivery_unknown 等结果在任务终态后回传，且不得再次交付 adapter。

### 8.5 Single-flight 与交付不确定性

响应处理必须先在内存中完成 `pending → submitting`，再进入任何 `await`：

1. broker 保存 responseId、规范化指纹和待交付内容；同 responseId 在处理中只共享这次交付，不另起写入；
2. 不同 responseId 的相同指纹在 submitting/resolved 时只返回 duplicate，不并发调用 adapter；
3. 不同指纹在 submitting/resolved 时返回 conflict，原交付不变；
4. adapter 写成功后才允许 `submitting → resolved` 和 accepted；只有成功路径宣称 exactly-once 交付；
5. 若确定尚未写入，可回 pending 并允许新 responseId 重试；若写入结果不确定，requestState=failed、
   errorCode=interaction_delivery_unknown，取消回合并将任务置 failed，禁止自动重试造成二次执行；
6. 已终态任务的响应只允许回 result，不得再进入 submitting 或调用 adapter。

## 9. 鉴权、隐私与限流

- permission 响应检查 `task:approve`；elicitation 响应检查 `task:respond`；取消检查 `session:close`；
- 使用 serviceToken 时必须校验，session:create 不隐含 approve/respond/write/close；respondedBy 是平台/principal 审计身份，不替代令牌认证；
- 本机 interaction_enabled 与任务 allowInteractive 必须同时为 true；否则不建立双向 stdin；
- 每任务最多一个 pending、16 次交互、64 KiB 交互 wire、32 KiB Form、8 options、64 KiB message part、
  256 KiB 单消息、64 KiB step content、256 KiB inline artifact、1 MiB 任务 inline 均为**默认配置**，
  可按部署容量调整；ACP 帧做同等级有界解析防 DoS；
- artifact 只从 adapter 明确事件读取，并限定在该任务 cwd 的 realpath 子树；拒绝符号链接逃逸、目录、凭据路径和未经允许的外部路径；
- 非敏感 Form 答案仅传给对应 adapter，不写审计、不写 task_interaction_result、不主动写 task_log；
- 秘密识别不能靠正则保证，adapter 与平台必须执行“Form 不收秘密”禁令；明确的 secret/OAuth 流程使用 URL Elicitation，
  bridge 不按字段名猜测密码；普通 Form 依赖 Agent 合规和人工审查；
- 审计记录 taskId/requestId/kind/optionId 或 action/respondedBy/时间/结果，不记录 Form content 和其他 env；
- 交互 title/path 走现有脱敏；不根据模型标签自动批准；allow_always 仅按 session-gateway ledger 规则持久化，
  full 模式不得用 ledger 自动批准。

## 10. 适配器模型

```ts
interface AgentInteractionDefinition {
  kinds: Array<"permission" | "elicitation-form">;
  transport: "acp-stdio";
  launchArgs: string[];
}

interface InteractionAdapter {
  start(context: { prompt: string; permissionMode: "default" | "full" }): Promise<void>;
  respondPermission(requestId: string, outcome: unknown): Promise<void>;
  respondElicitation(requestId: string, action: string, content?: unknown): Promise<void>;
  cancelTurn(): Promise<void>; // Client → Agent: session/cancel
  resolveCancelled(requestId: string, kind: "permission" | "elicitation"): Promise<void>;
  close(): Promise<void>;
}
```

- 声明只在真实实现并通过测试后出现；未声明种类返回 interaction_unsupported；
- `start(context)` 同时接收 permissionMode，交互执行模式必须显式实现 full 的会话配置；未实现时拒绝，不能以 headless 的 full 映射冒充；
- stdin 仅在该适配器和双重开关生效时为 pipe，写入序列化 JSON-RPC，不接受平台原始 stdin；
- JSONL 解析允许任意 TCP/stdio 分片，限制帧大小，非法 JSON、未知 method、伪造 response id 均 fail closed；
- ACP sessionId 与 taskId 分开保存，不假设字面相等；toolCallId 用于步骤与权限事件配对；
- `session/prompt` 的 stopReason 必须显式映射，不得收到 result 就算 success：

| stopReason / 结果 | TaskStatus / errorCode |
| --- | --- |
| `end_turn` | success，但仍有 pending/submitting 时改判 agent_protocol_error |
| `max_tokens` | failed / agent_error，并保留 stopReason |
| `max_turn_requests` | failed / agent_error，并保留 stopReason |
| `refusal` | failed / agent_error，并保留 stopReason |
| `cancelled` | cancelled |
| JSON-RPC error | failed / agent_error（已有 cancelled/timeout 终态除外） |
| 回合响应时仍有未决交互 | failed / agent_protocol_error，并关闭进程 |

`task_status.stopReason` 可选回显。取消必须依靠 stopReason=cancelled，不得用 JSON-RPC error 冒充；
已收到取消/超时后又收到其他 result 不得改成 success。
- 完整目标实现通用 ACP client；CodeBuddy/DSH 先接 native-session，其余适配器按官方 resume/replay 能力逐步接入；
- Form 只有在适配器实际收到 elicitation/create 并验证可回复后才上报 elicitation-form；
- 无 native 交互的工具按 resume/replay 提供回合边界会话；live permission/elicitation 不得伪造，未声明时拒绝该种交互；
- full 仍按 12 个 headless 映射执行，不受交互覆盖范围影响。

## 11. 外部协议映射

### 11.1 ACP

- taskId ↔ sessionId（映射表保存，不要求相等）；
- requestId ↔ JSON-RPC id；permission toolCall/options 与 outcome 直接映射；
- elicitation 使用显式 `mode: "form"`，action/content 直接映射；
- ACP response 的 JSON-RPC result 对应 adapter 接收完成；bridge 的 task_interaction_result 是外层传输确认，不新增 ACP 方法；
- 不支持的 ACP client method 返回 UnsupportedOperation，不能静默执行 fs/terminal。

### 11.2 MCP

- Form 可映射 `elicitation/create` 与 accept/decline/cancel；使用双方兼容的 schema 子集；
- MCP 2025-06-18 与 2026-07-28 的承载差异由 MCP 适配层处理，core 不依赖某一版 MRTR 封装；
- 权限没有统一 MCP 原生方法，使用 `agent-bridge/permission` 命名空间扩展，不声称 MCP 标准能力；
- 敏感信息不得降级到 Form；无 URL 支持时失败，而不是改收 secret。

### 11.3 A2A

请求映射为 agent Message：

```json
{
  "messageId": "msg_example",
  "taskId": "bt_7f3a",
  "contextId": "ctx_example",
  "role": "agent",
  "extensions": ["urn:agent-bridge:interaction:v1"],
  "parts": [{
    "mediaType": "application/vnd.agent-bridge.interaction+json",
    "data": { "requestId": "ir_018f0d3c-7a2b-4c1d-9e2f-1234567890ac", "kind": "elicitation", "elicitation": { "mode": "form" } }
  }]
}
```

用户以同 taskId/contextId 的 user Message 回复，DataPart 携带 response 和原 requestId；新 messageId 不改变交互幂等键。
等待/恢复通过 TaskStatusUpdateEvent；终态由 `status.state` 表达，并按 A2A v1.0.1 生命周期关闭流，**不添加 final 字段**。
权限与 Elicitation 都是扩展载荷，不冒充 A2A 原生字段。

Session Feed 映射：

- task_message 的 complete 文本映射为 A2A agent Message/TextPart；delta 不是 A2A 标准消息，使用扩展事件或在映射层合并后再发；
  system 消息不冒充 A2A agent role，使用扩展 DataPart；
- 小 task_artifact 可映射 A2A Artifact 的 raw Part（base64）和 mediaType；大文件仅发 DataPart 元数据 + agent-bridge 扩展 URI；
  `kind` 枚举 attachment/created/modified/output，`source` 枚举 agent/workspace，并与 sha256/size/contentUnavailableReason
  一起放在 Artifact.metadata 的 `agent-bridge` 命名空间；
- get_task 对应 A2A tasks/get 语义；task_snapshot 映射 Task 的历史消息/Artifact，不把 raw task_log 伪装成 A2A Message；
- 用户交互响应作为同 taskId/contextId 的 user Message，responseId 可由 messageId 承载。

### 11.4 本地 HTTP 控制面

| 方法 | 路径 | scope | 说明 |
| --- | --- | --- | --- |
| POST | `/v1/sessions` | session:create | 创建 Session/首轮任务 |
| GET | `/v1/sessions?tenant=&state=` | session:read | 有界列出会话 |
| GET | `/v1/interactions?taskId=&state=pending` | session:read | 有界列出交互 |
| GET | `/v1/interactions/{requestId}` | session:read | 当前请求/结果快照 |
| POST | `/v1/interactions/{requestId}:respond` | task:approve 或 task:respond | 按 kind 鉴权；responseId/Idempotency-Key 幂等 |
| GET | `/v1/sessions/{id}/events` | session:read | SSE task_message/step/artifact/interaction/status |
| GET | `/v1/sessions/{id}/snapshot` | session:read | canonical 会话快照；不含 raw log/Form content/大文件正文 |
| GET | `/v1/sessions/{id}/artifacts/{artifactId}` | session:read | 补取同 eventSeq 的保留 artifact；不重读工作区 |

错误使用 RFC 9457，detail.code 与 WS errorCode 相同；HTTP 响应不返回 Form content 的审计副本。

## 12. 错误码

| code | 使用场景 | HTTP |
| --- | --- | --- |
| permission_policy_denied | 本机策略拒绝 full 或受管非空 args | 403 |
| permission_mode_unsupported | 工具/运行条件不支持 full | 400 |
| interaction_disabled | 本机或任务未启用交互 | 403 |
| interaction_unsupported | 适配器或 kind 不支持 | 400 |
| interaction_invalid_response | kind、option、schema、大小或形状无效 | 400 |
| interaction_response_conflict | resolved 后出现不同响应 | 409 |
| interaction_expired | 等待已过期或响应迟到 | 408 |
| interaction_timeout | adapter 无法处理超时取消，任务终止 | 504 |
| interaction_rate_limited | 超过 pending/次数限制 | 429 |
| interaction_delivery_unknown | adapter 写入结果不确定，禁止重试 | 502 |
| interaction_denied | full 残余权限无法以明确 deny 处理，安全关闭 | 403 |
| agent_protocol_error | 回合完成仍有未决交互或 ACP 状态矛盾 | 502 |
| task_not_found | taskId 从未存在/不在该租户 | 404 |
| session_deleted | tombstone 存在但内容已删除 | 410 |
| session_history_pruned | 历史被 retention 裁剪，无法完整 replay | 410 |
| artifact_not_found | artifact 未知或已淘汰 | 404 |
| unauthorized / insufficient_scope | 缺令牌或 approve/respond scope 不足 | 401 / 403 |

A2A/ACP 映射可保留 `data.code`；JSON-RPC -32602 用于无效参数，-32004 用于不支持，其他业务错误使用实现保留码并携带 canonical code。

## 13. 版本

- 发布 1.0.0，`PROTOCOL_VERSION=1`，不提供 0.2.x 协议/HTTP 兼容；
- `run_task` 创建 Session；未声明 sessionMode 时为 task，一次执行后关闭；conversation 需显式声明；
- SQLite idempotency/tombstone 是唯一权威：taskId 在 tenant 内不复用；retention 删除内容也不允许同 ID 重跑；
- 历史被裁剪导致无法完整 replay 时回 session_history_pruned，要求新建 Session，不能静默补空历史；
- 所有同步拒绝创建 settled Entry；相同终态以脱敏后指纹允许重放，不同终态与后续 log/step/running 丢弃；
- task_interaction_result 在任务终态后仍可按 requestId+resultSeq 重放，只有新 interaction_request 被终态禁止；
- elicitation-url、persistent-permission、多轮 send_message、artifact transfer 属于 1.0 目标态。

## 14. 实施阶段与验收

交付顺序见 design-full.md §13；所有阶段都是完整目标的一部分，不是能力删减。

- **Phase 1 协议/存储内核**：v1 Session/Turn、SQLite schema、事件/幂等/错误、权限与 executionModes；
- **Phase 2 执行与权限**：12 full、native/resume/replay 策略、ACP client、approval ledger；
- **Phase 3 交互/会话 Feed**：Broker、send_message、task_message/step/artifact、snapshot/gaps、终态 flush；
- **Phase 4 附件/恢复**：CAS、分块双向 transfer、续传/流控、kill -9 恢复、retention/backup；
- **Phase 5 网关/治理**：A2A/ACP/MCP、JWT/tenant、OTel、故障注入与负载；
- **Phase 6 全量验收**：协议一致性、并发审批、大附件、断网/崩溃、真实 CLI 可选 E2E。

最终证据：真实输出 `npm run gate`、`npm run harness:validate`、`npm run openspec:validate`、build 后 `npm run e2e:smoke`；
full 与危险环境用无害 mock 验证，真实 CLI E2E 使用临时工作区且不执行破坏性操作；SQLite/附件恢复需 kill -9 测试证据。

## 15. 官方参考

- A2A v1.0.1：https://a2a-protocol.org/v1.0.1/specification/
- ACP Tool Calls：https://agentclientprotocol.com/protocol/v1/tool-calls
- ACP Elicitation：https://agentclientprotocol.com/protocol/v1/elicitation
- MCP Elicitation 2025-06-18：https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation
- MCP 最新 Elicitation：https://modelcontextprotocol.io/specification/latest/client/elicitation
- CloudEvents 1.0.2：https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md
- DSH ACP：https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/README.md
- CodeBuddy CLI：https://www.codebuddy.ai/docs/cli/cli-reference
- better-sqlite3：https://github.com/WiseLibs/better-sqlite3
- OpenTelemetry：https://opentelemetry.io/docs/specs/otel/
