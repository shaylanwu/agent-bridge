# 变更提案：本地回环控制面（local control plane）

## Why

当前 bridge 只有**一个**对外通道：与远程编排平台之间的出站长连。这带来一个结构性缺口 ——
**任何"不是平台"的系统都接不进来**：

| 想接入方 | 今天的处境 |
| --- | --- |
| IDE 插件 / 编辑器扩展 | 没有接口，只能自己 spawn CLI 重造一遍适配器与调度 |
| 本机脚本 / 本地 Agent / MCP server | 同上，且拿不到 diff、步骤、审计这些产物 |
| CI（本机 runner） | 只能走平台绕一圈，离线就断 |
| 平台侧下发的**本机协同服务** | 与 bridge 之间没有任何标准通道 |
| 用户自己排查（"现在在跑什么"） | 只有 `status` 一次性探测，看不到任务与历史事件 |

注意缺口不是"远程平台调不进设备"（那是 NAT 问题，永远解决不了），而是
**"本机上的其它程序"调不进 bridge**。这个缺口完全可以在不破坏"零入站"卖点的前提下补上 ——
因为它是**回环地址**，不出网。

## What Changes

新增一个**默认关闭**的本地回环 HTTP 控制面（`control_plane.enabled = true` 才开）：

- 只绑 `127.0.0.1`（Unix 另提供 unix socket 选项），**永不绑 0.0.0.0 / ::**；
- 用**同一套** scoped service token 鉴权（复用 P0-8 已落地的 `abs_<kid>_<secret>`），scope 复用
  `task:create` / `task:cancel` / `task:read` / `device:read`；
- 以 **OpenAPI 3.1** 为契约真源，端点按 `/v1/*` 版本前缀；
- 事件回传用 **SSE**（`GET /v1/tasks/:id/events`），与对平台那条 WS 并存、互不干扰；
- 错误一律 **RFC 9457** `application/problem+json`；
- 发现端点 `GET /v1/capabilities`（并对齐 A2A 提供 `/.well-known/agent-card.json` 可选形态）。

护栏需要同步放开一条（已获授权）：`protocol-boundary-check` 的"除 `src/auth.ts` 外不得 `listen(`"
改为白名单 `src/auth.ts` + `src/transport/control-plane.ts`，且**强制回环地址**、**强制默认关闭**。

## Impact

- **不影响"零入站"卖点**：回环监听不是入站网络暴露。README 安全边界表要写清楚"默认关闭、只绑回环"，
  避免被误读成"bridge 开了端口"。
- 对平台（第三方）：零影响 —— 远程平台继续走原有出站 WS，控制面是**另一条**通道。
- 新增表面：一个本机 HTTP 服务 + 一个 SSE 端点。风险集中在鉴权与绑定地址，故两者都由护栏硬校验。
- 依赖：**不新增任何运行时依赖**（用 `node:http`），主包仍是 `ws` + `smol-toml`。
