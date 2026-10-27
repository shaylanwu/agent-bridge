---
title: 协议消息
description: WebSocket 通道上的全部消息，逐字段说明 —— 由 AsyncAPI 契约生成。
---

> 本页由 `contracts/asyncapi-3.0.yaml` 生成 —— 请勿手工编辑。在 `site/` 下执行 `npm run build` 会自动刷新。

## Upstream (bridge → platform)

设备上报的消息。bridge 的所有上行报文都经唯一出口 `Emitter` 发出。

<a id="msg-hello"></a>

### hello — 握手

WebSocket 建立后立即发送。平台必须先完成握手（协议版本、设备令牌校验），之后才能下发指令。

**字段**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` = `hello` | ✓ |  |
| `protocolVersion` | `integer` = `2` | ✓ |  |
| `deviceId` | `string` | ✓ | 本地持久化的稳定身份；必须与 WS URL 的 `deviceId` query 完全相等，不允许空 ID 或仅凭 Bearer 反查 |
| `cliVersion` | `string` | ✓ |  |
| `platform` | `string` | ✓ |  |
| `hostname` | `string` | ✓ |  |
| `capabilities` | array&lt;string&gt; |  | 可选能力清单，平台据此降级。当前取值：diff / service-token / queue / scan-progress / cloud-events / capacity / task-step / task-message / task-snapshot / session-control / session-multi-turn / task-interaction / artifact-upload / artifact-download / interaction-url / permission-mode / artifact-inline / approval-ledger。 |
| `capacity` | `object` |  | 本次会话生效的调度额度（平台据此做有水位线的派发，而非靠 device_busy 试错） |
| `execution` | `object` |  | 本次会话生效的执行侧策略。平台据此决定「能不能请求 full」与「要不要等交互」， 不要按缺省值瞎猜：interactionEnabled=false 时不会出现任何 task_interaction_request。 |

**示例**

```json
{
  "type": "hello",
  "protocolVersion": 2,
  "deviceId": "bd_001122334455",
  "cliVersion": "string",
  "platform": "win32",
  "hostname": "string"
}
```


<a id="msg-agent_list"></a>

### agent_list — 本机 Agent 清单

探测到的全部 AI Agent，首连后发送一次。

**字段**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` = `agent_list` | ✓ |  |
| `agents` | array&lt;AgentListItem&gt; | ✓ |  |
| `scannedAt` | `string` (date-time) | ✓ |  |

**示例**

```json
{
  "type": "agent_list",
  "agents": [
    {
      "kind": "claude-code",
      "display": "string",
      "version": "string",
      "status": "not_installed",
      "path": "string",
      "credentialSource": "env:OPENAI_API_KEY",
      "capability": "non_interactive",
      "logo": "string"
    }
  ],
  "scannedAt": "string"
}
```


<a id="msg-scan_progress"></a>

### scan_progress — 扫描增量

扫描过程中的流式增量（仅在收到 scan 指令后出现）。

**字段**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` = `scan_progress` | ✓ |  |
| `requestId` | `string` |  |  |
| `items` | array&lt;AgentListItem&gt; | ✓ |  |
| `scannedAt` | `string` (date-time) | ✓ |  |
| `done` | `boolean` | ✓ |  |

**示例**

```json
{
  "type": "scan_progress",
  "requestId": "string",
  "items": [
    {
      "kind": "claude-code",
      "display": "string",
      "version": "string",
      "status": "not_installed",
      "path": "string",
      "credentialSource": "env:OPENAI_API_KEY",
      "capability": "non_interactive",
      "logo": "string"
    }
  ],
  "scannedAt": "string",
  "done": true
}
```


<a id="msg-scan_result"></a>

### scan_result — 扫描终态

scan 指令的最终响应。

**字段**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` = `scan_result` | ✓ |  |
| `requestId` | `string` |  |  |
| `agents` | array&lt;AgentListItem&gt; | ✓ |  |
| `scannedAt` | `string` (date-time) | ✓ |  |

**示例**

