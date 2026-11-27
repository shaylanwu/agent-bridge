# agent-bridge-service

把本机已安装的 AI Agent 接入远程编排平台 —— 只靠一条**出站** WebSocket。不需要开入站端口、不需要反向穿透，API Key 始终留在本机。

[English](README.md) · **简体中文**

📚 **文档站（中英双语，支持全文搜索）：<https://shaylanwu.github.io/agent-bridge/>**
—— 协议参考、CLI 参考，以及两条对接指南（平台方 / 本机程序）。内容由同一批机器可读契约生成，因此不会与代码漂移。

---

## 简介

AI 编码 Agent（Claude Code、Codex、Antigravity CLI 等）装在开发者的电脑上。网页平台看不到它们：浏览器沙箱拿不到
`PATH`、可执行文件和凭据存储；平台部署在别处，也连不进 NAT 后面的笔记本。

`agent-bridge-service` 补上这一环：它运行在拥有这些 CLI 的机器上，向平台保持一条出站 WebSocket，
回答三个平台自己永远回答不了的问题：

1. **这台机器装了什么？** —— 真实探测本地 `PATH` 与常见安装目录。
2. **装了能不能用？** —— 区分「已安装」「已安装但缺凭据」「已安装但跑不起来」。
3. **能不能帮我跑一下？** —— 在受控工作目录里执行白名单内的 CLI，并实时把输出回传。

这个包是自包含的：运行时只依赖 `ws` 和 `smol-toml`，通过一个小型 JSON 协议（HTTP + WebSocket）与平台通信。

## 功能

- **内置 12 个适配器** —— Claude Code、CodeBuddy CLI、Codex、DeepSeek Harness、Antigravity CLI、opencode、Mimo Code、
  Qoder CLI、Grok Build、Kimi Code、MiniMax Code、Trae CLI。
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

要求：**Node.js 24.x**，支持 macOS / Linux / Windows。

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

# 持久授权账本（1.0）：只有 approval_ledger_enabled = true 时才会写入
agent-bridge approvals list            # 加 --all 连已撤销的一起列出
agent-bridge approvals revoke ap_7c31f0d2a4b8   # 撤销后该指纹不再自动批准
agent-bridge approvals purge           # 清理过期记录

# 会话历史（1.0）：session_deleted(410) 的唯一产生点 —— close_session 只关闭、保留历史
agent-bridge sessions list                        # 会话 + 事件区间 + 最后更新时间
agent-bridge sessions purge --session=tk_9f1c2a   # 删除一个已终结的会话
agent-bridge sessions purge --older-than=14       # 删除闲置 14 天以上的已终结会话
```

> `agent-bridge daemon start <platformUrl>` / `stop` / `status` 提供轻量后台进程管理（detached + PID +
> `daemon.log`）。`install` / `uninstall` 注册当前用户服务：Linux systemd user、macOS LaunchAgent、
> Windows 登录计划任务；均支持 `--dry-run` 先看将写入的命令/定义。

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
DeepSeek Harness   0.2.1-rc.2           就绪
Antigravity CLI     1.5.9                就绪
opencode           1.19.3               缺凭据
Qoder CLI          1.1.75               就绪
MiniMax Code       -                    装坏
Kimi Code          -                    未装

共 12 个工具，可用 5 个
```

凭据证据来自环境变量、已知凭据文件或适配器显式登记的 OS keyring 目标。agy 在 Windows 上探测
`gemini:antigravity`，只上报 `credentialSource = "keyring:gemini:antigravity"`；不会读取或上传秘密。
Qoder 探测 `~/.qoder/.auth/user` / `QODER_PERSONAL_ACCESS_TOKEN`；opencode 认官方登录态
`~/.local/share/opencode/auth.json`，也认 `~/.config/opencode/opencode.json` 里自定义 provider 的
apiKey 配置；kimi 探测 oauth 登录态 `~/.kimi-code/credentials/kimi-code.json` 与自定义 provider
配置 `~/.kimi-code/config.toml`；minimax 探测 mcode 的 oauth 登录态
`~/.minimax/auth/prod/cn/mcode-public/auth.json` 与 provider 配置 `~/.minimax/config.yaml`；Trae 使用 `TRAECLI_PERSONAL_ACCESS_TOKEN`
或官方 `traecli login status` 的退出码，不再把安装目录当成登录凭据，状态命令输出不上报。注意：trae-cli 0.121.3
不含 `login` 子命令——认证走 Trae IDE 团队/企业登录写入的 OS keyring，或上面的 PAT 环境变量；两者都没有时任何
模型任务都无法运行。

agy 与 codex 的外部请求可用 `AGENT_BRIDGE_EXTERNAL_PROXY` 显式指定代理；未指定时，Windows 自动读取当前用户
系统代理；设为 `off`（或 `none`）则不注入任何代理、直连。这避免 WorkBuddy 进程代理与系统代理不一致导致
Google API 502，也避免 codex 的 responses WebSocket 走直连时空转约 113s；不会把本机端口写死进代码。
agy 1.5.9 起声明 ACP，旧版只保留 headless；已实测首轮和原生续接，未逐项实测的 permission/form 不声明。

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

**权限模式**（`permissionMode`）：平台可以在 `run_task` 里请求 `default` 或 `full`，**能不能给由本机决定**：

```toml
permission_policy = "default"   # default | allow-full | full
external_sandbox = false        # 仅 CodeBuddy 的 full 需要
```

| permission_policy | 平台不写 | 请求 default | 请求 full |
| --- | --- | --- | --- |
| `default`（默认） | default | default | **拒绝**（`permission_policy_denied`） |
| `allow-full` | default | default | 满足条件则 full |
| `full` | full | default | 满足条件则 full |

