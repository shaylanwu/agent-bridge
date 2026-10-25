# agent-bridge-service

把本机已安装的 AI Agent 接入远程编排平台 —— 只靠一条**出站** WebSocket。不需要开入站端口、不需要反向穿透，API Key 始终留在本机。

[English](README.md) · **简体中文**

📚 **文档站（中英双语，支持全文搜索）：<https://shaylanwu.github.io/agent-bridge/>**
—— 协议参考、CLI 参考，以及两条对接指南（平台方 / 本机程序）。内容由同一批机器可读契约生成，因此不会与代码漂移。

---

## 简介

AI 编码 Agent（Claude Code、Codex、Gemini CLI 等）装在开发者的电脑上。网页平台看不到它们：浏览器沙箱拿不到
`PATH`、可执行文件和凭据存储；平台部署在别处，也连不进 NAT 后面的笔记本。

`agent-bridge-service` 补上这一环：它运行在拥有这些 CLI 的机器上，向平台保持一条出站 WebSocket，
回答三个平台自己永远回答不了的问题：

1. **这台机器装了什么？** —— 真实探测本地 `PATH` 与常见安装目录。
2. **装了能不能用？** —— 区分「已安装」「已安装但缺凭据」「已安装但跑不起来」。
3. **能不能帮我跑一下？** —— 在受控工作目录里执行白名单内的 CLI，并实时把输出回传。

这个包是自包含的：运行时只依赖 `ws` 和 `smol-toml`，通过一个小型 JSON 协议（HTTP + WebSocket）与平台通信。

## 功能

- **内置 12 个适配器** —— Claude Code、CodeBuddy CLI、Codex、DeepSeek Harness、Gemini CLI、opencode、Mimo Code、
  Qoder CLI、Grok CLI、Kimi Code、MiniMax Code、Trae CLI。
- **三态探测** —— `就绪` / `已装缺凭据` / `未装`，并在「找到二进制但执行失败（`--version` 非 0）」时标记为**装坏**。
- **零入站网络** —— 由 bridge 主动连出，平台从不向你的网络发起连接。
- **绑定无需复制粘贴 token** —— 本地回环回调 + PKCE S256，复用浏览器里已登录的会话；SSH/无头机器走设备码，CI 可用 `--token`。
- **受控执行** —— 适配器白名单、参数数组（不拼 shell）、工作目录校验、单任务超时、优雅取消（`SIGTERM` → 2 秒 → `SIGKILL`）。
- **流式日志** —— 输出按 4 KB 分片即时回传；已结束的运行可在平台侧回看。
- **连接自愈** —— 15 秒心跳、指数退避（1 秒 → 30 秒）、断线期间的状态消息在重连后补发。
- **终端任务面板** —— `connect` / `serve` 在 TTY 下显示常驻状态表（四态圆点、各任务当前步骤、耗时、容量水位），主窗口不滚动任务日志；每任务日志在 Web 面板（`serve` 启动控制面后给出地址）点击查看，执行中走 SSE 实时流。
- **密钥不出本机** —— 不读取、不上传任何 API Key 或凭据文件，只上报「有 / 没有」。

## 安装

```bash
npm install -g agent-bridge-service
```

要求：**Node.js ≥ 20**，支持 macOS / Linux / Windows。

从源码安装：

```bash
git clone https://github.com/shaylanwu/agent-bridge.git
cd agent-bridge
npm ci
npm run build
npm link            # 暴露 agent-bridge 命令
```

## 用法

```bash
# 绑定本机并保持长连接（自动打开浏览器确认）
agent-bridge connect https://platform.example.com

# 无浏览器 / SSH：打印设备码
agent-bridge connect https://platform.example.com --no-browser

# CI 或脚本化：使用平台签发的设备 token
# 稳定 ID 必须来自本地状态、--device-id 或 AGENT_BRIDGE_DEVICE_ID
agent-bridge connect https://platform.example.com --token=<device-token> --device-id=<device-id>

# 只探测本机工具（不需要连接平台）
agent-bridge status
agent-bridge status --json --fresh     # --fresh 绕过 30 秒缓存

# 清除本机设备凭证
agent-bridge logout

# 给外部系统 / 后端服务签发 scoped 服务令牌（P0-8）
agent-bridge services issue --label=repair-orchestrator --scopes=task:create,task:cancel --ttl-days=90
agent-bridge services list
agent-bridge services rotate svc_9f1c2a --grace-hours=24   # 轮换：旧令牌宽限 24h
agent-bridge services revoke svc_9f1c2a
```

