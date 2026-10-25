---
title: Protocol messages
description: Every message on the WebSocket channel, field by field — generated from the AsyncAPI contract.
---

> This page is generated from `contracts/asyncapi-3.0.yaml` — do not edit by hand. Run `npm run build` in `site/` to refresh.

## Upstream (bridge → platform)

Messages the device sends up. Everything the bridge sends leaves through a single `Emitter`.

<a id="msg-hello"></a>

### hello — Handshake

Sent immediately after the WebSocket opens. The platform must implement the handshake rules (protocol version, device token) before anything else.

**Fields**


| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `string` = `hello` | ✓ |  |
| `protocolVersion` | `integer` = `2` | ✓ |  |
| `deviceId` | `string` | ✓ |  |
| `cliVersion` | `string` | ✓ |  |
| `platform` | `string` | ✓ |  |
| `hostname` | `string` | ✓ |  |
| `capabilities` | array&lt;string&gt; |  |  |
| `capacity` | `object` |  |  |

**Example**

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

### agent_list — Agent inventory

The full list of detected agents, sent once after the first connection.

**Fields**


| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `string` = `agent_list` | ✓ |  |
| `agents` | array&lt;AgentListItem&gt; | ✓ |  |
| `scannedAt` | `string` (date-time) | ✓ |  |

**Example**

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

### scan_progress — Scan progress

Streaming partial results while a scan is running (only after a `scan` command).

**Fields**


| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `string` = `scan_progress` | ✓ |  |
| `requestId` | `string` |  |  |
| `items` | array&lt;AgentListItem&gt; | ✓ |  |
| `scannedAt` | `string` (date-time) | ✓ |  |
| `done` | `boolean` | ✓ |  |

**Example**

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

### scan_result — Scan result

Terminal response to a `scan` command.

**Fields**


| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `string` = `scan_result` | ✓ |  |
| `requestId` | `string` |  |  |
| `agents` | array&lt;AgentListItem&gt; | ✓ |  |
| `scannedAt` | `string` (date-time) | ✓ |  |

**Example**

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

### task_log — Task output chunk

A chunk of stdout/stderr (each chunk is at most 4096 bytes and never splits a multi-byte character). The bridge redacts home directories and long secrets before sending.

**Fields**


| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `string` = `task_log` | ✓ |  |
| `taskId` | `string` | ✓ |  |
| `stream` | `stdout` \| `stderr` | ✓ |  |
| `data` | `string` | ✓ |  |
| `isAnsi` | `boolean` | ✓ |  |
| `turnId` | `string` |  |  |
| `eventSeq` | `integer` |  |  |

**Example**

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

### task_status — Task state

State transitions, and the only message that carries terminal results: exit code, controlled error code, and (when enabled) the diff.

**Fields**


| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `string` = `task_status` | ✓ |  |
| `taskId` | `string` | ✓ |  |
| `status` | `running` \| `success` \| `failed` \| `cancelled` \| `timeout` | ✓ |  |
| `exitCode` | `integer` |  |  |
| `error` | `string` |  |  |
| `errorCode` | `string` |  |  |
| `phase` | `queued` \| `running` \| `waiting_interaction` \| `waiting_user` |  |  |
| `queuePosition` | `integer` |  |  |
| `turnId` | `string` |  |  |
| `eventSeq` | `integer` |  |  |
| `diff` | `string` |  |  |
| `changedFiles` | array&lt;string&gt; |  |  |
| `diffTruncated` | `boolean` |  |  |
| `result` | `string` |  |  |
| `requestedBy` | `string` |  |  |

**Example**

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

**Fields**


| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `string` = `capacity_update` | ✓ |  |
| `running` | `integer` | ✓ |  |
| `queued` | `integer` | ✓ |  |
| `maxTasks` | `integer` | ✓ |  |
| `maxQueued` | `integer` | ✓ |  |

**Example**

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

**Fields**


| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `string` = `task_step` | ✓ |  |
| `taskId` | `string` | ✓ |  |
| `seq` | `integer` | ✓ |  |
| `action` | `string` | ✓ |  |
| `label` | `string` |  |  |
| `state` | `started` \| `finished` | ✓ |  |
| `ok` | `boolean` |  |  |
| `ref` | `string` |  |  |
| `at` | `string` (date-time) | ✓ |  |
| `turnId` | `string` |  |  |
| `eventSeq` | `integer` |  |  |