`allow-full` / `full` 同时进入**受管参数模式**：平台只能发空 `args`，argv 完全由适配器模板决定
（发了非空 args 直接 `permission_policy_denied`，不因参数看似普通而放行）。full 只是换一套参数，
**不是** OS 提权、配置隔离或环境沙箱的证明；工具缺 full 映射、或 CodeBuddy 未声明 `external_sandbox = true` 时，
请求会被 `permission_mode_unsupported` 拒绝，**不会**偷偷降级成 default 继续跑。
启动参数 `--permission-policy=` / `--external-sandbox` 可临时覆盖配置。

### 逐工具能力矩阵

`agent_list` 如实标注每项能力 —— **省略即「未验证」，不是「假定能跑」**：

| agentType | full 参数 | 执行模式 | 续会话 |
| --- | --- | --- | --- |
| `claude-code` | `--dangerously-skip-permissions` | headless | 原生 `--resume` |
| `codebuddy-cli` | `-y`（+ 固定 `CODEBUDDY_IS_SANDBOX=1`，需 `external_sandbox = true`） | headless、ACP | 原生 `--resume` |
| `codex` | `--dangerously-bypass-approvals-and-sandbox` | headless | app-server 线程 |
| `ds-harness` | `--permission-mode danger-full-access --approval-policy never` | headless、ACP | 原生 `--session-id` / ACP `session/resume` |
| `agy` | `--dangerously-skip-permissions` | headless、ACP | 原生 `--conversation` / ACP 会话 |
| `opencode` | `--auto` | headless、ACP | ACP 会话 |
| `mimo-code` | `--dangerously-skip-permissions` | headless、ACP | ACP 会话 |
| `qoder-cli` | `--dangerously-skip-permissions` | headless | 原生 `--resume` |
| `grok-cli` | `--always-approve` | headless、ACP | 原生 `--resume` / ACP 会话 |
| `kimi-code` | *（不追加 —— `-p` 已是 auto）* | headless、ACP | ACP 会话 |
| `minimax-code` | `--permission full` | headless、ACP | ACP 会话 |
| `trae-cli` | `--yolo` | headless、ACP | ACP 会话 |

ACP 模式恒为 `default`（走原生权限确认，不用绕过参数），所以 `full` 请求要么走 headless、要么被拒绝，
不会悄悄降级。agy 的 full 旗标使用专用模板放在 `-p` 之前，确保 prompt 始终位于 argv 末尾。
full conversation 使用受管 headless + 完整 canonical transcript 重放；default 的后续 `send_message` 回合按上表通道续会话，
只有没有可用续会话通道时才重放 transcript。

有两条内部通道**不单列为 `executionMode`**，因为通道是 bridge 自选的（`run_task` 没有 `executionMode` 字段）：
codex 的会话走 app-server `thread/resume`，Claude 走常驻 stream-json 进程；Qoder 走 headless + 原生 `--resume`。它们写在上表里而不编码成
`executionMode` 取值，并且**至少不弱于**它替代的那个模式所声明的 continuation —— 声明只会保守，不会夸大。
7 个本机无凭据工具的 ACP `native-session` 依据是 ACP 规范 + `codebuddy`/`ds-harness` 的实测，不是逐个实测；
若某个 agent 连 `session/load` 与 `session/resume` 都不认，该回合会开新会话**并把完整 transcript 当首轮
prompt 发过去**，不会出现「看着成功、其实历史没了」的新会话。

`AgentListItem.capability`（`non_interactive` / `interactive_only`）是留给旧平台的 0.x 展示标签 ——
标成 `interactive_only` 的多数工具在这里其实能跑 headless。**能力以 `executionModes` 为准**，
`capability` 只用于文案。

### `executionModes` 字段口径

每个元素描述某个工具的一种执行模式。字段缺省 = 「只有 headless，能力等同旧标签」；所有维度都**逐模式**
上报，因为同一工具的 headless 与 ACP 能做的事实上不一样：

| 字段 | 取值 | 含义 |
| --- | --- | --- |
| `mode` | `headless`、`acp-stdio` | 这个模式怎么跑 |
| `permissionModes` | `default`、`full` | 该模式真正能提供的权限模式；不含 `full` 时，`full` 请求在 spawn 前被拒（`permission_mode_unsupported`），不会降级 |
| `interactionKinds` | `permission`、`form`、`auth-url` | 该模式能中转的交互种类；`[]` 是「不能问」，不是「未知」——平台不要等 |
| `feedKinds` | `messages`、`steps`、`artifacts` | 该模式实际能提取的 canonical 维度 |
| `continuation` | `native-session`、`resume-session`、`replay-session`、`single-turn` | 后续回合怎么接回本会话：会话由 agent 持有（`session/load`、`session/resume`、app-server `thread/resume`）、靠 CLI 的续接参数接上、把完整持久 transcript 当 prompt 重放、或 CLI 根本不接受后续 prompt。这里 12 个工具**至少都是 `replay-session`**；若某工具是 `single-turn`，`sessionMode = conversation` 会在**创建时**回 `session_not_continuable`，不会先接受再失败 |

三者是三层不同的事实：`hello.capabilities` 是**构建能力**（这个二进制能不能做）、`hello.execution` 是
**本机策略**（这台机器允不允许）、`executionModes` 是**逐工具能力**（这个工具、这个模式下真的能做）。
平台要三者一起看，才能挑出不会跑到一半才失败的组合。

**交互（权限确认 / 表单 / 授权 URL）默认关闭**：关着时 bridge 不会向平台发任何
`task_interaction_request`，上游拿不到回答会自行按拒绝或取消处理 —— 这比让平台干等一个永远不会来的问题要好：

```toml
interaction_enabled = false      # true 才开放交互往返
interaction_timeout_ms = 900000  # 单次等待上限（默认 15 分钟，夹 10 秒 ~ 2 小时）
max_interactions_per_task = 16   # 单任务交互次数上限（默认 16，夹 1 ~ 256）
```

