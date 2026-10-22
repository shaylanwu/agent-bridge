---
name: openspec-workflow
description: OpenSpec 规格驱动开发流程：变更提案 → 实施勾选留痕 → 归档合并规格。Agent 接到任何能力级任务前必读。
description_zh: 'OpenSpec 任务流程管控（提案/实施/归档）'
version: 1.0.0
enforced_by:
  - scripts/validate-change.sh
  - hooks/post-change-gate.sh
  - hooks/pre-action-check.sh
---

# skill: OpenSpec 任务流程管控

**目标：让每个任务的执行流程有迹可循** —— 需求先成提案、实施按清单勾选留痕、完成即归档并让规格始终反映真实能力。

## 何时必须走此流程

| 任务类型 | 是否需要提案 |
| --- | --- |
| 新增/修改能力（协议消息、CLI 命令、适配器、授权流程、任务执行语义） | ✅ 必须 |
| 多文件重构 / 引入新依赖 / 影响平台对接面 | ✅ 必须 |
| 单点 bug 修复（不改行为契约） | 可简化：proposal.md 一段 Why |
| 文档错字、注释、格式化 | ❌ 不需要 |

## 三阶段（详见 references/change-lifecycle.md）

1. **创建提案**：`openspec/changes/<change-id>/`（proposal.md + tasks.md + 可选 design.md + specs 增量）
   → `bash .harness/skills/openspec-workflow/scripts/validate-change.sh <change-id>` 通过 → **停下等人工评审**；
2. **实施**：严格按 `tasks.md` 执行，**完成一项立即勾 `- [x]`**；发现提案有误 → 回写 proposal.md 注明原因，禁止悄悄改；
3. **归档**：tasks 全勾 + `npm run gate` 全绿 + 评审通过 → 增量合并进 `openspec/specs/<capability>/spec.md`
   → 移入 `changes/archive/YYYY-MM-DD-<change-id>/`。

## 本项目的提案要点（与 e2e-pilot 的差异）

- 本仓库**单包、无 DB、无前端**：提案的 `## Impact` 只需写「协议 / CLI / 适配器 / 文档」四类影响面；
- 涉及 `src/protocol.ts` → 提案是**强制前置**（`pre-action-check.sh` 会直接阻断没有提案的 protocol.ts 改动）；
- 涉及适配器表新增条目 → 提案必须写明该 CLI 的 `taskArgs` 模板与凭据判据（面向平台可见能力）；
- 规格目录建议：`bridge-protocol`（wire 契约）、`local-tool-scan`（探测口径）、`task-execution`（spawn/超时/取消）。

## 允许

- 在 `openspec/changes/` 下创建/更新活跃提案（中风险：输出方案 + 审计日志）；
- 随时跑 `validate-change.sh` 自检格式（低风险，鼓励常跑）；
- 归档操作（中风险：须评审通过且增量已合并）。

## 禁止

- ⛔ 绕过提案直接实施能力级变更（reviewer-agent 按 checklist 驳回）；
- ⛔ 直接改 `openspec/specs/` 而不走提案（specs 只能在归档时合并更新）；
- ⛔ 修改 `openspec/changes/archive/` 下任何已归档内容（只增不改）；
- ⛔ 提案格式未过校验就送评审；归档时丢失增量（specs 未合并不得移目录）。

## 红线冲突说明

本 skill 与 `../../rules/always-on.md` 同级生效；高风险判定（protocol.ts / runner / auth / 发布）以
`../../contracts/policy.yaml` 为准，**提案获批不豁免实施阶段的高风险操作审批**。
