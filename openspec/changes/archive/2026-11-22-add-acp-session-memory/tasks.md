# 实施清单：add-acp-session-memory

> 状态：2026-11-22 评审通过（4.1 完成）；正式 spec（含 conversation 章节）已合并进
> `openspec/specs/external-gateway/spec.md`；归档执行序列：用户人工 mv 提案目录 → agent 核验。

## 1. conversation 入口暴露与注入

- [x] 1.1 `BridgeSession` 暴露 conversation 编排（run / message / cancelTurn；复用 WS 同一 dispatchOptions——鉴权/账本/审计/residentSessions 单一真源）
- [x] 1.2 control-plane deps 注入 + connect/serve 传递（与 startTask/respondInteraction 同一模式）

## 2. ACP prompt/cancel 重写

- [x] 2.1 `session/prompt` 首轮走 `run_task(sessionMode=conversation)`，后续轮走 `send_message` 续接同一 bridge 会话（acpSession ↔ bridgeSessionId 绑定；SSE 订阅先于发起，同步事件零丢失）
- [x] 2.2 SSE 流「本轮结束」判定改 turn 终态语义（turnId 锁定 + 过滤；waiting_user → end_turn；turn 失败 → 会话关闭走 error 帧；后续 prompt 前置检查会话终态、如实提示 session/new）
- [x] 2.3 `session/cancel` 取消当前 turn（cancel_turn 编排，operationId 幂等键）
- [x] 2.4 幂等与拒绝路径：message_ack(queued/duplicate) 锁定 turnId、rejected → 拒绝帧；conversation 未注入 → -32004 不降级为单发任务；bridge 重启后 acpSession 丢失走 sessionNotFound

## 3. 测试与契约

- [x] 3.1 单测：多轮续接（同 bridge 会话两轮 prompt、send_message 断言）、取消当前 turn、会话终态后拒绝、并发 promptBusy、conversation 未注入 -32004、交互闭环（permission/form）维持全绿（test/gateway-acp.test.ts 14 项）
- [x] 3.2 initialize 能力声明翻新 + README（两份）+ OpenAPI /acp 描述同步
- [x] 3.3 全流程走测：全量单测（含 WS conversation 回归 12 项全绿）+ gate 分项 + e2e:smoke（13 项全过）+ **e2e:gateway 15/15 全过（2026-11-22 codex 真跑）**：A2A send→COMPLETED+history、messageId 幂等、cancel→CANCELED、ACP prompt 两轮——**第二轮续接同一 bridge 会话且回答引用第一轮内容（BANANA42）**。环境根因为会话注入的坏代理（HTTPS_PROXY=127.0.0.1:65495）挡死 CLI 出网，e2e 增加 `E2E_PROXY` 覆盖支持（`E2E_PROXY=http://127.0.0.1:7897 node scripts/gateway-e2e.mjs --agent codex`）

## 4. 归档

- [x] 4.1 人工评审（2026-11-22 用户通过：会话终态后拒绝并提示 session/new 的诚实取向、Non-goals 边界（重启不恢复绑定/不做摘要压缩）、实施范围（5 文件、无 wire 变更）均确认）
- [x] 4.2 归档并合并 spec（正式 spec 的 conversation 章节已先行合并进 `openspec/specs/external-gateway/spec.md`（验证通过）；本清单定稿后由用户人工 mv 提案目录至 archive，agent 核验收口）
