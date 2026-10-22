---
name: superpowers-workflow
description: 四道关卡把任务压成可控流程：需求澄清（brainstorming）→ 实现计划（writing-plans）→ 根因调试（systematic-debugging）→ 完成前验证（verification-before-completion）。任何非琐碎任务开工前必读。
description_zh: 'superpowers 工作流接入：四道关卡 + 触发条件 + 证据要求'
version: 1.0.0
enforced_by:
  - rules/workflow-rules.md
  - hooks/post-change-gate.sh
  - agents/reviewer-agent/checklists/review-checklist.md
---

# skill: superpowers 工作流（四道关卡）

本仓库不引入新的技能运行时：四个 superpowers 技能已在用户级 `~/.workbuddy/skills/` 安装
（`brainstorming` / `writing-plans` / `systematic-debugging` / `verification-before-completion`）。
**这里定义的是「什么时候必须用哪个」，以及产物落在哪** —— 否则四份技能文档读起来都对，实际没人执行。

| 关卡 | 技能 | 触发 | 产物落点 |
| --- | --- | --- | --- |
| 一 | `brainstorming` | 需求有非平凡歧义 / 涉及协议或安全边界 | 回复里一页「我的理解 + 取舍 + 默认选择」 |
| 二 | `writing-plans` | ≥3 个可独立验证的步骤 | `openspec/changes/<id>/tasks.md`（**不另开 plan.md**） |
| 三 | `systematic-debugging` | 任何失败 / 异常 / 无法解释的现象 | 回复里四阶段结论，根因未定不得改代码 |
| 四 | `verification-before-completion` | 即将说「完成 / 修好 / 通过」 | 门禁实跑输出（贴证据），部分完成如实写 |

## 关卡一：需求澄清

- 产出要求：**我的理解**（一句话复述需求）、**关键取舍**（最多 2 条，各带我的默认选择）、**请你确认的点**（最多 1 个）。
- ⛔ 禁止把决策细节抛给用户挑选项（"你要 A 还是 B？"×5）；我按最适合的方案先定，再请确认。
- 豁免：< 15 分钟的琐碎改动（文档错字、日志文案、一行判断），但要在回复里声明一句关键取舍。
- 本项目典型歧义源：「对接第三方」= 谁对接谁（bridge 是客户端）、「支持多平台」= 多个平台地址还是多台设备。

## 关卡二：实现计划

- 计划必须能逐条验证：改哪个文件 → 跑什么命令 → 期望输出。
- **落点是 OpenSpec 的 tasks.md**，理由是留痕只有一套：plan.md 和 tasks.md 并存时，两边必然不同步。
- 纯 bug 修复（不建提案）时，计划写在回复里即可，但要带验证命令。

## 关卡三：根因调试

四阶段（不可跳步）：

1. **复现**：用最小命令复现，记录真实输出（不是"应该会报错"）；
2. **缩小范围**：二分定位到文件/函数/输入；
3. **假设**：写出「如果 X 成立，则 Y 现象成立」；
4. **最小验证**：只验证该假设，不顺手改别的。

⛔ 连续 3 次修复失败 → 停止，报告假设与已排除项，转人工。

## 关卡四：完成前验证

- 必须实跑：`bash .harness/hooks/post-change-gate.sh`（或 `npm run gate`），把输出贴进回复；
- 涉及协议 / 授权 / 任务执行 → 还要跑端到端（`skills/protocol-e2e`），单测通过不算完成；
- 部分完成必须写成「完成 X/Y，差 Z（原因）」，⛔ 禁止「基本完成 / 应该没问题」。

## 关卡与「自主连续性」的边界

- 关卡只拦**方向级 / 需求歧义 / 不可逆**的事；低风险可逆的执行细节连续做完再汇报，不要每步停下来问。
- 判据：能独立完成且可回退 → 继续做；需要人工审批（policy.yaml high）→ 停。