```json
{
  "type": "scan_result",
  "requestId": "string",
  "agents": [
    {
      "kind": "claude-code",
      "display": "string",
      "version": "string",
      "status": "not_installed",
      "path": "string",
      "credentialSource": "env:OPENAI_API_KEY",
      "capability": "non_interactive",
      "logo": "string"
    }
  ],
  "scannedAt": "string"
}
```


<a id="msg-task_log"></a>

### task_log — 任务输出分片

stdout / stderr 分片（每片 ≤ 4096 字节，且不切断多字节字符）。bridge 发送前会做脱敏（家目录 → `~`，长密钥折叠）。

**字段**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` = `task_log` | ✓ |  |
| `taskId` | `string` | ✓ |  |
| `stream` | `stdout` \| `stderr` | ✓ |  |
| `data` | `string` | ✓ |  |
| `isAnsi` | `boolean` | ✓ | 当前恒为 true（ANSI 解析未实现） |
| `turnId` | `string` |  |  |
| `eventSeq` | `integer` |  |  |

**示例**

```json
{
  "type": "task_log",
  "taskId": "string",
  "stream": "stdout",
  "data": "string",
  "isAnsi": true,
  "turnId": "string"
}
```


<a id="msg-task_status"></a>

### task_status — 任务状态

状态变更；也是唯一携带终态结果的消息：退出码、受控错误码，以及开启时的 diff。

**字段**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` = `task_status` | ✓ |  |
| `taskId` | `string` | ✓ |  |
| `status` | `running` \| `success` \| `failed` \| `cancelled` \| `timeout` | ✓ |  |
| `exitCode` | `integer` |  |  |
| `error` | `string` |  | 人类可读文案，可直接展示 |
| `errorCode` | `string` |  | 受控错误码，用于程序化分支（见 components/schemas/ErrorCode） |
| `phase` | `queued` \| `running` \| `waiting_interaction` \| `waiting_user` |  |  |
| `queuePosition` | `integer` |  |  |
| `turnId` | `string` |  |  |
| `eventSeq` | `integer` |  |  |
| `permissionMode` | `default` \| `full` |  | 本次任务实际采用并用于构造命令的权限模式。只表示 bridge 的选择， **不是** CLI 实际权限的证明，也不是 OS 提权或环境沙箱。 |
| `interactionId` | `string` |  | phase=waiting_interaction 时正在等待的 requestId；回到 running 或进入终态时该字段消失 （平台据「有无该字段」收起等待态，而不是靠超时猜）。 |
| `stopReason` | `end_turn` \| `max_tokens` \| `max_turn_requests` \| `refusal` \| `cancelled` |  | ACP 回合结算原因；只有 end_turn 才可能 success，取消必须靠 cancelled。 |
| `feedIncomplete` | `boolean` |  | canonical feed 未完整收尾；为 true 时平台必须展示「会话不完整」。 |
| `diff` | `string` |  | unified diff，仅当 `run_task.captureDiff` 为 true 时出现 |
| `changedFiles` | array&lt;string&gt; |  | 仓库相对路径，上限 500 条 |
| `diffTruncated` | `boolean` |  |  |
| `result` | `string` |  | 终态最终回答文本（步骤流工具从 result 事件提取；≤16KB） |
| `requestedBy` | `string` |  | 回显调用方身份，供平台落 requested_by 审计 |

**示例**

```json
{
  "type": "task_status",
  "taskId": "string",
  "status": "running",
  "error": "string",
  "errorCode": "string",
  "phase": "queued",
  "turnId": "string",
  "permissionMode": "default",
  "interactionId": "string",
  "stopReason": "end_turn",
  "diff": "string",
  "result": "string",
  "requestedBy": "string"
}
```


<a id="msg-capacity_update"></a>

### capacity_update — 容量水位

每次调度状态变化（入队 / 启动 / 终态）后发送一次，反映平台与控制面 两条通道的合计占用。平台据此知道「还能不能再派任务」，无需等 device_busy。

