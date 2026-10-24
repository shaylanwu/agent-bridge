# 技术方案：官网 + API 对接文档 + 自动版本历史（第 2 版 · 按成品系统重排）

> 第 1 版写在 P0-6/P0-8 刚落地时，系统的"对外表面"只有一条 WS 通道。
> 现在入口已瘦身分层、本地控制面（C1~C4）已落地、**对外表面变成两条**，
> 本版按**当前真实系统**重新盘点内容清单与信息架构 —— 你据此决策是否动工。

## 1. 先盘点：站点到底要承载什么（这是第 2 版与第 1 版最大的差别）

当前系统的对外表面（全部有机器可读真源，无一项靠散文维持）：

| 对外表面 | 读者 | 真源 | 现状 |
| --- | --- | --- | --- |
| **WebSocket 协议 v1**（11 个消息类型） | 平台方 | `src/protocol.ts` + `contracts/asyncapi-3.0.yaml` | 已发布语义，`contracts:check` 机检 |
| **平台需实现的 4 个 HTTP 端点** | 平台方 | `contracts/openapi-3.1.yaml` | PKCE/设备码/令牌端点 |
| **本地回环控制面**（9 个路径 / 10 个操作） | **本机程序**（IDE 插件、脚本、MCP、CI） | `contracts/openapi.control-plane.yaml` | **新增**，默认关闭 |
| **CLI**（6 个命令） | 所有人 | `src/cli/dispatch.ts` 的 `COMMANDS` 表 | 新增 `serve`；`doc:check` 机检 |
| 能力协商（5 个 capability） | 平台方 | `PROTOCOL_CAPABILITIES` | 第三方靠它降级 |
| 受控错误码（15 个） | 所有人 | `src/core/errors.ts` | 与 AsyncAPI 镜像 |
| scoped 服务令牌 | 平台方 + 本机方 | `src/infra/service-token.ts` | P0-8 |
| diff 捕获 | 平台方 + 本机方 | `src/infra/git.ts` | P0-6 |
| 排队语义 / 审计 / 配置 | 运维 | README 两份 | — |

**结论：站点必须分两条对接路径，否则"平台方"和"本机程序作者"会互相看错文档。**
这是第 1 版没有的维度（当时只有平台方一个读者）。

## 2. 信息架构（按读者分叉）

```
/                      定位 + 30 秒上手 + 架构图（出站 WSS 一条、回环控制面一条）
├─ /quickstart/        装 → connect → status → 下一个任务
├─ /cli/               6 个命令参考（与 COMMANDS 表同源校验）
├─ /architecture/      分层图 + 依赖方向 + 三条红线（唯一上行出口 / 入口只分发 / 回环默认关闭）
├─ /protocol/          方向表、能力协商、版本规则、错误码、排队语义
│   ├─ /protocol/messages/   11 个消息逐字段 + 示例
│   └─ /protocol/websocket/  AsyncAPI 渲染（URL/鉴权/心跳/退避/断线补发）
├─ /integrate/platform/      ★ 平台方清单：要实现什么（WS 服务端 + 4 个 HTTP 端点 + scope 校验）
├─ /integrate/local/         ★ 本机程序清单：控制面怎么用（令牌、幂等键、SSE、diff）
├─ /api/                     Scalar 渲染 openapi-3.1.yaml（**平台方**要实现的端点）
├─ /api/control-plane/       Scalar 渲染 openapi.control-plane.yaml（**本机方**可调用的端点）
├─ /changelog/              CHANGELOG.md 渲染视图
└─ /llms.txt /llms-full.txt AI 客户端入口
```

两处 ★ 是第 2 版的**新增主干**：一条给远端平台，一条给本机程序。

## 3. 技术选型（与第 1 版一致，理由复核后不变）

| 层 | 选型 | 复核结论 |
| --- | --- | --- |
| 站点框架 | **Astro + Starlight** | 仍是零前端栈场景的首选：内置 Pagefind 检索、i18n、暗色模式；产物近乎零 JS。VitePress 仍缺原生版本化（硬伤未变） |
| API 渲染 | **Scalar** | 原生 OpenAPI 3.1、自带试请求客户端；**现在要渲染 2 份契约**（平台端点 + 控制面），Scalar 的多实例能力正好覆盖 |
| 契约真源 | OpenAPI 3.1 ×2 + AsyncAPI 3.0 | 控制面加入后契约从 2 份变 3 份，更不能再靠 Markdown |
| 发布/版本历史 | **semantic-release** + commitlint | 单包场景仍最省心；`CHANGELOG.md` 永不手工编辑 |
| 托管 | GitHub Pages | 与主仓库同源 |

## 4. 目录结构（独立性与第 1 版一致，`site/` 不进主包）

