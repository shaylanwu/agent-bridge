---
title: Quickstart
description: Install Agent Bridge Service, bind a device to your platform, and run your first task.
sidebar:
  order: 1
---

## Install

```bash
npm install -g agent-bridge-service
# or, without installing:
npx agent-bridge-service status
```

Requires Node.js 18 or newer. The device keeps **no inbound ports** — everything below works
behind NAT and corporate proxies.

## See what's on the machine

```bash
agent-bridge status
```

Probes the 12 supported AI agents and reports each one's state: `ready`, `installed_no_cred`
(installed but no credentials), or `not_installed`. Add `--fresh` to force a re-probe, `--json`
for machine consumption.

## Bind to a platform

```bash
agent-bridge connect https://your-platform.example.com
```

1. Your browser opens on the platform's authorization page.
2. You approve; the platform redirects back to a loopback callback with a one-time `code`.
3. Agent Bridge Service exchanges that `code` (PKCE S256) for a `device_token`.
4. It opens the outbound WebSocket and sends `hello`, then `agent_list`.

Over SSH or any environment without a browser, use the device-code flow instead:

```bash
agent-bridge connect https://your-platform.example.com --no-browser
```

You get a short code to approve elsewhere; the CLI polls until you do.

Already have a token (CI, scripted fleet rollout)? Skip the browser entirely:

```bash
agent-bridge connect https://your-platform.example.com \
  --token=dt_xxx --device-id=bd_xxx
```

Pass `--device-id` (or set `AGENT_BRIDGE_DEVICE_ID`) whenever you use `--token`, otherwise the
platform has to reverse-lookup the device from the token.

## Where state lives

| File | Path | Contents |
| --- | --- | --- |
| Config | `~/.agent-bridge/config.toml` (`%APPDATA%\.agent-bridge\config.toml` on Windows) | `platformUrl`, `deviceId`, `max_tasks`, control-plane settings |
| Device credential | same directory | `device_token`, chmod `0600` |
| Service tokens | `~/.agent-bridge/services.toml` | Issued `abs_…` tokens (hashed) |

Override the config location with `AGENT_BRIDGE_CONFIG`.

## Run your first task

From the platform side, send a `run_task` frame:

```json
{
  "type": "run_task",
  "taskId": "t_01",
  "agentType": "claude-code",
  "cwd": "/home/you/repo",
  "prompt": "Add a unit test for the tokenizer",
  "timeoutMs": 300000,
  "captureDiff": true
}
```

You then receive, in order: `task_status` (`running`), zero or more `task_log` chunks, and one
terminal `task_status` (`success` / `failed` / `cancelled` / `timeout`) carrying `exitCode`,
`errorCode`, and — because `captureDiff` was set — the diff.

## Optional: the loopback control plane

If the thing calling you is another program **on the same machine**, you do not need a platform at
all:

```bash
agent-bridge services issue --label=my-script --scopes=task:create,task:read
agent-bridge serve https://your-platform.example.com --port=8787
curl -H "Authorization: Bearer abs_…" http://127.0.0.1:8787/v1/health
```

See [Local integration](/agent-bridge/en/integrate/local) for the full surface. Without `--port`
(or without `enabled = true` in config), `serve` behaves exactly like `connect` and opens no port
at all.

## Next steps

- [CLI reference](/agent-bridge/en/cli) — every command and flag
- [Protocol overview](/agent-bridge/en/protocol/overview) — capabilities, versioning, error codes
- [Platform integration](/agent-bridge/en/integrate/platform) — what to implement
