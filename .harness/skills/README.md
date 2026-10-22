# .harness/skills — 技能目录（Agent Skill 标准结构）

每个技能一个目录，目录名 kebab-case，核心是 `SKILL.md`（YAML frontmatter 的 `name`/`description` 是 Agent 自动匹配技能的依据）：

```
skills/<skill-name>/
├── SKILL.md          # 必需：frontmatter + 何时用 / 允许 / 禁止
├── scripts/          # 可选：技能自带可执行脚本
└── references/       # 可选：详细资料（避免 SKILL.md 膨胀）
```

## 技能索引

| 技能 | 覆盖能力 | 自带脚本/资料 |
| --- | --- | --- |
| [openspec-workflow](./openspec-workflow/SKILL.md) | 任务流程：提案 → 实施勾选 → 归档 | [validate-change.sh](./openspec-workflow/scripts/validate-change.sh)、[change-lifecycle.md](./openspec-workflow/references/change-lifecycle.md)、[spec-format.md](./openspec-workflow/references/spec-format.md) |
| [superpowers-workflow](./superpowers-workflow/SKILL.md) | 四道关卡：澄清 / 计划 / 根因调试 / 完成前验证 | [gates.md](./superpowers-workflow/references/gates.md) |
| [protocol-e2e](./protocol-e2e/SKILL.md) | bridge↔平台 端到端冒烟 | [e2e-smoke.mjs](./protocol-e2e/scripts/e2e-smoke.mjs) |
| [release-publish](./release-publish/SKILL.md) | npm 发布前置条件与发布后核对 | — |

## 为什么 OpenSpec 与 superpowers 都在这里

两套流程解决的是不同问题，缺一个就会出现"流程看起来齐全但没人执行"：

- **superpowers 管"怎么想"**：需求先澄清、计划先落文件、调试先找根因、完成先拿证据（横切所有任务）；
- **OpenSpec 管"留下什么"**：提案、勾选清单、规格增量、归档（纵向贯穿一个能力变更）；
- 交汇点只有一个：**writing-plans 的产出直接写进 `openspec/changes/<id>/tasks.md`**，不另开 plan.md ——
  两套留痕并存必然不同步。

四个 superpowers 技能本体在用户级 `~/.workbuddy/skills/`（`brainstorming` / `writing-plans` /
`systematic-debugging` / `verification-before-completion`），本仓库只定义**触发条件与产物落点**，不复制技能文档。

## 通用规则

- 工具白名单与风险分级见 `../contracts/policy.yaml`；
- 每次工具调用经 `../hooks/pre-action-check.sh` 拦截，变更后经 `../hooks/post-change-gate.sh` 门禁（映射见 `../hooks/hooks.json`）；
- 全链路动作写审计日志（`../hooks/audit-logger.sh` → `../work/audit-*.jsonl`）；
- **新增技能**：建 `skills/<kebab-name>/SKILL.md`（frontmatter name 必须与目录名一致）→ 更新本索引 → 人工评审入库。
