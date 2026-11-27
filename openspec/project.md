# project.md — agent-bridge 项目上下文

> Agent 在创建任何变更提案（proposal）之前必须先读本文件，确保提案贴合现状而非凭空设计。

## 项目概述

`agent-bridge-service` 是一个**本机侧桥接客户端**：把开发者机器上已安装的 AI 编码 CLI（Claude Code、Codex、
CodeBuddy、DeepSeek Harness、Antigravity、opencode、mimo、Qoder、Grok Build、Kimi Code、MiniMax Code、
Trae 等 12 个）通过一条**出站 WebSocket** 暴露给远程编排平台。
平台不主动打入内网，也不需要 API Key 离开本机。

除 WebSocket 主通道外，还有两个**默认关闭**的可选入口：本地回环控制面（只绑 `127.0.0.1`，HTTP/SSE）
与挂在它上面的 A2A / ACP 网关（`[gateway]` 段，默认关闭）。它们不改变「以出站连接为主」的定位。

**关键认知：本仓库只有一半系统** —— 另一半（平台侧）是第三方实现，必须按 `openspec/specs/bridge-protocol/spec.md`
与两份 README 的协议表对接。任何契约改动都是跨团队成本。

## 技术栈（真实识别）

- TypeScript（`strict` + `noUncheckedIndexedAccess`）+ Node `>=24 <25`
- 构建：`tsc`（无打包器）；测试：Vitest；ESM（NodeNext，相对导入必须带 `.js`）
- 运行时依赖只有两个：`ws`（WebSocket 客户端）+ `smol-toml`（配置解析）—— 刻意保持极简
- 无 lint/format 工具链（没有 eslint/prettier/oxlint），代码风格靠 `.harness/rules/code-style.md` 约束

## 模块地图

| 模块 | 职责 | 风险级别 |
| --- | --- | --- |
| `src/protocol.ts` | wire 类型 + 运行期校验 + 4KB 分片 | **high**（第三方契约） |
| `src/core/task-supervisor.ts` | 任务生命周期：白名单、spawn、超时、取消（`src/runner.ts` 是 v1 兼容包装） | **high**（安全边界） |
| `src/infra/auth.ts` | PKCE 回环授权 + 设备码兜底 | **high**（凭据） |
| `src/transport/bridge-client.ts` | WS 传输：鉴权、心跳、退避、离线队列 | medium |
| `src/infra/config.ts` | `~/.agent-bridge/config.toml` 读写（0600）+ 脱敏 | medium |
| `src/core/scan.ts` | 探测调度 + 30s 缓存 | medium |
| `src/adapters/agent-adapters.ts` | 12 个适配器表 + 二进制解析 + 版本/凭据探测 | medium |
| `src/adapters/win-exec.ts` | Windows `.cmd` 垫片引号规则 | medium |
| `src/app/session.ts` | 平台会话：初值上报、指令路由、在跑任务表 | medium |
| `src/app/task-dispatch.ts` | `run_task` / `cancel_task` 编排（鉴权 → 拉起 → 回传） | medium |
| `src/app/service-gate.ts` | 服务身份校验 + 审计（P0-8） | medium |
| `src/cli.ts` | **只做** `argv → cli/dispatch.ts` 分发与顶层错误兜底 | medium |
| `src/cli/` + `src/commands/` | CLI 支撑件（参数/渲染/帮助/注册表）+ 一个命令一个文件 | medium |

## 关键约定（提案必须遵守）

1. **协议唯一真源**：wire 类型只在 `protocol.ts`，改它必须先有提案；
2. **平台不可信**：所有下发报文过 `assertServerMessage`；参数永远数组传递，不拼 shell；
3. **凭据不出本机**：只探测存在性，不读内容；token 只打尾号；
4. **只出不入**：主通道是出站 WebSocket；仅有的监听是授权期 `127.0.0.1` 临时回调、默认关闭的
   回环控制面与网关，全部只绑 `127.0.0.1`；
5. **文档即接口**：两份 README 的协议表就是平台侧的实现依据，改代码必须同批改文档。

## 已知未落地项（提案时不要假设它们存在）

