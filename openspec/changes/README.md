# changes/ — 变更提案

活跃提案放 `<change-id>/`（kebab-case 动词开头），完成后归档到 `archive/YYYY-MM-DD-<change-id>/`。

## 提案内文件

| 文件 | 必需 | 内容 |
| --- | --- | --- |
| `proposal.md` | ✅ | `## Why` / `## What Changes` / `## Impact` |
| `tasks.md` | ✅ | 编号勾选清单（实施留痕主线索，完成一项勾一项） |
| `design.md` | 可选 | 非平凡变更的技术决策与备选方案 |
| `specs/<capability>/spec.md` | 能力变更时 ✅ | 规格增量（`## ADDED/MODIFIED/REMOVED Requirements`） |

## 流程与格式

见 `../AGENTS.md`（三阶段工作流）与 `.harness/skills/openspec-workflow/references/`。

## 校验

```bash
npm run openspec:validate                     # 全部活跃提案
bash .harness/skills/openspec-workflow/scripts/validate-change.sh <change-id>
```

## 归档纪律

`archive/` 只增不改 —— 归档目录是历史留痕，任何人不允许修改已归档提案的内容
（`pre-action-check.sh` 与 `post-change-gate.sh` 双重拦截）。

## 已有提案

| change-id | 状态 | 说明 |
| --- | --- | --- |
| （暂无） | — | 首个提案建议：`add-cwd-allowlist`（接通 `allowed_cwd`）或 `fix-token-mode-device-id` |
