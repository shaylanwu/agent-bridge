---
title: CLI reference
description: Every Agent Bridge Service command and flag.
sidebar:
  order: 2
---

Six commands. The registry lives in `src/cli/dispatch.ts`; a harness check fails the build if a
command is added without documentation, so this page cannot drift from the code.

## connect

Bind this machine to a platform and stay connected.

```bash
agent-bridge connect <platformUrl> [--token=xxx] [--device-id=bd_xxx] [--no-browser] [--label=name]
```

| Flag | Meaning |
| --- | --- |
| `--token` | Use an existing device token instead of the browser flow (CI / scripted rollouts). Pair it with `--device-id`. |
| `--device-id` | Device id, e.g. `bd_9f1c…`. Also settable via `AGENT_BRIDGE_DEVICE_ID`. |
| `--no-browser` | Use the device-code flow instead of opening a browser (SSH, headless). |
| `--label` | A human label for the device. |

With no flags, it opens your browser, completes PKCE, stores the token `0600`, and opens the
outbound WebSocket.

## serve

Same main flow as `connect`, plus the **optional** loopback control plane.

```bash
agent-bridge serve <platformUrl> [--port=8787]
```

- With `--port` (or `[control_plane] enabled = true` in config), a loopback HTTP API starts for
  other programs on this machine.
- **Without it, `serve` is identical to `connect` and opens no port.** The control plane is never
  on by default.
- Env overrides: `AGENT_BRIDGE_CONTROL_PLANE=true`, `AGENT_BRIDGE_CONTROL_PORT=8787`.

## status

Probe installed coding CLIs on this machine.

```bash
agent-bridge status [--json] [--fresh]
```

| Flag | Meaning |
| --- | --- |
| `--json` | Machine-readable output. |
| `--fresh` | Force a re-probe instead of the cached snapshot. |

Each agent reports `ready`, `installed_no_cred`, or `not_installed`, plus the resolved executable
path and credential source.

## logout

Delete the local device credential. The device must bind again before it can be used.

```bash
agent-bridge logout
```

## services

Issue and manage **scoped service tokens** — identities for backend services and scripts, not for
humans.

```bash
agent-bridge services issue|list|revoke|rotate
  --label=<name>
  --scopes=task:create,task:cancel,task:read,device:read
  [--ttl-days=90]          # issue
  [--grace-hours=24]       # rotate: old token stays valid during the grace window
```

| Subcommand | Meaning |
| --- | --- |
| `issue` | Mint `abs_<kid>_<secret>`. The secret is shown once. |
| `list` | Show issued tokens (secret never stored in the clear). |
| `revoke` | Revoke immediately. |
| `rotate` | Mint a replacement with a grace window, so deploys do not break. |

Pass the token as `serviceToken` on `run_task` / `cancel_task`, or as a Bearer token to the control
plane. Failure codes are stable: `unauthorized` (missing), `invalid_token`, `token_expired`,
`insufficient_scope`.

## daemon

```bash
agent-bridge daemon start|stop|install|uninstall
```

**Not implemented.** The command exists as a placeholder and exits with a notice. Run the process
under your own supervisor (systemd, launchd, Windows service) for now.

## Global

```bash
agent-bridge --version | -v
agent-bridge help | --help | -h
```
