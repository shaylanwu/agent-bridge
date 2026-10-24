# AGENTS.md — agent-bridge Agent 工程总入口

> 本文件只做导航与顶层约束，详细规则全部下沉 `.harness/rules/`。**任何 AI Agent 在本仓库工作前必须读完本文件与 `.harness/rules/always-on.md`。**

## 项目概述

`agent-bridge-service`：把本机已安装的 AI 编码 CLI（12 个）通过一条**出站 WebSocket** 接给远程编排平台。
不需要入站端口、不需要反向穿透，API Key 始终留在本机。

**重要认知：本仓库只有系统的一半。** 平台侧是第三方实现，按两份 README 的协议表与
`openspec/specs/bridge-protocol/spec.md` 对接 —— 任何契约改动都是跨团队成本。

## 技术栈（真实识别）

- TypeScript（`strict` + `noUncheckedIndexedAccess`）+ Node ≥ 20；ESM（NodeNext，相对导入带 `.js`）
- 构建 `tsc`（无打包器）；测试 Vitest；**无 lint/format 工具链**（靠 `code-style.md` 约束）
- 运行时依赖只有 `ws` + `smol-toml`（刻意极简，新增依赖需提案）

## 模块地图与风险级别

| 模块 | 职责 | 风险 |
| --- | --- | --- |
| `src/protocol.ts` | wire 类型 + 运行期校验 + 4KB 分片 | **high**（第三方契约） |
| `src/core/task-supervisor.ts` | 任务生命周期：白名单、spawn、超时、取消（`src/runner.ts` 是其 v1 兼容包装） | **high**（spawn 安全） |
| `src/infra/auth.ts` | PKCE 回环授权 + 设备码 | **high**（凭据） |
| `src/transport/bridge-client.ts` | WS 传输：鉴权、心跳、退避 | medium |
| `src/app/`（session / task-dispatch / service-gate） | 用例编排：会话、指令路由、服务身份校验 | medium |
| `src/cli.ts` → `src/cli/` → `src/commands/` | 入口（只做分发）/ CLI 支撑件 / 命令实现 | medium |
| `src/infra/config.ts` / `src/core/scan.ts` / `src/adapters/agent-adapters.ts` / `src/adapters/win-exec.ts` | 见 `openspec/project.md` | medium |

依赖方向只能**从外圈指向核心**：
`cli.ts → cli/(参数·渲染·帮助·分发) → commands/ → app/ → { core, transport, adapters, infra }`。
⛔ 入口文件不许承载业务逻辑；`src/app/` 不许直接 `console.*`（输出走 `SessionLog`）。详见 `.harness/rules/always-on.md` §4.5。

## 标准命令

```bash
npm run build              # tsc → dist/
npm run typecheck          # tsc --noEmit
npm test                   # vitest run
npm run gate               # 收尾门禁（契约边界 + 文档一致 + 类型 + 单测 + 构建 + 提案）
npm run arch:check         # 架构/安全边界硬校验
npm run doc:check          # 文档-实现一致性
npm run harness:validate   # .harness 自检
npm run openspec:validate  # 活跃提案格式校验
npm run e2e:smoke          # 端到端冒烟（mock 平台 + 真实 CLI，需先 build）
```

## 工作流（两套流程，一套留痕）

```
需求澄清（brainstorming）→ OpenSpec 提案 → 实现计划（writing-plans → tasks.md）
→ 编码 → 单测 → npm run gate → 评审 → 端到端取证 → 归档
```

- **superpowers 管"怎么想"**：`brainstorming` / `writing-plans` / `systematic-debugging` / `verification-before-completion`
  （技能本体在 `~/.workbuddy/skills/`，本仓库在 `.harness/skills/superpowers-workflow/` 定义**触发条件与产物落点**）；
- **OpenSpec 管"留下什么"**：`openspec/`（提案 → tasks.md 勾选 → specs 增量 → archive）；
- 交汇点：`writing-plans` 的产出直接写进 `openspec/changes/<id>/tasks.md`，**不另开 plan.md**。

## 顶层禁止动作（黑名单，详见 `.harness/rules/always-on.md`）

1. ⛔ 修改/删除 `.harness/` 下任何文件（`work/` 除外）；
2. ⛔ 无提案改动 `src/protocol.ts`；在 `protocol.ts` 之外定义 wire 类型；
3. ⛔ 把平台参数拼成 shell 字符串；新增 `shell: true`；绑定非回环地址；
4. ⛔ 读取凭据文件内容；输出完整 `device_token`；明文密钥入库；
5. ⛔ 只改代码不改文档（或反之）；把未实现能力写成已支持；
6. ⛔ 自行 `npm publish` / force push / 删除文件。

## DoD（完成定义）

1. `npm run gate` 全绿（贴真实输出）；2. 协议/runner/适配器改动附端到端证据（`e2e:smoke`）；
3. 两份 README 同批更新；4. 新逻辑有用例；5. 能力级变更走完 OpenSpec（tasks 全勾、specs 已合并或已归档）。

## 文档导航

| 主题 | 位置 |
| --- | --- |
| 最高优先级红线 | `.harness/rules/always-on.md` |
| 协议契约演进（含未落地台账） | `.harness/rules/protocol-contract-rules.md` |
| 安全边界 | `.harness/rules/security-rules.md` |
| Windows 兼容（垫片/空格/where） | `.harness/rules/windows-compat-rules.md` |
| 文档-实现同步（漂移台账） | `.harness/rules/doc-impl-sync-rules.md` |
| 代码风格与模块职责 | `.harness/rules/code-style.md` |
| 发布纪律 | `.harness/rules/release-rules.md` |
| 工作流与人工卡点 | `.harness/rules/workflow-rules.md` |
| 风险分级 / 工具白名单 | `.harness/contracts/policy.yaml` |
| Agent 角色 | `.harness/agents/<name>/AGENT.md` |
| 技能（含 OpenSpec / superpowers / e2e） | `.harness/skills/README.md` |
| 护栏事件映射 | `.harness/hooks/hooks.json` |
| 护栏评测用例 | `.harness/evals/` |
| OpenSpec 流程 | `openspec/AGENTS.md`、`openspec/project.md` |
| Harness 结构与落地步骤 | `.harness/README.md` |
