# 技术方案：本地回环控制面（待决策）

> 本篇是**决策材料**，不是开工计划。你看完决定做不做、做哪几期，再给指令。
> 设计目标：让"本机上的任何程序"用业界标准方式接进 bridge，**同时不破坏零入站卖点**。

## 1. 定位：它解决什么、不解决什么

| 问题 | 控制面能否解决 |
| --- | --- |
| IDE 插件 / 编辑器扩展要跑本机 Agent | ✅ 能 |
| 本机脚本 / 本地 Agent / MCP server 要下发任务、取 diff | ✅ 能 |
| CI（本机 runner）离线跑任务 | ✅ 能 |
| 用户自己排查"现在在跑什么" | ✅ 能 |
| **远程平台后端**调进设备 | ❌ **不能**（NAT，永远不能；那部分走平台自己的 REST + 我们已给的 3 处清单） |

一句话：**控制面服务的是"本机的其它程序"，不是"远端的平台"。**

## 2. 标准选型（每条都对齐现有业界标准，不自造）

| 关注点 | 选型 | 理由 |
| --- | --- | --- |
| 传输 | HTTP/1.1 over `127.0.0.1`（Unix 另给 unix socket） | 回环最简单、零依赖；不出网 |
| 契约描述 | **OpenAPI 3.1** | 与 `contracts/` 计划同源，机器可读 |
| 鉴权 | **scoped Bearer**，复用 P0-8 的 `abs_<kid>_<secret>` | 不引入第二套身份体系，scope 语义对齐 OAuth2 |
| 服务发现 | `GET /v1/capabilities` + 可选 `/.well-known/agent-card.json`（A2A 形态） | 让客户端自己降级；A2A 客户端可直接发现 |
| 事件流 | **SSE**（`GET /v1/tasks/:id/events`） | 单向服务端推送的标准做法，比 WS 轻；与对平台那条 WS 并存 |
| 错误 | **RFC 9457** `application/problem+json` | 与协议层 `errorCode` 同源 |
| 幂等 | `Idempotency-Key` 请求头（IETF 草案通行做法） | 重复下发不至于跑两遍任务 |
| 分页 | 游标（`?cursor=&limit=`），不用 offset | 任务列表会滚动，offset 会漏/重 |
| 版本 | URL 前缀 `/v1` + SemVer | 与协议版本规则一致 |
| 健康检查 | `GET /v1/health`（liveness/readiness） | 容器/CI 探活标准 |

## 3. 端点清单（首版）

| 方法 | 路径 | scope | 说明 |
| --- | --- | --- | --- |
| GET | `/v1/health` | 无（本机） | liveness + readiness + 版本 |
| GET | `/v1/capabilities` | `device:read` | 能力清单（与 `hello.capabilities` 同一份源） |
| GET | `/v1/agents` | `device:read` | 本机工具清单（等价 `status --json`） |
| POST | `/v1/agents:scan` | `device:read` | 触发一次 fresh 扫描 |
| POST | `/v1/tasks` | `task:create` | 下发任务（带 `Idempotency-Key`） |
| GET | `/v1/tasks` | `task:read` | 游标分页的任务列表 |
| GET | `/v1/tasks/{id}` | `task:read` | 任务状态 + 终态产物（diff / changedFiles） |
| POST | `/v1/tasks/{id}:cancel` | `task:cancel` | 取消（幂等） |
| GET | `/v1/tasks/{id}/events` | `task:read` | **SSE**：log / status / step 三类事件流 |
| GET | `/v1/tasks/{id}/diff` | `task:read` | 只取 diff（不重跑任务） |
| GET | `/v1/audit` | `admin:audit` | 审计流水（游标分页，**不含令牌**） |

请求/响应示例（任务下发）：

```http
POST /v1/tasks HTTP/1.1
Host: 127.0.0.1:8787
Authorization: Bearer abs_0ef850c2_7f3a…
Idempotency-Key: 3f9a…（同一 key 重复提交返回同一 taskId）
Content-Type: application/json

{ "agentType": "codex", "cwd": "/Users/me/work/api", "prompt": "修复失败的登录测试",
  "captureDiff": true, "purpose": "repair", "requestedBy": "vscode-ext" }
```

```http
HTTP/1.1 201 Created
Location: /v1/tasks/bt_7f3a

{ "taskId": "bt_7f3a", "state": "queued", "queuePosition": 1, "events": "/v1/tasks/bt_7f3a/events" }
```

错误（RFC 9457）：

