# 变更提案：断线补发的规格说反了（写着「task_log 不补发」，实现一直在补）

## Why

补「断线重连」e2e 时对照规格，发现正式规格与实现**方向相反**：

- `openspec/specs/bridge-protocol/spec.md`「出站长连接 / 网络中断」写着：
  > bridge 以 1s→2s→4s…→30s 指数退避重连，并在重连后补发状态类消息（**`task_log` 不补发**）
- 实现（`src/transport/outbox.ts`，P1-2 起）是**两类都补**：控制类按条数（200）、日志按字节（256 KB），
  日志超限**丢最旧**并插一条说明性日志；`bridge-client.flush()` 在每次 `open` 时统一 drain。

即：规格低估了实现。读规格的人会以为断线必然丢日志、不必为「日志跳段」做解释，
而实际行为是**日志会补一段、超限会明说**。这会让平台侧的排障假设出错
（看到日志跳段去怀疑 CLI，而不是识别桥接已经提示过裁剪）。

## 证据（新增 e2e）

`test/e2e-ws-dispatch.test.ts`「断线期间的缓冲边界与终态竞争」：

- 断线窗口内灌 ~480 KB 日志（> 256 KB 上限）→ 重连后收到
  `[agent-bridge] 断线期间日志超出缓冲上限（N KB），已丢弃较早部分`（`stream:"stderr"`），
  且补发的 `task_log` 总字节 < 320 KB —— 有界，不是原样灌回。
- 先红后绿：临时让 `outbox.notice()` 返回 `null`，该用例 15s 超时变红；复原后全绿。

## What Changes

只改规格文本（`bridge-protocol` 的「出站长连接」Requirement），把断线补发写成实现的样子：

1. 补发的分界不再是「状态类 vs 日志」，而是**有界缓冲**：控制类按条数、日志按字节，各自上限；
2. 日志超限 SHALL 丢最旧并 SHALL 插入一条说明性 `task_log`（`stream:"stderr"`，含量级），SHALL NOT 静默丢弃；
3. 补发 SHALL 保持原事件的身份（同一 `eventSeq` 的重放，不是新造事件）——平台按事件去重时不会看到两条；
4. 明确 SHALL NOT 因断线停任务：断线期间产生的终态 SHALL 在重连后补发。

**不做**：不改实现（实现是对的）；不加新能力/字段；不递增 `PROTOCOL_VERSION`。

## Impact

- 只动规格与文档，不动代码。
- 正面：平台侧对「日志跳段」有明确判断依据（看那条说明性日志），不会误判成 CLI 没输出。
- 风险：无（实现不变）。

## 验收标尺

1. `npm run gate` + `npm run harness:validate` + `npm run openspec:validate` 全绿。
2. 规格文本与新 e2e 的三条断言逐条对应（有界 / 说明性提示 / 同一 `eventSeq` 重放）。
