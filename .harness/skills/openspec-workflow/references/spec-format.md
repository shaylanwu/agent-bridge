# 规格与提案格式参考

## 提案目录结构

```
openspec/changes/<change-id>/
├── proposal.md                    # 必需
├── tasks.md                       # 必需
├── design.md                      # 可选（非平凡决策：备选方案对比）
└── specs/<capability>/spec.md     # 能力变更时必需（增量）
```

## proposal.md

```markdown
## Why

<当前问题 / 动机。写给不了解上下文的人看：现象 + 影响 + 为什么现在要改。>

## What Changes

- <变更项 1：改哪个模块、什么行为变了>
- <变更项 2>

## Impact

- 协议：<无 / 新增字段 X（向后兼容）/ 破坏性变更（需 PROTOCOL_VERSION+1）>
- CLI：<无 / 新增命令或参数>
- 适配器：<无 / 新增 kind>
- 文档：<README.md / README.zh-CN.md / CHANGELOG.md 需同步的段落>
- 风险级别：<low / medium / high（见 contracts/policy.yaml）>
```

## tasks.md

```markdown
## 1. 实现

- [ ] 1.1 `src/config.ts` 增加 allowedCwd 读取与默认值
- [ ] 1.2 `src/runner.ts` 接入 allowedCwd 校验（已有实现，接线即可）
- [ ] 1.3 `test/bridge.test.ts` 补 3 条用例（在范围内 / 越界 / 未配置）

## 2. 文档与验证

- [ ] 2.1 两份 README 同步「allowed_cwd」说明
- [ ] 2.2 `npm run gate` 全绿（贴输出）
- [ ] 2.3 提案送评审（人工）

## 3. 归档

- [ ] 3.1 specs 增量合并进 `openspec/specs/task-execution/spec.md`
- [ ] 3.2 移入 `openspec/changes/archive/YYYY-MM-DD-<change-id>/`
```

## specs 增量

只用三种操作头：

```markdown
## ADDED Requirements

### Requirement: 工作目录白名单

bridge SHALL 拒绝执行 `cwd` 不在 `allowed_cwd` 配置范围内的任务，并返回 `failed` 状态与原因。

#### Scenario: 越界目录

- **WHEN** 平台下发 `cwd` 为白名单外的目录
- **THEN** bridge 不 spawn 任何进程，回传 `task_status: failed`，`error` 说明"工作目录不在允许范围内"
```

- `## MODIFIED Requirements`：必须给出**完整的新版 Requirement 全文**（不是 diff 片段）；
- 每个 Requirement 至少 1 个 `#### Scenario:`，用 WHEN/THEN；
- 用 `SHALL` 表达规范行为；避免"尽量"、"适当"这类不可验证的措辞。

## 合并进正式规格

归档时把增量合进 `openspec/specs/<capability>/spec.md`：

```markdown
# <capability> 规格

## Purpose

<该能力存在的原因，1-3 句>

## Requirements

### Requirement: ...

...
```

`openspec/specs/` 是**系统现状的唯一真源**：代码行为变了而 specs 没变 = 漂移，评审驳回。