适配器自带的 `expiresAt` 与 `interaction_timeout_ms` 取**较小值**；超过次数上限的请求直接不转发并记日志。
启动参数 `--interaction-enabled` / `--interaction-timeout-ms=` / `--max-interactions-per-task=` 可临时覆盖。

`hello.execution` 会把本机实际策略（`permissionPolicy` / `externalSandbox` / `interactionEnabled` /
`interactionTimeoutMs` / `maxInteractionsPerTask` / `approvalLedgerEnabled`）如实上报，平台据此决定能不能
请求 full、要不要等交互。

**持久授权默认关闭**，且只能由人工回答产生：

```toml
approval_ledger_enabled = false   # true 才记住「永久允许」的回答
approval_ttl_ms = 604800000       # 7 天（夹 1 分钟 ~ 90 天）
```

开启后，交互里选 `allow_always` 会连同 tenant/principal/agent/tool/resource/scope 与到期时间一起落库 ——
但**响应方还必须在 `task:approve` 之外持有 `approval:persist`**；不满足时该回答只对当前会话有效、
不被记住（审计记 `approval_grant` + `outcome=denied`）。后续自动批准必须**同时**满足：模式是 `default`、
请求本身真的提供了持久允许选项、指纹（agent + 工具类别 + 归一化资源）命中未过期记录。
`full` 模式永不用账本，模型文本与工具标题也不会创建或扩大授权。**没有可归一化资源的请求**（`toolCall`
里既无路径、也无命令/URL）一律不自动批准、也不写入账本 —— 否则一条授权会静默覆盖该工具所有无名调用。
查看与撤销：`agent-bridge approvals list` / `agent-bridge approvals revoke <approvalId>`
（审计记 `approval_hit` / `approval_revoke`）。

**事件历史按条数封顶，不按天数**，长会话不会把状态库撑爆：

```toml
event_retention_max_events = 5000   # 单会话事件上限（0 = 全留，上限 1000000）
```

裁剪是惰性的 —— 每写入第 100 条事件时把该会话裁回最新 `event_retention_max_events` 条。裁剪水位会持久化，
所以 `eventSeq` 始终单调递增，被裁掉的号**不会重新发放**。只裁事件：turns / artifacts / interactions 是
「任务发生过」的证据，一律保留。启动参数 `--event-retention-max-events=` 可临时覆盖。

**在按条数保留之上，canonical feed 还有 per-task 预算**（默认策略而非产品硬上限 —— 用 `[feed]` 段逐维调整或关闭）：

```toml
[feed]
max_messages     = 200        # 每会话保留的最新 task_message 条数（0 = 关闭该维）
max_steps        = 200        # 每会话保留的最新 task_step 条数（0 = 关闭该维）
max_artifacts    = 50         # 每会话保留的最新 task_artifact 条数（0 = 关闭该维）
task_max_bytes   = 4194304    # 单会话事件 payload 总字节预算（0 = 关闭该维）
global_max_bytes = 67108864   # 全库事件 payload 总字节预算（0 = 关闭该维）
```

不写该段 = 使用上述默认值；单维写 0 = 只关这一维。淘汰**永不触碰**各会话最新终态 `task_status`
与最新一条事件（pending 交互在独立表，天然不受影响）。窗口内的淘汰显式可见：
`eventWindow.gaps` 的元素带 `reason: count | task_bytes | global_bytes`；
前缀删除则推进 `prunedThrough`（旧游标会收到 `session_history_pruned`，而不是被静默挖洞）。

**打开状态库时先跑一次 `PRAGMA quick_check`**（`SessionStore` 的 `integrityCheck`，缺省开启，可显式关闭）。
理由不是洁癖：损坏的 SQLite 文件通常**能正常打开**、schema 也读得出来，只是跑到一半读页失败 ——
那种现场是「任务执行到一半报内部错误」，几乎无法排查。自检把故障提前到启动：不合格就拒绝启动，
不降级到内存库。实测 22 MB 库自检耗时约 19 ms（跳过则 1.7 ms），所以默认开。
口径要精确：`quick_check` 抓的是**结构**损坏（页头、b-tree、索引），正文里被改写的字节它不校验。
随时复查：`GET /v1/health?integrity=quick` 会重跑一次并在响应里带 `db: { ok, detail? }`。

因此 `get_task` 有三种游标形态，语义各不相同：

| 请求 | 返回 | 用途 |
| --- | --- | --- |
| 不给游标 | 最新 `limit` 条（尾部窗口） | 刷新页面后重建当前状态 |
| `afterEventSeq` | 严格大于游标、升序 | 断线重连后补洞 |
| `beforeEventSeq` | 严格小于游标的最新 `limit` 条，升序 | 往回翻历史 |

`hasMoreBefore` 说明返回窗口之前还有没有内容（长会话的尾部窗口会是 `true`）。游标落在被裁剪的区间时，`get_task` 仍回 `found: true`，但附 `errorCode: "session_history_pruned"` 与 `prunedThrough`，
含义是「更早的部分已回收，这里才是保留起点」，不是「任务到此为止」。同时给 `afterEventSeq` 与
`beforeEventSeq` 会被明确拒绝（`protocol_incompatible`），不会静默挑一个。`close_session` 之后会话**仍可读**，
只有被删除的才回 `session_deleted`（410），而删除只能由 `agent-bridge sessions purge` 触发：
`task_not_found` 是「从没存在过」，`session_deleted` 是「放弃重试、别再发」。