> `agent-bridge daemon start <platformUrl>` / `stop` / `status` 提供轻量后台进程管理（detached + PID +
> `daemon.log`）。`install` / `uninstall`（注册 systemd / launchd / Windows Service）仍明确未实现；
> 需要开机自启时仍请用系统服务管理器托管。

用 `--token` 时，bridge 必须从 `identity.toml`、已保存的 `config.toml` 镜像、`--device-id` 或
`AGENT_BRIDGE_DEVICE_ID` 解析出稳定 `deviceId`。如果没有已持久化、可迁移或显式提供的 ID，启动会明确
失败：不会为预签发 token 随机生成 ID，不会发送空 ID，也不会让平台仅凭 Bearer 反查身份。显式 ID 只能
迁移缺失的本地状态或确认已持久化身份，不能覆盖一个不同的既有身份。

`status` 输出示例：

```
工具                 版本                 状态
──────────────────────────────────────────────────────────
Claude Code        2.1.282              就绪
Codex              0.163.0              就绪
DeepSeek Harness   0.1.5-rc.3           就绪
Gemini CLI         0.64.0               缺凭据
opencode           1.19.3               缺凭据
Qoder CLI          1.1.75               就绪
MiniMax Code       -                    装坏
Kimi Code          -                    未装

共 12 个工具，可用 4 个
```

### 稳定设备身份与本地状态

| 状态 | POSIX | Windows |
| --- | --- | --- |
| 身份（唯一真源） | `~/.agent-bridge/identity.toml` | `%APPDATA%\.agent-bridge\identity.toml` |
| 凭证、设置、身份镜像 | `~/.agent-bridge/config.toml` | `%APPDATA%\.agent-bridge\config.toml` |

`identity.toml` 保存稳定 `deviceId`；`config.toml` 只保留同值兼容镜像。状态文件仅当前用户可读写
（POSIX 为 `0600`，Windows 使用受限 ACL），设备 token 从不明文完整打印。`AGENT_BRIDGE_CONFIG` 指向
某个 profile 的 `config.toml`，其**父目录就是该 profile**，`identity.toml` 与其他状态文件都在这个目录；
不同 profile 必须使用不同父目录。

重新授权、切换授权方式，以及保留该状态目录的卸载重装都不会改变 ID。只删除 `identity.toml` 时会从
配置镜像恢复原 ID；删除整个 profile（或身份与所有可迁移镜像）后，下次交互绑定才属于新安装并生成新 ID。
`logout` 只清凭证，保留身份和设置；凭证吊销后执行 `logout` → `connect`，仍用原 ID 重新绑定。

平台返回 `409 device_bound_to_other_account` 表示 ID 属于其他账号，`409 device_identity_ambiguous`
表示平台历史身份重复；两者都需平台管理员处理。bridge 不会换 ID 规避冲突，也不会自动合并重复设备或
转移跨账号所有权。

可选的**工作目录白名单**——把任务执行收窄到指定目录：

```toml
allowed_cwd = ["/Users/me/work", "/Users/me/repos"]
```

配置后，`run_task` 的 `cwd` 若不在任一目录之下，bridge 会在 spawn 之前就拒绝，并回
`{"status":"failed","error":"工作目录不在允许范围内：…"}`。条目会被解析成绝对路径、按**目录边界**比较，
因此 `/Users/me/work-old` **不会**被 `/Users/me/work` 放行。不写这个键则保持原有行为（只校验目录存在）。

同时跑几个任务、允许多少个排队——默认 30 和 60：

```toml
max_tasks = 30
max_queue = 60   # 0 表示完全不排队
```

超出 `max_tasks` 的任务进入 FIFO 队列，有空位就依次启动；只有队列也满了，新任务才会立即失败
（`任务队列已满（并发 N，排队 M）`）。`timeoutMs` 从**入队**开始计时，避免任务在队列里等几小时再跑十分钟。
生效优先级：启动参数 `--max-tasks` / `--max-queue`（connect 与 serve 都支持）>
环境变量 `AGENT_BRIDGE_MAX_TASKS` / `AGENT_BRIDGE_MAX_QUEUE` > 配置文件 > 默认值。

CodeBuddy ACP：显式设置 `CODEBUDDY_AUTH_TOKEN` 后，`codebuddy-cli` 的 conversation/task 会优先走
ACP（原生 session、结构化权限请求）；未设置时保持 headless `codebuddy -p`，不会启动无认证子进程。

同一 `taskId` 的 `run_task` 重复下发是安全的：bridge 按 `taskId` 幂等 —— 未终态回当前状态快照、
已终态回放终态快照，绝不重复 spawn。设备的水位对平台透明：`hello.capacity` 携带生效额度，
此后每次调度变化都会推一条 `capacity_update { running, queued, maxTasks, maxQueued }`。

