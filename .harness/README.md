# .harness — agent-bridge 驾驭工程（Harness Engineering）配置

> **第一红线：`.harness/` 下所有配置仅限人工维护，AI Agent 绝对禁止修改/删除**（`.harness/work/` 运行时目录除外）。见 `rules/always-on.md`。

## 这个仓库的护栏重点

护栏重点是**分包依赖边界 + DB 迁移**。agent-bridge 是单包 CLI，真实风险完全不同：

| 风险 | 对应护栏 |
| --- | --- |
| wire 契约被第三方平台依赖，改动是跨团队成本 | `rules/protocol-contract-rules.md` + `scripts/doc-contract-check.mjs` |
| 能 spawn 本机任意白名单 CLI（平台下发参数） | `rules/security-rules.md` + `scripts/protocol-boundary-check.mjs` |
| Windows `.cmd` 垫片/路径空格/where 多行（主要故障源） | `rules/windows-compat-rules.md` |
| 文档比代码"超前"（本项目已发生 3 次漂移） | `rules/doc-impl-sync-rules.md` + doc-contract-check |
| 凭据/device_token 泄露 | `pre-action-check.sh` + 边界检查的脱敏断言 |
| 未发布就宣称可安装 | `rules/release-rules.md` + package.json 门禁 |

## 目录结构（Agent 工具标准）

```
.harness/
├── README.md                     # 本文件
├── agents/                       # Agent 角色（一角色一目录，AGENT.md 带 frontmatter）
│   ├── owner-agent/AGENT.md
│   ├── coding-agent/AGENT.md
│   ├── test-agent/AGENT.md
│   └── reviewer-agent/
│       ├── AGENT.md
│       └── checklists/review-checklist.md
├── rules/                        # 规则（带 frontmatter，priority/applies_to/enforced_by）
│   ├── always-on.md              #   P0 红线（禁改 .harness / 协议唯一真源 / 凭据 / spawn）
│   ├── protocol-contract-rules.md
│   ├── security-rules.md
│   ├── windows-compat-rules.md
│   ├── doc-impl-sync-rules.md
│   ├── code-style.md
│   ├── release-rules.md
│   └── workflow-rules.md         #   superpowers 四道关卡 + OpenSpec + 人工卡点
├── skills/                       # 技能（一技能一目录，SKILL.md 带 frontmatter）
│   ├── openspec-workflow/        #   提案 → 实施勾选 → 归档（+ 校验脚本 + 格式参考）
│   ├── superpowers-workflow/     #   四道关卡：澄清/计划/根因调试/完成前验证
│   ├── protocol-e2e/             #   mock 平台 + 真实 bridge 端到端冒烟（带脚本）
│   ├── release-publish/          #   发布前置条件与发布后核对
│   └── README.md
├── contracts/policy.yaml         # 风险分级 / forbidden / 工具白名单 / 上限
├── hooks/                        # 硬护栏
│   ├── hooks.json                #   PreToolUse / PostToolUse / Stop 事件映射
│   ├── pre-action-check.sh       #   前置拦截（.harness / force push / 明文密钥 / shell 拼接 / 凭据读取）
│   ├── post-change-gate.sh       #   变更后门禁（契约边界 / 文档一致 / 类型 / 单测 / 构建 / 提案）
│   └── audit-logger.sh           #   全链路审计 → work/audit-*.jsonl
├── evals/                        # 护栏评测（positive 5 / negative 9，全部带 frontmatter）
├── scripts/
│   ├── protocol-boundary-check.mjs   # 架构与安全边界（类型唯一/无 shell 字符串/回环/脱敏/凭据/导入）
│   ├── doc-contract-check.mjs        # 文档-实现一致性（协议类型/示例报文/命令/未实现标注/配置路径）
│   ├── harness-validate.sh           # .harness 自检
│   └── rollback.sh                   # 回退（默认 dry-run，CONFIRM=1 执行）
└── work/                         # 运行时会话/审计/备份（gitignore，不入库）
```

## 结构约定

1. **Skill = 目录**：`<kebab-name>/SKILL.md` 必需，frontmatter `name` 与目录名一致；细节下沉 `references/`，可执行逻辑放 `scripts/`；
2. **Agent = 目录**：`AGENT.md` frontmatter 声明 `role / tools_allowed / tools_forbidden / escalates_to`；评审清单独立成 `checklists/`；
3. **Rule = 带 frontmatter 的文档**：`priority / applies_to / enforced_by` 让规则可被机器路由；
4. **Hook = 脚本 + 清单**：`hooks.json` 声明事件映射，`.workbuddy/settings.json` 是真正挂载点；脚本只做一件事，
   **exit 2 阻断**（WorkBuddy/CodeBuddy 语义：0 放行、2 阻断、其他非零码只是提示 —— 用 `exit 1` 等于没拦）；