**字段**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` = `capacity_update` | ✓ |  |
| `running` | `integer` | ✓ | 正在执行的任务数 |
| `queued` | `integer` | ✓ | 排队中的任务数 |
| `maxTasks` | `integer` | ✓ |  |
| `maxQueued` | `integer` | ✓ |  |

**示例**

```json
{
  "type": "capacity_update",
  "running": 1,
  "queued": 1,
  "maxTasks": 1,
  "maxQueued": 1
}
```


<a id="msg-task_step"></a>

### task_step — 任务步骤（动态步骤流）

AI CLI 的步骤由模型实时决定，没有预定义总步数；平台拿到的是「已发生的步骤序列 + 当前步骤」。 仅 `agent_list` 中 `steps: true` 的工具会产生本消息。终态后该 task 的步骤一律丢弃（同 task_log）。

**字段**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` = `task_step` | ✓ |  |
| `taskId` | `string` | ✓ |  |
| `seq` | `integer` | ✓ | 从 1 单调递增 |
| `action` | `string` | ✓ | Bash / Edit / Read / command_execution / file_change… |
| `label` | `string` |  | 目标摘要，与日志同口径脱敏 |
| `state` | `started` \| `finished` | ✓ |  |
| `ok` | `boolean` |  | 仅 state=finished 时给出 |
| `ref` | `string` |  | 源事件关联 id（started/finished 配对） |
| `at` | `string` (date-time) | ✓ |  |
| `turnId` | `string` |  |  |
| `eventSeq` | `integer` |  |  |

**示例**

```json
{
  "type": "task_step",
  "taskId": "string",
  "seq": 1,
  "action": "string",
  "label": "string",
  "state": "started",
  "ref": "string",
  "at": "string",
  "turnId": "string"
}
```


<a id="msg-task_message"></a>

### task_message — canonical 会话消息

delta 是流式增量，complete 是最终完整文本；messageId 供平台幂等去重。

**字段**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` = `task_message` | ✓ |  |
| `taskId` | `string` | ✓ |  |
| `messageId` | `string` | ✓ |  |
| `role` | `user` \| `agent` \| `system` | ✓ |  |
| `state` | `delta` \| `complete` | ✓ |  |
| `text` | `string` | ✓ |  |
| `turnId` | `string` |  |  |
| `eventSeq` | `integer` |  |  |
| `at` | `string` (date-time) | ✓ |  |

**示例**

```json
{
  "type": "task_message",
  "taskId": "string",
  "messageId": "string",
  "role": "user",
  "state": "delta",
  "text": "string",
  "turnId": "string",
  "at": "string"
}
```


<a id="msg-task_snapshot"></a>

### task_snapshot — 任务历史快照

响应 get_task；终态后仍可补取，events 按 eventSeq 升序。

**字段**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` = `task_snapshot` | ✓ |  |
| `taskId` | `string` | ✓ |  |
| `requestId` | `string` |  |  |
| `found` | `boolean` | ✓ |  |
| `session` | `object` |  |  |
| `turns` | array&lt;object&gt; |  |  |
| `events` | array&lt;object&gt; |  |  |
| `oldestEventSeq` | `integer` |  |  |
| `latestEventSeq` | `integer` |  |  |
| `eventWindow` | `object` |  | 事件窗口完整性；gaps 为空数组表示序号连续。 |
| `errorCode` | `string` |  |  |

**示例**

```json
{
  "type": "task_snapshot",
  "taskId": "string",
  "requestId": "string",
  "found": true,
  "errorCode": "string"
}
```


<a id="msg-artifact_content"></a>

### artifact_content — 附件内联内容

响应 get_artifact。超过内联上限（1 MB）只回元数据并置 contentUnavailableReason=too_large， 平台应改走 artifact_download 分块通道。终态后仍可取，且不会重读工作区。