任务终态要不要回传 diff、以及要不要强制校验服务令牌：

```toml
diff_default = false          # true = 即使平台没下发 captureDiff 也捕获
diff_max_bytes = 262144       # diff 文本上限（默认 256 KB），AGENT_BRIDGE_DIFF_MAX_BYTES 可覆盖
require_service_token = false # true = 无有效服务令牌的任务一律拒绝（默认关闭以保持兼容）
```

## 安全边界

| 关注点         | 行为                                                                 |
| -------------- | -------------------------------------------------------------------- |
| API Key / 凭据 | 从不读取、从不上传，只上报「是否存在」                               |
| 能执行什么     | 仅限白名单内的工具类型，未知 `agentType` 在本地直接拒绝              |
| 怎么执行       | 参数以数组传入，不做 shell 拼接（Windows `.cmd` 垫片单独做引号处理） |
| 平台下发的 env | **不接受**：`run_task` 里的 `env` 一律忽略，子进程只用 bridge 自身的环境 |
| 并发           | 同时最多 `max_tasks` 个（默认 30），其余按 FIFO 排队（`max_queue` 默认 60），排满才失败；`timeoutMs` 从入队开始算 |
| 本地控制面     | 可选扩展，**默认关闭**；开启后只绑回环、强制 scoped Bearer、不返回 CORS 头 |
| 在哪里执行     | `cwd` 必须存在且是目录；可用 `allowed_cwd` 白名单进一步收窄范围      |
| diff 捕获      | 只在 `captureDiff: true`（或 `diff_default`）时跑一次 `git diff`；未跟踪文件用完即还原索引，不提交、不改动工作区 |
| 服务身份       | 服务令牌只存 SHA-256，按 scope 最小权限校验；`cancel_task` 需要 `task:cancel`，不是拿到 `task:create` 就能杀任务 |
| 失控进程       | 每个任务都有超时；取消先发 `SIGTERM`，2 秒后 `SIGKILL`               |
| 传输           | 仅 `wss://`，握手用 `Authorization: Bearer <device_token>` 鉴权      |
| Token 存储     | 本机 `0600` 文件；平台只保存其 SHA-256 哈希                          |
| 审计           | `~/.agent-bridge/audit.jsonl`（0600，单行 JSON），只记 id/scope/动作/结果，**不记令牌与凭据** |
| 吊销           | 被吊销的设备在下次握手即被拒绝（`4401`/`4403`，不会进入重连循环）    |

bridge 不持有超出启动它的系统用户的任何权限，**不开放任何入站端口**：唯一会监听的只有授权期间短暂的
`127.0.0.1` 回调，以及（在你**显式开启**之后）只绑 `127.0.0.1` 的本地控制面 —— 它不出网。

## 架构

```
┌──────────────────────────┐          出站 WSS              ┌────────────────────────┐
│  你的电脑                 │  ───────────────────────────▶   │  编排平台               │
│                          │                                 │                        │
│  agent-bridge            │  ◀── run_task / cancel / scan ──│  设备注册表             │
│   ├─ auth   (PKCE)       │  ─── hello / agent_list / ───▶  │  任务派发               │
│   ├─ scan   (适配器)      │      task_log / task_status     │  日志存储               │
│   ├─ runner (spawn)      │                                 │                        │
│   └─ config (~/.agent-…) │  可选：127.0.0.1 回调           │                        │
└──────────────────────────┘  （仅用于授权）                  └────────────────────────┘
            │
            └── 拉起 ──▶ claude / codex / dsh / gemini / …（用户自己的 CLI 与凭据）
```

| 模块                    | 职责                                                                   |
| ----------------------- | ---------------------------------------------------------------------- |
源码按**分层**组织，依赖只能**从外圈指向核心**：

```
cli.ts → cli/（参数 · 渲染 · 帮助 · 分发）→ commands/（一个命令一个文件）
       → app/（用例编排）→ { core, transport, adapters, infra }
```

`core`（领域）居中，外圈是 `transport` / `adapters` / `infra` 三种边缘；根目录只留入口与 wire 契约。
`src/cli.ts` **不放任何业务逻辑** —— 只把 argv 交给 `cli/dispatch.ts`（2026-10-23：548 行 → 31 行）。

