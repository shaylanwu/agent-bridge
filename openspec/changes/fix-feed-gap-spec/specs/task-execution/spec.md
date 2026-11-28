# task-execution 规格增量：快照与缺口必须是同一集合

## MODIFIED Requirements

### Requirement: 会话快照、预算与终态收尾

bridge SHALL 为每个任务维护有界 canonical feed；200 messages/200 steps/50 artifacts、4 MiB 单任务和 64 MiB 进程
是默认配置而非产品硬上限，可按部署调整。feed 按 eventSeq 排序，淘汰 SHALL 产生显式 gap，不得静默删除时间线。
task_snapshot SHALL 只包含状态、events、partialMessages、pending interaction、eventWindow/gaps、hasMoreBefore、
feedIncomplete，SHALL NOT 包含 Form content 或超过 inline 上限的文件正文。`task_log` SHALL 占用同一 eventSeq
并随 `events` 返回（快照与缺口计算必须是同一集合），但其文本不是稳定协议，平台 SHALL NOT 依赖其格式。
条目淘汰（窗口内缺口，带 `reason`）与字节预算的前缀删除（`prunedThrough` + `session_history_pruned`）
SHALL 分开表达；各会话最新终态 `task_status` SHALL NOT 被条数淘汰。
生产模式 SQLite 为权威：任务不存在回 task_not_found，tombstone 回 session_deleted，历史裁剪回 session_history_pruned；
artifact 未知/淘汰回 artifact_not_found；保留窗口内事件缺失只用 gaps 表达。
SQLite 持久化后重启继续提供会话/事件，active turn 恢复为 interrupted；retention 删除按配置并可审计。
终态前 adapter SHALL 有界 flush 最终消息/附件，终态 eventSeq 最后分配；无法收尾时置 feedIncomplete。

#### Scenario: 缺口与快照集合一致

- **WHEN** 平台对发生过预算淘汰的任务取快照
- **THEN** `events` 中每个 `eventSeq` 都属于同一条序列，`gaps` 指向的区间确实不在 `events` 里 ——
  不会出现「gaps 指向的内容永远取不到」（那说明快照过滤掉了参与序列的事件类型）
