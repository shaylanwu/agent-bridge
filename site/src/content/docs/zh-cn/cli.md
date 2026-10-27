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
    [--permission-policy=default|allow-full|full] [--external-sandbox]
    [--interaction-enabled] [--interaction-timeout-ms=900000] [--max-interactions-per-task=16]
```

| 参数 | 含义 |
| --- | --- |
| `--token` | 用已有设备令牌，跳过浏览器流程（CI / 批量装机）。必须有已持久化、可迁移或显式稳定 ID，否则启动失败。 |
| `--device-id` | 匹配 `^bd_(?:[0-9a-f]{32}|[0-9a-f]{12})$` 的稳定设备 ID；也可设 `AGENT_BRIDGE_DEVICE_ID`。只能迁移或确认身份，不能覆盖不同的已存 ID。 |
| `--no-browser` | 走设备码流程而不开浏览器（SSH、无头环境）。 |
| `--label` | 给设备一个人类可读的名字。 |
| `--max-tasks` | 本次会话的并发上限（默认 30，夹 1–128）。 |
| `--max-queue` | 本次会话的排队上限（默认 60，夹 0–1024；0 = 不排队）。 |
| `--permission-policy` | 本机权限策略，覆盖本会话的 `permission_policy`：`allow-full` 才允许平台按任务申请 full，`full` 让缺省任务也走 full。`allow-full` / `full` 下平台只能发空 `args`。 |
| `--external-sandbox` | 声明本机 CodeBuddy 的 full 运行处于外部沙箱内（仅影响 CodeBuddy 的 full 准入）。 |
| `--interaction-enabled` | 本会话开放权限/表单交互（默认关闭；关闭时不会向平台发任何交互请求）。 |
| `--interaction-timeout-ms` | 单次交互等待上限（默认 900000，夹 10 秒 ~ 2 小时；适配器更短的 `expiresAt` 优先）。 |
| `--max-interactions-per-task` | 单任务交互次数上限（默认 16，夹 1 ~ 256）；超出不再转发。 |

优先级：启动参数 > 环境变量（`AGENT_BRIDGE_MAX_TASKS` / `AGENT_BRIDGE_MAX_QUEUE`）> config.toml > 默认值。

不带任何参数时：先持久化或复用稳定身份，再开浏览器完成 PKCE、保存令牌并建立出站 WebSocket。
授权请求、WS URL query 与 `hello.deviceId` 都使用同一个 ID。预签发 `--token` 绝不会触发生成新 ID。

## serve

主流程与 `connect` 相同，**额外**提供可选的本地回环控制面。

```bash
agent-bridge serve <platformUrl> [--port=8787] [--max-tasks=30] [--max-queue=60]
    [--permission-policy=default|allow-full|full] [--external-sandbox]
    [--interaction-enabled] [--interaction-timeout-ms=900000] [--max-interactions-per-task=16]
```

- `connect` 默认在 `127.0.0.1:8787` 启动本机 Web 面板，端口占用自动顺延；
- `serve` 带 `--port`（或配置里 `[control_plane] enabled = true`）时按指定端口启动，不带时沿用默认行为；
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
  --scopes=task:create,task:cancel,task:read,session:read,device:read,task:approve,task:respond,approval:persist
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

## approvals

查看与撤销**持久授权**（1.0）。账本默认关闭（`approval_ledger_enabled = true` 或
`connect --approval-ledger`）；只有当人工在交互里选择持久允许、**且**响应方持有 `approval:persist`
时才会写入。

```bash
agent-bridge approvals list [--all]        # --all 连已撤销的一起列出
agent-bridge approvals revoke <approvalId>
agent-bridge approvals purge               # 清理过期记录
```

自动命中必须同时满足：模式是 `default`、请求本身真的提供了持久允许选项、指纹（agent + 工具类别 +
归一化资源）命中未过期记录。`full` 模式永不用账本，模型文本与工具标题也不会创建或扩大授权。
命中与撤销分别记 `approval_hit` / `approval_grant` / `approval_revoke` 审计。

## sessions

本地状态库里会话历史的查看与清理。`purge` 是 `session_deleted`（410）这个错误码的**唯一产生点** ——
`close_session` 只写 tombstone 并保留历史（关了不等于没了），只有整会话删除后平台才会收到 410。

```bash
agent-bridge sessions list                        # 会话 + 事件区间 + 最后更新时间
agent-bridge sessions purge --session=<taskId>    # 删一个会话
agent-bridge sessions purge --older-than=<天>      # 删一批（按最后更新时间）
```

只删已终结的会话，`running` 的会被跳过（删掉等于让平台永远等不到终态）。tombstone 保留，
该 taskId 永不复用，平台应把 `session_deleted` 当作**放弃重试**的信号，而不是 `task_not_found`。

## daemon

```bash
agent-bridge daemon start <platformUrl> | stop | status | install <platformUrl> | uninstall
```

轻量后台管理：detached 进程 + `daemon.pid` + 状态目录下的 `daemon.log`。
`install` / `uninstall` 注册当前用户服务：Linux systemd user、macOS LaunchAgent、
Windows 登录计划任务；均支持 `--dry-run`。

## 全局

```bash
agent-bridge --version | -v
agent-bridge help | --help | -h
```
