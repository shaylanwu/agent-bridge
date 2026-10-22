# agent-bridge-service

把本机已安装的 AI 编码 CLI 接入远程编排平台 —— 只靠一条**出站** WebSocket。不需要开入站端口、不需要反向穿透，API Key 始终留在本机。

[English](README.md) · **简体中文**

---

## 简介

AI 编码 CLI（Claude Code、Codex、Gemini CLI 等）装在开发者的电脑上。网页平台看不到它们：浏览器沙箱拿不到
`PATH`、可执行文件和凭据存储；平台部署在别处，也连不进 NAT 后面的笔记本。

`agent-bridge-service` 补上这一环：它运行在拥有这些 CLI 的机器上，向平台保持一条出站 WebSocket，
回答三个平台自己永远回答不了的问题：

1. **这台机器装了什么？** —— 真实探测本地 `PATH` 与常见安装目录。
2. **装了能不能用？** —— 区分「已安装」「已安装但缺凭据」「已安装但跑不起来」。
3. **能不能帮我跑一下？** —— 在受控工作目录里执行白名单内的 CLI，并实时把输出回传。

这个包是自包含的：运行时只依赖 `ws` 和 `smol-toml`，通过一个小型 JSON 协议（HTTP + WebSocket）与平台通信。

## 功能

- **内置 11 个适配器** —— Claude Code、Codex、DeepSeek Harness、Gemini CLI、opencode、Mimo Code、
  Qoder CLI、Grok CLI、Kimi Code、MiniMax Code、Trae CLI。
- **三态探测** —— `就绪` / `已装缺凭据` / `未装`，并在「找到二进制但执行失败（`--version` 非 0）」时标记为**装坏**。
- **零入站网络** —— 由 bridge 主动连出，平台从不向你的网络发起连接。
- **绑定无需复制粘贴 token** —— 本地回环回调 + PKCE S256，复用浏览器里已登录的会话；SSH/无头机器走设备码，CI 可用 `--token`。
- **受控执行** —— 适配器白名单、参数数组（不拼 shell）、工作目录校验、单任务超时、优雅取消（`SIGTERM` → 2 秒 → `SIGKILL`）。
- **流式日志** —— 输出按 4 KB 分片即时回传；已结束的运行可在平台侧回看。
- **连接自愈** —— 15 秒心跳、指数退避（1 秒 → 30 秒）、断线期间的状态消息在重连后补发。
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
# （--device-id 可选，也可用 AGENT_BRIDGE_DEVICE_ID 环境变量）
agent-bridge connect https://platform.example.com --token=<device-token> --device-id=<device-id>

# 只探测本机工具（不需要连接平台）
agent-bridge status
agent-bridge status --json --fresh     # --fresh 绕过 30 秒缓存

# 清除本机设备凭证
agent-bridge logout
```

> `agent-bridge daemon` **尚未实现**（Phase 3）。在此之前请用你自己的进程守护（systemd / launchd /
> Windows 服务包装）托管前台运行的 `connect`。

用 `--token` 时，只有显式给 `--device-id` 或设置 `AGENT_BRIDGE_DEVICE_ID` 才有 `deviceId`（解析顺序：
授权响应 → `--device-id` → 环境变量 → 同平台的已保存配置）。都解析不到时，WS 地址会**省略** `deviceId`
查询参数（而不是发一个空值），`hello.deviceId` 为空串 —— **此时平台必须按 `Authorization: Bearer` 反查设备**。
从未交互式绑定过的 CI 机器就是这种情况。

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

共 11 个工具，可用 4 个
```

配置位于 `~/.agent-bridge/config.toml`（Windows：`%APPDATA%\agent-bridge\config.toml`），权限 `0600`；
设备 token 从不明文完整打印。

可选的**工作目录白名单**——把任务执行收窄到指定目录：

```toml
allowed_cwd = ["/Users/me/work", "/Users/me/repos"]
```

