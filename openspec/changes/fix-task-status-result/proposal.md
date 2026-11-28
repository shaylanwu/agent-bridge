# 变更提案：终态 `task_status.result` 是死字段（契约写了，实现从没发过）

## Why

补 WS 直连 e2e 的 form 用例时顺手断言了「终态带最终回答」，结果拿到空字符串。
导出这一批任务的全部上行帧后确认：**`task_status` 从来没有 `result` 字段**。

### 证据

`test/e2e-ws-dispatch.test.ts`（真 WebSocket + 真 `createSession` + 真 SQLite + 假 ACP 子进程）
里把某个任务的所有上行帧打出来：

```
task_status(running, eventSeq=1)
task_interaction_request(kind=permission)
task_status(running, phase=waiting_interaction)
task_interaction_result(accepted)
task_status(running, phase=running)
task_log(stdout, "APPROVED_OK")
task_message(state=complete, text="APPROVED_OK")     ← 最终回答在这里
task_status(success, exitCode=0, stopReason=end_turn, eventSeq=7)   ← 没有 result
```

- `src/app/task-dispatch.ts` 构造 `task_status` 时逐个列字段，**漏了 `result`**；
- `git log -S "result:" -- src/app/task-dispatch.ts` 无任何历史命中 —— 不是回归，
  是这个字段从上线起就没被填过；
- `src/transport/control-plane.ts` 落 `task_status` 事件载荷时同样没有。

### 契约侧却是「已支持」

- `src/protocol.ts`：`/** 终态最终回答文本（步骤流工具从 result 事件提取；≤16KB） */ result?: string;`
- `contracts/asyncapi-3.0.yaml`（以及站点 `protocol/messages` 表格）写着同一句。

即协议承诺了「终态帧里能直接读到最终回答」，实现只给事件流里的 `task_message`。
平台若按文档读 `task_status.result`（最省事、不需要重建事件流），**永远读到 `undefined`**，
表现是「任务成功了但没有结果」。

### 为什么以前没暴露

`task_message`（state=complete）确实带着同样内容，平台侧一直走的是事件流；
单元用例要么只测 supervisor 的 `info.result`，要么只测帧构造的其它字段，
**没有一条用例把「终态帧里的 result」当成断言**。

## What Changes

1. **`src/core/result-text.ts`（新增）**
   `capResultText()`：按协议写明的 16KB 上限截断并补省略号。放成独立小模块，
   与 `form-schema.ts` / `context-overflow.ts` 同一风格，避免两处各写一遍截断。
2. **WS 上行补齐**（`src/app/task-dispatch.ts`）
   终态 `task_status` 带 `result: capResultText(info.result)`；
   同时把同一个值写进落库的 `task_status` 事件载荷，保证历史快照重放与实时帧一致。
3. **控制面同口径**（`src/transport/control-plane.ts`）
   落库的 `task_status` 事件载荷同样带 `result`。该文件注释本就写着「与 WS dispatch 同口径」，
   现在真正对齐。
4. **正式 spec 增补**（`bridge-protocol`）
   「任务终态」增一条 Requirement：终态 `task_status` SHALL 携带最终回答文本，
   与 canonical `task_message`（state=complete）一致，且 SHALL 不超过 16KB（超出截断并补省略号）；
   非终态帧 SHALL NOT 携带。
5. **测试**
   - WS e2e：approve 用例断言终态 `result` 含 `APPROVED_OK`；form 用例断言含 `FORM_OK`
     （两条用例在修复前都会红）。
   - 单测：`test/result-text.test.ts` 覆盖未超限原样、恰好 16KB、超出截断补省略号、`undefined`。

**不做**：

- 不删 `task_message`（它仍是 canonical、可重建事件流的通道），也不改它的字段；
- 不给 `task_message.text` 加截断（它的契约里没有 16KB 上限，加了等于偷偷丢内容）；
- 不改 wire 结构（字段本就存在）、不递增 `PROTOCOL_VERSION`；
- 不改 `TaskSupervisor.settle()` 里 stepParser 的内联截断（高风险文件，且行为已经正确）。

## Impact

- 修复面：新增 `src/core/result-text.ts`；改 `src/app/task-dispatch.ts`、`src/transport/control-plane.ts`
  （均非高风险文件）。
- 行为（正面）：平台按文档读 `task_status.result` 能拿到最终回答；事件快照重放同口径。
- 行为（风险）：终态帧体积变大（上限 16KB + 省略号）——只在有最终回答时出现，
  且与同批次发出的 `task_message` 同量级，可接受。
- 观测面：`task_status` 事件载荷多一个 `result` 键；老平台忽略未知字段即可，无破坏性。

## 验收标尺

1. `npm run gate` + `npm run harness:validate` 全绿；全量 vitest 不回归。
2. WS e2e **7 例全绿**，且在**回退本次修复后** approve / form 两条用例因 `result` 为空变红
   （先红后绿，证明用例真的在守这个字段）。
3. `test/result-text.test.ts` 覆盖 16KB 边界（16384 原样、16385 截断）。