**字段**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` = `artifact_content` | ✓ |  |
| `taskId` | `string` | ✓ |  |
| `artifactId` | `string` | ✓ |  |
| `requestId` | `string` |  |  |
| `found` | `boolean` | ✓ |  |
| `name` | `string` |  |  |
| `mimeType` | `string` |  |  |
| `size` | `integer` |  |  |
| `sha256` | `string` |  |  |
| `kind` | `string` |  |  |
| `data` | `string` |  | base64 内容；仅可内联时出现 |
| `contentUnavailableReason` | `too_large` \| `not_readable` |  |  |
| `errorCode` | `string` |  |  |

**示例**

```json
{
  "type": "artifact_content",
  "taskId": "string",
  "artifactId": "string",
  "requestId": "string",
  "found": true,
  "name": "string",
  "mimeType": "string",
  "sha256": "string",
  "kind": "string",
  "data": "string",
  "contentUnavailableReason": "too_large",
  "errorCode": "string"
}
```


<a id="msg-task_artifact"></a>

### task_artifact — 入站附件已提交

**字段**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` = `task_artifact` | ✓ |  |
| `taskId` | `string` | ✓ |  |
| `artifactId` | `string` | ✓ |  |
| `name` | `string` | ✓ |  |
| `mimeType` | `string` | ✓ |  |
| `size` | `integer` | ✓ |  |
| `sha256` | `string` | ✓ |  |
| `kind` | `string` | ✓ |  |
| `eventSeq` | `integer` |  |  |

**示例**

```json
{
  "type": "task_artifact",
  "taskId": "string",
  "artifactId": "string",
  "name": "string",
  "mimeType": "string",
  "size": 1,
  "sha256": "string",
  "kind": "string"
}
```


<a id="msg-artifact_upload_ready"></a>

### artifact_upload_ready — 上传就绪

**字段**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` = `artifact_upload_ready` | ✓ |  |
| `transferId` | `string` | ✓ |  |
| `artifactId` | `string` | ✓ |  |
| `nextOffset` | `integer` | ✓ |  |
| `chunkSize` | `integer` | ✓ |  |

**示例**

```json
{
  "type": "artifact_upload_ready",
  "transferId": "string",
  "artifactId": "string",
  "nextOffset": 1,
  "chunkSize": 1
}
```


<a id="msg-artifact_upload_chunk_ack"></a>

### artifact_upload_chunk_ack — 上传 chunk 确认

**字段**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` = `artifact_upload_chunk_ack` | ✓ |  |
| `transferId` | `string` | ✓ |  |
| `nextOffset` | `integer` | ✓ |  |

**示例**

```json
{
  "type": "artifact_upload_chunk_ack",
  "transferId": "string",
  "nextOffset": 1
}
```


<a id="msg-artifact_download_ready"></a>

### artifact_download_ready — 下载就绪

**字段**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` = `artifact_download_ready` | ✓ |  |
| `transferId` | `string` | ✓ |  |
| `artifactId` | `string` | ✓ |  |
| `size` | `integer` | ✓ |  |
| `sha256` | `string` | ✓ |  |
| `chunkSize` | `integer` | ✓ |  |

**示例**

```json
{
  "type": "artifact_download_ready",
  "transferId": "string",
  "artifactId": "string",
  "size": 1,
  "sha256": "string",
  "chunkSize": 1
}
```


<a id="msg-artifact_download_chunk"></a>

### artifact_download_chunk — 下载附件 chunk

**字段**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` = `artifact_download_chunk` | ✓ |  |
| `transferId` | `string` | ✓ |  |
| `offset` | `integer` | ✓ |  |
| `data` | `string` | ✓ | base64 |
| `chunkSha256` | `string` | ✓ |  |

**示例**

```json
{
  "type": "artifact_download_chunk",
  "transferId": "string",
  "offset": 1,
  "data": "string",
  "chunkSha256": "string"
}
```


<a id="msg-artifact_download_result"></a>

### artifact_download_result — 下载结果

**字段**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` = `artifact_download_result` | ✓ |  |
| `transferId` | `string` | ✓ |  |
| `status` | `completed` \| `failed` | ✓ |  |
| `errorCode` | `string` |  |  |

**示例**

```json
{
  "type": "artifact_download_result",
  "transferId": "string",
  "status": "completed",
  "errorCode": "string"
}
```


<a id="msg-artifact_upload_result"></a>

### artifact_upload_result — 上传结果

**字段**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` = `artifact_upload_result` | ✓ |  |
| `transferId` | `string` | ✓ |  |
| `status` | `committed` \| `failed` | ✓ |  |
| `artifactId` | `string` |  |  |
| `sha256` | `string` |  |  |
| `eventSeq` | `integer` |  |  |
| `errorCode` | `string` |  |  |

