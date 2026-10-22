# 变更生命周期（proposal → apply → archive）

## 阶段 1：提案

```bash
mkdir -p openspec/changes/add-cwd-allowlist/specs/task-execution
$EDITOR openspec/changes/add-cwd-allowlist/proposal.md
$EDITOR openspec/changes/add-cwd-allowlist/tasks.md
$EDITOR openspec/changes/add-cwd-allowlist/specs/task-execution/spec.md
bash .harness/skills/openspec-workflow/scripts/validate-change.sh add-cwd-allowlist
```

- `change-id`：kebab-case、动词开头（`add-` / `fix-` / `refactor-` / `remove-`）；
- `proposal.md` 三章节必须存在：`## Why`（问题与动机）、`## What Changes`（变更清单）、`## Impact`（影响面 + 是否破坏协议）；
- 提案通过校验后**停下等人工评审**，未获批不得写业务代码。

## 阶段 2：实施

- 顺序执行 tasks.md；**每完成一项立刻** `- [ ]` → `- [x]`（这是执行留痕的主线索，事后补勾等于造假）；
- 每轮变更后跑 `npm run gate`（协议边界 + 文档一致性 + 类型 + 单测 + 构建）；
- 偏差处理：实施中发现提案有误 → 回写 proposal.md 并注明「为什么改」，禁止悄悄偏离；
- 高风险项（protocol.ts / runner.ts / auth.ts / 发布）在动手前单独请求人工确认。

## 阶段 3：归档

前置条件（缺一不可）：

1. tasks.md 全部勾选；
2. `npm run gate` 全绿；
3. 评审通过（reviewer checklist 走完）；
4. specs 增量已合并进 `openspec/specs/<capability>/spec.md`（合并后 specs 描述的是**系统现在是什么样**）。

```bash
git mv openspec/changes/<change-id> openspec/changes/archive/$(date +%F)-<change-id>
bash .harness/skills/openspec-workflow/scripts/validate-change.sh   # 归档后应无活跃提案
```

归档目录只增不改：`post-change-gate.sh` 会检出 `archive/` 下的 M/D 状态并判失败。

## 反模式（评审时直接驳回）

| 反模式 | 为什么不行 |
| --- | --- |
| 先写完代码再补一份"提案" | 提案失去决策价值，等于事后记账 |
| tasks.md 一次全勾 | 无法判断哪一步做过、哪一步跳过 |
| specs 不合并就归档 | 归档后 specs 与代码永久漂移，下一个 Agent 会照着错的规格干活 |
| 提案里写"顺便改一下 X" | 范围蔓延：X 应单独提案，否则评审无法评估影响 |
