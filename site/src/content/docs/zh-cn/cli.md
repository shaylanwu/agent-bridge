---
title: CLI 参考
description: Agent Bridge Service 的全部命令与参数。
sidebar:
  order: 2
---

共 6 个命令。命令表在 `src/cli/dispatch.ts`，护栏会核对"加了命令没写文档"的情况，
所以本页不会与代码漂移。

## connect

把本机绑定到平台并保持连接。

```bash
agent-bridge connect <platformUrl> [--token=xxx] [--device-id=bd_xxx] [--no-browser] [--label=name]
    [--max-tasks=30] [--max-queue=60]
```

| 参数 | 含义 |
| --- | --- |
| `--token` | 用已有设备令牌，跳过浏览器流程（CI / 批量装机）。必须有已持久化、可迁移或显式稳定 ID，否则启动失败。 |
| `--device-id` | 匹配 `^bd_(?:[0-9a-f]{32}|[0-9a-f]{12})$` 的稳定设备 ID；也可设 `AGENT_BRIDGE_DEVICE_ID`。只能迁移或确认身份，不能覆盖不同的已存 ID。 |
| `--no-browser` | 走设备码流程而不开浏览器（SSH、无头环境）。 |
| `--label` | 给设备一个人类可读的名字。 |
| `--max-tasks` | 本次会话的并发上限（默认 30，夹 1–128）。 |
| `--max-queue` | 本次会话的排队上限（默认 60，夹 0–1024；0 = 不排队）。 |

优先级：启动参数 > 环境变量（`AGENT_BRIDGE_MAX_TASKS` / `AGENT_BRIDGE_MAX_QUEUE`）> config.toml > 默认值。

不带任何参数时：先持久化或复用稳定身份，再开浏览器完成 PKCE、保存令牌并建立出站 WebSocket。
授权请求、WS URL query 与 `hello.deviceId` 都使用同一个 ID。预签发 `--token` 绝不会触发生成新 ID。

## serve

主流程与 `connect` 相同，**额外**提供可选的本地回环控制面。

```bash
agent-bridge serve <platformUrl> [--port=8787] [--max-tasks=30] [--max-queue=60]
```

- 带 `--port`（或配置里 `[control_plane] enabled = true`）时，为同机程序开一个回环 HTTP API；
- **不带时 `serve` 与 `connect` 完全等价，一个端口都不开** —— 控制面永远默认关闭；
- 环境变量可覆盖：`AGENT_BRIDGE_CONTROL_PLANE=true`、`AGENT_BRIDGE_CONTROL_PORT=8787`。

## status

探测本机已安装的编码 CLI。

```bash
agent-bridge status [--json] [--fresh]
```

| 参数 | 含义 |
| --- | --- |
| `--json` | 机器可读输出。 |
| `--fresh` | 强制重新探测，不用缓存快照。 |

每个工具报告 `ready` / `installed_no_cred` / `not_installed`，并给出命中的可执行文件路径与凭据来源。

## logout

清除本地设备凭证，但保留 `identity.toml`、配置镜像和设置。凭证吊销后执行 `logout` → `connect`，
仍用原设备 ID 重新绑定。

```bash
agent-bridge logout
```

## services

签发与管理 **scoped 服务令牌** —— 给后端服务/脚本的身份，不是给人用的。

```bash
agent-bridge services issue|list|revoke|rotate
  --label=<name>
  --scopes=task:create,task:cancel,task:read,device:read,task:approve,task:respond
  [--ttl-days=90]          # issue 用
  [--grace-hours=24]       # rotate 用：旧令牌宽限期内仍然有效
```

| 子命令 | 含义 |
| --- | --- |
| `issue` | 签发 `abs_<kid>_<secret>`，密钥只显示一次。 |
| `list` | 列出已签发令牌（不明文存储密钥）。 |
| `revoke` | 立即吊销。 |
| `rotate` | 带宽限期轮换，发布期间不会中断。 |

令牌作为 `serviceToken` 随 `run_task` / `cancel_task` 下发，或作为控制面的 Bearer 令牌。
失败错误码是稳定的：`unauthorized`（缺失）、`invalid_token`、`token_expired`、`insufficient_scope`。

## daemon

```bash
agent-bridge daemon start|stop|install|uninstall
```

**尚未实现。** 该命令目前是占位，会打印提示后退出。请先用自己的进程管理器
（systemd / launchd / Windows 服务）托管。

## 全局

```bash
agent-bridge --version | -v
agent-bridge help | --help | -h
```
