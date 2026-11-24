# 变更提案：ACP 会话多轮记忆（add-acp-session-memory）

> 来源：add-a2a-acp-gateway 评审结论（2026-11-22）——「④接受显式指定 CLI，但需要考虑多轮记忆、
> 长对话场景」。
> 2026-11-22 用户拍板：**按方案 B（conversation 续接）执行，砍掉方案 A（网关层历史重放）**；
> 改完需全流程走测受影响的全部业务。

## Why

ACP 网关当前是「一问一任务」：同一个 `acp_` 会话里连续问三句，三句被当成三个**独立** bridge 任务跑，
互相不记得。编辑器场景（ACP 的主场景）天然是长对话。

bridge 已有完整的 conversation 编排（多轮、续接、空闲回收）与 12 适配器续接矩阵
（resumeArgs / native ACP session / transcript 重放兜底），在 WS 通道上运行多日——本提案只是把
**这套已有能力暴露到 ACP 表面**，与网关其它部分「纯适配、不复制语义」的定位一致。

## What Changes（方案 B，已定案）

- `app/session.ts` 的 `BridgeSession` 暴露 conversation 编排入口（run / message / cancelTurn），
  内部复用 WS 通道同一个 `dispatchOptions`（同一份鉴权、账本、审计与续接状态——
  `residentSessions`/`idleTimers` 挂在会话级，跨轮复用不失效）；
- control-plane / 网关注入该入口（与 `startTask`/`respondInteraction` 同一注入模式）；
- ACP `session/prompt` 语义升级：
  - 首轮 = `run_task(sessionMode=conversation)`（创建 bridge conversation 会话）；
  - 后续轮 = `send_message`（续接同一会话；CLI 原生续接，**token 只传增量**，历史由 CLI 上下文持有）；
  - SSE 流的「本轮结束」判定改为 **turn 终态语义**：`task_status{turnId=本轮, phase=waiting_user}`
    → result 帧（end_turn）；turn failed/timeout/cancelled → 会话随之关闭（conversation 既有语义）；
- ACP `session/cancel` 取消当前 turn（复用 `cancel_turn` 编排）；
- 会话空闲回收复用 conversation 的 `idleTimeoutMs`（ACP 协议无 close 方法，由空闲语义收口）。

## 已评估并否决的替代方案

**方案 A（网关层历史重放）**：每轮把历史拼进 prompt。否决理由：token 随轮数线性重放，
恰与「长对话」目的相悖；实现放在协议适配层、与网关「不新造业务语义」的定位打架；
且注定被 B 替代（一次性成本）。用户 2026-11-22 确认砍掉。

## Non-goals

- 不做跨进程持久记忆：bridge 重启后 acpSession 登记丢失（进程内存态），store 里的
  conversation 会话在但第一版不恢复 ACP 绑定；
- 不做向量检索/摘要压缩（token 治理超范围）；
- 不影响 A2A 表面（A2A 多轮由客户端用 contextId 自行组织，规范如此）。

## Impact

- `src/app/session.ts`（BridgeSession 暴露 conversation 入口）、`src/transport/control-plane.ts`
  （deps 注入）、`src/transport/gateway.ts`（ACP prompt/cancel 重写）、`src/commands/{connect,serve}.ts`（注入）；
- ACP initialize 能力声明翻新（`loadSession` 语义按会话内存续接如实声明）；
- README/OpenAPI 契约同步；
- **全流程回归**：全量单测（含 WS conversation 回归）+ gate + e2e:smoke + e2e:gateway
  （新增两轮对话记忆断言）。

## Rollout

单批：实现 + 单测（含多轮/续接/取消/拒绝路径）→ 文档契约 → 全流程走测 → 评审归档。