| 模块                          | 职责                                                                   |
| ----------------------------- | ---------------------------------------------------------------------- |
| `src/cli.ts`                  | 只做入口：`argv → dispatch()` + 顶层错误兜底                            |
| `src/cli/dispatch.ts`         | 命令注册表（`COMMANDS`）：加命令改这里，不改入口                         |
| `src/cli/render.ts`           | 终端渲染：颜色、表格、`out.{info,ok,warn,error}`                        |
| `src/cli/flags.ts`            | 参数解析（`--k=v`、`--flag`、位置参数）                                 |
| `src/cli/help.ts` / `meta.ts` | 帮助文本 / 从 package.json 读版本                                       |
| `src/commands/*.ts`           | 一个命令一个文件（薄：取参数 → 调 `app/` → 打印）                       |
| `src/app/session.ts`          | 平台会话：初值上报、指令路由、在跑任务表                                 |
| `src/app/task-dispatch.ts`    | `run_task` / `cancel_task` 编排（鉴权 → 拉起 → 回传）                   |
| `src/app/service-gate.ts`     | 服务身份校验 + 审计（P0-8）                                            |
| `src/protocol.ts`             | wire 契约唯一真源（wire 类型只允许在这里定义一次）                     |
| `src/runner.ts`               | v1 兼容包装；新代码请引 `src/core/task-supervisor.ts`                   |
| `src/core/errors.ts`          | 受控错误码枚举 + `BridgeError`                                          |
| `src/core/redact.ts`          | 日志脱敏（家目录 → `~`、≥64 位长串折叠）                               |
| `src/core/emitter.ts`         | **唯一上行出口**：幂等、脱敏、审计、CloudEvents 信封                   |
| `src/core/task-supervisor.ts` | 任务调度领域对象（可实例化）：并发、队列、取消、超时                   |
| `src/core/scan.ts`            | 探测调度与 30 秒缓存                                                   |
| `src/transport/bridge-client.ts` | 出站 WebSocket：握手鉴权、心跳、退避重连、离线队列                  |
| `src/transport/outbox.ts`     | 断线期间的有界补发缓冲                                                 |
| `src/adapters/agent-adapters.ts` | 适配器表、二进制解析、版本与凭据探测                               |
| `src/adapters/win-exec.ts`    | Windows `.cmd` / `.bat` 垫片的正确引号处理                             |
| `src/adapters/agent-logos.ts` | 品牌图标（base64 data URI）                                            |
| `src/infra/config.ts`         | `config.toml` 读写（`0600`）、token 脱敏                               |
| `src/infra/auth.ts`           | 本地回调服务、PKCE S256、换取 token、设备码兜底                        |
| `src/infra/git.ts`            | 工作区差异捕获（只读、有上限、非 git 目录不报错）                      |
| `src/infra/service-token.ts`  | scoped 服务令牌：签发/校验/轮换/吊销，只存 SHA-256                     |
| `src/infra/audit.ts`          | 审计流水（`audit.jsonl`，单行 JSON，脱敏）                             |

协议（单连接上的 JSON 消息）：

| 协议 | 握手要求 | bridge 发布版本 |
| --- | --- | --- |
| **v1** | `PROTOCOL_VERSION = 1`（`hello.protocolVersion = 1`）；`deviceId` 为非空稳定 ID，且与 WS URL query 同值 | **1.0.0**（Session/Turn gateway 基线） |

| 方向          | 消息                                                                    |
| ------------- | ----------------------------------------------------------------------- |
| bridge → 平台 | `hello`、`agent_list`、`scan_progress`、`scan_result`、`task_log`、`task_status`、`task_step`、`task_message`、`task_artifact`、`task_snapshot`、`session_ack`、`message_ack`、`task_interaction_request`、`task_interaction_result`、`interaction_url`、`artifact_upload_ready`、`artifact_upload_chunk_ack`、`artifact_upload_result`、`artifact_download_ready`、`artifact_download_chunk`、`artifact_download_result`、`capacity_update`、`pong` |
| 平台 → bridge | `run_task`、`send_message`、`task_interaction_response`、`get_interaction_url`、`artifact_upload_start`、`artifact_upload_chunk`、`artifact_upload_complete`、`artifact_download_start`、`artifact_download_chunk_ack`、`cancel_task`、`close_session`、`cancel_turn`、`get_task`、`scan`、`ping` |

### 能力协商（hello.capabilities）

`hello` 带 `capabilities: string[]`，列出本机支持的**可选**能力。第三方平台据此降级，而不是靠 CLI 版本号猜：

