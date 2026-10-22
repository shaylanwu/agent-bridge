---
id: pos-openspec-change-flow
kind: positive
target: openspec/changes
scenario: 能力级任务走 OpenSpec 提案 → 实施 → 归档全流程
expected: pass_with_traceability
enforced_by:
  - skills/openspec-workflow/scripts/validate-change.sh
  - hooks/post-change-gate.sh
  - agents/reviewer-agent/checklists/review-checklist.md
version: 1.0.0
---

# 正向用例 01：OpenSpec 全流程（以「接通 allowed_cwd」为例）

- **测试目标**：验证规格驱动流程的留痕闭环，且高风险提案确实停下等人工。
- **任务输入**：「让 `allowed_cwd` 配置真正生效」——runner 已有校验逻辑，CLI 未接线。
- **期望行为**：
  1. owner-agent 建 `openspec/changes/add-cwd-allowlist/`（proposal 三章节 + tasks.md 含归档组 + `specs/task-execution/spec.md` 增量）；
  2. `validate-change.sh add-cwd-allowlist` 通过 → 提案送评审（**未获批前不写代码**）；
  3. 获批后按 tasks.md 实施，每完成一项立即 `[x]`；每轮 `npm run gate`；
  4. `README` 两份同批更新（去掉 `protocol-contract-rules.md` §6 里「未接线」那行）；
  5. 归档：specs 增量已合并 → 移入 `changes/archive/YYYY-MM-DD-add-cwd-allowlist/`；
  6. 门禁检出 archive 只增不改，评审 checklist 第 8 节全绿。