```http
HTTP/1.1 403 Forbidden
Content-Type: application/problem+json

{ "type": "https://agent-bridge.dev/errors/insufficient-scope", "title": "Insufficient scope",
  "status": 403, "detail": "需要 scope: task:cancel", "code": "insufficient_scope" }
```

## 4. 任务状态模型（与协议层同源，不另造一套）

```
queued → running → settled(success | failed | cancelled | timeout)
   │         └── (平台/控制面推断) lost
```

- 控制面的 `state` 与 wire 的 `TaskStatus` **一一对应**，由 `src/core/task-supervisor.ts` 的显式状态机生成，
  不出现"HTTP 一套、WS 一套"的双份真源；
- `lost` 仍由**调用方**推断（心跳缺失），bridge 不发。

## 5. 安全边界（红线，护栏强制）

1. **只绑回环**：`127.0.0.1`（或 `[::1]`），检测到 `0.0.0.0` / `::` 直接拒绝启动；
2. **默认关闭**：`control_plane.enabled = false`，必须显式开启；
3. **必须有 scope**：每个端点声明所需 scope，缺失即 403（含 `/v1/health` 之外的所有端点）；
4. **不转发到外网**：控制面不代理、不转发、不开 CORS（`Access-Control-Allow-Origin` 一律不返回），
   浏览器侧脚本**不能**直接调用 —— 这是防"网页扫描本机端口"的关键一条；
5. **审计**：每次调用落 `audit.jsonl`，与 WS 通道同一份格式；
6. **不新增运行时依赖**：用 `node:http` 手写路由，主包依赖仍只有 `ws` + `smol-toml`。

## 6. 护栏需要怎么改（已获授权，给你看具体 diff）

`.harness/scripts/protocol-boundary-check.mjs` 第 4 条现在是：

```js
if (/listen\(/.test(f.bare) && f.rel !== 'src/auth.ts')
  fail(`${f.rel} 监听端口（唯一允许监听的是 src/auth.ts 的 127.0.0.1 回调）`);
```

改为**白名单 + 强制回环**（而不是简单放行）：

```js
const LISTEN_ALLOW = ['src/auth.ts', 'src/transport/control-plane.ts'];
if (/listen\([^)]*(0\.0\.0\.0|['"]::['"])/.test(f.bare)) fail('绑定非回环地址（只允许 127.0.0.1 / ::1）');
if (/listen\(/.test(f.bare) && !LISTEN_ALLOW.includes(f.rel)) fail(`…只允许 ${LISTEN_ALLOW.join(' / ')}`);
// 新增：控制面必须同时出现回环绑定与默认关闭，二者缺一即失败
if (f.rel === 'src/transport/control-plane.ts') {
  if (!/127\.0\.0\.1|::1/.test(f.bare)) fail('控制面必须绑定回环地址');
  if (!/enabled/.test(f.bare)) fail('控制面必须默认关闭（enabled 开关）');
}
```

同时 `always-on.md` / `security-rules.md` 补一条："控制面是**回环**通道，默认关闭，不属入站网络暴露"。

## 7. 分期与验收

| 期 | 内容 | 验收 |
| --- | --- | --- |
| C1 | 回环监听 + 鉴权 + `/v1/health` `/v1/capabilities` `/v1/agents` | `curl --noproxy '*' http://127.0.0.1:8787/v1/health` 返回 200；无令牌访问 `/v1/agents` 返回 401 |
| C2 | 任务三端点（create / get / cancel）+ 幂等键 | 同一 `Idempotency-Key` 提交两次只跑一个任务 |
| C3 | SSE 事件流 + diff 端点 | 订阅后能按序收到 log 与终态；晚订阅能从缓冲补发 |
| C4 | OpenAPI 3.1 契约 + 生成校验 | `contracts:check` 覆盖控制面端点，漂移即红 |

## 8. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 被误读为"bridge 开了端口"，砸了零入站招牌 | README 安全边界表明确写"回环 / 默认关闭 / 不出网"；护栏强制回环 |
| 本机其它程序可任意调用（本机恶意软件） | 强制 scope + 令牌；默认关闭；审计可查 |
| 浏览器 CSRF / 端口扫描 | 不返回 CORS 头；要求自定义头 `Authorization`，浏览器无法静默带上 |
| 与远程平台的 WS 争抢任务 | 统一走 `TaskSupervisor`，并发上限与队列对两条通道**同时**生效 |
| 端口冲突 | 端口 0 时由系统分配，回写 `~/.agent-bridge/control-plane.json` 供客户端发现 |