配置后，`run_task` 的 `cwd` 若不在任一目录之下，bridge 会在 spawn 之前就拒绝，并回
`{"status":"failed","error":"工作目录不在允许范围内：…"}`。条目会被解析成绝对路径、按**目录边界**比较，
因此 `/Users/me/work-old` **不会**被 `/Users/me/work` 放行。不写这个键则保持原有行为（只校验目录存在）。

## 安全边界

| 关注点         | 行为                                                                 |
| -------------- | -------------------------------------------------------------------- |
| API Key / 凭据 | 从不读取、从不上传，只上报「是否存在」                               |
| 能执行什么     | 仅限白名单内的工具类型，未知 `agentType` 在本地直接拒绝              |
| 怎么执行       | 参数以数组传入，不做 shell 拼接（Windows `.cmd` 垫片单独做引号处理） |
| 在哪里执行     | `cwd` 必须存在且是目录；可用 `allowed_cwd` 白名单进一步收窄范围      |
| 失控进程       | 每个任务都有超时；取消先发 `SIGTERM`，2 秒后 `SIGKILL`               |
| 传输           | 仅 `wss://`，握手用 `Authorization: Bearer <device_token>` 鉴权      |
| Token 存储     | 本机 `0600` 文件；平台只保存其 SHA-256 哈希                          |
| 吊销           | 被吊销的设备在下次握手即被拒绝（`4401`/`4403`，不会进入重连循环）    |

bridge 不持有超出启动它的系统用户的任何权限；除授权期间短暂监听 `127.0.0.1` 外，不开放任何端口。

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
| `src/cli.ts`            | 命令入口（`connect` / `status` / `logout` / `daemon`）、组装与终端输出 |
| `src/auth.ts`           | 本地回调服务、PKCE S256、换取 token、设备码兜底                        |
| `src/config.ts`         | `config.toml` 读写（`0600`）、token 脱敏                               |
| `src/bridge-client.ts`  | WebSocket 客户端：握手鉴权、心跳、退避重连、离线队列                   |
| `src/scan.ts`           | 探测调度与 30 秒缓存                                                   |
| `src/agent-adapters.ts` | 适配器表、二进制解析、版本与凭据探测                                   |
| `src/runner.ts`         | 任务生命周期：校验、拉起、日志分片、取消、超时                         |
| `src/win-exec.ts`       | Windows `.cmd` / `.bat` 垫片的正确引号处理                             |
| `src/protocol.ts`       | 线协议类型、运行时校验、4 KB 日志分片                                  |

协议（单连接上的 JSON 消息）：

| 方向          | 消息                                                                    |
| ------------- | ----------------------------------------------------------------------- |
| bridge → 平台 | `hello`、`agent_list`、`scan_result`、`task_log`、`task_status`、`pong` |
| 平台 → bridge | `run_task`、`cancel_task`、`scan`、`ping`                               |

## 案例

**绑定一台笔记本并确认在线**

```bash
$ agent-bridge connect https://platform.example.com
[agent-bridge] 开始设备授权…
[agent-bridge] 已打开浏览器，若无反应请手动访问：
  https://platform.example.com/bridge/authorize?code_challenge=…
✅ 设备绑定成功（bd_9f1c…），配置已写入 ~/.agent-bridge/config.toml
[agent-bridge] 已连接平台
[agent-bridge] 已上报 11 个工具状态，等待平台任务…
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
  cli.ts               命令入口
  auth.ts              授权流程
  config.ts            本地持久化
  bridge-client.ts     WebSocket 传输
  scan.ts              探测调度
  agent-adapters.ts    适配器表与探测
  runner.ts            任务执行
  win-exec.ts          Windows 垫片引号处理
  protocol.ts          线协议
test/
  bridge.test.ts       单元测试
```

新增一个适配器：在 `src/agent-adapters.ts` 的 `AGENTS` 里加一条（二进制名、展示名、能力类型、任务参数模板、凭据判据），
传输与调度层无需改动。

## 许可证

Apache-2.0
