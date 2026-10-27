---
title: 平台方对接
description: 想在别人的机器上跑 agent，你需要实现什么。
sidebar:
  order: 1
---

你在做**远端**那一侧：用户在自己机器上执行 `agent-bridge connect <你的地址>`，由你向他们下发任务。

要建两样东西，二者是分开的：

1. **四个 HTTP 端点** —— 把设备绑定到用户（每台设备一次）；
2. **一个 WebSocket 服务端** —— 承载全部任务与事件（持续）。

## 1. 设备绑定（HTTP）

| 端点 | 用途 |
| --- | --- |
| `GET /bridge/authorize` | 已登录用户确认绑定的浏览器页面，确认后带 `code` 302 回跳 |
| `POST /api/bridge/token` | 用 `code` + `codeVerifier`（PKCE S256）换 `device_token` |
| `POST /api/bridge/device-code` | 为无浏览器 / SSH 场景下发短码 `user_code` |
| `POST /api/bridge/device-token` | 轮询设备码直到用户确认 |

没有商量余地的地方：

- **必须校验 PKCE**：`base64url(sha256(codeVerifier))` 必须等于此前下发的 `code_challenge`；
- **按请求中的稳定身份幂等重绑**：两个 token 端点都必填 `deviceId`、`hostname`、`platform`、
  `cliVersion`；PKCE 端点还发送 `redirectUri`，两者都使用 `clientId`。`/device-code` 仍只发送
  `clientId`。成功响应的 `device_id` 必须等于请求 `deviceId`，否则 bridge 不保存凭证、不连接；
- **公开错误码放在 JSON 顶层**：`400 invalid_device_id` 保留本地身份；
  `409 device_bound_to_other_account` 与 `409 device_identity_ambiguous` 需平台管理员处理
  （不自动换 ID、合并或转移所有权）；`401`/`403` 是终态凭证失败；只有
  `428 authorization_pending` 让设备码按服务端 interval 继续轮询；
- **只存 `device_token` 的 SHA-256**，绝不存明文。`refresh_token` 可选。若返回，bridge 会在 WS
  关闭码 `4401`/`4403` 时调用 `POST /api/bridge/token` + `grant_type=refresh_token` 尝试一次刷新，
  成功后用新 token 重连；刷新失败回退到显式重新授权，不会无限重试；
- 回调地址是回环地址（`http://127.0.0.1:<随机端口>/callback`），不要把 `redirect_uri` 限制成已注册的 HTTPS 源；
- `device-code` / `device-token` 返回 `404` 是允许的：bridge 会据此提示"平台配套接口未上线"。

字段级参考见[平台 HTTP 端点](/agent-bridge/zh-cn/api/reference)，契约在
[`/openapi-3.1.yaml`](/agent-bridge/openapi-3.1.yaml)；也可以到[交互页](/agent-bridge/zh-cn/api/index)直接试请求。

## 2. 任务通道（WebSocket）

**从设备接收**（24 条，对应 `src/protocol.ts` 的 `ClientMessage`）：

- 握手与清单：`hello`、`agent_list`、`scan_progress`、`scan_result`、`capacity_update`、`pong`
- 任务与事件：`task_status`、`task_log`、`task_step`、`task_message`、`task_artifact`、`task_snapshot`
- 会话：`message_ack`、`session_ack`
- 交互：`task_interaction_request`、`task_interaction_result`、`interaction_url`
- 产物：`artifact_content`、`artifact_upload_ready` / `_chunk_ack` / `_result`、
  `artifact_download_ready` / `_chunk` / `_result`

**向设备下发**（16 条，对应 `ServerMessage`）：`run_task`、`cancel_task`、`cancel_turn`、`close_session`、
`send_message`、`get_task`、`scan`、`ping`、`get_artifact`、`get_interaction_url`、
`task_interaction_response`、`artifact_upload_start` / `_chunk` / `_complete`、
`artifact_download_start` / `_chunk_ack`。

字段级参考见[协议消息](/agent-bridge/zh-cn/protocol/messages)。

生产环境里真正会踩到的规则：

- **校验协议 1.0 身份**：`hello.protocolVersion` 为 `1`；非空 `deviceId` 匹配
  `^bd_(?:[0-9a-f]{32}|[0-9a-f]{12})$`，且必须等于 WS URL query。没有空 ID / Bearer 反查降级；
- **按 `capabilities` 降级，不要按版本号猜。** 没有 `diff` 就别要 diff，也别渲染 diff 面板；
- **按 `errorCode` 分支，不要按文案。** 见[协议总览](/agent-bridge/zh-cn/protocol/overview#受控错误码)里的 23 个码；
- **多轮先看 `executionModes[].continuation`。** `sessionMode: "conversation"` 只对「至少有一种模式能续接」的工具
  成立；`single-turn` 的工具会在**创建时**回 `session_not_continuable`，不要先按成功处理；
- **半截文本看 `task_snapshot.partialMessages`。** 本轮未定稿的助手文本只在快照里（`pm_<taskId>`，内存态、
  不落库）；`task_message.state` 的 `delta` 是保留位，bridge **不推 delta 帧**；
- **重连补洞用游标，不要靠重放。** `get_task?afterEventSeq=` 取严格大于游标的事件（升序），
  `beforeEventSeq=` 往前翻；两者同给会被拒；
- **`status: "running"` 一律当作"没结束"。** 排队中的任务看起来一样，但会带 `phase: "queued"` 与 `queuePosition`；
- 设备侧每 15 秒心跳；平台不需要主动 ping，但应在长时间无帧时把设备标为离线。设备会以 1s→30s 退避自行重连；
- **`lost` 状态归平台自己。** 任务长时间没动静应由你的看门狗收尾 —— bridge 只上报它知道的，机器可能中途断电。

## 3. 并发

设备上的 `max_tasks`（默认 30）同时约束**两个**通道：平台任务与本地创建的任务共享这个上限。
超出的任务会排队而不是被拒；要显示"排队中"请读 `phase`。

## 4. 可选：让后端服务调用你

如果你的后端服务（修复编排器、CI 调度器）要下发任务，给它一张 **scoped 服务令牌**而不是用户会话，并透传下去：

```json
{ "type": "run_task", "taskId": "t_9", "agentType": "codex", "cwd": "/repo",
  "prompt": "…", "requestedBy": "svc:repair-orchestrator",
  "purpose": "repair", "serviceToken": "abs_…" }
```

bridge 校验令牌，并在终态 `task_status` 回显 `requestedBy`，让你能在自己的库里记录真正的发起方。
**平台管授权**（这个服务能不能代表这个用户），**bridge 管认证**（令牌真假、scope、是否吊销）。

## 5. 上线检查清单

- [ ] PKCE S256 已校验；按请求稳定 ID 幂等重绑并核对响应 `device_id`；只存令牌哈希
- [ ] `invalid_device_id`、两类 409、凭证失败与 `authorization_pending` 均返回公开顶层 `code`
- [ ] `hello.protocolVersion` 为 `1` 且与 URL/hello 的 ID 一致；未知能力能优雅降级
- [ ] 终态 `task_status` 幂等处理（重连后可能到两次）
- [ ] 23 个错误码都映射成了人能行动的信息
- [ ] 排队任务按 `phase` 渲染，而不是自造状态值
- [ ] 开 conversation 前看过 `executionModes[].continuation`，并处理 `session_not_continuable`
- [ ] 看门狗能收尾长时间无动静的任务
- [ ] 重连后用 `get_task?afterEventSeq` 补洞，缺口被显式呈现而不是藏起来