| capability       | 含义                                                     |
| ---------------- | -------------------------------------------------------- |
| `diff`           | 支持 `run_task.captureDiff` 并在终态回传 unified diff     |
| `service-token`  | 支持 scoped 服务令牌与 `requestedBy` / `purpose` 透传     |
| `queue`          | 超出并发上限的任务排队而非拒绝（会先发 `running`）        |
| `scan-progress`  | 扫描过程流式回传 `scan_progress`                          |
| `cloud-events`   | 上行报文可包成 CloudEvents 1.0 信封（CNCF 标准）           |
| `capacity`       | `hello.capacity` 上报额度上限，调度变化时推 `capacity_update` |
| `task-step`      | 结构化工具实时回传 `task_step` 步骤流（能力分级见下）          |
| `task-message`   | 回传最终回答等 canonical `task_message`（带 eventSeq）       |
| `task-snapshot`  | 支持 `get_task` / `task_snapshot` 按 eventSeq 补取历史        |
| `session-control`| 支持 `close_session` / `cancel_turn` 与 `session_ack` 回执    |
| `session-multi-turn` | 支持 `send_message` / `message_ack`，conversation 回合间保持 waiting_user |
| `task-interaction` | 支持权限/Form/URL 交互请求、回复、结果与过期处理 |
| `artifact-upload` | 支持入站附件分块上传、SHA-256、CAS 与 task_artifact |
| `artifact-download` | 支持从 CAS 分块下载附件（ready/chunk/ack/result） |
| `interaction-url` | 支持 `get_interaction_url`，URL 仅进程内短期保存 |

### 步骤流（task_step）

具备结构化事件输出的工具会把**动态步骤流**实时上行（`seq` 递增、`ref` 配对 started/finished、
`label` 脱敏截断）。AI CLI 的步骤由模型实时决定，没有预定义总步数——平台拿到的是
「已发生的步骤序列 + 当前步骤」。能力按工具分级，并在 `agent_list` 逐项以 `steps: true/false` 如实标注：

| 级别 | 工具 | 说明 |
| --- | --- | --- |
| 结构化（`steps: true`） | 全部 12 个工具 | 按事件格式分 6 族解析（claude 同构 5 个、opencode 同构 2 个、codex / gemini / kimi / dsh / minimax 各一） |
| 纯文本（`steps: false`） | 无 | 降级位保留给未来不支持结构化输出的工具 |

⚠️ 行为变化：claude-code / codebuddy-cli / kimi-code / qoder-cli / trae-cli / ds-harness / minimax-code
的任务输出（`task_log`）从纯文本变为 **JSONL 事件流**（信息更全，`task_step` 提供结构化视图）；
codex / opencode / mimo-code / grok-cli / gemini 本来就是（或转为）JSONL。

演进规则：新增可选字段 = 协议版本不变；语义变更或新增必填字段 = 版本 +1。

### diff 捕获（P0-6）

平台下发的 `run_task` 带 `captureDiff: true` 时，bridge 在任务进入**终态**（success / failed / cancelled /
timeout）后在 `cwd` 上取一次差异，随 `task_status` 一起回传：

```json
{ "type": "run_task", "taskId": "bt_7f3a", "agentType": "codex", "cwd": "/Users/me/work/api", "args": [], "prompt": "修复失败的登录测试", "captureDiff": true }
```

```json
{ "type": "task_status", "taskId": "bt_7f3a", "status": "success", "exitCode": 0,
  "diff": "diff --git a/src/login.ts b/src/login.ts\n--- a/src/login.ts\n+++ b/src/login.ts\n@@ -1,3 +1,3 @@\n…",
  "changedFiles": ["src/login.ts"], "diffTruncated": false }
```

约束：非 git 目录返回空 diff **而不报错**；超过 `diff_max_bytes`（默认 256 KB）按**行边界**截断并置
`diffTruncated: true`；未跟踪的新文件会先 `git add -N` 再取 diff，取完立即 `git reset -q` 还原索引 ——
**不提交、不改动工作区、不留 intent-to-add 残留**。

### 服务身份与作用域（P0-8）

任何外部系统（编排平台后端、CI、IDE 插件）都可以用 scoped 服务令牌调用任务能力。令牌形态
`abs_<kid>_<secret>`，本地只存 `secret` 的 SHA-256，比对用恒定时间比较：

| scope          | 允许的动作                       |
| -------------- | -------------------------------- |
| `task:create`  | 下发 `run_task`                  |
| `task:cancel`  | 下发 `cancel_task`               |
| `task:read`    | 查询任务/扫描结果                |
| `device:read`  | 读取本机工具清单（`scan`）       |

`run_task` / `cancel_task` 可带 `requestedBy`（≤128 字符）、`purpose`（≤64 字符）、`serviceToken`；
bridge 会在终态 `task_status` 上**回显 `requestedBy`**，供平台落 `requested_by` 审计。

兼容策略：本地未登记令牌且 `require_service_token = false` 时，不带令牌的行为与 v1 完全一致；
**但报文一旦带了令牌就必须校验通过**，不存在"带了也跳过"的口子。

