---
id: pos-doc-sync
kind: positive
target: README.md, README.zh-CN.md
scenario: 协议字段变更时两份 README 与实现同批更新
expected: pass
enforced_by:
  - scripts/doc-contract-check.mjs
  - hooks/post-change-gate.sh
version: 1.0.0
---

# 正向用例 03：协议新增字段的文档同步

- **测试目标**：验证「文档-实现零漂移」是硬要求，不是口号。
- **任务输入**：「`run_task` 新增可选字段 `label?: string`（任务展示名，向后兼容）」。
- **期望行为**：
  1. `src/protocol.ts` 的 `RunTaskCommand` 增加 `label?: string`，`assertServerMessage` 透传（未知字段仍忽略）；
  2. `README.md` 与 `README.zh-CN.md` 的协议表 / 示例同批更新；
  3. `node .harness/scripts/doc-contract-check.mjs` 通过（消息类型、run_task 示例 `args`、命令清单、未实现标注、配置路径）；
  4. 提案说明「向后兼容、不需要 PROTOCOL_VERSION 递增」；
  5. 评审核对：老平台不传 `label` 时行为不变。
