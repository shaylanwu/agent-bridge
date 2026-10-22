# AGENTS.md — OpenSpec 使用指令（Agent 必读）

> 本文件是 AI Agent 使用 OpenSpec 的操作规范。配套硬护栏：`.harness/skills/openspec-workflow/`（校验脚本 + 格式参考）。

## 何时必须走 OpenSpec 流程

| 任务类型 | 是否需要提案 |
| --- | --- |
| 新增/修改能力（协议消息、CLI 命令、适配器、授权流程、执行语义） | ✅ 必须 |
| 多文件重构 / 引入新依赖 / 影响第三方平台对接面 | ✅ 必须 |
| 纯 bug 修复（单点、不改行为契约） | 可简化：proposal.md 一段 Why |
| 文档错字、注释、格式化 | ❌ 不需要 |

## 三阶段工作流

### 阶段 1：创建提案（Proposal）

1. 读 `openspec/project.md` + 相关 `openspec/specs/<capability>/spec.md` 现状；
2. 建 `openspec/changes/<change-id>/`（change-id：kebab-case 动词开头，如 `add-cwd-allowlist`）：
   - `proposal.md`：`## Why` + `## What Changes` + `## Impact`；
   - `tasks.md`：编号勾选清单（`1.1` / `1.2`…），**这是执行留痕的主线索**；
   - `design.md`（可选）：非平凡技术决策与备选方案；
   - `specs/<capability>/spec.md`：规格增量，只用三种操作头：`## ADDED / MODIFIED / REMOVED Requirements`；
3. 运行校验：`bash .harness/skills/openspec-workflow/scripts/validate-change.sh <change-id>` 必须通过；
4. **停下等人工评审提案**（`src/protocol.ts` / `runner.ts` / `auth.ts` / 发布相关 = 高风险），获批后才可实施。

### 阶段 2：实施（Apply）

1. 严格按 `tasks.md` 顺序执行，**每完成一项立即把 `- [ ]` 改为 `- [x]`**（有迹可循的核心）；
2. 遵守 `.harness/rules/`（协议契约 / 安全 / Windows 兼容 / 文档同步 / 代码风格）；
3. 每轮变更后跑 `npm run gate`；协议字段变化同步两份 README 协议表；
4. 偏差处理：实施中发现提案有误 → 回更新 proposal.md 并注明原因（不允许"悄悄改"）。

### 阶段 3：归档（Archive）

任务完成（tasks 全勾 + 门禁全绿 + 评审通过）后：

1. 把规格增量合并进 `openspec/specs/<capability>/spec.md`（ADDED/MODIFIED 直接更新对应 Requirement）；
2. 将 `openspec/changes/<change-id>/` 整体移入 `openspec/changes/archive/YYYY-MM-DD-<change-id>/`；
3. 确认 `openspec/specs/` 与代码实际行为一致（specs 是"系统现在是什么样"的唯一真源）。

## 规格文件格式（Requirement / Scenario）

```markdown
## Purpose

<该能力存在的原因，1-3 句>

## Requirements

### Requirement: 需求名称

系统 SHALL <可验证的规范化描述>。

#### Scenario: 场景名称

- **WHEN** <触发条件>
- **THEN** <预期行为>
```

硬性要求：每个 Requirement 至少 1 个 Scenario；`SHALL` 用规范动词；MODIFIED 必须给出完整新版 Requirement 全文（不是 diff 片段）。

## 红线

- ⛔ 禁止绕过提案直接实施能力级变更（reviewer-agent 按 checklist 驳回）；
- ⛔ 禁止归档时丢失增量（specs 未合并不得移目录）；
- ⛔ `openspec/changes/archive/` 只增不改；
- ⛔ 禁止 specs 与代码长期漂移：能力行为变更必须伴随 spec delta。

## 本项目的能力划分（specs/）

| capability | 覆盖 |
| --- | --- |
| `bridge-protocol` | wire 契约：消息类型、字段、鉴权、心跳、吊销、日志分片 |
| `local-tool-scan` | 本机 11 个 AI 编码 CLI 的探测口径（三态 + broken） |
| `task-execution` | 任务生命周期：白名单、cwd、超时、取消、并发（尚未建，首次改动时创建） |