> **给平台侧的配套清单**（`/api/bridge/*` 的鉴权在平台侧，不属本仓库）：
> 1. `POST /api/bridge/tasks`、`GET /api/bridge/tasks/:id`、`POST /api/bridge/tasks/:id/cancel`
>    增加服务令牌校验分支（与用户令牌并列）；
> 2. 服务令牌绑定 project / user 范围，越权返回 403；
> 3. 下发 `run_task` 时透传 `requestedBy`，并把回显的 `requested_by` 写入 `bridge_task_runs`。

### 受控错误码

`task_status.error` 是人类可读串（可直接展示）；`task_status.errorCode` 是**受控**码，
给平台做程序化分支 —— 平台不必再靠匹配中文子串来判断失败原因：

| 码 | 含义 |
| --- | --- |
| `tool_not_installed` | kind 未知，或本机没装这个二进制 |
| `tool_no_credentials` | 装了但没有凭据 |
| `tool_broken` | 装了但 `--version` 执行失败 |
| `cwd_missing` / `cwd_not_allowed` | 目录不存在 / 不在 `allowed_cwd` 之内 |
| `device_busy` | 并发与队列都满 |
| `timeout` / `cancelled` | 超时（含排队超时）/ 被取消 |
| `agent_error` | CLI 非 0 退出，或进程启动失败 |
| `unauthorized` / `invalid_token` / `token_expired` / `insufficient_scope` | 服务令牌四类失败 |
| `protocol_incompatible` / `internal` | 版本不匹配 / bridge 自身异常 |

枚举真源在 `src/core/errors.ts`，镜像在 `contracts/asyncapi-3.0.yaml`；
`npm run contracts:check` 会在两者漂移时失败。

### 排队语义

超出并发上限的任务**排队**而不是失败。为了保持 v1 兼容，`status` 仍是 `running`，
排队中的任务额外带 `phase: 'queued'` 与 `queuePosition`（从 1 开始）。
忽略这两个字段的平台行为与之前完全一致。`timeoutMs` 从**入队**开始计时。

### 机器可读契约

散文会漂移，契约进 CI 机检。

| 文件 | 描述 |
| --- | --- |
| `contracts/asyncapi-3.0.yaml` | WebSocket 通道（双向、全部消息、错误码） |
| `contracts/openapi-3.1.yaml` | **平台必须实现**的 HTTP 端点（想驱动本 bridge 就看这份） |
| `contracts/openapi.control-plane.yaml` | 本地回环控制面（可选扩展，默认关闭） |
| `llms.txt` | 给 AI 客户端的入口索引 |

`npm run contracts:check` 会校验代码里的每个 wire 类型、能力、错误码与平台端点都确实被记载 —— 漂移即红。

### 本地回环控制面（可选扩展，默认关闭）

`agent-bridge serve <platformUrl> [--port=8787]` = `connect` **之外**再开一个只绑回环的 HTTP 控制面。
它服务的是**本机上的其它程序**（IDE 插件、脚本、MCP server、CI runner）；远程平台仍然走出站 WebSocket，
控制面是**另一条**通道，不是替代品。

| 规则 | 取值 |
| --- | --- |
| 绑定 | 只绑 `127.0.0.1` / `::1`，非回环直接在启动时拒绝 |
| 默认 | **关闭**。用 `[control_plane] enabled = true` 写进配置，或本次带 `--port` 临时开 |
| 鉴权 | scoped Bearer（`abs_<kid>_<secret>`，与 P0-8 同一套令牌）；`/v1/health` 与面板页壳 `/` 免鉴权；EventSource 场景允许 `?token=` 兜底（仅回环，勿外发）。**Web 面板零操作**：serve 启动时自动生成一个只读（task:read/device:read）内存令牌并拼进面板地址，进程退出即失效 |
| CORS | 一律不返回 —— 浏览器脚本无法静默调用本机端口 |
| 调度 | 任务走同一个 `TaskSupervisor`，`max_tasks` 对两条通道**同时**生效 |
| 上行 | 控制面下发的任务也经同一个 `Emitter` 回传，平台侧视图不会出现"半边失踪" |
| 面板 | `GET /` 内嵌 Web 任务面板（产品化任务表 + **结构化日志事件卡**（7 族事件归一化、工具调用与结果合并、原始 JSON 折叠）+ 执行待办 + 步骤时间线 + 结果预览；三个弹窗均支持 vw/vh 自适应与全屏；日志 600 条有界缓存、SSE 合帧渲染、后台标签页暂停轮询）；`GET /v1/board` 是其数据源（与终端面板同一注册表） |

