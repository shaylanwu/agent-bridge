# bridge-protocol 规格增量：终态后仍可发的读回包

## MODIFIED Requirements

### Requirement: 终态幂等重放与终态后交互结果

所有同步拒绝与正常终态 SHALL 保留可重放快照。Emitter SHALL 允许同一 taskId 的完全相同终态 task_status 重放，
并 SHALL 拒绝不同终态及终态后的日志、步骤、running 和新 interaction_request。
已存在 request 的 task_interaction_result SHALL 即使在任务终态后也允许按 requestId+resultSeq 回传，
响应路由 SHALL 使用 broker 历史而不是 activeTasks，且不得再次交付 adapter。

**读回包 SHALL 与「事件」区别对待**：`task_snapshot`（get_task）与 `artifact_content`（get_artifact）
回答的是客户端请求、不产生新事件，因此 SHALL 在任务终态后仍然可发；把它们一起丢弃会让
「任务跑完再取产物」这一最常见路径永久无响应（平台只能等到超时）。该豁免 SHALL 只覆盖
回答请求的帧类型，SHALL NOT 被扩大为「终态后什么都发」。

生产模式 SHALL 以 SQLite idempotency/tombstone 为权威，taskId 永不复用；retention 删除内容后同 ID 再提交
SHALL 回 session_deleted 且永不 spawn。SQLite 是唯一权威，不使用 MAX_TRACKED 内存淘汰。历史裁剪导致 replay
不完整 SHALL 回 session_history_pruned。

#### Scenario: 终态后取产物

- **WHEN** 某任务已进入 success / failed / cancelled / timeout 终态，平台随后发 `get_artifact`
- **THEN** bridge SHALL 回 `artifact_content`（`found:true` 带元数据与可读内容，或
  `found:false` 带 `artifact_not_found` / `not_readable`），不因终态而静默丢弃

#### Scenario: 终态后取快照

- **WHEN** 任务终态后平台发 `get_task`
- **THEN** bridge SHALL 回 `task_snapshot`

#### Scenario: 同步拒绝后改参重发

- **WHEN** 首次任务因权限或交互策略被拒绝，平台以同 taskId 修改权限、args 或 allowInteractive 重发
- **THEN** 平台收到首次 failed 的相同终态回放，bridge 不重新校验、不 spawn

#### Scenario: 不同终态冲突

- **WHEN** 某 taskId 已终态后又出现不同内容的终态或新的 log/step/running
- **THEN** Emitter 丢弃这些冲突消息，不因新的 CloudEvents seq/id 而放行