**半截文本走 `partialMessages`，不走事件表**。助手文本通常只在回合结束时作为一条 `state: "complete"`
的 `task_message` 落库，中途刷新会一个字都看不到。所以快照额外带「本回合已累积的助手文本」，id 是
`pm_<taskId>`（刻意不是 `msg_*` 幂等键），上限 32 KiB（到顶置 `truncated`）。它**只在内存里、绝不写 SQLite**：
流式 chunk 是 token 级的，落库会让事件表被文本淹掉、retention 反过来把真事件挤掉。回合终态即清空 ——
那时该读事件里的 complete。没有流式文本通道的适配器（headless）这里就是空的，属如实缺省。

需要说清的不对称：bridge 目前**不**推送 `state: "delta"` 的 `task_message`。实时流只有 `task_log` 分片
与 `task_step`；结构化地看「正在写的文本」只有快照里的 `partialMessages`。`delta` 请当作保留位，
不要等它。

ACP：`codebuddy-cli`、`ds-harness`、`agy`、`opencode`、`mimo-code`、`kimi-code`、`minimax-code`、
`grok-cli`、`trae-cli` 声明了原生 ACP，conversation/task 会优先走 ACP（原生 session、结构化权限请求）。
`ds-harness` 在这条通道上是 **automation-only**（实测）：跑工具只发 `tool_call`、从不回问权限，所以它的
`executionModes.interactionKinds` 声明为空数组；续会话靠自家的 `session/resume`，标准 `session/load`
会回 `-32601 Method not found`（客户端先试 load 再退 resume）。
`codex` 走 `codex app-server` JSON-RPC（thread/resume、turn/steer，审批请求经
`item/*/requestApproval` 接通——但**本机尚未取到真 CLI 的审批证据**，见下面交互闭环段）；Claude 的
conversation 保持常驻 `stream-json` 进程（Turn 间复用）；Qoder 用 headless + 原生 `--resume`，其余工具保持各自已声明通道。
CodeBuddy 优先用显式 `CODEBUDDY_AUTH_TOKEN`；未设置时从本机 CodeBuddyExtension 的明文
`auth/*.info` 读取登录态并注入 ACP 子进程。两者都没有时回落 `codebuddy -p`，不会启动无认证子进程。

同一 `taskId` 的 `run_task` 重复下发是安全的：bridge 按 `taskId` 幂等 —— 未终态回当前状态快照、
已终态回放终态快照，绝不重复 spawn。设备的水位对平台透明：`hello.capacity` 携带生效额度，
此后每次调度变化都会推一条 `capacity_update { running, queued, maxTasks, maxQueued }`。

任务终态要不要回传 diff、以及要不要强制校验服务令牌：

```toml
diff_default = false          # true = 即使平台没下发 captureDiff 也捕获
diff_max_bytes = 262144       # diff 文本上限（默认 256 KB），AGENT_BRIDGE_DIFF_MAX_BYTES 可覆盖
require_service_token = false # true = 无有效服务令牌的任务一律拒绝（默认关闭以保持兼容）
session_idle_ms = 0           # waiting_user 空闲关闭（0=不关闭；AGENT_BRIDGE_SESSION_IDLE_MS 可覆盖）

# 本机 MCP server 宿主（stdio）。平台 Form 链路还需选定 MCP 代理/ACP 扩展通道。
[mcp.servers.echo]
command = "node"
args = ["mcp-server.js"]
cwd = "."
[mcp.servers.echo.env]
NODE_ENV = "production"
```

## 安全边界

| 关注点         | 行为                                                                 |
| -------------- | -------------------------------------------------------------------- |
| API Key / 凭据 | 从不读取、从不上传，只上报「是否存在」                               |
| 能执行什么     | 仅限白名单内的工具类型，未知 `agentType` 在本地直接拒绝              |
| 怎么执行       | 参数以数组传入，不做 shell 拼接（Windows `.cmd` 垫片单独做引号处理） |
| 平台下发的 env | **不接受**：`run_task` 里的 `env` 一律忽略，子进程只用 bridge 自身的环境 |
| 并发           | 同时最多 `max_tasks` 个（默认 30），其余按 FIFO 排队（`max_queue` 默认 60），排满才失败；`timeoutMs` 从入队开始算 |
| 本地控制面     | `connect` 默认在 `127.0.0.1:8787` 启动 Web 面板（占用自动顺延）；只绑回环、强制 scoped Bearer、不返回 CORS 头 |
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
            └── 拉起 ──▶ claude / codex / dsh / agy / …（用户自己的 CLI 与凭据）
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
| bridge → 平台 | `hello`、`agent_list`、`scan_progress`、`scan_result`、`task_log`、`task_status`、`task_step`、`task_message`、`task_artifact`、`task_snapshot`、`artifact_content`、`session_ack`、`message_ack`、`task_interaction_request`、`task_interaction_result`、`interaction_url`、`artifact_upload_ready`、`artifact_upload_chunk_ack`、`artifact_upload_result`、`artifact_download_ready`、`artifact_download_chunk`、`artifact_download_result`、`artifact_transfer_status`、`capacity_update`、`pong` |
| 平台 → bridge | `run_task`、`send_message`、`task_interaction_response`、`get_interaction_url`、`get_artifact`、`artifact_upload_start`、`artifact_upload_chunk`、`artifact_upload_complete`、`artifact_download_start`、`artifact_download_chunk_ack`、`artifact_transfer_status`、`artifact_transfer_abort`、`cancel_task`、`close_session`、`cancel_turn`、`get_task`、`scan`、`ping` |

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
| `session-feed`   | 跨回合 canonical 会话流：`task_message` / `task_step` / `task_artifact` 共用一条 `eventSeq`，可用 `get_task` 补洞与回翻，不必解析 `task_log` |
| `task-interaction` | 支持权限/Form/URL 交互请求、回复、结果与过期处理 |
| `elicitation-form` | 支持中转 agent 表单请求（`session/request_form` 与标准 ACP `elicitation/create`），结构化答案原路回传 |
| `artifact-upload` | 支持入站附件分块上传、SHA-256、CAS 与 task_artifact |
| `artifact-download` | 支持从 CAS 分块下载附件（ready/chunk/ack/result） |
| `interaction-url` | 支持 `get_interaction_url`，URL 仅进程内短期保存 |
| `permission-mode` | 支持 `run_task.permissionMode`（本机 `permission_policy` 仍可否决，不代表一定能给 full） |
| `artifact-inline` | 支持 `get_artifact` 内联取回附件内容（超过 1 MB 回 `too_large`，改走分块下载） |
| `approval-ledger` | 持久授权账本：交互里选「永久允许」可被记住（限 default 模式、指纹匹配、带过期），可用 `agent-bridge approvals revoke` 撤销 |

