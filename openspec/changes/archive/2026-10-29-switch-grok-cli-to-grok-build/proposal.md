# 变更提案：grok 适配器改用官方 Grok Build

## Why

`grok-cli` 这条适配器当年是照社区版 Grok CLI 写的，本机与目标用户机上实际装的是**官方 Grok Build**
（`grok --version` → `1.0.70`，`--help` 首行 `Grok Build TUI`）。两者命令行高度兼容，于是留下两处**真实的错误行为**：

1. **凭据探测指向不存在的文件**：`~/.grok/user-settings.json` 是社区版路径，Grok Build 从不创建它
   ⇒ 即使已配好 `~/.grok/config.toml` 或已 OAuth 登录（`~/.grok/auth.json`），`agent_list` 仍报
   `installed_no_cred`，平台侧表现为「装了但这个工具缺凭据」，用户无从下手。
2. **ACP 认证方式写死成浏览器登录**：`authMethod: 'grok.com'` 会让每次任务都尝试 `authenticate('grok.com')`（5s 超时后吞掉）。
   实测 `grok agent stdio` 的 `session/new` **不需要 authenticate 就能建会话**，这个调用纯属噪音，
   在无浏览器的机器上还可能弹窗。

顺带一个能力缺口：Grok Build 支持 `-r/--resume` 与 `-s/--session-id`（实测可用），
但适配器没有声明 `resumeArgs`，多轮会话只能走「重放 transcript」——而更省的做法是原生续接。

## What Changes

- `src/adapters/agent-adapters.ts` 的 grok 条目：
  - `display` 改为 **Grok Build**（`kind` 保持 `grok-cli` 不变 —— 它是平台 `agentType` 的精确匹配值，
    改名属跨团队契约变更，本次不做）；
  - `credential.files` 改为 `~/.grok/auth.json`、`~/.grok/config.toml`（按「先强证据后弱证据」排序）；
  - 删除 `acp.authMethod: 'grok.com'`，保留 `authEnvMethods: { XAI_API_KEY: 'xai.api_key' }`；
  - 新增 `resumeArgs`（`--resume {{sessionId}}`）⇒ `executionModes.headless.continuation` 由
    `replay-session` 升为 `resume-session`（只增不减）。
- 测试：`test/acp-diagnostics.test.ts` 里「grok 的 authMethod 是 grok.com」的断言改为「不再写死认证方式」；
  新增 grok 的 `resumeArgs` 与凭据路径断言。
- 文档：两份 README 的工具名（Grok CLI → Grok Build）与能力矩阵行（续会话列）、站点 `AgentWall` 的展示名。

## Impact

- **不改协议**：`kind` 不变，wire 字段、消息、错误码、capabilities 全部不动，平台侧零改动。
- **不改权限语义**：`fullArgs` 仍是 `--always-approve`（实测等价 `--permission-mode bypassPermissions`）。
- 唯一平台可见变化：`agent_list[].display` 变成 `Grok Build`，`executionModes[headless].continuation`
  从 `replay-session` 变成 `resume-session`（能力增强，README 能力矩阵同批更新）。
- 单测与 `doc:check` / `arch:check` / `contracts:check` 不受影响；`e2e:smoke --agent grok-cli` 为端到端证据。
