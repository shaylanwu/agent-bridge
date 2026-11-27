# 变更提案：终态后 `get_artifact` 零响应（Emitter 把读回包一起丢了）

## Why

补 WS 直连 e2e 时发现的**真 bug**，不是测试问题：

### 证据

在 `test/e2e-ws-dispatch.test.ts` 里用真 WebSocket 服务器 + 真 `createSession` + 真 SQLite 跑：

```
run_task(ws_cancel_1) → task_status(running) → cancel_task → task_status(cancelled)
get_artifact(ws_cancel_1, art_missing)  → 15s 内零响应
```

- 同一时刻 `ping` → `pong` 正常（通道活着，不是断线）；
- 直接调用 `dispatchGetArtifact()`（隔离验证）→ 立刻产出
  `{ type:'artifact_content', found:false, errorCode:'artifact_not_found' }`。

### 根因

`src/core/emitter.ts` 的终态幂等闸门按 `taskId` 一刀切：任务进入终态后，除
`task_snapshot` / `session_ack` / `message_ack` / `task_interaction_result` / `interaction_url`
之外的帧一律丢弃。**`artifact_content` 不在白名单里**。

而 `src/protocol.ts` 就写着这条帧的契约：「附件内联内容：响应 get_artifact。
**终态后仍可取**（走持久元数据 + CAS，不重读工作区）」。实现与自己的文档矛盾，
后果是**最常用的读法**（任务跑完再去取产物）永远收不到回复，平台只能干等超时。

### 为什么以前没暴露

网关 e2e（A2A/ACP over HTTP）不经过 WS 上行；控制面 HTTP 直接读 store 不走 Emitter；
单元级用例没有「先终态、再取产物」的组合。WS 直连这条链此前没有闭环测试。

## What Changes

1. **Emitter 放行读回包**（`src/core/emitter.ts`）
   在终态丢弃的豁免清单里加入 `artifact_content`。判定口径不变：仍按 `taskId`、
   仍只豁免「回答请求的帧」，**不**放行 log / step / running / 新 interaction_request。
2. **协议语义写进正式 spec**（`bridge-protocol`）
   「终态幂等重放与终态后交互结果」增补一条：读回包（`task_snapshot`、`artifact_content`）
   SHALL 在终态后可发，因为它们回答的是请求而不是产生新事件。
3. **补 WS 直连 e2e**（`test/e2e-ws-dispatch.test.ts`，新增）
   真 `ws` 服务器 + 真 `createSession` + 真 SQLite + 假 ACP 子进程（写死 .cjs），覆盖：
   hello 协商、approve（权限请求 → 响应 → 回合继续）、cancel、artifact（未知 / 已知）。
   - approve 的交付证据取**子进程落盘**（它只在真收到响应时才写 optionId），不看桥接日志；
   - 失败断言带出最近帧与桥接日志，避免「空数组看不出为什么」。
4. **Emitter 边界单测**（`test/emitter-settled.test.ts`，新增）
   终态后 log 丢弃、相同终态可重放 / 不同终态拒绝、`artifact_content` 与 `task_snapshot` 必须放行。

**不做**：不放宽其它帧类型的豁免（终态后仍禁止 log/step/running）；不改 wire 结构；
不改 `PROTOCOL_VERSION`；不引入「终态后仍可发 task_artifact」（产物通知应在终态前发出）。

## Impact

- 修复面：`src/core/emitter.ts`（非高风险文件）。
- 行为（正面）：平台可在任务终态后用 `get_artifact` 拿到产物元数据与内容。
- 行为（风险）：极小的幂等风险 —— 若平台在终态后重复请求同一 artifact，会收到重复的
  `artifact_content`（带 `requestId`，本就按请求幂等）。这是**正确**行为：读操作不是副作用。
- 观测面：`task_artifact` 通知仍受终态约束（产物应在终态前上报）。

## 验收标尺

1. `npm run gate` + `npm run harness:validate` 全绿；全量 vitest 不回归。
2. 新增 WS e2e 5 例全绿（约 2s），且**在回退 Emitter 修复后两条 artifact 用例变红**
   （各挂 15s 超时）—— 证明用例真的在守这个缺陷。
3. `test/emitter-settled.test.ts` 4 例全绿，其中 artifact / snapshot 放行两例在回退修复后变红。