### 步骤流（task_step）

具备结构化事件输出的工具会把**动态步骤流**实时上行（`seq` 递增、`ref` 配对 started/finished、
`label` 脱敏截断）。AI CLI 的步骤由模型实时决定，没有预定义总步数——平台拿到的是
「已发生的步骤序列 + 当前步骤」。能力按工具分级，并在 `agent_list` 逐项以 `steps: true/false` 如实标注：

| 级别 | 工具 | 说明 |
| --- | --- | --- |
| 结构化（`steps: true`） | 全部 12 个工具 | 按事件格式分 7 族解析（claude 同构 5 个、opencode 同构 2 个、codex / agy / kimi / dsh / minimax 各一） |
| 纯文本（`steps: false`） | 无 | 降级位保留给未来不支持结构化输出的工具 |

⚠️ 行为变化：claude-code / codebuddy-cli / kimi-code / qoder-cli / trae-cli / ds-harness / minimax-code
的任务输出（`task_log`）从纯文本变为 **JSONL 事件流**（信息更全，`task_step` 提供结构化视图）；
codex / opencode / mimo-code / grok-cli / agy 本来就是（或转为）JSONL。

**富 `toolCall`（可选字段）**：步骤可携带规范化的工具调用子集 —— `toolCallId` / `name` /
`kind`（ACP 的 `read|edit|delete|move|search|execute|think|fetch|switch_mode|other`）/
`title` / `status` / `locations`（路径）/ `content`（有界 `text|diff|terminal` 块，单块 16KB、
上行出口脱敏）。`rawInput` / `rawOutput` **绝不上行**；无法可靠提取的适配器省略该字段、
保留 legacy 字段。当前来源：ACP `tool_call` 更新（原生字段直传）与 claude 同构解析器族
（工具名→kind 映射 + `file_path`/`path` 进 locations + `tool_result` 输出映射 terminal 块）。

**中间 agent 消息**：headless 结构化输出里的 assistant 文本块现在成为 canonical `task_message`
事件（`state: "complete"`，每条 assistant 消息一条，CLI 提供原生 `messageId` 时优先使用），
不再只埋在 `task_log` 里。thinking 块不进消息；流式增量仍走内存 `partialMessages` 通道。

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

**变更文件生成产物元数据事件（4.9）**：带 `captureDiff` 的任务终态时，每个仍存在（且通过下方路径安全
检查）的变更文件会作为 `task_artifact` 事件上行（`kind: "output"`、`source: "agent"`、`name`、
`mimeType`、`size` —— 仅 stat 元数据）。内容**刻意不读**：没有 adapter 明确声明的 artifact 事件时
bridge 只发元数据 —— `sha256` 省略，`contentUnavailableReason: "no_adapter_artifact_event"` 显式说明
原因；对此类 artifactId 的 `get_artifact` 如实回 `artifact_not_found`。凭据路径、`..`、绝对路径、
目录与符号链接逃逸连名字都不上行。

**产物读取的路径安全**（内容读取的前提，现在与未来的 adapter 事件通道一致）：读取根是**该任务自身
cwd 的 realpath 子树**（`allowed_cwd` 只决定任务能否启动）；realpath 解析后必须仍在根内 —— `..`、
绝对路径、目录、凭据位置（`.ssh`、`.aws`、`.env`、`id_rsa` 等）一律拒绝；文件只打开一次，同一 fd
上 `fstat` 定尺寸并流式读取计算 SHA-256（POSIX 有 `O_NOFOLLOW` 处用之；Windows 以 realpath 前置
检查 + 单 fd 读取为等价实现）。inline 上限内随消息上行；超上限只给 size/sha256 —— 大内容走分块
artifact transfer，绝不塞进消息体。**不扫描工作区**。

### 服务身份与作用域（P0-8）

任何外部系统（编排平台后端、CI、IDE 插件）都可以用 scoped 服务令牌调用任务能力。令牌形态
`abs_<kid>_<secret>`，本地只存 `secret` 的 SHA-256，比对用恒定时间比较：

