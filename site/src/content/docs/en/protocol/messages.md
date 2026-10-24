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
| `protocolVersion` | `integer` = `1` | ✓ |  |
| `deviceId` | `string` | ✓ |  |
| `cliVersion` | `string` | ✓ |  |
| `platform` | `string` | ✓ |  |
| `hostname` | `string` | ✓ |  |
| `capabilities` | array&lt;string&gt; |  |  |

**Example**

```json
{
  "type": "hello",
  "protocolVersion": 1,
  "deviceId": "string",
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

**Example**

```json
{
  "type": "task_log",
  "taskId": "string",
  "stream": "stdout",
  "data": "string",
  "isAnsi": true
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
| `phase` | `queued` \| `running` |  |  |
| `queuePosition` | `integer` |  |  |
| `diff` | `string` |  |  |
| `changedFiles` | array&lt;string&gt; |  |  |
| `diffTruncated` | `boolean` |  |  |
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
  "diff": "string",
  "requestedBy": "string"
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