```
agent-bridge/
├─ contracts/                ← 3 份机器可读契约（站点 + 第三方共同消费）
│   ├─ asyncapi-3.0.yaml
│   ├─ openapi-3.1.yaml
│   └─ openapi.control-plane.yaml
├─ site/                     ← 独立工作区（自己 package.json，不进 files）
│   ├─ public/{asyncapi.yaml, openapi.yaml, openapi.control-plane.yaml, llms.txt}
│   └─ src/content/docs/…    见 §2 信息架构
└─ .github/workflows/{release.yml, site.yml}
```

**独立性硬约束（不变）**：主包 `files` 仍只有 `dist/assets/README ×2/CHANGELOG`；
主包 `dependencies` 仍只有 `ws` + `smol-toml`；`npm run gate` 不构建站点。

## 5. 防漂移：把现有机检全部接进站点构建前

现成的机检（**站点不需要重新发明**）：

| 机检 | 命令 | 守住什么 |
| --- | --- | --- |
| 契约-代码一致 | `npm run contracts:check` | wire 类型 / 能力 / 错误码 / 平台端点 |
| 文档-实现一致 | `npm run doc:check` | 11 个消息类型、5 个能力、**6 个 CLI 命令**、**9 个控制面端点**、未实现标注、配置路径 |
| 架构/安全边界 | `npm run arch:check` | wire 类型唯一、无 shell 字符串、只绑回环、控制面三条红线、凭据不入库 |

站点侧新增两条（放进 `site.yml` 的 pre-build）：

1. **CLI 命令页 ↔ `src/cli/dispatch.ts`**：从 `COMMANDS` 表抽键，逐条比对 `/cli/` 页面是否覆盖（缺一个即红）；
2. **契约渲染前结构校验**：`@scalar/openapi-parser` / `@asyncapi/parser` 解析 3 份契约，解析失败即红。

## 6. 版本历史（真源仍是 `CHANGELOG.md`）

```
feat(control-plane): add loopback control plane
   └─ CI(release.yml)：commit-analyzer → minor → changelog → tag vx.y.z → npm → GitHub Release
        └─ CI(site.yml)：site 构建期读 ../../CHANGELOG.md → /changelog/ 渲染
```

- `CHANGELOG.md` 永不手工编辑；站点只是它的**渲染视图**（一处真源两处呈现）；
- 协议不兼容变更必须是 `feat!:` / `BREAKING CHANGE:`，与 `PROTOCOL_VERSION` 递增同步（人工审批项）；
- 额外素材：`openspec/changes/archive/` 里的提案（proposal/design）可在「变更说明」页做深度解读 ——
  这是本仓库相对一般开源包的独特资产，第 1 版没考虑到。

## 7. 命令与脚本

```jsonc
"site:dev":     "npm --prefix site run dev",
"site:build":   "npm --prefix site run build",
"site:preview": "npm --prefix site run preview",
"site:check":   "node scripts/site-check.mjs"   // §5 的两条站点级校验
```

## 8. 分期（建议）

| 期 | 内容 | 产出 |
| --- | --- | --- |
| W1 | Starlight 骨架 + i18n（en/zh）+ 首页/Quickstart/CLI | 能本地 preview |
| W2 | 协议区：messages 逐字段 + AsyncAPI 渲染 | 平台方能照抄实现 |
| W3 | **两条对接路径**：`/integrate/platform/` + `/integrate/local/`，Scalar 渲染 2 份契约 | 两类读者各得其所 |
| W4 | 版本历史（CHANGELOG 渲染）+ semantic-release + Pages | push main 即发布 |

i18n：`src/` 与两份 README 已是中英并存，站点按 en 为主 + zh 为第二 locale（与 README 口径对齐）。

## 9. 验收标准

1. `npm run site:build` 产出静态站，`site:preview` 可浏览；
2. `/api/` 与 `/api/control-plane/` 两页都能从页面发起试请求（Scalar）；
3. `site:check` 在「加了 CLI 命令但没写文档」或「契约改了但没渲染」时失败；
4. 打一个 `feat:` commit → CI 升 minor、更新 CHANGELOG、建 tag/Release → `/changelog/` 出现新版本（全程无人工编辑）；
5. `npm pack --dry-run` 产物里**没有** `site/`、`contracts/`；
6. `npm run gate` 仍全绿（站点不进主包门禁）。

## 10. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 两条对接路径被读者搞混 | 首页就分叉（"你是平台方 / 你是本机程序"），两个 Scalar 页各有明确标题与适用范围 |
| 控制面被误读成"bridge 开了端口" | `/integrate/local/` 开篇就写：默认关闭、只绑回环、需 scoped 令牌、不返回 CORS；与 README 安全边界表同一口径 |
| 站点依赖拖慢主包 CI | 独立安装 + 独立 job；主包门禁不构建站点 |
| 3 份契约与代码漂移 | 现有机检（`contracts:check`/`doc:check`）已覆盖，站点只做渲染不做第二次描述 |
| semantic-release 自动生成的 CHANGELOG 太"机器味" | PR 描述写好正文；必要时 `chore` 补导语 |