| scope          | 允许的动作                       |
| -------------- | -------------------------------- |
| `task:create`  | 下发 `run_task`                  |
| `task:cancel`  | 下发 `cancel_task` / `cancel_turn` / `close_session` |
| `task:read`    | 查询任务/扫描结果                |
| `session:read` | 只读会话、事件与交互（拿不到任务输出与 diff）—— 看板与审批 UI 用这一条 |
| `task:approve` | 回答 `permission` 交互（`task_interaction_response`、`POST /v1/interactions/{id}:respond`） |
| `task:respond` | 回答 `form` / `auth-url` 交互    |
| `approval:persist` | 允许该回答写进持久授权账本（影响未来任务，因此单独一条） |
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
| `interaction_delivery_unknown` | 无法确认交互响应是否写入 adapter；交互置为 failed、回合终止且禁止重试 |
| `interaction_invalid_response` / `interaction_response_conflict` | 响应校验失败 / 幂等键或已结算响应冲突 |
| `interaction_timeout` | 单次交互等待到期且 options 未提供 `reject_once`：以 cancelled outcome 完成请求并结束回合 |
| `interaction_denied` | full 模式的残余权限请求（options 未提供 `reject_once`）：fail closed —— cancelled outcome、取消回合、绝不转交人工 |
| `agent_protocol_error` | Agent 在交互未决时结束回合或违反执行协议 |
| `idempotency_conflict` | 同一幂等键携带了不同的请求指纹 |
| `session_not_continuable` | 该工具没有任何续接回合的通道（`executionModes[].continuation` 为 `single-turn`），`sessionMode = conversation` 在**创建时**即被拒绝 |
| `context_exhausted` | CLI 自己报告历史已装不进上下文窗口（`prompt is too long: … tokens > … maximum`、`context_length_exceeded` 等）。原样重试同一个 prompt 一定还是失败——应开新会话或缩短历史。判定来自 CLI 自己的失败文本（**不做**模型上下文预算预测），且只替换 `agent_error` |
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
| `contracts/openapi.control-plane.yaml` | 本地回环控制面（connect 默认开启，只绑回环） |
| `llms.txt` | 给 AI 客户端的入口索引 |

`npm run contracts:check` 会校验代码里的每个 wire 类型、能力、错误码与平台端点都确实被记载 —— 漂移即红。

### 本地回环控制面（connect 默认开启）

`agent-bridge connect <platformUrl>` 默认在 `127.0.0.1:8787` 启动本机 Web 面板；端口被占用时自动顺延。
`agent-bridge serve <platformUrl> [--port=8787]` 仍可按配置/参数显式控制。
它服务的是**本机上的其它程序**（IDE 插件、脚本、MCP server、CI runner）；远程平台仍然走出站 WebSocket，
控制面是**另一条**通道，不是替代品。

| 规则 | 取值 |
| --- | --- |
| 绑定 | 只绑 `127.0.0.1` / `::1`，非回环直接在启动时拒绝 |
| 默认 | `connect` 从 8787 起自动启动（连续 20 个端口都占用才降级）；`serve` 仍按 `[control_plane]` / `--port` 决定 |
| 鉴权 | scoped Bearer（`abs_<kid>_<secret>`，与 P0-8 同一套令牌）；`/v1/health` 与面板页壳 `/` 免鉴权；EventSource 场景允许 `?token=` 兜底（仅回环，勿外发）。**Web 面板零操作**：serve 启动时自动生成一个只读（task:read/device:read）内存令牌并拼进面板地址，进程退出即失效 |
| CORS | 一律不返回 —— 浏览器脚本无法静默调用本机端口 |
| JWT | 可选 `[jwt] jwks_url = "..."`；验签后按 `tenant_id` 隔离 `/v1/sessions`、`/v1/board`、`/v1/tasks*` 与附件；跨租户任务读取统一 404 |
| 调度 | 任务走同一个 `TaskSupervisor`，`max_tasks` 对两条通道**同时**生效 |
| 上行 | 控制面下发的任务也经同一个 `Emitter` 回传，平台侧视图不会出现"半边失踪" |
| 面板 | `GET /` 内嵌 Web 任务面板（产品化任务表 + **结构化日志事件卡**（7 族事件归一化、工具调用与结果合并、原始 JSON 折叠）+ 执行待办 + 步骤时间线 + 结果预览；三个弹窗均支持 vw/vh 自适应与全屏；日志 600 条有界缓存、SSE 合帧渲染、后台标签页暂停轮询）；`GET /v1/board` 是其数据源（与终端面板同一注册表） |