**示例**

```json
{
  "type": "artifact_upload_result",
  "transferId": "string",
  "status": "committed",
  "artifactId": "string",
  "sha256": "string",
  "errorCode": "string"
}
```


<a id="msg-task_interaction_request"></a>

### task_interaction_request — 交互请求

权限 / Form / URL 请求；平台必须按 kind 选择对应 UI。

**字段**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` = `task_interaction_request` | ✓ |  |
| `taskId` | `string` | ✓ |  |
| `requestId` | `string` | ✓ |  |
| `turnId` | `string` |  |  |
| `kind` | `permission` \| `form` \| `auth-url` | ✓ |  |
| `payload` | `object` | ✓ |  |
| `expiresAt` | `string` (date-time) |  |  |
| `eventSeq` | `integer` |  |  |

**示例**

```json
{
  "type": "task_interaction_request",
  "taskId": "string",
  "requestId": "string",
  "turnId": "string",
  "kind": "permission",
  "payload": {},
  "expiresAt": "string"
}
```


<a id="msg-interaction_url"></a>

### interaction_url — 交互短期 URL

URL 仅存 bridge 进程内，带 TTL；不写入 SQLite 或日志。过期回 interaction_url_expired，从未注册/已撤销回 interaction_url_not_found。

**字段**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` = `interaction_url` | ✓ |  |
| `taskId` | `string` | ✓ |  |
| `requestId` | `string` | ✓ |  |
| `ok` | `boolean` | ✓ |  |
| `url` | `string` |  |  |
| `expiresAt` | `string` (date-time) |  |  |
| `errorCode` | `string` |  |  |

**示例**

```json
{
  "type": "interaction_url",
  "taskId": "string",
  "requestId": "string",
  "ok": true,
  "url": "string",
  "expiresAt": "string",
  "errorCode": "string"
}
```


<a id="msg-task_interaction_result"></a>

### task_interaction_result — 交互结果

终态后仍可按 requestId + resultSeq 重放。

**字段**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` = `task_interaction_result` | ✓ |  |
| `taskId` | `string` | ✓ |  |
| `requestId` | `string` | ✓ |  |
| `state` | `accepted` \| `declined` \| `cancelled` \| `expired` \| `failed` | ✓ |  |
| `responseId` | `string` |  |  |
| `resultSeq` | `integer` |  |  |
| `resultPayload` | `object` |  |  |
| `errorCode` | `string` |  |  |
| `eventSeq` | `integer` |  |  |

**示例**

```json
{
  "type": "task_interaction_result",
  "taskId": "string",
  "requestId": "string",
  "state": "accepted",
  "responseId": "string",
  "errorCode": "string"
}
```


<a id="msg-message_ack"></a>

### message_ack — 多轮消息回执

**字段**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` = `message_ack` | ✓ |  |
| `taskId` | `string` | ✓ |  |
| `messageId` | `string` | ✓ |  |
| `turnId` | `string` |  |  |
| `eventSeq` | `integer` |  |  |
| `delivery` | `queued` \| `duplicate` \| `rejected` | ✓ |  |
| `errorCode` | `string` |  |  |
| `at` | `string` (date-time) | ✓ |  |

**示例**

```json
{
  "type": "message_ack",
  "taskId": "string",
  "messageId": "string",
  "turnId": "string",
  "delivery": "queued",
  "errorCode": "string",
  "at": "string"
}
```


<a id="msg-session_ack"></a>

### session_ack — 会话控制回执

close_session / cancel_turn 的幂等回执；终态后仍会返回。

