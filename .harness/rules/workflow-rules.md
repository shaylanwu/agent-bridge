---
name: workflow-rules
description: Agent 完整工作流（需求→归档）、superpowers 四道关卡、OpenSpec 提案、迭代上限与人工卡点。
priority: P1
applies_to: ['*']
enforced_by:
  - contracts/policy.yaml
  - hooks/post-change-gate.sh
  - skills/superpowers-workflow
version: 1.0.0
---

# workflow-rules.md — 工作流与人工卡点

## 主流水线

```
需求澄清 → OpenSpec 提案 → 实现计划 → 编码 → 单测 → 自检门禁 → 评审 → 联调验证 → 归档
             ↑superpowers        ↑superpowers              ↑superpowers     ↑superpowers
             brainstorming        writing-plans             systematic-      verification-
                                                                debugging      before-completion
```

## 关卡一：需求澄清（brainstorming）

**触发**：需求存在非平凡歧义（"做个对接"、"优化一下性能"、"支持多平台"这类），或改动涉及协议/安全边界。

**产出**（一页，不写代码）：我理解的需求 + 关键取舍 + 我的默认选择。给人确认，不列一堆选项让人挑。

**豁免**：< 15 分钟的琐碎改动（改文档、修错字、调一行日志），但要在回复里声明一句关键取舍。

## 提案：OpenSpec（能力级任务必经）

- 判定：新增/修改能力（协议消息、CLI 命令、适配器、授权流程）→ ✅ 必须提案；单点 bug 修复 → 可只写 `proposal.md` 一段 Why；文档错字 → 不需要。
- `openspec/changes/<change-id>/` 建 proposal.md + tasks.md + specs 增量 → `validate-change.sh` 通过 → **停下等人工评审**。
- 获批后按 tasks.md 实施，**完成一项立即勾 `- [x]`**；发现提案有误 → 回写 proposal.md 注明原因，禁止悄悄改。

## 关卡二：实现计划（writing-plans）

- 多步任务（≥3 个可独立验证的步骤）必须先把计划写成 `openspec/changes/<id>/tasks.md`，**不另开 plan.md**（本项目只保留一套留痕）。
- 每一步一个可验证动作：改哪个文件、跑什么命令、期望什么输出。
- ⛔ 禁止"边想边改"式施工；计划没落文件 = 没计划。

## 编码

- 遵守 `code-style.md`；每个可测单元随手写 Vitest 用例（TDD 鼓励）。
- 涉及协议字段 → 同批更新两份 README 的协议表（`doc-impl-sync-rules.md`）。

## 调试（systematic-debugging）

- 遇到失败/异常行为，⛔ 禁止直接猜修法；先走四阶段：现象复现 → 缩小范围 → 根因假设 → 最小验证。
- 根因未定位前不得改代码；连续 3 次修复失败 → 停止，报告根因假设并转人工。

## 验收（verification-before-completion）

- 宣称"完成/修好/通过"前必须：`bash .harness/hooks/post-change-gate.sh` 实跑 + 贴真实输出。
- 只完成一部分 → 如实写"完成 X/Y，差 Z"，⛔ 禁止用"基本完成"掩盖。
- 涉及协议/授权/任务执行 → 必须有端到端证据（mock 平台跑通一次，见 `skills/protocol-e2e`），不能只靠单测。

## 迭代上限与停止条件

| 项 | 上限 | 超限动作 |
| --- | --- | --- |
| 单任务迭代轮次 | 12 轮 | 强制转人工，输出已完成/未完成清单 |
| 单轮工具调用 | 200 次 | 同上 |
| 门禁连续失败 | 3 次 | 停止，报告根因假设 |
| 同一 bug 修复尝试 | 3 次 | 转 `systematic-debugging` 四阶段 |

## 人工卡点（Agent 不可代行）

1. `src/protocol.ts` 的破坏性变更评审；
2. npm publish / 打 tag / 改 CI；
3. 删除文件、force push、依赖移除；
4. `.harness/` 任何变更（仅人工）；
5. OpenSpec 能力级提案评审（获批后才可实施）；
6. 授权流程（PKCE / 设备码）与安全边界的任何放宽。
