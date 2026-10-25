## ADDED Requirements

### Requirement: 任务幂等

bridge SHALL 按 `taskId` 去重：同一 `taskId` 的 `run_task` 重复到达时 SHALL NOT 重复 spawn。
任务未终态时 SHALL 回当前状态快照（`task_status`，含 `phase` / `queuePosition`）；
已终态时 SHALL 回放终态快照（含 `exitCode` / `errorCode`）。去重记录 SHALL 有界
（LRU，与 Emitter 的 `maxSettled` 同口径）。

#### Scenario: 网络重发不双跑

- **WHEN** 平台因断线重连重发同一 `taskId` 的 `run_task`，该任务仍在运行
- **THEN** bridge 回一条当前状态的 `task_status`（`running`），进程仍只有一个

#### Scenario: 终态重发放快照

- **WHEN** 平台重发一个已 `success` 的 `taskId`
- **THEN** bridge 立即回放 `{ status: 'success', exitCode: 0 }`，不产生任何子进程