**字段**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` = `session_ack` | ✓ |  |
| `taskId` | `string` | ✓ |  |
| `operationId` | `string` | ✓ |  |
| `action` | `close_session` \| `cancel_turn` | ✓ |  |
| `ok` | `boolean` | ✓ |  |
| `status` | `string` |  |  |
| `errorCode` | `string` |  |  |
| `at` | `string` (date-time) | ✓ |  |

**示例**

```json
{
  "type": "session_ack",
  "taskId": "string",
  "operationId": "string",
  "action": "close_session",
  "ok": true,
  "status": "string",
  "errorCode": "string",
  "at": "string"
}
```


<a id="msg-pong"></a>

### pong — 心跳应答

对 ping 的应答。

**字段**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` = `pong` | ✓ |  |
| `at` | `integer` (int64) | ✓ |  |

**示例**

```json
{
  "type": "pong",
  "at": 1
}
```


## Downstream (platform → bridge)

平台下发的指令。未知消息类型会被拒并回受控错误码，不会静默忽略。

<a id="msg-run_task"></a>

### run_task — 下发任务

平台 → bridge。创建并执行一个任务；可携带可选的服务身份三件套（requestedBy / purpose / serviceToken）。

**字段**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` = `run_task` | ✓ |  |
| `taskId` | `string` | ✓ |  |
| `agentType` | `string` | ✓ | 必须是白名单内的 kind，否则本地拒绝 |
| `cwd` | `string` | ✓ | 设备上的绝对路径，须落在 allowed_cwd（若配置）内 |
| `args` | array&lt;string&gt; | ✓ | 参数数组（不经 shell）。传空数组表示用适配器的默认模板 |
| `prompt` | `string` |  |  |
| `timeoutMs` | `integer` |  | 从**入队**开始计时，缺省 10 分钟 |
| `allowInteractive` | `boolean` |  |  |
| `captureDiff` | `boolean` |  | 终态回传 unified diff（P0-6） |
| `sessionMode` | `task` \| `conversation` |  | 缺省 task；conversation 回合间保持 waiting_user |
| `permissionMode` | `default` \| `full` |  | 请求的权限模式（缺省 = 由本机 permission_policy 决定）。能否按 full 执行取决于 本机策略与该工具的 full 映射：不满足时任务被拒绝（permission_policy_denied / permission_mode_unsupported），**不会**静默降级为 default。 |
| `requestedBy` | `string` |  |  |
| `purpose` | `string` |  |  |
| `serviceToken` | `string` |  | scoped 服务令牌 `abs_<kid>_<secret>`；一旦携带必须校验通过 |

**示例**

```json
{
  "type": "run_task",
  "taskId": "string",
  "agentType": "string",
  "cwd": "string",
  "args": [
    "string"
  ],
  "prompt": "string",
  "sessionMode": "task",
  "permissionMode": "default",
  "requestedBy": "string",
  "purpose": "repair",
  "serviceToken": "string"
}
```


<a id="msg-cancel_task"></a>

### cancel_task — 取消任务

平台 → bridge。请求取消一个运行中的任务。

**字段**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` = `cancel_task` | ✓ |  |
| `taskId` | `string` | ✓ |  |
| `requestedBy` | `string` |  |  |
| `purpose` | `string` |  |  |
| `serviceToken` | `string` |  |  |

**示例**

```json
{
  "type": "cancel_task",
  "taskId": "string",
  "requestedBy": "string",
  "purpose": "string",
  "serviceToken": "string"
}
```


<a id="msg-get_task"></a>

### get_task — 补取任务历史

按 afterEventSeq 返回有界窗口；终态后仍可调用，需 task:read scope。

**字段**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` = `get_task` | ✓ |  |
| `taskId` | `string` | ✓ |  |
| `requestId` | `string` |  | 会原样带回 task_snapshot |
| `afterEventSeq` | `integer` |  |  |
| `limit` | `integer` |  |  |
| `requestedBy` | `string` |  |  |
| `purpose` | `string` |  |  |
| `serviceToken` | `string` |  |  |

**示例**

```json
{
  "type": "get_task",
  "taskId": "string",
  "requestId": "string",
  "requestedBy": "string",
  "purpose": "string",
  "serviceToken": "string"
}
```


<a id="msg-get_artifact"></a>

### get_artifact — 补取附件内容

按 artifactId 取回已落盘内容，需 task:read scope，且 artifact 必须属于该 taskId。 超过 1 MB 只回元数据（contentUnavailableReason=too_large），未知/已淘汰回 artifact_not_found。

**字段**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` = `get_artifact` | ✓ |  |
| `taskId` | `string` | ✓ |  |
| `artifactId` | `string` | ✓ |  |
| `requestId` | `string` |  | 会原样带回 artifact_content |
| `requestedBy` | `string` |  |  |
| `purpose` | `string` |  |  |
| `serviceToken` | `string` |  |  |

