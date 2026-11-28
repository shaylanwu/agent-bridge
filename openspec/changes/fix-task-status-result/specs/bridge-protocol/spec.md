# bridge-protocol 规格增量：终态最终回答上报

## ADDED Requirements

### Requirement: 终态最终回答随 task_status 上报

终态 `task_status` SHALL 携带最终回答文本（`result`），其内容 SHALL 与该任务同时上行的
canonical `task_message`（`state:"complete"`）一致；SHALL NOT 超过 16KB —— 超出时 SHALL 截断
并在末尾补 `…`。非终态 `task_status` SHALL NOT 携带 `result`（半截回答属于事件流，不是结论）。

理由：协议字段表把 `result` 描述为「终态最终回答文本（≤16KB）」，但实现只发 `task_message`，
于是按文档读 `task_status.result` 的客户端永远读到空值，表现为「任务成功却没有结果」。
同时该文本 SHALL 写入持久化的 `task_status` 事件载荷，使历史快照重放与实时帧同口径。

#### Scenario: 终态帧可直接读到最终回答

- **WHEN** 某任务以 `success` 终态结束且有最终回答
- **THEN** 该 `task_status` 帧带 `result`，内容与 `task_message`（`state:"complete"`）一致

#### Scenario: 最终回答超长

- **WHEN** 最终回答超过 16KB
- **THEN** `task_status.result` 截断到 16KB 并补 `…`，`task_message` 仍保留完整文本

#### Scenario: 无最终回答的终态

- **WHEN** 任务失败、取消或超时，且没有产出任何回答文本
- **THEN** `task_status` 不带 `result` 字段（而不是空字符串）
