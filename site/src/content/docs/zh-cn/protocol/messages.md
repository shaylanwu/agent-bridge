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
| `capabilities` | array&lt;string&gt; |  | 可选能力清单，平台据此降级。当前取值：diff / service-token / queue / scan-progress / cloud-events / capacity / task-step / task-message / task-snapshot。 |
| `capacity` | `object` |  | 本次会话生效的调度额度（平台据此做有水位线的派发，而非靠 device_busy 试错） |

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

