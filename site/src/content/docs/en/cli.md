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
    [--max-tasks=30] [--max-queue=60]
    [--permission-policy=default|allow-full|full] [--external-sandbox]
    [--interaction-enabled] [--interaction-timeout-ms=900000] [--max-interactions-per-task=16]
```

| Flag | Meaning |
| --- | --- |
| `--token` | Use an existing device token instead of the browser flow (CI / scripted rollouts). Requires a persisted, migratable, or explicit stable ID; startup fails without one. |
| `--device-id` | Stable device id matching `^bd_(?:[0-9a-f]{32}|[0-9a-f]{12})$`. Also settable via `AGENT_BRIDGE_DEVICE_ID`; can migrate or confirm identity, never override a different stored ID. |
| `--no-browser` | Use the device-code flow instead of opening a browser (SSH, headless). |
| `--label` | A human label for the device. |
| `--max-tasks` | Concurrency cap for this session (default 30, clamped 1–128). |
| `--max-queue` | Queue cap for this session (default 60, clamped 0–1024; 0 = no queueing). |
| `--permission-policy` | Local permission policy for this session: `allow-full` lets the platform ask for full per task; `full` also promotes tasks that omit the field. Under `allow-full` / `full` the platform may only send empty `args`. |
| `--external-sandbox` | Declares that CodeBuddy's full mode runs inside a real external sandbox (only affects CodeBuddy's full admission). |
| `--interaction-enabled` | Allows permission/form interactions for this session (off by default; while off no interaction request is sent). |
| `--interaction-timeout-ms` | Per-wait cap (default 900000, clamped 10s–2h; a shorter adapter `expiresAt` wins). |
| `--max-interactions-per-task` | Per-task interaction budget (default 16, clamped 1–256); extra requests are dropped. |

Precedence: startup flags > env (`AGENT_BRIDGE_MAX_TASKS` / `AGENT_BRIDGE_MAX_QUEUE`) > config.toml > defaults.

With no flags, it persists or reuses the stable identity before opening your browser, completes PKCE,
stores the token, and opens the outbound WebSocket. The authorization request, WS URL query, and
`hello.deviceId` all carry that same ID. A pre-issued `--token` never causes a new ID to be generated.

## serve

Same main flow as `connect`, plus the **optional** loopback control plane.

```bash
agent-bridge serve <platformUrl> [--port=8787] [--max-tasks=30] [--max-queue=60]
    [--permission-policy=default|allow-full|full] [--external-sandbox]
    [--interaction-enabled] [--interaction-timeout-ms=900000] [--max-interactions-per-task=16]
```

- `connect` starts the local Web panel on `127.0.0.1:8787` by default and falls forward if the port is taken.
- `serve` honors `--port` (or `[control_plane] enabled = true` in config); without it, the default behavior applies.
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

Delete the local device credential while preserving `identity.toml`, the config mirror, and settings.
After revocation, run `logout` → `connect`: authorization binds the same device ID again.

```bash
agent-bridge logout
```

## services

Issue and manage **scoped service tokens** — identities for backend services and scripts, not for
humans.

```bash
agent-bridge services issue|list|revoke|rotate
  --label=<name>
  --scopes=task:create,task:cancel,task:read,session:read,device:read,task:approve,task:respond,approval:persist
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

## approvals

Inspect and revoke **persistent approvals** (1.0). The ledger is off by default
(`approval_ledger_enabled = true` or `connect --approval-ledger`); it is only ever written when a human
answers an interactive permission request with a persistent allow **and** the responder holds
`approval:persist`.

```bash
agent-bridge approvals list [--all]        # --all also shows revoked rows
agent-bridge approvals revoke <approvalId>
agent-bridge approvals purge               # drop expired rows
```

An approval matches only when the mode is `default`, the request really offers a persistent allow
option, and the fingerprint (agent + tool kind + normalized resource) hits an unexpired record. `full`
mode never uses the ledger, and model text or tool titles never create or widen an approval. Hits and
revocations are audited as `approval_hit` / `approval_grant` / `approval_revoke`.

## daemon

```bash
agent-bridge daemon start <platformUrl> | stop | status | install <platformUrl> | uninstall
```

Lightweight background management: detached process, `daemon.pid`, and `daemon.log` under the state
directory. `install` / `uninstall` registers a per-user service: Linux systemd user, macOS LaunchAgent,
or a Windows logon scheduled task; both support `--dry-run`.

## Global

```bash
agent-bridge --version | -v
agent-bridge help | --help | -h
```