> 2026-11-28 核对：以下每条都在源码里确认过仍是缺口。已实现的不再列在这里——
> `refresh_token` 续期、`allowed_cwd` 白名单、`max_tasks`/`max_queue` 并发上限、
> `isAnsi`（按 `hasAnsi()` 实测）、**`daemon install`/`uninstall`**（Windows `schtasks` /
> macOS LaunchAgent / Linux systemd user unit，含 `--dry-run`，见 `src/commands/daemon.ts`
> 与 `test/daemon*.test.ts`；真机注册未验证）都已落地，别再按旧台账当成不存在。

- **`context_exhausted`**：规格（`session-gateway/spec.md`）要求「超上下文回 context_exhausted」，
  但代码与契约（错误码清单）里都没有它 —— 目前是**规格承诺、实现缺失**，需么实现、么降级为未实现；
- **附件容量与安全**：无 artifact 配额、无 `ENOSPC` 专门处理、无入站扫描/quarantine、无引用计数；
- **备份与恢复**：状态库没有 backup/restore 流程；
- **A2A 推送**：无 push notification / webhook；
- **可观测性**：无 OpenTelemetry / W3C `traceparent`，`/metrics` 只有进程内计数，无 DB/WAL/磁盘指标；
- **传输与存储加密**：无 mTLS、无 AES-256-GCM 静态加密、无 key rotation、审计无 hash chain；
- **发布**：`1.0.0` 已于 2026-11-26 发布（npm `latest=1.0.0`、tag `v1.0.0`、GitHub Release 齐备）；
  发布后 SHALL 手工补跑 `node site/scripts/gen-changelog.mjs` 并提交，否则仓库内站点 changelog 页
  会落后一个版本（线上构建时重生成，所以用户看不出来，但 `site:check` 会一直红）；
- **真实验证**：12 个适配器里完成模型级真跑的是 6 个（codex / agy / kimi-code / minimax-code /
  ds-harness / opencode），其余 6 个卡在账号或本机配置（claude-code 订阅 403、mimo-code key 401、
  codebuddy 需 `/login`、qoder 额度用尽、grok 的 `node_repl` MCP 路径不存在、trae 未登录）；
  permission 交互只有 kimi-code 有真 CLI 证据，**form（elicitation）在所有适配器上都还没有真证据**。

详见 `.harness/rules/protocol-contract-rules.md` §6 与 `.harness/rules/release-rules.md`。

## 标准命令

```bash
npm run build          # tsc → dist/
npm run typecheck      # tsc --noEmit
npm test               # vitest run
npm run gate           # 收尾门禁（契约边界 + 文档一致 + 类型 + 单测 + 构建）
npm run harness:validate   # .harness 自检
npm run openspec:validate  # 活跃提案格式校验
node .harness/skills/protocol-e2e/scripts/e2e-smoke.mjs   # WS 协议冒烟（需先 build）
npm run e2e:gateway        # A2A/ACP/控制面端到端（真 bridge + 真令牌 + 真 CLI；自动挑就绪工具）
npm --prefix site run check    # 文档站一致性（生成页 ↔ CHANGELOG/契约、i18n 对等、图标与页脚）
node scripts/verify-release.mjs    # 发布链离线取证：算下一版 + 断言 CHANGELOG 结构（不联网不写仓库）
node scripts/verify-release.mjs --expect=x.y.z   # 发布前闸门：版本不符即退出码 1
```

E2E 说明：`e2e:gateway` 默认自动挑本机就绪的 CLI（全不就绪退出码 2，`E2E_ALLOW_SKIP=1` 才跳过）；
`E2E_INTERACTION=1` 追加交互闭环段（需要 CLI 真的申请权限；一帧都没收到时记「未验证」，不算桥接失败）；
CLI 出网代理与系统不一致时用 `E2E_PROXY=http://127.0.0.1:<port>`。
**发布后须手工补跑** `node site/scripts/gen-changelog.mjs` 并提交，否则仓库内站点 changelog 页会落后一版。

## 文档索引

`README.md` / `README.zh-CN.md`（对接契约）· `CHANGELOG.md` · `AGENTS.md`（Agent 总入口）·
`.harness/rules/`（规则）· `.harness/skills/`（技能）