| 方法 | 路径 | scope |
| --- | --- | --- |
| GET | `/` | 无（Web 任务面板壳；数据走 /v1/*） |
| GET | `/v1/health` | 无（存活/就绪/版本） |
| GET | `/v1/capabilities` | `device:read` |
| GET | `/v1/agents` | `device:read` |
| POST | `/v1/agents:scan` | `device:read` |
| GET | `/v1/board` | `task:read`（面板聚合视图：任务 + 计数 + 容量） |
| POST | `/v1/artifacts:gc` | `task:cancel`（显式 artifact TTL 清理，支持 dryRun） |
| GET | `/v1/sessions` | `task:read`（持久会话列表） |
| GET | `/v1/sessions/{id}` | `task:read`（会话快照 + eventSeq 窗口） |
| GET | `/v1/sessions/{id}/events` | `task:read`（SSE：回放 + 实时事件） |
| GET | `/v1/sessions/{id}/artifacts/{artifactId}` | `task:read`（附件流式下载） |
| POST | `/v1/tasks` | `task:create` |
| GET | `/v1/tasks` | `task:read`（游标分页） |
| GET | `/v1/tasks/{id}` | `task:read` |
| POST | `/v1/tasks/{id}:cancel` | `task:cancel`（幂等） |
| GET | `/v1/tasks/{id}/events` | `task:read`（SSE：日志 + 状态 + 步骤） |
| GET | `/v1/tasks/{id}/steps` | `task:read`（步骤时间线 + 最终回答） |
| GET | `/v1/tasks/{id}/file?path=` | `task:read`（产物文件预览：锁任务 cwd + allowed_cwd，≤512KB） |
| GET | `/v1/tasks/{id}/diff` | `task:read`（只取产物，不重跑任务） |
| GET | `/v1/tasks` | `task:read`（游标分页） |
| GET | `/v1/tasks/{id}` | `task:read` |
| POST | `/v1/tasks/{id}:cancel` | `task:cancel`（幂等） |
| GET | `/v1/tasks/{id}/events` | `task:read`（SSE：日志 + 状态） |
| GET | `/v1/tasks/{id}/diff` | `task:read`（只取产物，不重跑任务） |

```bash
agent-bridge services issue --label=vscode --scopes=task:create,task:read
curl --noproxy '*' -H "Authorization: Bearer abs_…" http://127.0.0.1:8787/v1/agents
curl --noproxy '*' -H "Authorization: Bearer abs_…" -H "Idempotency-Key: 3f9a…" \
  -d '{"agentType":"codex","cwd":"/work/api","prompt":"修复失败的登录测试","captureDiff":true}' \
  http://127.0.0.1:8787/v1/tasks
```

错误统一是 RFC 9457 `application/problem+json`，`code` 与协议层同一套受控枚举（客户端按 `code` 分支，
不用匹配文案）。`Idempotency-Key` 让重试的 `POST /v1/tasks` 返回同一个 `taskId`，不会跑两遍。
契约：`contracts/openapi.control-plane.yaml`。

### 扫描结果实时回传与品牌图标

探测 12 个 CLI 需要几秒，所以结果是**流式**回传而不是一次性丢出去：每有一个适配器探测完成，bridge 就发一条
`scan_progress`（`items` 为刚完成的项，`done: false`）；全部完成后发一条 `done: true` 收尾，再发终态清单
（首连是 `agent_list`，响应 `scan` 则是带同一 `requestId` 的 `scan_result`）。忽略 `scan_progress` 的平台
仍能拿到完整清单。

每一项都带卡片需要的四要素：`display`（工具名）、`version`（版本）、`status`（状态）、`logo`（品牌图标）——
`logo` 是 `data:image/svg+xml;base64,…` 的矢量图标，统一 **24×24 画布**（内容内缩到 20×20，保留官方品牌色），
取自 `assets/agent-icons/<kind>.svg` 里的官方商标副本。同一批图标会在每条消息里重复（12 个合计约 70 KB），
平台请按 `kind` 缓存，不要每帧重新解析；资产缺失时字段直接省略。

### 断线期间的日志

连接断开时产生的 `task_log` 不再被丢弃，而是先缓冲：每次断线最多 256 KB（超出时丢最旧的，控制类消息另有一条
有界队列）。重连后按原顺序补发；若缓冲溢出，补发开头会先来一条
`[agent-bridge] 断线期间日志超出缓冲上限（N KB），已丢弃较早部分` —— 缺口不会静默。

## 案例

**绑定一台笔记本并确认在线**

```bash
$ agent-bridge connect https://platform.example.com
[agent-bridge] 开始设备授权…
[agent-bridge] 已打开浏览器，若无反应请手动访问：
  https://platform.example.com/bridge/authorize?code_challenge=…
✅ 设备绑定成功（bd_9f1c…），配置已写入 ~/.agent-bridge/config.toml
[agent-bridge] 已连接平台
[agent-bridge] 已上报 12 个工具状态，等待平台任务…
```

**不连平台，只看本机**（排查问题时很好用）

```bash
$ agent-bridge status --json | jq -r '.agents[] | select(.status=="ready") | .display'
Claude Code
Codex
DeepSeek Harness
```

**让平台在这台机器上跑一个任务**

平台下发：

```json
{
  "type": "run_task",
  "taskId": "bt_7f3a",
  "agentType": "codex",
  "cwd": "/Users/me/work/api",
  "args": [],
  "prompt": "修复登录用例失败的问题"
}
```

`args` 是协议必填字段。想用适配器自带的参数模板时也要发 `"args": []`，bridge 会把上面的 `prompt`
代入模板（这里是 `codex exec --json {{prompt}}`）。漏掉 `args` 会被本地校验直接拒帧。

bridge 校验适配器与目录后拉起 CLI，并实时回传：

```json
{ "type": "task_log",    "taskId": "bt_7f3a", "stream": "stdout", "data": "…", "isAnsi": true }
{ "type": "task_status", "taskId": "bt_7f3a", "status": "success", "exitCode": 0 }
```

**解绑本机**

```bash
$ agent-bridge logout
✅ 已清除本地设备凭证（bd_9f1c…）
```

## 开发

```bash
npm ci
npm run build         # tsc → dist/
npm test              # 单元测试（协议、引号处理、探测）
npm run typecheck
npm run dev status    # 用 tsx 直接跑 TypeScript
npm start             # 先构建再跑 dist/（等同全局安装后的行为）
```

目录结构：

```
src/
  cli.ts               入口：argv → cli/dispatch.ts，其它一概不放
  protocol.ts          wire 契约（唯一真源）
  runner.ts            v1 兼容包装 → core/task-supervisor.ts
  cli/                 参数解析 · 终端渲染 · 帮助 · 命令注册表
  commands/            一个命令一个文件（connect/status/logout/services/daemon）
  app/                 用例编排：会话 · 任务指令 · 服务身份校验
  core/                领域：调度 · 上行出口 · 脱敏 · 错误码 · 探测
  transport/           出站 WebSocket + 有界断线补发
  adapters/            12 个 CLI 适配器 · Windows 垫片引号 · 图标
  infra/               配置 · 授权 · git diff · 服务令牌 · 审计
test/
  bridge.test.ts       单元测试
```

新增一个适配器：在 `src/adapters/agent-adapters.ts` 的 `AGENTS` 里加一条（二进制名、展示名、能力类型、任务参数模板、凭据判据），
传输与调度层无需改动。

### 发布

版本号由**提交信息**决定，不由人决定。把一条
[Conventional Commit](https://www.conventionalcommits.org/) 合进 `main`，
[`.github/workflows/release.yml`](./.github/workflows/release.yml) 会把剩下的事做完：

| 提交 | 升位 |
| --- | --- |
| `feat: …` | minor |
| `fix: …` | patch |
| `feat!: …` / `BREAKING CHANGE:` | major —— 需人工审批，且必须在同一个提交里递增 `PROTOCOL_VERSION` |
| `docs` `chore` `test` `refactor` `style` `ci` `build` | 完全不发布 |

随后 semantic-release 升 `package.json` 版本、写回 `CHANGELOG.md`、打 `v<version>` tag、创建 GitHub Release
并发布到 npm。它需要两个仓库 secret：`AGENT_BRIDGE_NPM_TOKEN`（npm automation token）与默认的 `GITHUB_TOKEN`。
本地 `commit-msg` 会先跑 commitlint —— 写错的提交信息在产生错误版本号之前就被拦下。

**不要手工打 tag** —— 手工的 `v1.2.3` 会和 semantic-release 抢同一个版本号。
文档站（`.github/workflows/site.yml`）在每次 `main` 推送后重建，它的版本历史页由**同一个** `CHANGELOG.md`
在构建期渲染 —— 一处真源，两处呈现。
有个坑值得知道：用 `GITHUB_TOKEN` 推送的提交**不会**触发新的 workflow，所以 `release.yml` 在最后
显式 dispatch 一次 `site.yml`；少了这一步，版本历史页会永远落后一个版本。

离线验证发布链路（不需要 token、不联网、不写仓库）：

```bash
node scripts/verify-release.mjs   # 拿 v0.1.0..HEAD 的真实提交跑一遍 notes 生成 + CHANGELOG 写入
```

## 许可证

MIT —— 见 [LICENSE](./LICENSE)。
