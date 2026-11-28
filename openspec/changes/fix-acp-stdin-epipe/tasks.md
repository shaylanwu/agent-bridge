# 任务清单：fix-acp-stdin-epipe

> 条目以 `N.N` 开头（OpenSpec 校验要求）；完成一项勾一项并附证据。

## 1. 修复

- [x] 1.1 `src/adapters/acp-codebuddy.ts`：spawn 后给 `child.stdin` 挂 `error` 监听（`closed = true` + 唤醒等待中的响应），不改结算语义
- [x] 1.2 回归用例 `test/acp-diagnostics.test.ts`：假 CLI 立刻 `process.exit(2)`，断言以 `EPIPE CLI 进程退出（code 2）` 正常 reject，并留 200ms 让异步 `stdin error` 落地

## 2. 验证与取证

- [x] 2.1 `test/acp-diagnostics.test.ts` **23 例全绿**
- [x] 2.2 诚实记录：Windows 上移除修复后用例**仍绿**（本机不触发 `EPIPE`），红证据来自 macOS CI 日志 `Unhandled Errors … write EPIPE at send src/adapters/acp-codebuddy.ts:301`
- [x] 2.3 `npm run gate` 全绿（vitest 并行度已封顶 4，不再「跑完不退出」）
- [ ] 2.4 推送后 macOS CI 转绿（同一提交族不再出现 `write EPIPE` 未捕获异常）

## 3. 归档

- [x] 3.1 `specs/task-execution/spec.md` 增量已合并进 `openspec/specs/task-execution/spec.md`（新增「子进程写失败不得升级为进程级异常」）
- [ ] 3.2 由人工执行 `mv openspec/changes/fix-acp-stdin-epipe openspec/changes/archive/<日期>-fix-acp-stdin-epipe`
