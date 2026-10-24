---
title: 本机程序对接
description: 从 IDE 插件、脚本、MCP server 或 CI 步骤驱动这台机器上的 agent。
sidebar:
  order: 2
---

你在写**与开发者同机**运行的程序：IDE 插件、shell 脚本、MCP server、CI runner。你想就在这台机器上跑编码 agent。

用**本地回环控制面** —— `127.0.0.1` 上的一个小 HTTP API。

## 先读这段

:::caution
控制面默认关闭，而且它不是网络暴露面
- 只有显式开启才会启动（`agent-bridge serve --port=8787`，或配置 `[control_plane] enabled = true`）；
- **只绑回环**（`127.0.0.1` / `::1`），绝不绑 `0.0.0.0`；
- **永不返回 CORS 头**，网页无法访问它；
- 除 `/v1/health` 外，每个路由都要 scoped Bearer 令牌。

如果你被人要求"开个端口"—— 那不是这个东西。设备依然没有任何入站连接，这只是给本机程序的本地 API。
:::

## 启动

```bash
agent-bridge services issue --label=my-extension --scopes=task:create,task:read,task:cancel
agent-bridge serve https://your-platform.example.com --port=8787
```

不带 `--port` 时，`serve` 与 `connect` 完全等价，**一个端口都不开**。

## 拿令牌

```bash
agent-bridge services issue --label=my-extension --scopes=task:create,task:read
# → abs_<kid>_<secret>   （只显示一次）
```

scope 共四个：`task:create`、`task:cancel`、`task:read`、`device:read`。按最小够用申请。
轮换时用 `--grace-hours` 给宽限期，发布不会中断。

## 创建任务

```bash
curl -X POST http://127.0.0.1:8787/v1/tasks \
  -H "Authorization: Bearer abs_…" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"agentType":"claude-code","cwd":"/home/you/repo",
       "prompt":"给 tokenizer 补测试","captureDiff":true}'
```

`Idempotency-Key` 很关键：超时重试会返回**同一个** `taskId`，而不是把活干两遍。

## 跟踪进度

两种做法，按场景选：

```bash
# 轮询
curl -H "Authorization: Bearer abs_…" http://127.0.0.1:8787/v1/tasks/t_01

# SSE 流式 —— 晚订阅会先从有界环形缓冲补发
curl -N -H "Authorization: Bearer abs_…" http://127.0.0.1:8787/v1/tasks/t_01/events
```

## 取结果

```bash
curl -H "Authorization: Bearer abs_…" http://127.0.0.1:8787/v1/tasks/t_01/diff
```

diff 是终态产物 —— **不会**为了取 diff 而重跑任务。

## 取消 —— 一条值得知道的边界

```bash
curl -X POST -H "Authorization: Bearer abs_…" \
  http://127.0.0.1:8787/v1/tasks/t_01:cancel
```

取消是幂等的；已终态的任务返回 `200` 且带 `alreadySettled`。但要注意：

> 你只能取消**经由本通道创建**的任务。远端平台下发的任务归那个会话所有，会返回 **409** ——
> 控制面不会越权杀掉另一个通道的活。取消先 SIGTERM，2 秒后 SIGKILL。

任务台账（`GET /v1/tasks`）能看到**全部**任务，包括平台下发的 —— 单进程统一视图，
其中不属于你的那部分只读。

## 分页

台账用游标分页，不是 offset：

```bash
curl -H "Authorization: Bearer abs_…" \
  "http://127.0.0.1:8787/v1/tasks?limit=50&cursor=eyJ…"
```

一直在动的列表不可能用 offset 分页而不漏不重。

## 错误

RFC 9457 `application/problem+json`，`code` 与线协议同源：

```json
{ "type": "about:blank", "title": "Insufficient scope", "status": 403,
  "detail": "服务令牌缺少 scope：task:create", "code": "insufficient_scope" }
```

按 `code` 分支。`401` 是缺失/过期/无效，`403` 是令牌有效但 scope 不足。

## 完整参考

- [本地控制面端点](/agent-bridge/zh-cn/api/control-plane-reference) —— 每个端点每个字段（静态页，可搜索）
- [交互试请求页](/agent-bridge/zh-cn/api/control-plane) —— Scalar
- 契约：[`/openapi.control-plane.yaml`](/agent-bridge/openapi.control-plane.yaml)
