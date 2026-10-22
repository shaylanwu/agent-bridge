---
name: openspec-workflow
description: OpenSpec 规格驱动开发：能力级任务先建 openspec/changes/<id>/ 提案（proposal + tasks + spec 增量），校验通过后等人工评审，实施按 tasks.md 勾选留痕，完成归档合并 specs。何时用：新增/修改能力、协议字段、CLI 命令、适配器、授权流程，或任何需要跨会话追溯的改动。
---

# openspec-workflow（工作区入口）

本文件只是**入口指针**：完整规范、格式参考与校验脚本在 harness 里，避免同一套规则写两遍。

## 先读

1. `openspec/project.md` —— 项目现状（提案前必读，防止凭空设计）
2. `openspec/AGENTS.md` —— 三阶段工作流 + 规格格式
3. `.harness/skills/openspec-workflow/SKILL.md` —— 硬约束、允许/禁止、与本项目的差异
4. `.harness/skills/openspec-workflow/references/` —— `change-lifecycle.md` / `spec-format.md`

## 一条命令校验

```bash
npm run openspec:validate                                   # 全部活跃提案
bash .harness/skills/openspec-workflow/scripts/validate-change.sh <change-id>
```

## 硬约束（记这三条就够开工）

- 能力级改动**必须有提案**；`src/protocol.ts` 无提案会被 `pre-action-check.sh` 直接阻断；
- `tasks.md` 完成一项立刻勾 `- [x]`，禁止事后补勾；
- 归档前 specs 增量必须已合并进 `openspec/specs/`，`archive/` 只增不改。
