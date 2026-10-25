---
title: WebSocket channel
description: URL, authentication, handshake, heartbeat, backoff, and what is lost during a disconnect.
sidebar:
  order: 3
---

One WebSocket, opened by the device, outbound. This is the whole task channel: HTTP is used only
to bind the device.

## Connecting

- **Direction of establishment:** device → platform. The device never listens.
- **Scheme:** `wss://` in production; `ws://` only for local development.
- **URL:** `wss://<platform>/api/bridge/ws?deviceId=<stable-id>`; the query ID is required and must
  equal `hello.deviceId`.
- **Authentication:** the `device_token` obtained during binding, sent as a Bearer credential at
  handshake. Platforms store only the token's SHA-256.

## Handshake

As soon as the socket opens, the device sends `hello`:

```json
{
  "type": "hello",
  "protocolVersion": 2,
  "deviceId": "bd_001122334455",
  "cliVersion": "0.2.3",
  "platform": "darwin",
  "hostname": "dev-laptop",
  "capabilities": ["diff", "service-token", "queue", "scan-progress", "cloud-events", "capacity", "task-step"]
}
```

Protocol v2 requires a non-empty `deviceId` matching `^bd_(?:[0-9a-f]{32}|[0-9a-f]{12})$`; it is
the locally persisted identity, not a value derived from the Bearer token. Reject a missing, malformed,
or URL/hello-mismatched ID. If your platform speaks a different `protocolVersion`, close with
`protocol_incompatible` — do not proceed and hope.

Right after `hello` the device sends `agent_list`, the inventory of AI agents it found.

## Heartbeat

The device pings every **15 s** and expects `pong`. A platform should treat a missed heartbeat as
"possibly disconnected" and, if no frame arrives for a while, consider the device offline.

```json
{ "type": "ping", "ts": 1730000000000 }
```

## Reconnect and backoff

The device reconnects on its own, with exponential backoff starting at **1 s** and capped at
**30 s**. A successful connection resets the backoff to 1 s.

:::caution
What is lost across a disconnect
Task output produced while the socket is down is **dropped** — there is no replay buffer yet. The
device resynchronizes state on reconnect, but log chunks emitted during the outage are gone.
Platforms should surface a gap rather than pretend the log is complete.
:::

## Ordering guarantees

- `task_status` reaches a terminal state exactly once, per task, thanks to the `Emitter`.
- `task_log` chunks are ordered per task, ≤ 4096 bytes each, and never split a multi-byte
  character.
- `scan_progress` may interleave with `task_log`; they belong to different tasks or scans.

## Full normative description

Everything above is summarised from [`contracts/asyncapi-3.0.yaml`](/agent-bridge/asyncapi-3.0.yaml).
For field-level detail, see [Protocol messages](/agent-bridge/en/protocol/messages).
