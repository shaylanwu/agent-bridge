# 变更提案：真的执行「单响应 1 MiB」上限（快照此前无上限）

## Why

规格两处都写着这个承诺：

- `bridge-protocol`「会话快照、附件补取与历史分页」：
  > limit 默认 200、上限 1000，**单响应 1 MiB 是默认可配置安全策略**
- `task-execution`「会话快照、预算与终态收尾」同段亦有此意

但 `dispatchGetTask` **没有任何体积判断**：默认 `limit=200`，而 `task_log` 是持久化事件
（一条几 KiB 很常见），200 条就能拼出 1.6 MiB 以上的单帧。后果是真实的：WS 心跳、
平台解析、中间代理缓冲都吃这一帧，极端情况下直接断连 —— 且失败点在**读历史**这条最不该出事的路径上。

这也是我自己在补 e2e 时踩出来的：`BIGLOGS` 造 480 KB 日志后，`get_task` 一帧就把它们全带回来。

## What Changes

1. **`src/core/snapshot-cap.ts`（新增）**
   `SNAPSHOT_MAX_BYTES = 1 MiB` + `capEventsByBytes(events, budget)`：从**最新**往回装，
   装不下就停（保住最新状态），至少保留一条（返回空 events 会被误读成「这任务没有任何事件」）。
2. **`src/app/task-dispatch.ts`（`dispatchGetTask`）**
   先拼不含 `events` 的骨架并量出字节数，剩下额度给事件，再留 1 KiB 序列化噪声；
   被裁掉前缀时把 `hasMoreBefore` 置 `true`（语义就是「更早还有货，往前翻」）——
   **不新增字段、不改 wire 结构、不动 gaps 语义**。
3. **测试** `test/snapshot-byte-cap.test.ts`（5 例）
   纯函数边界（空/装得下/部分/单条超预算）+ 整帧：200 条 × 8 KiB ≈ 1.6 MiB → 裁剪后
   `events.length < 200`、帧 ≤ 1 MiB、最后一条等于 `latestEventSeq`、`hasMoreBefore=true`；
   小任务一条不少且 `hasMoreBefore=false`。

**不做**：不改规格文本（规格本来就是对的，是没实现）；不截断事件内容（那会静默丢数据）；
不引入 `truncated` 之类的新字段（`hasMoreBefore` 已足够表达）；不动 `PROTOCOL_VERSION`。

## Impact

- 修复面：新增 `src/core/snapshot-cap.ts`，改 `src/app/task-dispatch.ts`（均非高风险文件）。
- 行为（正面）：`get_task` 单帧不再可能到 MB 级；历史补取靠 `hasMoreBefore` + `beforeEventSeq` 分页。
- 行为（风险）：一次返回的事件数可能少于 `limit`（平台若假设「一定给满 limit 条」需改成看 `hasMoreBefore`）。
  这正是 `hasMoreBefore` 的既有语义，属对齐而非新约定。
- 未知量：单条事件自身超过 1 MiB 时仍会超限（保留一条优先于返回空）——已写进注释。

## 验收标尺

1. `npm run gate` + `npm run harness:validate` 全绿；全量 vitest 不回归。
2. `test/snapshot-byte-cap.test.ts` 5 例全绿，且**把预算改成 `Number.MAX_SAFE_INTEGER` 后**
   整帧用例变红（`expected 200 to be less than 200`）——证明用例真的在守这个上限。
