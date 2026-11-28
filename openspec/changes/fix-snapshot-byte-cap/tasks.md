# 任务清单：fix-snapshot-byte-cap

> 条目以 `N.N` 开头（OpenSpec 校验要求）；完成一项勾一项并附证据。
> 本提案**不带 specs/ 增量**：规格早已写明「单响应 1 MiB」，缺的是实现。

## 1. 实现

- [x] 1.1 `src/core/snapshot-cap.ts`（新增）：`SNAPSHOT_MAX_BYTES` + `capEventsByBytes`（从最新往回装，至少保留一条）
- [x] 1.2 `src/app/task-dispatch.ts`：`dispatchGetTask` 按整帧骨架量预算，裁剪时置 `hasMoreBefore`

## 2. 测试

- [x] 2.1 `test/snapshot-byte-cap.test.ts`（5 例）：纯函数 4 个边界 + 整帧 2 例（超限裁剪 / 未超限一条不少）
- [x] 2.2 先红后绿：把预算改成 `Number.MAX_SAFE_INTEGER` → 整帧用例变红 `expected 200 to be less than 200`，复原后全绿

## 3. 验证

- [x] 3.1 `npm run gate` 全绿；`npm run harness:validate` 全绿
- [x] 3.2 相关三个 e2e 文件（snapshot-byte-cap / e2e-ws-feed-gaps / e2e-ws-dispatch）23 例全绿

## 4. 归档

- [ ] 4.1 由人工执行 `mv openspec/changes/fix-snapshot-byte-cap openspec/changes/archive/<日期>-fix-snapshot-byte-cap`
