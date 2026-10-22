---
name: harness-gates
description: 本项目四道质量关卡：需求澄清（brainstorming）→ 计划落 tasks.md（writing-plans）→ 根因调试（systematic-debugging）→ 完成前取证（verification-before-completion），外加 npm run gate / harness:validate / e2e:smoke 三道硬门禁。何时用：任何非琐碎改动的开工前、遇到失败时、以及想说"做完了"之前。
---

# harness-gates（工作区入口）

本文件是**触发条件与产物落点**的速查，完整说明见 `.harness/skills/superpowers-workflow/SKILL.md`
（四个 superpowers 技能本体在用户级 `~/.workbuddy/skills/`，已在会话中可用）。

| 关卡 | 何时触发 | 产物 |
| --- | --- | --- |
| 一 澄清 | 需求有歧义 / 涉及协议或安全边界 | 回复里一页「我的理解 + 取舍 + 默认选择」 |
| 二 计划 | ≥3 个可独立验证的步骤 | `openspec/changes/<id>/tasks.md`（不另开 plan.md） |
| 三 根因 | 任何失败 / 异常 | 四阶段结论，根因未定不改代码 |
| 四 取证 | 即将宣称完成 | 门禁真实输出 + 端到端证据 |

## 三条硬门禁（必须实跑，不许口头通过）

```bash
npm run gate              # 契约边界 + 文档一致 + 类型 + 单测 + 构建（+ package.json 检查）
npm run harness:validate  # .harness 自身完整性
npm run e2e:smoke         # 协议/runner/适配器改动时必跑（先 npm run build）
```

## 已知红线（会被钩子直接拦）

改 `.harness/`、无提案改 `src/protocol.ts`、`npm publish`、`execSync`/新增 `shell:true`、
读凭据文件内容、明文 key/token、改 `openspec/changes/archive/`、绑定非回环地址。
