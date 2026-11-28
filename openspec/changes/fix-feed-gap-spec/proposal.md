# 变更提案：feed 缺口语义的规格校正（字段名写错 + 分层没讲清）

## Why

给「有界 feed 缺口」补 e2e 时逐字对照规格，发现正式规格与**契约（asyncapi）/ 实现 / 站点文档**
三处对不上，属同一节的两类问题：

### 1) 快照窗口的字段名写错了

`openspec/specs/bridge-protocol/spec.md`「会话快照、附件补取与历史分页」写着：

> eventWindow { **oldestRetainedEventSeq, lastEventSeq**, gaps }

而实现（`src/app/task-dispatch.ts` 的 `dispatchGetTask`）、契约 `contracts/asyncapi-3.0.yaml`、
站点 `protocol/messages` 三处都是 `oldestEventSeq` / `latestEventSeq`。
照规格写客户端的字段名，拿到的永远是 `undefined` —— 这类漂移在「可选字段没人填」之外又多一种：
**规格自己编了一个字段名**。

### 2) 缺口形态与分层没讲清

同一节与「Web Agent 会话呈现 Feed」里写缺口是 `(fromEventSeq/toEventSeq/reason)`，
实际结构与契约都是 `{ from, to, reason? }`。更要紧的是**两种裁剪的分层**只在实现注释里：

- 分类条数淘汰（类型交错留下洞）：产生**窗口内缺口**，`eventWindow.gaps[].reason = count|task_bytes|global_bytes`，
  事件序号水位不前移；
- 前缀删除（从最旧删起、整段前缀没了）：推进 `prunedThrough`，用 `session_history_pruned` 表达，**不进 gaps**。

平台侧要判断「这段是补不回来了（前缀已裁）」还是「中间有洞但两头都在」，全靠这个分层；
写不清楚就只能靠读实现。

## 证据（新增 e2e）

`test/e2e-ws-feed-gaps.test.ts`（真 WS + 真 `createSession` + 真 SQLite + 小预算 `maxSteps:2 / taskMaxBytes:3000`）：

1. `STEPS:5` → 快照里 `task_step` 只剩 2 条、`gaps` 非空且 `reason` 全为 `count`，
   且**最新终态 `task_status` 仍在**（保护行，结论不能被过程挤掉）。
2. 断线重连后再次 `get_task`：`gaps` 与 `oldestEventSeq/latestEventSeq` 与断线前**完全一致**
   —— 缺口是事实，不会因为换了条连接就被「治好」。
3. `BIGLOGS:6`（> 3 KB）→ `prunedThrough > 0`、`gaps` 为空；游标落在已删前缀
   （`afterEventSeq: 1`）→ `found:true` + `errorCode: session_history_pruned` + 同一 `prunedThrough`。

## What Changes

只改规格文本，不动代码：

1. 「会话快照、附件补取与历史分页」：`eventWindow` 字段名改成契约里的 `oldestEventSeq / latestEventSeq`，
   并明确窗口外还有 `prunedThrough` 表达前缀删除。
2. 「Web Agent 会话呈现 Feed」：缺口结构写成 `{ from, to, reason? }`，
   并把「分类淘汰 → 窗口内 gap（带 reason）」与「前缀删除 → prunedThrough，不进 gap」写成分层；
   补充「各会话最新终态 `task_status` SHALL NOT 被条数淘汰（保护行）」。
3. **修正 `task_log` 占不占 eventSeq 的自相矛盾**：旧文写「task_log 不占 eventSeq」，且快照
   「SHALL NOT 包含 raw task_log」；实现里 `task_log` 就是持久化事件（`onLog` → `appendEvent`），
   `task_snapshot.events` 与缺口计算用的都是同一集合。若按旧文把 logs 从快照里滤掉，
   缺口就会指向平台**永远取不到**的内容 —— 语义不自洽。故改为：`task_log` 占同一 eventSeq、
   随 `events` 返回，但文本不是稳定协议（平台不得依赖格式）。`task-execution` 同步改。
4. 新增 Scenario：分类淘汰给 reason、前缀删除不进 gaps、断线重连后 gaps 不变、缺口与快照集合一致。

**不做**：不改 `eventGaps()` 的窗口函数实现（O(n) 全表扫描在该表规模下可接受）；
不新增字段；不动 `PROTOCOL_VERSION`。
**未做（需单独决策）**：规格写的「单响应 1 MiB」上限在 `dispatchGetTask` 里**没有执行**，
`task_log` 进快照后这个缺口更值得补 —— 属行为变更，本提案不动。

## Impact

- 只动规格与文档 + 新增一个 e2e 文件。
- 正面：平台按规格能正确区分「补不回来」与「中间有洞」，不必读实现。
- 风险：无（行为不变）。

## 验收标尺

1. `npm run gate` + `npm run harness:validate` + `npm run openspec:validate` 全绿。
2. 新 e2e 3 例全绿，且第 1 例在关掉 `maxSteps` 预算后变红（证明断言真的依赖预算生效）。