**示例**

```json
{
  "type": "get_artifact",
  "taskId": "string",
  "artifactId": "string",
  "requestId": "string",
  "requestedBy": "string",
  "purpose": "string",
  "serviceToken": "string"
}
```


<a id="msg-artifact_upload_start"></a>

### artifact_upload_start — 启动附件上传

**字段**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` = `artifact_upload_start` | ✓ |  |
| `taskId` | `string` | ✓ |  |
| `operationId` | `string` | ✓ |  |
| `name` | `string` | ✓ |  |
| `mimeType` | `string` | ✓ |  |
| `size` | `integer` | ✓ |  |
| `sha256` | `string` | ✓ |  |
| `chunkSize` | `integer` |  |  |
| `requestedBy` | `string` |  |  |
| `purpose` | `string` |  |  |
| `serviceToken` | `string` |  |  |

**示例**

```json
{
  "type": "artifact_upload_start",
  "taskId": "string",
  "operationId": "string",
  "name": "string",
  "mimeType": "string",
  "size": 1,
  "sha256": "string",
  "requestedBy": "string",
  "purpose": "string",
  "serviceToken": "string"
}
```


<a id="msg-artifact_upload_chunk"></a>

### artifact_upload_chunk — 上传附件 chunk

**字段**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` = `artifact_upload_chunk` | ✓ |  |
| `transferId` | `string` | ✓ |  |
| `offset` | `integer` | ✓ |  |
| `data` | `string` | ✓ | base64 |
| `chunkSha256` | `string` | ✓ |  |

**示例**

```json
{
  "type": "artifact_upload_chunk",
  "transferId": "string",
  "offset": 1,
  "data": "string",
  "chunkSha256": "string"
}
```


<a id="msg-artifact_download_start"></a>

### artifact_download_start — 启动附件下载

**字段**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` = `artifact_download_start` | ✓ |  |
| `taskId` | `string` | ✓ |  |
| `artifactId` | `string` | ✓ |  |
| `operationId` | `string` | ✓ |  |
| `requestedBy` | `string` |  |  |
| `purpose` | `string` |  |  |
| `serviceToken` | `string` |  |  |

**示例**

```json
{
  "type": "artifact_download_start",
  "taskId": "string",
  "artifactId": "string",
  "operationId": "string",
  "requestedBy": "string",
  "purpose": "string",
  "serviceToken": "string"
}
```


<a id="msg-artifact_download_chunk_ack"></a>

### artifact_download_chunk_ack — 下载 chunk 确认

**字段**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` = `artifact_download_chunk_ack` | ✓ |  |
| `transferId` | `string` | ✓ |  |
| `nextOffset` | `integer` | ✓ |  |

**示例**

```json
{
  "type": "artifact_download_chunk_ack",
  "transferId": "string",
  "nextOffset": 1
}
```


<a id="msg-artifact_upload_complete"></a>

### artifact_upload_complete — 完成附件上传

**字段**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` = `artifact_upload_complete` | ✓ |  |
| `transferId` | `string` | ✓ |  |
| `size` | `integer` | ✓ |  |
| `sha256` | `string` | ✓ |  |

**示例**

```json
{
  "type": "artifact_upload_complete",
  "transferId": "string",
  "size": 1,
  "sha256": "string"
}
```


<a id="msg-get_interaction_url"></a>

### get_interaction_url — 获取交互短期 URL

需要 task:respond scope；只返回进程内 Vault 中未过期的 URL。

**字段**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` = `get_interaction_url` | ✓ |  |
| `taskId` | `string` | ✓ |  |
| `requestId` | `string` | ✓ |  |
| `requestedBy` | `string` |  |  |
| `purpose` | `string` |  |  |
| `serviceToken` | `string` |  |  |

