---
title: 快速开始
description: 安装 Agent Bridge Service、绑定设备到平台、跑通第一个任务。
sidebar:
  order: 1
---

## 安装

```bash
npm install -g agent-bridge-service
# 或者不安装直接跑：
npx agent-bridge-service status
```

需要 Node.js 18 及以上。设备**不开任何入站端口** —— 下面的流程在 NAT 和企业代理后面同样成立。

## 先看本机有什么

```bash
agent-bridge status
```

探测 12 个受支持的 AI Agent，逐个报告状态：`ready`（可用）、`installed_no_cred`（装了但没凭据）、
`not_installed`（没装）。加 `--fresh` 强制重新探测，`--json` 输出机器可读结果。

## 绑定到平台

```bash
agent-bridge connect https://your-platform.example.com
```

1. 浏览器打开平台的授权页；
2. 你确认后，平台带一次性 `code` 302 回环回调地址；
3. Agent Bridge Service 用这个 `code`（PKCE S256）换 `device_token`；
4. 建立出站 WebSocket，依次发出 `hello` 与 `agent_list`。

SSH 或任何打不开浏览器的环境，改用设备码流程：

```bash
agent-bridge connect https://your-platform.example.com --no-browser
```

你会拿到一个短码，在别处确认即可，CLI 会自动轮询。

已经有令牌（CI、批量装机）？完全跳过浏览器：

```bash
agent-bridge connect https://your-platform.example.com \
  --token=dt_xxx --device-id=bd_xxx
```

预签发 token 本身不带身份。bridge 必须从本地状态取得稳定 ID，或从 `--device-id` /
`AGENT_BRIDGE_DEVICE_ID` 迁移；都没有时启动明确失败，不会随机生成 ID、发送空 ID 或依赖 Bearer 反查。

## 状态文件在哪

| 文件 | 路径 | 内容 |
| --- | --- | --- |
| 身份（唯一真源） | `~/.agent-bridge/identity.toml`（Windows：`%APPDATA%\.agent-bridge\identity.toml`） | 稳定 `deviceId` |
| 配置 | `~/.agent-bridge/config.toml`（Windows：`%APPDATA%\.agent-bridge\config.toml`） | `platformUrl`、`deviceToken`、`deviceId` 兼容镜像、`max_tasks`、控制面设置 |
| 服务令牌 | `~/.agent-bridge/services.toml` | 已签发的 `abs_…` 令牌（只存哈希） |

`AGENT_BRIDGE_CONFIG` 指向某个 profile 的 `config.toml`，其父目录就是 profile，也保存 `identity.toml`。
卸载重装时保留该目录即可复用原 ID。只删除 `identity.toml` 会从配置镜像恢复；删除整个 profile 才是新安装。
`logout` 保留身份与设置，因此 `logout` → `connect` 会用原 ID 重新绑定。

## 跑第一个任务

平台侧发一个 `run_task` 帧：

```json
{
  "type": "run_task",
  "taskId": "t_01",
  "agentType": "claude-code",
  "cwd": "/home/you/repo",
  "prompt": "给 tokenizer 补一个单元测试",
  "timeoutMs": 300000,
  "captureDiff": true
}
```

你会依次收到：`task_status`（`running`）、若干 `task_log` 分片、以及一个终态 `task_status`
（`success` / `failed` / `cancelled` / `timeout`），终态带 `exitCode`、`errorCode`，
因为开了 `captureDiff`，还带 diff。

## 可选：本地回环控制面

如果调用方是**同机程序**，你其实不需要平台：

```bash
agent-bridge services issue --label=my-script --scopes=task:create,task:read
agent-bridge serve https://your-platform.example.com --port=8787
curl -H "Authorization: Bearer abs_…" http://127.0.0.1:8787/v1/health
```

完整能力见[本机程序对接](/agent-bridge/zh-cn/integrate/local)。不带 `--port`（配置里也没开
`enabled` 时），`serve` 与 `connect` 完全等价，**一个端口都不开**。

## 下一步

- [CLI 参考](/agent-bridge/zh-cn/cli) —— 全部命令与参数
- [协议总览](/agent-bridge/zh-cn/protocol/overview) —— 能力协商、版本规则、错误码
- [平台方对接](/agent-bridge/zh-cn/integrate/platform) —— 你要实现什么
