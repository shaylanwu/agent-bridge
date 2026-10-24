---
title: WebSocket 通道
description: 连接地址、鉴权、握手、心跳、退避，以及断线期间会丢什么。
sidebar:
  order: 3
---

一条 WebSocket，由设备主动向外建立。任务通道全在这里；HTTP 只负责绑定设备。

## 连接

- **建连方向**：设备 → 平台。设备从不监听。
- **协议**：生产用 `wss://`；`ws://` 仅限本地开发。
- **鉴权**：绑定阶段拿到的 `device_token`，握手时以 Bearer 凭据带上。平台侧只存令牌的 SHA-256。

## 握手

socket 一打开，设备立即发 `hello`：

```json
{
  "type": "hello",
  "protocolVersion": 1,
  "deviceId": "bd_9f1c…",
  "cliVersion": "0.1.0",
  "platform": "darwin",
  "hostname": "dev-laptop",
  "capabilities": ["diff", "service-token", "queue", "scan-progress", "cloud-events"]
}
```

若 `deviceId` 为空串，请按 Bearer 令牌反查设备。若你的平台说的是另一个 `protocolVersion`，
请以 `protocol_incompatible` 关闭连接 —— 不要硬着头皮继续。

`hello` 之后设备紧接着发 `agent_list`（本机探测到的 AI Agent 清单）。

## 心跳

设备每 **15 秒** ping 一次并期待 `pong`。平台应把漏掉的心跳当作"可能已断开"；
若一段时间没有任何帧到达，应判定设备离线。

```json
{ "type": "ping", "ts": 1730000000000 }
```

## 重连与退避

设备自动重连，指数退避从 **1 秒**起、上限 **30 秒**；连接成功即把退避重置为 1 秒。

:::caution
断线期间会丢什么
断线期间产生的任务输出会被**丢弃** —— 目前没有重放缓冲。重连后设备会重新同步状态，
但断网期间发出的日志分片找不回来。平台应把这个缺口显式呈现，而不是假装日志完整。
:::

## 顺序保证

- 借助 `Emitter`，每个任务的 `task_status` 只会到达一次终态；
- `task_log` 按任务有序，每片 ≤ 4096 字节，且不切断多字节字符；
- `scan_progress` 可能与 `task_log` 交错 —— 它们属于不同的任务或扫描。

## 规范性描述

以上内容均摘自 [`contracts/asyncapi-3.0.yaml`](/agent-bridge/asyncapi-3.0.yaml)。
字段级细节见[协议消息](/agent-bridge/zh-cn/protocol/messages)。