**示例**

```json
{
  "type": "get_interaction_url",
  "taskId": "string",
  "requestId": "string",
  "requestedBy": "string",
  "purpose": "string",
  "serviceToken": "string"
}
```


<a id="msg-task_interaction_response"></a>

### task_interaction_response — 回复交互

permission 需要 task:approve，form/auth-url 需要 task:respond；responseId 幂等。

**字段**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` = `task_interaction_response` | ✓ |  |
| `taskId` | `string` | ✓ |  |
| `requestId` | `string` | ✓ |  |
| `responseId` | `string` | ✓ |  |
| `state` | `accepted` \| `declined` \| `cancelled` | ✓ |  |
| `payload` | `object` |  |  |
| `respondedBy` | `string` |  |  |
| `requestedBy` | `string` |  |  |
| `purpose` | `string` |  |  |
| `serviceToken` | `string` |  |  |

**示例**

```json
{
  "type": "task_interaction_response",
  "taskId": "string",
  "requestId": "string",
  "responseId": "string",
  "state": "accepted",
  "respondedBy": "string",
  "requestedBy": "string",
  "purpose": "string",
  "serviceToken": "string"
}
```


<a id="msg-send_message"></a>

### send_message — 发送多轮消息

conversation 且 waiting_user 时创建新 Turn；messageId 为幂等键。

**字段**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` = `send_message` | ✓ |  |
| `taskId` | `string` | ✓ |  |
| `messageId` | `string` | ✓ |  |
| `mode` | `queue` \| `steer` |  |  |
| `parts` | array&lt;object&gt; | ✓ |  |
| `respondedBy` | `string` |  |  |
| `requestedBy` | `string` |  |  |
| `purpose` | `string` |  |  |
| `serviceToken` | `string` |  |  |

**示例**

```json
{
  "type": "send_message",
  "taskId": "string",
  "messageId": "string",
  "mode": "queue",
  "parts": [
    {
      "kind": "text",
      "text": "string"
    }
  ],
  "respondedBy": "string",
  "requestedBy": "string",
  "purpose": "string",
  "serviceToken": "string"
}
```


<a id="msg-close_session"></a>

### close_session — 关闭会话

operationId 为幂等键；终态会话重复关闭返回原状态。

**字段**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` = `close_session` | ✓ |  |
| `taskId` | `string` | ✓ |  |
| `operationId` | `string` | ✓ |  |
| `requestedBy` | `string` |  |  |
| `purpose` | `string` |  |  |
| `serviceToken` | `string` |  |  |

**示例**

```json
{
  "type": "close_session",
  "taskId": "string",
  "operationId": "string",
  "requestedBy": "string",
  "purpose": "string",
  "serviceToken": "string"
}
```


<a id="msg-cancel_turn"></a>

### cancel_turn — 取消指定 Turn

**字段**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` = `cancel_turn` | ✓ |  |
| `taskId` | `string` | ✓ |  |
| `turnId` | `string` | ✓ |  |
| `operationId` | `string` | ✓ |  |
| `requestedBy` | `string` |  |  |
| `purpose` | `string` |  |  |
| `serviceToken` | `string` |  |  |

**示例**

```json
{
  "type": "cancel_turn",
  "taskId": "string",
  "turnId": "string",
  "operationId": "string",
  "requestedBy": "string",
  "purpose": "string",
  "serviceToken": "string"
}
```


<a id="msg-scan"></a>

### scan — 重新扫描工具

平台 → bridge。请求设备重新探测本机已安装的工具。

**字段**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` = `scan` | ✓ |  |
| `requestId` | `string` |  | 会原样带回 scan_progress / scan_result |

**示例**

```json
{
  "type": "scan",
  "requestId": "string"
}
```


<a id="msg-ping"></a>

### ping — 心跳

平台 → bridge；bridge 回 pong。

**字段**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` = `ping` | ✓ |  |
| `at` | `integer` (int64) |  |  |

**示例**

```json
{
  "type": "ping"
}
```

