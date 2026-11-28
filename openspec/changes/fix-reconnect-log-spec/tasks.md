# 任务清单：fix-reconnect-log-spec

> 条目以 `N.N` 开头（OpenSpec 校验要求）；完成一项勾一项并附证据。

## 1. 取证

- [x] 1.1 对照实现确认漂移：`src/transport/outbox.ts` 两类都缓冲（控制按条数 200 / 日志按字节 256 KB），`bridge-client.flush()` 每次 `open` 统一 drain
- [x] 1.2 e2e 取证（`test/e2e-ws-dispatch.test.ts`）：480 KB 断线日志 → 重连收到「断线期间日志超出缓冲上限（N KB）」且补发总量 < 320 KB

## 2. 规格

- [x] 2.1 `specs/bridge-protocol/spec.md`（MODIFIED「出站长连接」）：把「task_log 不补发」改成有界缓冲 + 超限提示 + 同一 eventSeq 重放
- [x] 2.2 合并进 `openspec/specs/bridge-protocol/spec.md`

## 3. 验证

- [x] 3.1 `npm run openspec:validate` 通过
- [x] 3.2 `npm run gate` 全绿（改动只涉及 md，vitest 不回归）

## 4. 归档

- [ ] 4.1 由人工执行 `mv openspec/changes/fix-reconnect-log-spec openspec/changes/archive/<日期>-fix-reconnect-log-spec`
