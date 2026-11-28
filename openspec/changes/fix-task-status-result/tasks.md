# 任务清单：fix-task-status-result

> 条目以 `N.N` 开头（OpenSpec 校验要求）；完成一项勾一项并附证据。

## 1. 实现

- [x] 1.1 `src/core/result-text.ts`（新增）：`RESULT_TEXT_LIMIT = 16_384` + `capResultText()`（超出截断并补 `…`，`undefined` 原样返回）
- [x] 1.2 `src/app/task-dispatch.ts`：终态 `task_status` 带 `result`，并写进落库的事件载荷（实时帧与快照重放同口径）
- [x] 1.3 `src/transport/control-plane.ts`：落库的 `task_status` 事件载荷同样带 `result`（注释里早写着「与 WS dispatch 同口径」）

## 2. 测试

- [x] 2.1 `test/result-text.test.ts`（新增）：未超限原样、恰好 16384 原样、16385 截断补省略号、`undefined` → `undefined`
- [x] 2.2 `test/e2e-ws-dispatch.test.ts`：approve 用例断言终态 `result` 含 `APPROVED_OK`
- [x] 2.3 `test/e2e-ws-dispatch.test.ts`：form 用例断言终态 `result` 含 `FORM_OK`（该用例本就为 form 链路取证而来）

## 3. 验证与取证

- [x] 3.1 先红后绿：回退 1.2 后 2.2 / 2.3 变红（`expected undefined to be 'APPROVED_OK'` / `expected '' to contain 'FORM_OK'`），恢复后全绿
- [x] 3.2 WS e2e 7 例全绿（约 2.0s）
- [x] 3.3 `npm run gate` 全绿；`npm run harness:validate` 全绿；全量 vitest **73 文件 770 passed / 1 skipped**（12.7s）

## 4. 归档

- [x] 4.1 `specs/bridge-protocol/spec.md` 增量已合并进 `openspec/specs/bridge-protocol/spec.md`
- [ ] 4.2 由人工执行 `mv openspec/changes/fix-task-status-result openspec/changes/archive/<日期>-fix-task-status-result`
