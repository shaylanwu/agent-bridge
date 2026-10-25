---
title: For platform builders
description: What you must implement to drive agents on someone else's machine.
sidebar:
  order: 1
---

You are building the **remote** side: users run `agent-bridge connect <your-url>` on their own
machines, and you dispatch agent tasks to them.

Two things to build, and they are separate:

1. **Four HTTP endpoints** that bind a device to a user (once per device).
2. **A WebSocket server** that carries every task and event (continuously).

## 1. Device binding (HTTP)

| Endpoint | Purpose |
| --- | --- |
| `GET /bridge/authorize` | Browser page where the logged-in user approves the binding, then 302s back with `code` |
| `POST /api/bridge/token` | Exchange `code` + `codeVerifier` (PKCE S256) for a `device_token` |
| `POST /api/bridge/device-code` | Issue a short `user_code` for browserless / SSH setups |
| `POST /api/bridge/device-token` | Poll that device code until the user confirms |

Non-negotiables:

- **Verify PKCE.** `base64url(sha256(codeVerifier))` must equal the `code_challenge` you issued.
- **Rebind the requested stable identity.** Both token endpoints require `deviceId`, `hostname`,
  `platform`, and `cliVersion`; the PKCE endpoint also sends `redirectUri` and both use `clientId`.
  `/device-code` still sends only `clientId`. A successful `device_id` must equal the request `deviceId`,
  or the bridge rejects the response without saving credentials or connecting.
- **Return public error codes at JSON top level.** `400 invalid_device_id` preserves local identity;
  `409 device_bound_to_other_account` and `409 device_identity_ambiguous` require a platform administrator
  (no automatic ID change, merge, or ownership transfer); `401`/`403` are terminal credential failures;
  only `428 authorization_pending` tells device-code polling to continue at the server interval.
- **Store only the SHA-256 of `device_token`** — never the token itself. `refresh_token` is optional.
  When present, the bridge tries one refresh on WS close `4401`/`4403` by calling
  `POST /api/bridge/token` with `grant_type=refresh_token` and reconnects with the new token. A failed
  refresh falls back to explicit re-authorization; it never retries indefinitely.
- The redirect target is a loopback URL (`http://127.0.0.1:<random port>/callback`) — do not
  restrict `redirect_uri` to a registered HTTPS origin.
- Returning `404` for `device-code` / `device-token` is allowed: the bridge then tells the user your
  platform has not shipped that flow.

Full field-level reference: [Platform HTTP endpoints](/agent-bridge/en/api/reference), and the
contract at [`/openapi-3.1.yaml`](/agent-bridge/openapi-3.1.yaml). You can also try requests
live on the [interactive page](/agent-bridge/en/api/index).

## 2. The task channel (WebSocket)

Accept from the device: `hello`, `agent_list`, `scan_progress`, `scan_result`, `task_log`,
`task_status`, `capacity_update`, `pong`.
Send to the device: `run_task`, `cancel_task`, `scan`, `ping`.

Field-level reference: [Protocol messages](/agent-bridge/en/protocol/messages).

Rules that bite in production:

- **Require protocol v1 identity.** `hello.protocolVersion` is `1`; its non-empty `deviceId` matches
  `^bd_(?:[0-9a-f]{32}|[0-9a-f]{12})$` and must equal the WS URL query. There is no empty-ID/Bearer
  reverse-lookup fallback.
- **Degrade on `capabilities`, not on version numbers.** If `diff` is absent, never ask for it and
  never render a diff pane.
- **Branch on `errorCode`, never on prose.** See the 15 codes in
  [Protocol overview](/agent-bridge/en/protocol/overview#controlled-error-codes).
- **Treat `status: "running"` as "not finished".** Queued tasks look the same but carry
  `phase: "queued"` and `queuePosition`.
- **Heartbeat every 15 s** from the platform is optional, but you should mark a device offline if
  nothing arrives for a while. The device reconnects with backoff (1 s → 30 s) on its own.
- **Own your own `lost` state.** If a task goes silent, your watchdog should settle it — the
  bridge reports what it knows, but a machine can lose power mid-task.

## 3. Concurrency

`max_tasks` on the device (default 30) covers **both** channels — platform tasks and locally created
ones share the cap. A task beyond the cap is queued, not rejected; if you need to show "queued",
read `phase`.

## 4. Optional: let backend services call you

If a backend service of yours (a repair orchestrator, a CI scheduler) dispatches tasks, give it a
**scoped service token** instead of a user session, and pass it through:

```json
{ "type": "run_task", "taskId": "t_9", "agentType": "codex", "cwd": "/repo",
  "prompt": "…", "requestedBy": "svc:repair-orchestrator",
  "purpose": "repair", "serviceToken": "abs_…" }
```

The bridge validates the token and echoes `requestedBy` back on the terminal `task_status`, so you
can record in your own database who actually asked. Your platform still authorizes (may this service
act for this user?); the bridge authenticates (is this token real, in scope, un-revoked?).

## 5. Go-live checklist

- [ ] PKCE S256 verified; stable request ID rebound idempotently; response `device_id` checked; only token hashes stored
- [ ] Public `code` returned for `invalid_device_id`, both 409 conflicts, credential failures, and `authorization_pending`
- [ ] `hello` v2 and URL/hello ID equality checked; unknown capabilities degraded gracefully
- [ ] Terminal `task_status` handled idempotently (it can arrive twice after a reconnect)
- [ ] All 15 error codes mapped to something a human can act on
- [ ] Queued tasks rendered via `phase`, not by inventing a status
- [ ] Watchdog settles tasks that went silent
- [ ] Log gaps after a reconnect are surfaced, not hidden
