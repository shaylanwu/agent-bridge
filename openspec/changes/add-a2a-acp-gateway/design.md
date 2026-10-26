# 设计：A2A / ACP 网关

## 边界

```text
外部客户端
  ├─ A2A JSON-RPC ─┐
  └─ ACP JSON-RPC ─┤
                   ▼
             gateway (可选)
                   ▼
        TaskSupervisor / SessionStore / Emitter
```

网关是**适配层**，不复制调度、不复制持久化、不另开上行出口。

## A2A 映射

| bridge | A2A |
| --- | --- |
| `TaskStatus: running` + `phase: queued` | `submitted` / `working` |
| `waiting_user` / `waiting_interaction` | `input-required` |
| `success` | `completed` |
| `failed` / `timeout` | `failed` |
| `cancelled` | `canceled` |
| `task_message` | `Message` |
| `task_artifact` | `Artifact` |
| `task_log` | 不映射为标准消息，只作为调试扩展 |

要求：

- `eventSeq` 用于 `tasks/resubscribe` 补洞；
- `tasks/get` 返回当前快照，不返回全量 raw log；
- 认证失败与 scope 不足沿用受控错误码。

## ACP 映射

| bridge | ACP |
| --- | --- |
| `run_task` | `session/prompt` |
| `cancel_task` / `cancel_turn` | `session/cancel` |
| `task_interaction_request(kind=permission)` | permission request |
| `task_interaction_request(kind=form)` | form / elicitation |
| `task_interaction_request(kind=auth-url)` | auth URL |
| `task_interaction_response` | ACP response |

要求：

- 只声明真实通过的 `executionModes` / `interactionKinds`；
- 交互超时、取消、断线复用现有语义；
- 不把 secret 写入日志或持久化。

## 安全

- 默认关闭；
- 只绑回环，除非显式配置并加认证；
- 复用 `abs_` token / JWT principal；
- 每请求带 tenant，跨租户 404；
- 不返回 CORS。

## 分阶段

1. 映射表 + 纯函数测试
2. A2A `agent-card` + `tasks/get` 只读
3. A2A `message/send` + `tasks/cancel` + resubscribe
4. ACP server `initialize/session/new/prompt/cancel`
5. 交互/附件映射与端到端
