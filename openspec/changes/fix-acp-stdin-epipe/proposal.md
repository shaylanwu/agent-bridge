# 变更提案：ACP 子进程崩溃时 stdin `EPIPE` 会把 bridge 一起带走

## Why

macOS CI 在**只有站点文档改动**的提交（`2d387ef`）上红了，日志里 71 个测试文件全过、退出码却是 1：

```
Unhandled Errors
Error: write EPIPE
 ❯ Socket.Writable.write (node:net:512:10)
 ❯ send src/adapters/acp-codebuddy.ts:301:19
This error originated in "test/acp-diagnostics.test.ts" …
```

`send()` 明明有 `try/catch`，为什么还逃逸？因为**`write()` 只是把数据入队**，
真正的写入失败在事件循环后段以 `stdin` 的 `error` 事件抛出 —— `try/catch` 抓不到，
而 `child.stdin` 上**没有任何 `error` 监听器**，于是 `EPIPE` 成为未捕获异常，
Node 默认终止进程。

真实后果不是「测试偶发红」：ACP 通道（codebuddy / opencode / mimo / grok / kimi / minimax / trae / dsh
共 8 个工具）只要子进程在桥接写通知的瞬间死掉（崩溃、被 kill、被系统回收），
**整个 bridge 进程会跟着退出**，正在跑的所有任务一起丢。

这与 codex 那次「握手期失败未挂 catch → 未处理拒绝」是同一类缺陷（见
`add-context-exhausted` 之后合并进 `task-execution` 的「回合 Promise 不得产生未处理拒绝」），
只是从 Promise 换成了 stream 事件。

## What Changes

1. **`src/adapters/acp-codebuddy.ts`**：spawn 之后给 `child.stdin` 挂 `error` 监听，
   命中即 `closed = true` + 唤醒所有等待中的响应（`settleResponseWaiters()`）。
   只做「标记关闭 + 结算等待者」，**不抛错、不改写结论**：真正的失败仍由进程 `exit`
   分支按原有语义结算（stderr 尾部照样拼进原因）。
2. **回归用例**（`test/acp-diagnostics.test.ts`）：假 CLI 立刻 `process.exit(2)`，
   断言 `runAcpPrompt` 以 `EPIPE CLI 进程退出（code 2）` 正常 reject，且之后留 200ms 窗口
   让异步 `stdin error` 落地 —— 没被监听时这里会以未捕获异常让整个文件变红。
3. **规范**：`task-execution` 增一条 Requirement，把「子进程写失败必须是可结算的失败，
   不得升级为进程级未捕获异常」钉住（与既有「未处理拒绝」条目并列）。

**不做**：不改变 ACP 请求/响应语义、不改 wire、不改结算码；不吞掉**同步**异常
（`write()` 本身抛错仍走现有 `catch` 返回 false）。

## Impact

- 修复面：`src/adapters/acp-codebuddy.ts`（非高风险文件）。
- 行为（正面）：子进程崩溃不再导致 bridge 进程退出；等待中的响应会被唤醒为 `false`，
  由上层按「交付不确定」处理（`interaction_delivery_unknown` 语义不变）。
- 行为（风险）：极小 —— `closed` 提前置真会让后续 `send()` 直接返回 false（本就是正确行为：
  管道已不可用）。
- 本地无法复现：Windows 上同样的假 CLI 不会触发 `EPIPE`（移除修复后用例仍绿），
  所以红证据是 **macOS CI 日志**，绿证据是修复后 CI 转绿 + 本用例全平台通过。

## 验收标尺

1. `npm run gate` 全绿；全量 vitest 不回归。
2. `test/acp-diagnostics.test.ts` 23 例全绿（新增 1 例）。
3. 推送后 macOS CI 转绿（同一提交族上不再出现 `Unhandled Errors … write EPIPE`）。
