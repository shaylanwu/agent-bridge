# 非 ACP Agent 对接调研（2026-10-26）

> 实施更新：Grok 已确认原生 ACP（`grok agent stdio`）；Codex app-server 客户端已实现并接入
> TaskSupervisor（`codex-app-server.ts` / `appServer`）。剩余 Claude、Qoder、DSH。

> 目标：12 个工具统一 `session/new → prompt → stream → permission → resume/cancel` 语义。
> 已有 8 个原生 ACP：codebuddy / gemini / opencode / mimo / kimi / minimax / grok / trae。
> 本文件只分析剩余 4 个：claude-code、qoder-cli、codex、ds-harness。

## 结论表

| Agent | 官方可编程通道 | 会话恢复 | 权限请求 | steer | 推荐方式 |
| --- | --- | --- | --- | --- | --- |
| Claude Code | Agent SDK + `--input-format stream-json` + `--output-format stream-json` | `--resume` / SDK resume | `canUseTool` / `--permission-prompt-tool` | 双向 stdin | **Claude 双向 CLI 适配器**（必要时 SDK） |
| Qoder CLI | Agent SDK + `--input-format stream-json` + hooks | `--resume` / `--session-id` | PermissionRequest hook | 双向 stdin | **Qoder 双向 CLI 适配器** |
| Codex | `codex app-server` JSON-RPC over stdio | `thread/resume` | `item/*/requestApproval` | `turn/steer` | **Codex App Server 适配器**（原生化，优先级最高） |
| DSH | `deepseek-harness-sdk` stdio JSON-RPC；headless `--json --session-id` | SDK `resume_session` / `--session-id` | 无独立权限通道（headless） | 无 | **DSH SDK 适配器**，权限显式降级 |

## 1. Claude Code

### 官方依据

- Agent SDK 的 `canUseTool` 回调：工具权限与 `AskUserQuestion` 都会暂停执行，直到返回 allow/deny。
  <https://code.claude.com/docs/en/agent-sdk/user-input>
- CLI 支持 `--input-format stream-json`、`--output-format stream-json`、`--resume`、
  `--permission-prompt-tool`、`--include-partial-messages`。

### 可行路径

1. **Agent SDK（TypeScript）**
   - 直接 `query({ prompt, options: { canUseTool, resume, ... } })`
   - 优点：权限是官方一等能力，`AskUserQuestion` 也能映射成 `form` 交互。
   - 代价：新增 `@anthropic-ai/claude-agent-sdk` 依赖，违反当前“零运行时依赖”约束，需要提案。
2. **双向 CLI**
   - spawn `claude -p --input-format stream-json --output-format stream-json --verbose`
   - stdin 持续写 user message / control request；stdout 读事件。
   - 权限：`--permission-prompt-tool` 需要一个 MCP 工具承接；等于在 bridge 内再实现一个小 MCP server。
   - 优点：不新增 npm 依赖，符合现有 spawn 白名单。
   - 代价：要维护 Claude 的 stream-json control 协议与 MCP 权限工具。

### 建议

先做**双向 CLI + 本地 MCP 权限工具**，避免新增 SDK 依赖；如果 control 协议不稳定，再切 SDK。
`AskUserQuestion` 映射为 `form`，工具权限映射为 `permission`，`resume` 直接透传。

## 2. Qoder CLI

### 官方依据

- Agent SDK：`@qoder-ai/qoder-agent-sdk`，`query()`、`resume`、`sessionId`、`forkSession`。
  <https://docs.qoder.com/cli/sdk/session-control>
- CLI 支持 `--input-format`、`--output-format`、`--resume`、`--session-id`、hooks（含 `PermissionRequest`）。

### 可行路径

1. **Agent SDK**：与 Claude 类似，权限/会话能力完整；新增依赖。
2. **双向 CLI**：`qodercli -p --input-format stream-json --output-format stream-json`
   - 权限走 `PermissionRequest` hook：bridge 生成临时 hook 配置/脚本，把 decision 写回。
   - 恢复用 `--resume <id>`，新会话可指定 `--session-id`。
   - 优点：零依赖，复用现有任务调度。
   - 代价：hook 是进程外协议，延迟与超时控制要自己兜。

