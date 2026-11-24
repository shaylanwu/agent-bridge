# 实施清单：add-a2a-acp-gateway

> 状态：2026-11-22 评审通过（5.2 完成）；归档执行序列：用户人工 mv 提案目录 → agent 合并正式 spec
> （`openspec/specs/external-gateway/`）并核验。ACP-over-HTTP 为 vendor-specific 承载（ACP Transports
> RFD 未定稿）：请求走 POST，prompt 下行与 agent→client 交互请求走 SSE 流，客户端应答走另一条
> POST 的「响应报文」。

## 1. 契约与映射

- [x] 1.1 写 A2A `TaskState` ↔ `TaskStatus` 映射表与纯函数测试（`src/transport/a2a-mapping.ts` + `test/a2a-mapping.test.ts`；含 A2A-Version 0.3/1.0 双拼写协商）
- [x] 1.2 写 `task_message` / `task_artifact` ↔ A2A `Message` / `Artifact` 映射（complete 消息进 history；附件为 file part 指向控制面下载端点）
- [x] 1.3 写 ACP `session/prompt` / permission / form / cancel 映射（`src/transport/acp-gateway-mapping.ts` + `test/acp-gateway-mapping.test.ts`；处理器在阶段 3 接入）
- [x] 1.4 明确 `task_log` 只作为调试扩展，不冒充标准消息（`Task.metadata.bridge.taskLogEndpoint` 指引，测试覆盖）

## 2. A2A 网关

- [x] 2.1 `GET /.well-known/agent-card.json`，声明真实能力（capabilities 只写已实现项：streaming=false；skills 来自静态适配器表）
- [x] 2.2 `tasks/get` 只读，按 tenant 隔离（跨租户/不存在统一 JSON-RPC -32001；`src/transport/gateway.ts` + `test/gateway-a2a.test.ts`；网关挂 control-plane 路由，默认关闭 404）
- [x] 2.3 `message/send` 创建任务，复用 TaskSupervisor（messageId 即幂等键；metadata.agentType/cwd 扩展；与 POST /v1/tasks 共用 createTaskCore 编排）
- [x] 2.4 `tasks/cancel` 幂等取消（与 :cancel 共用 cancelTaskCore；终态 -32002、跨租户 -32001）
- [x] 2.5 `tasks/resubscribe` 用 `eventSeq` 补洞（SSE：回放 + 实时帧 + 终态 done；afterEventSeq 游标）

## 3. ACP server

- [x] 3.1 `initialize` / `session/new`（initialize 只声明真实能力：loadSession=false、text-only；session/new 固化 agentType/cwd（`params._meta.agentType` 扩展字段））
- [x] 3.2 `session/prompt` 映射到 `run_task`（一轮 prompt = 一个 bridge 任务，与 POST /v1/tasks 同一条 createTaskCore 编排；SSE 下行 update 帧 + result 终帧）
- [x] 3.3 `session/cancel` 映射到 `cancel_task` / `cancel_turn`（走 cancelTaskCore；无活动任务时静默成功——notification 语义）
- [x] 3.4 permission / form / auth-url 交互映射（waiting 时流中注入 agent→client `request` 帧（request_permission / elicitation/create）；客户端 POST /acp 回响应报文 → 转成 `task_interaction_response` 走与 `:respond` 同一条 dispatch 路径；permission/form 闭环有测试，auth-url 复用同一映射与注入机制）
- [x] 3.5 超时、断线、取消、畸形帧测试（超时终态 → result 帧 JSON-RPC error；流结束清理出站请求登记；session/cancel；畸形 prompt/信封/未知会话拒绝）

## 4. 安全与运维

- [x] 4.1 默认关闭、回环绑定、token/JWT 鉴权（`[gateway]` 配置段 + `AGENT_BRIDGE_GATEWAY` 环境变量；挂 control-plane 服务器，listen 红线不新增豁免；测试覆盖默认 404/401/403）
- [x] 4.2 跨租户 404 与 scope 测试（get/cancel/subscribe 的跨租户统一 -32001、写/取消的 scope 403，gateway-a2a.test.ts 覆盖）
- [x] 4.3 不返回 CORS、不日志泄漏 secret（测试断言无 CORS 头；网关不打印令牌）
- [x] 4.4 契约文档与 site 页面（`contracts/openapi.control-plane.yaml` 新增 `a2a-gateway` tag；两份 README 新增网关小节）

## 5. 收尾

- [x] 5.1 端到端：A2A send/get/cancel、ACP prompt/permission（`npm run e2e:gateway`：真 bridge 进程 + 真令牌 + 真 CLI，13 项全过——A2A send→COMPLETED+history、messageId 幂等、cancel→CANCELED、ACP prompt→end_turn+content；permission/form 交互闭环由 test/gateway-acp.test.ts 真 store+真 SSE+dispatch 路径覆盖，真 CLI permission 冒烟依赖 ACP 通道工具调用，列为后续实测项）
- [x] 5.2 人工评审（2026-11-22 用户拍板：①网关仅本机——接受；②A2A 双拼写协商——确认；③ACP-over-HTTP vendor 承载（POST+SSE+响应报文）——定死为对外契约；④显式指定 CLI——接受；**多轮记忆/长对话场景列为后续提案 add-acp-session-memory**）
- [x] 5.3 归档并合并 spec（执行序列：本清单定稿后由用户人工 `mv` 提案目录至 archive（archive 保护 hook 拦 agent）；正式 spec `openspec/specs/external-gateway/spec.md` 由 agent 在 mv 后从 specs/external-gateway/spec.md 合并，随后跑 openspec:validate 核验）
