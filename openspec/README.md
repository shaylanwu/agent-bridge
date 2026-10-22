# openspec/ — 规格驱动开发目录

本目录是 **agent-bridge 的"系统现在是什么样"的唯一真源**，也是能力级任务的留痕入口。

```
openspec/
├── AGENTS.md              # Agent 操作规范（三阶段工作流 + 格式）
├── project.md             # 项目上下文（提案前必读）
├── specs/                 # 正式规格（已实现能力的现状）
│   ├── bridge-protocol/spec.md
│   └── local-tool-scan/spec.md
└── changes/               # 变更提案
    ├── README.md
    ├── archive/           # 已归档（只增不改）
    └── <change-id>/       # 活跃提案
```

## 为什么这个仓库需要它

agent-bridge 的"需求"大多来自平台侧（第三方），而平台侧只能读文档。**规格 = 对第三方的承诺**：
改了行为却没改 specs，下一个接手的人（或 Agent）就会照着错的规格实现。

## 快速使用

```bash
# 1. 建提案
mkdir -p openspec/changes/add-cwd-allowlist/specs/task-execution
$EDITOR openspec/changes/add-cwd-allowlist/{proposal.md,tasks.md}

# 2. 校验格式（硬护栏）
npm run openspec:validate

# 3. 实施后跑门禁
npm run gate

# 4. 归档（评审通过、specs 已合并之后）
git mv openspec/changes/add-cwd-allowlist openspec/changes/archive/$(date +%F)-add-cwd-allowlist
```

工作流细节见 `AGENTS.md`；强制门禁见 `.harness/skills/openspec-workflow/SKILL.md`。