### 建议

优先**双向 CLI + PermissionRequest hook**。Qoder 的 hook 输出是 JSON（`decision: allow/deny`），
与 `task_interaction_response` 语义接近，映射成本低于 Claude 的 MCP 工具。

## 3. Codex

### 官方依据

- Codex App Server：JSON-RPC over stdio，双向；线程/轮次/审批/steer 都是协议一等能力。
  <https://openai.com/index/unlocking-the-codex-harness/>
- 方法：`thread/start`、`thread/resume`、`turn/start`、`turn/steer`、`turn/interrupt`；
  审批：`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`。

### 可行路径

**Codex App Server 适配器**（推荐，不需要 ACP shim）：

- spawn `codex app-server`（或当前版本对应子命令），JSON-RPC 2.0。
- 会话：`thread/start` / `thread/resume`。
- 提示：`turn/start`。
- 流：`item/started`、`item/agentMessage/delta`、`item/completed`、`turn/diff/updated`、`turn/completed`。
- 审批：server → client request，返回 `{decision:"accept"|"acceptForSession"|"decline"|"cancel"}`。
- steer：`turn/steer`，这是 12 个工具里唯一有官方 mid-turn steer 的。
- 无需新增依赖，和现有 spawn 模型兼容。

### 建议

**最高优先级**。Codex App Server 的能力比 ACP 还完整（尤其是 steer 与 thread/resume），
应直接做 `CodexAppServerClient`，再映射到现有 `TaskHooks` / `task_interaction_request`。

## 4. DeepSeek Harness（dsh）

### 官方依据

- `deepseek-harness-sdk`：Python/TS SDK，stdio JSON-RPC 驱动；`resume_session(savedId)`；
  `RunResult(events, notifications)`。
  <https://pypi.org/project/deepseek-harness-sdk/>
- headless：`dsh --profile headless --json --session-id <id>`；一次一发，`--json` 是投影不是无损日志。
  <https://harness-ds.com/zh-cn/blog/dsh-headless-json-session>

### 可行路径

1. **SDK 适配器**：启动 dsh 运行时，`resume_session` / `run`；能得到结构化 events/notifications。
   - 需要引入 `@deepseek-ai/dsh-sdk-client`（或 Python SDK），并选择 sdk/sdk-minimal profile。
2. **headless CLI + `--session-id`**
   - 一次一个进程，`--json` 事件流；恢复靠 `--session-id`。
   - 无权限通道、无 steer；只能做“会话恢复 + 日志/工具事件”。
   - 零依赖，改动最小。

### 建议

先做 **headless CLI + `--session-id`**，明确标注：
- 支持 session 恢复
- 不支持 permission / steer（`unsupported`，不伪造）
- 若要完整权限，再接 SDK。

## 实现顺序

1. **Codex App Server**：能力最完整，且可覆盖 steer。
2. **Grok ACP**：已在本轮补入原生 ACP 矩阵。
3. **Claude 双向 CLI + MCP 权限**。
4. **Qoder 双向 CLI + PermissionRequest hook**。
5. **DSH headless resume**（权限显式降级）。

## 统一抽象

不建议把 4 个工具硬塞进 ACP。建议在 `AgentDef` 增加：

```ts
transport: 'acp' | 'app-server' | 'stream-json' | 'headless'
capabilities: {
  session: boolean
  resume: boolean
  permission: boolean
  steer: boolean
  form: boolean
}
```

`TaskSupervisor` 只认统一 `TaskHooks`，具体 transport 由适配器实现；
平台侧仍然只看到 `task_interaction_request` / `task_step` / `task_message`，不暴露底层协议差异。

## 风险

- Claude/Qoder 的 stream-json control 协议不是 ACP 稳定契约，需按版本锁定并加 fallback。
- Codex app-server 的方法名有 v1/v2 差异，需先 `codex app-server --help` / `generate-json-schema` 锁定。
- DSH headless 的 `--json` 明确不是无损会话日志，不能当 event store 用。
- 任何“权限 unsupported”必须显式返回，不能让平台误以为已批准。