**Example**

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

**Fields**


| Field | Type | Required | Description |
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

**Example**

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

**Fields**


| Field | Type | Required | Description |
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

**Example**

```json
{
  "type": "task_snapshot",
  "taskId": "string",
  "requestId": "string",
  "found": true,
  "errorCode": "string"
}
```


<a id="msg-session_ack"></a>

### session_ack — 会话控制回执

**Fields**


| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `string` = `session_ack` | ✓ |  |
| `taskId` | `string` | ✓ |  |
| `operationId` | `string` | ✓ |  |
| `action` | `close_session` \| `cancel_turn` | ✓ |  |
| `ok` | `boolean` | ✓ |  |
| `status` | `string` |  |  |
| `errorCode` | `string` |  |  |
| `at` | `string` (date-time) | ✓ |  |

**Example**

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

### pong — Heartbeat reply

Reply to `ping`.

**Fields**


| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `string` = `pong` | ✓ |  |
| `at` | `integer` (int64) | ✓ |  |

**Example**

```json
{
  "type": "pong",
  "at": 1
}
```


## Downstream (platform → bridge)

Commands the platform sends down. An unknown message type is rejected with a controlled error code, never silently ignored.

<a id="msg-run_task"></a>

### run_task — Dispatch a task

Platform → bridge. Creates and runs one agent task. Accepts the optional service-identity triple (`requestedBy` / `purpose` / `serviceToken`).

**Fields**


| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `string` = `run_task` | ✓ |  |
| `taskId` | `string` | ✓ |  |
| `agentType` | `string` | ✓ |  |
| `cwd` | `string` | ✓ |  |
| `args` | array&lt;string&gt; | ✓ |  |
| `prompt` | `string` |  |  |
| `timeoutMs` | `integer` |  |  |
| `allowInteractive` | `boolean` |  |  |
| `captureDiff` | `boolean` |  |  |
| `requestedBy` | `string` |  |  |
| `purpose` | `string` |  |  |
| `serviceToken` | `string` |  |  |

**Example**

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

### cancel_task — Cancel a task

Platform → bridge. Requests cancellation of a running task.

**Fields**


| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `string` = `cancel_task` | ✓ |  |
| `taskId` | `string` | ✓ |  |
| `requestedBy` | `string` |  |  |
| `purpose` | `string` |  |  |
| `serviceToken` | `string` |  |  |

**Example**

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

**Fields**


| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `string` = `get_task` | ✓ |  |
| `taskId` | `string` | ✓ |  |
| `requestId` | `string` |  |  |
| `afterEventSeq` | `integer` |  |  |
| `limit` | `integer` |  |  |
| `requestedBy` | `string` |  |  |
| `purpose` | `string` |  |  |
| `serviceToken` | `string` |  |  |

**Example**

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


<a id="msg-close_session"></a>

### close_session — 关闭会话

**Fields**


| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `string` = `close_session` | ✓ |  |
| `taskId` | `string` | ✓ |  |
| `operationId` | `string` | ✓ |  |
| `requestedBy` | `string` |  |  |
| `purpose` | `string` |  |  |
| `serviceToken` | `string` |  |  |

**Example**

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

**Fields**


| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `string` = `cancel_turn` | ✓ |  |
| `taskId` | `string` | ✓ |  |
| `turnId` | `string` | ✓ |  |
| `operationId` | `string` | ✓ |  |
| `requestedBy` | `string` |  |  |
| `purpose` | `string` |  |  |
| `serviceToken` | `string` |  |  |

**Example**

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

### scan — Re-scan agents

Platform → bridge. Asks the device to re-probe installed agents.

**Fields**


| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `string` = `scan` | ✓ |  |
| `requestId` | `string` |  |  |

**Example**

```json
{
  "type": "scan",
  "requestId": "string"
}
```


<a id="msg-ping"></a>

### ping — Heartbeat

Platform → bridge; the bridge replies with `pong`.

**Fields**


| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `string` = `ping` | ✓ |  |
| `at` | `integer` (int64) |  |  |

**Example**

```json
{
  "type": "ping"
}
```