| 方法 | 路径 | scope |
| --- | --- | --- |
| GET | `/` | 无（Web 任务面板壳；数据走 /v1/*） |
| GET | `/v1/health` | 无（存活/就绪/版本；`?integrity=quick` 顺带重跑状态库自检） |
| GET | `/v1/metrics` | `device:read`（Prometheus 文本） |
| GET | `/v1/whoami` | `device:read`（JWT principal / 服务身份） |
| GET | `/v1/capabilities` | `device:read` |
| GET | `/v1/agents` | `device:read` |
| POST | `/v1/agents:scan` | `device:read` |
| GET | `/v1/board` | `task:read`（面板聚合视图：任务 + 计数 + 容量） |
| POST | `/v1/artifacts:gc` | `task:cancel`（显式 artifact TTL 清理，支持 dryRun） |
| GET | `/v1/sessions` | `session:read` 或 `task:read`（持久会话列表） |
| GET | `/v1/sessions/{id}` | `session:read` 或 `task:read`（会话快照 + eventSeq 窗口） |
| GET | `/v1/sessions/{id}/events` | `session:read` 或 `task:read`（SSE：回放 + 实时事件） |
| GET | `/v1/sessions/{id}/artifacts/{artifactId}` | `task:read`（附件流式下载） |
| GET | `/v1/interactions?taskId=&state=&limit=` | `session:read` 或 `task:read`（有界交互列表，常用 `state=pending`） |
| GET | `/v1/interactions/{requestId}` | `session:read` 或 `task:read`（单条交互：待答请求或已结算结果） |
| POST | `/v1/interactions/{requestId}:respond` | permission 要 `task:approve`，form/auth-url 要 `task:respond`（规则与代码路径同 WS 的 `task_interaction_response`） |
| POST | `/v1/tasks` | `task:create`（请求体可带 `allowInteractive: true` 申请本任务交互；生效还须 `--interaction-enabled`） |
| GET | `/v1/tasks` | `task:read`（游标分页） |
| GET | `/v1/tasks/{id}` | `task:read` |
| POST | `/v1/tasks/{id}:cancel` | `task:cancel`（幂等） |
| GET | `/v1/tasks/{id}/events` | `task:read`（SSE：日志 + 状态 + 步骤） |
| GET | `/v1/tasks/{id}/steps` | `task:read`（步骤时间线 + 最终回答） |
| GET | `/v1/tasks/{id}/file?path=` | `task:read`（产物文件预览：锁任务 cwd + allowed_cwd，≤512KB） |
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

### A2A / ACP 网关（可选，默认关闭）

给外部编排器（A2A 客户端、ACP editor）一个**标准协议表面**，替代各自实现 bridge 私有 wire。
网关不另开端口：挂在控制面的 HTTP server 上（回环绑定、鉴权、审计与 `/v1/*` 同一套），
是**适配层**——复用 `TaskSupervisor / SessionStore / Emitter`，不复制调度与持久化。
配置 `[gateway] enabled = true`（或临时 `AGENT_BRIDGE_GATEWAY=1`）后生效，未启用时一律 404。
`a2a` / `acp` 子开关可单独关掉某个表面。

| 方法 | 路径 | scope |
| --- | --- | --- |
| GET | `/.well-known/agent-card.json` | 无（静态描述，不含任务数据；capabilities 只声明已实现项） |
| POST | `/a2a` | 逐方法：读 `session:read`/`task:read`，发送 `task:create`，取消 `task:cancel` |
| POST | `/acp` | 逐方法：握手/会话 `device:read`，prompt `task:create`，cancel `task:cancel`，交互应答 `task:approve`/`task:respond` |

#### A2A 表面

- **版本协商**：`A2A-Version` 头（空/缺省按 0.3；`1.0` 用 `TASK_STATE_*` 拼写；其余 `-32009`）。
  方法名 `GetTask` 与 `tasks/get` 两种拼写都接受。
- **`tasks/get`（只读）**：SQLite 快照 → A2A Task（`history` 只含 complete 消息；`task_log` 不冒充
  消息/附件，只在 `Task.metadata.bridge.taskLogEndpoint` 给指引；附件以 file part 指向控制面下载端点）。
- **`message/send`（创建任务）**：`message.parts`（仅 text）拼为 prompt；**bridge 扩展字段在
  `message.metadata`**——`agentType`（受管白名单内）与 `cwd` 必填、`timeoutMs` 可选。
  `messageId` 即幂等键（重发同 id 返回同一 task）；**立即返回**（长任务后续走 get/订阅）。
  与 `POST /v1/tasks` 同一条编排（并发上限/权限策略/幂等语义单一真源）。
- **`tasks/cancel`**：与 `:cancel` 同一条取消编排（SIGTERM → 2s → SIGKILL）；终态回 `-32002`。
- **`tasks/resubscribe`（SSE 补洞）**：`eventSeq` 游标（`params.metadata.afterEventSeq`，缺省 0）；
  帧格式 `task`/`message`/`status`/`artifact`（带 eventSeq）+ `log|step` 调试扩展 + `done`；
  终态任务回 `-32004`（规范语义）。
- **状态映射**：queued→`SUBMITTED`、running→`WORKING`、waiting_interaction/waiting_user→`INPUT_REQUIRED`、
  success→`COMPLETED`、failed/timeout→`FAILED`（真实归因放 `metadata.bridge.statusDetail`）、cancelled→`CANCELED`。
- **隔离**：跨租户/不存在统一 JSON-RPC `-32001`（不泄露「存在但不是你的」）。

##### A2A 映射细则（6.4 / 6.8）

- **TaskStatusUpdateEvent** ↔ `tasks/resubscribe` 的 SSE `status` 帧：携带 `state` + `eventSeq`；
  **终态帧关闭流**（`done`）—— Task 对象本身没有 `final` 字段，终态由 `status.state` 到达
  终值（`COMPLETED` / `FAILED` / `CANCELED`）表达，与 A2A v1.0.1 一致。
- **Message / Part** ↔ `task_message`：只有 `state: "complete"` 的消息进入 A2A history（text part）。
  流式 **delta 绝不冒充 A2A 消息** —— 它是 bridge 内部的 `partialMessages`（仅快照可见）；
  `task_log` 是调试输出，从 `Task.metadata.bridge.taskLogEndpoint` 指引获取，不成为消息 part。
- **Artifact** ↔ `task_artifact`：有内容的附件（平台上传）映射为 **file part**（指向控制面下载端点）；
  元数据 only 的任务产物（无 adapter artifact 事件，见上文产物节）只有 `name/mimeType/size`
  并如实标注不可得，绝不伪造可下载的 part。
- **权限不是 A2A 原生能力**：等待中的任务表现为 `INPUT_REQUIRED`，但批准/应答闭环只存在于
  bridge wire（`task_interaction_request/response`）与 ACP 表面（`session/request_permission` /
  `elicitation/create`）。A2A 客户端要回答交互必须走这两条通道之一；bridge 不为它发明 A2A 扩展。
  相应地，`message.metadata.allowInteractive: true` 会被**明确拒绝**（`-32000`，
  `data.code = "interaction_not_supported"`）且不创建任务 —— 静默跑成非交互会让调用方误以为
  「权限已被自动批准」。要交互请用 ACP `session/new` 的 `_meta.allowInteractive`。
- **bridge 扩展 URI** 位于 `message.metadata` / `Task.metadata.bridge.*`，全部是增量可选字段：

| 扩展 | 位置 | 含义 |
| --- | --- | --- |
| `agentType` | `message.metadata` | 受管 CLI 白名单项（必填） |
| `cwd` | `message.metadata` | 任务工作目录（必填） |
| `timeoutMs` / `captureDiff` / `permissionMode` | `message.metadata` | 可选的任务级覆盖 |
| `allowInteractive` | `message.metadata` | **不支持**：A2A 无请求帧通道，传 `true` 会被拒绝（`interaction_not_supported`） |
| `bridge.taskLogEndpoint` | `Task.metadata` | 调试日志位置（不是消息来源） |
| `bridge.statusDetail` | `Task.metadata` | 多个 bridge 状态坍缩到一个 A2A 状态时的真实归因 |
| `afterEventSeq` | resubscribe `params.metadata` | 补洞游标（eventSeq；缺省 0 = 全量回放） |
| `idempotentReplay` | send 响应 `Task.metadata` | 同 `messageId` 重发 → 同一任务，不重复执行 |

#### MCP 宿主（stdio，逐 server 配置）

config.toml 的 `[mcp.servers.<name>]` 启动本机 stdio MCP server；bridge 作为 MCP client 提供
`tools/list`、`tools/call` 与 **elicitation**（`McpElicitationClient`；传输层测试覆盖 elicitation
表面及其版本承载差异 —— 协议协商隔离在 client 内，不渗入 bridge wire）。**诚实边界**：
elicitation 的 handler 由调用方注入；MCP 问题接入平台 `task_interaction_request` **尚未启用** ——
宿主与客户端已就绪并有测试，接入交付后才作声明。MCP 工具调用绝不因模型文本被自动批准。

#### ACP 表面（ACP v1 over HTTP，vendor 承载）

ACP v1 的 HTTP 承载在上游还是 RFD 阶段，但**本网关这一侧的口径已经定死、按对外契约对待**
（2026-11-22 决定：不随上游 RFD 变动调整帧格式）：**请求走 `POST /acp`**、
**prompt 下行与交互请求走 SSE**、**客户端应答走另一条 `POST /acp` 的响应报文**。

- **`initialize`**：只声明真实能力——`loadSession: false`（会话不持久续接）、prompt 只收
  text block、fs/terminal 客户端能力不开放。
- **`session/new`**：固化 `params.cwd` 与 `params._meta.agentType`（12 个受管 CLI 必须显式选择）；
  可选 `params._meta.allowInteractive: true` 申请本会话的交互（只认布尔）。申请只是**请求**：
  进程没以 `--interaction-enabled` 启动时仍按非交互跑，CLI 的权限申请会被本机直接拒绝。
- **`session/prompt`（conversation 多轮，add-acp-session-memory）**：首轮创建 bridge conversation
  会话（`run_task` 语义）；后续轮 `send_message` 续接**同一会话**——CLI 原生续接（resume /
  ACP session / 重放兜底，12 适配器续接矩阵），**上下文由 CLI 持有、token 只传增量**。
  响应是 SSE 流：`event: prompt`（taskId + first/continue 标记）→ `event: update`（`session/update`
  通知，agent_message_chunk）→ 交互时 `event: request`（见下）→ `event: result`
  （本轮 turn 结束：`{stopReason, content}`，`waiting_user → end_turn`；turn 失败/超时走
  JSON-RPC error，会话随之关闭——后续 prompt 如实拒绝并提示 `session/new`）。
  会话空闲回收复用 conversation 的 `idleTimeoutMs`。bridge 重启后 acp 会话绑定丢失（内存态），
  旧会话不假装可续。
- **`session/cancel`**：取消当前轮次（`cancel_turn` 编排，operationId 幂等）；无活动轮次静默成功。
- **交互闭环**：**前提是该 ACP 会话在 `session/new` 声明了 `_meta.allowInteractive: true`**
  （不声明就不会弹请求——默认按非交互执行）。任务进入 `waiting_interaction` 时，prompt 流中注入
  `event: request` 帧（`session/request_permission` 或 `elicitation/create`——permission 走标准选项，
  form/auth-url 走 elicitation（form/url 两种 mode））。客户端用 `POST /acp` 发响应报文
  （无 method、带网关下发的 id + result）应答；网关转成 `task_interaction_response` 走与
  `POST /v1/interactions/{id}:respond` **同一条** dispatch 路径（权限判定双保险）。
  **证据等级**：permission 闭环有真 CLI 证据（kimi-code）；form/auth-url（elicitation）已实现且有单测，
  但**在任何适配器上都没有真 CLI 证据**——`interactionKinds` 里的 `form` 表示「这条通道能中转什么」，
  不是「已经观测到什么」。`opencode`/`minimax-code` 会自动放行工具调用所以从不发问；`codex` 在本机
  Windows 上根本不发起工具调用（`codex exec` 只出 reasoning），因此即使 `E2E_INTERACTION=1`，
  它的审批路径仍未被证明。
- 端到端取证：`npm run e2e:gateway`（真 bridge 进程 + 真服务令牌 + 真跑一次本机 CLI，
  覆盖 A2A send/get/cancel、messageId 幂等与 ACP prompt/cancel 全链路；**多轮记忆含真 CLI
  两轮对话断言**。CLI 出网代理与系统不一致时用 `E2E_PROXY=http://127.0.0.1:<port>` 指定）。
  不指定 `E2E_AGENT` 时脚本会**自动挑一个本机就绪的 CLI**（避免把某个工具的订阅/登录态
  问题当成桥接回归）；指定时按指定跑。一个就绪的都没有时退出码 `2`，
  设 `E2E_ALLOW_SKIP=1` 才会以「跳过」结束（并明确打印本轮未验证任何行为）。
  交互闭环（权限请求帧 → 响应报文 → 回合继续）需要 CLI 真的申请权限，各工具差异大
  （kimi-code 会问，opencode/minimax 自动放行，codex 在本机不发工具调用），因此默认不跑：
  `E2E_INTERACTION=1` 才启用。该段**一帧 request 都没收到时记为「未验证」而不是 FAIL**——
  一个从不发问的 agent 既没证伪也没证明桥接。
- 详见 `contracts/openapi.control-plane.yaml` 的 `a2a-gateway` tag。

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