5. **Eval = 带 frontmatter 的用例**：`kind / expected / enforced_by` 可批量回归护栏能力。

## 设计原则

1. **软硬结合**：rules 是提示词级软约束，hooks + 两个 check 脚本是硬门禁，缺一不可；
2. **护栏必须解决真实缺陷**：每条规则背后都有本项目踩过的坑（`run_task` 示例缺 `args`、unix 配置路径写错、
   文档宣称 `allowed_cwd` 可用），不是通用模板；
3. **两套流程只留一套留痕**：superpowers 的 `writing-plans` 产出直接落进 `openspec/changes/<id>/tasks.md`，不另开 plan.md；
4. **警告不装绿灯**：协议边界检查把「平台 env 直接并入子进程」「无并发上限」列为 ⚠️ 警告而不是通过 —— 已知缺陷要一直可见；
5. **贴合现状**：11 个适配器、4 KB 分片、15s 心跳、1s→30s 退避、0600 配置，全部来自真实代码。

## 快速命令

```bash
npm run gate               # 收尾门禁（= hooks/post-change-gate.sh）
npm run arch:check         # 架构/安全边界（protocol-boundary-check）
npm run doc:check          # 文档-实现一致性
npm run harness:validate   # .harness 自身完整性
npm run openspec:validate  # 活跃提案格式
npm run e2e:smoke          # 端到端冒烟（需先 npm run build）

bash .harness/hooks/pre-action-check.sh "<动作>"   # 前置拦截自测
bash .harness/scripts/rollback.sh --files <f>      # 回退（dry-run；CONFIRM=1 执行）
```

---

## 实施落地步骤（人工执行）

1. **接入宿主**：把三个脚本挂到宿主事件 —— **已挂载在 `.workbuddy/settings.json`**（PreToolUse → pre-action-check；
   PostToolUse(Write|Edit|MultiEdit) → 审计留痕；Stop → post-change-gate）。宿主只认 **exit 2** 为阻断，
   改动脚本时不要退回 `exit 1`。若桌面端不读项目级配置，把该文件的 `hooks` 段原样复制到 `~/.workbuddy/settings.json`；
2. **逐份评审**：由仓库 owner 评审 `.harness/`（重点：`policy.yaml` 的风险分级是否与真实高-risk 文件一致；
   `always-on.md` 的红线是否覆盖协议/凭据/spawn 三块）；
3. **护栏自测**：逐条跑 `evals/negative/`（每条都必须被拦），再跑 `evals/positive/`（每条都应放行且门禁全绿）；
4. **试运行**：拿一个真实小需求（推荐 `add-cwd-allowlist`）走完 `workflow-rules.md` 全流程，观察审计日志；
5. **接进 CI**：PR 必跑 `npm run gate && npm run harness:validate`；`e2e:smoke` 建议 nightly（会真实 spawn CLI）；
6. **持续运营**：新增适配器/协议字段 → 同批更新 rules 与 evals；每月跑一次 evals 回归。

## 验收检查清单

- [x] `AGENTS.md` 在仓库根，只做导航（规则全部下沉 `.harness/rules/`）
- [x] `skills/` 一技能一目录、SKILL.md frontmatter（name=目录名）；`agents/` 一角色一目录、AGENT.md frontmatter
- [x] `rules/` 8 份齐备且带 frontmatter；`always-on.md` 第一条为禁改 `.harness`，并含协议契约红线
- [x] `contracts/policy.yaml` 含 low/medium/high 三级 + forbidden + limits（迭代/工具调用/门禁重试）
- [x] `hooks/hooks.json` 可解析；三个脚本 `bash -n` 通过；pre-action 能拦 `.harness` 写、`rm -rf`、force push、
      明文密钥、套接字监听、凭据读取、无提案改 protocol.ts
- [x] 两个 check 脚本实跑通过（当前代码零违规；2 条已知缺陷以 ⚠️ 警告保留）
- [x] `harness-validate.sh` 全绿；`npm run gate` 全绿
- [x] evals：positive 5 / negative 9，全部带 frontmatter
- [x] `openspec/` 骨架齐备（AGENTS.md / project.md / specs 两份 / changes + archive）
- [x] `.gitignore` 含 `.harness/work/`；`.harness/` 其余目录全部入库
- [x] 根 `package.json` 提供 `gate` / `arch:check` / `doc:check` / `harness:validate` / `openspec:validate` / `e2e:smoke`

## 已追加到 .gitignore 的条目

```gitignore
# ---------- Harness 运行时目录（审计/备份，不入库） ----------
.harness/work/
```
