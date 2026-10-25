---
title: Changelog
description: Release history — one source of truth, two places it shows up.
sidebar:
  order: 5
---

This page is a **render of [`CHANGELOG.md`](https://github.com/shaylanwu/agent-bridge/blob/main/CHANGELOG.md)**
in the repository root: the build reads that file through `site/scripts/gen-changelog.mjs` and fills in
the body below. The site never keeps a second copy of the release history.

- **Releases are automatic.** Once a commit that follows
  [Conventional Commits](https://www.conventionalcommits.org/) lands on `main`, semantic-release
  (`.releaserc.json` + `.github/workflows/release.yml`) works out the version bump, writes back
  `CHANGELOG.md`, tags `v*`, creates the GitHub Release and publishes to npm — there is no
  "write the changelog by hand" step, so this page cannot lag behind a release.
- **Traceable.** Every entry maps to the commit that caused it, and the scope in each entry is the module
  the change landed in.
- Releases and tags: [github.com/shaylanwu/agent-bridge/releases](https://github.com/shaylanwu/agent-bridge/releases)

## Versioning rules

| Change | Bump | Example |
| --- | --- | --- |
| New optional field / endpoint | minor | `feat(control-plane): add SSE endpoint` |
| Bug fix | patch | `fix(emitter): drop duplicate terminal status` |
| Breaking protocol change | major, requires approval | `feat!: bump protocol to v2` |

A breaking protocol change must increment `PROTOCOL_VERSION` and update both READMEs in the same
commit — a harness check fails otherwise. `feat!:` / `BREAKING CHANGE:` is also the only signal
semantic-release has for a major bump: if the commit message is wrong, the version number and this
page are wrong too, which is why the `commit-msg` hook (commitlint) rejects malformed ones first.

<!-- CHANGELOG:BEGIN -->
## [0.2.3](https://github.com/shaylanwu/agent-bridge/compare/v0.2.2...v0.2.3) (2026-10-24)


### Bug Fixes

* **auth:** 修复 Windows 下经 cmd start 打开授权页会截断 & 之后的参数 ([d4227c4](https://github.com/shaylanwu/agent-bridge/commit/d4227c44d62ab23e9c4785804ea089dfb9f50714))
* **site:** 先 build 再 check，避免版本历史页滞后挡住部署 ([d0486f5](https://github.com/shaylanwu/agent-bridge/commit/d0486f5d5b1037b70220909bd150b9b29459c81e))

## [0.2.2](https://github.com/shaylanwu/agent-bridge/compare/v0.2.1...v0.2.2) (2026-10-24)


### Bug Fixes

* **site:** 先 build 再 check，避免版本历史页滞后挡住部署 ([a353563](https://github.com/shaylanwu/agent-bridge/commit/a353563d288633737860fe69c8f47d5395088ec0))

## [0.2.1](https://github.com/shaylanwu/agent-bridge/compare/v0.2.0...v0.2.1) (2026-10-24)


### Bug Fixes

* **release:** 发布后显式触发站点重建，补上历史页滞后一环 ([3285d95](https://github.com/shaylanwu/agent-bridge/commit/3285d953e2208760170e50a3794c6ba397be29f6))

## [0.2.0](https://github.com/shaylanwu/agent-bridge/compare/v0.1.0...v0.2.0) (2026-10-24)


### Bug Fixes

* **release:** 发布流水线读取正确的 npm token secret 名 ([d09d393](https://github.com/shaylanwu/agent-bridge/commit/d09d3933d7316f5f382c32aee6ab88c0a33f5f27))
* **release:** 同时提供 NODE_AUTH_TOKEN，修掉 npm 401 ([2282fde](https://github.com/shaylanwu/agent-bridge/commit/2282fde60179f0c3c78fe95588c2fca948e46d3f))
* **release:** 预检兼容两种 secret 名，并清理粘贴带进来的空白 ([94aeaa7](https://github.com/shaylanwu/agent-bridge/commit/94aeaa7922a28371e987f0366face924963638a2))


### Features

* **bridge-client:** 断线期间的 task_log 缓冲并重连补发 ([c183244](https://github.com/shaylanwu/agent-bridge/commit/c1832446bc7d4c25d334b569c65b4450b5624775))
* **cli:** --token 模式支持 --device-id，WS 地址不再发空 deviceId ([d1c9603](https://github.com/shaylanwu/agent-bridge/commit/d1c960387cc20acd8b3b8a03cf44093ece2d1f93))
* **release:** semantic-release 自动发布，站点构建期渲染版本历史 ([d6a0815](https://github.com/shaylanwu/agent-bridge/commit/d6a08158e3219eb02f8374296b34db84d6d1a0b6))
* **runner:** 平台 env 白名单 + 并发任务上限 ([ce85c83](https://github.com/shaylanwu/agent-bridge/commit/ce85c834c0457b0aabd3fdeabf2433f0cd48d580))
* **runner:** 移除平台 env 通道（不做白名单，直接删）+ max_tasks 可配置 ([6f4473b](https://github.com/shaylanwu/agent-bridge/commit/6f4473be8d6485fc58af4270a3c2acf191efd8e4))
* **runner:** 超限任务改为有界 FIFO 排队（标准做法），不再直接拒绝 ([4d57852](https://github.com/shaylanwu/agent-bridge/commit/4d578524efc612a642403af130e2cae6f499dd43))
* **scan:** 并发探测 + 扫描结果实时回传 + 官方品牌图标 ([1c07231](https://github.com/shaylanwu/agent-bridge/commit/1c072315d081d794f58ecdb6710d0fae04df62ed))
* **site:** 中英文档站（Astro Starlight + Scalar），API 参考由契约生成 ([a1994d4](https://github.com/shaylanwu/agent-bridge/commit/a1994d44368595d557dfdeacddd7f0ecfd9ee436))

## [0.1.0] - 2026-10-22

### Added

- `agent-bridge status` — probes 11 AI coding CLIs (Claude Code, Codex, DeepSeek Harness, Gemini CLI,
  opencode, Mimo Code, Qoder CLI, Grok CLI, Kimi Code, MiniMax Code, Trae CLI) and reports
  `ready` / `no credentials` / `not installed`, plus a `broken` flag when a binary exists but cannot run.
  Includes a 30-second cache with `--fresh` and machine-readable `--json` output.
- `agent-bridge connect <platformUrl>` — binds this machine over an outbound WebSocket. Authorization uses
  a loopback callback with PKCE S256 and reuses the existing browser session; `--no-browser` falls back to
  a device code, `--token` accepts a pre-issued device token.
- `agent-bridge logout` — clears local device credentials.
- WebSocket transport with bearer handshake, 15 s heartbeat, exponential backoff (1 s → 30 s), buffered
  status messages replayed after reconnect, and no reconnect loop once a device is revoked.
- Task execution with an adapter whitelist, argument arrays (no shell interpolation), working-directory
  validation, per-task timeout, graceful cancel (`SIGTERM` → 2 s → `SIGKILL`) and 4 KB log chunks.
- Protocol v1 with runtime validation. Bridge → platform: `hello`, `agent_list`, `scan_result`,
  `task_log`, `task_status`, `pong`. Platform → bridge: `run_task`, `cancel_task`, `scan`, `ping`.
- Configuration at `~/.agent-bridge/config.toml` (`%APPDATA%\agent-bridge\config.toml` on Windows) with
  `0600` permissions and token redaction in all output.
- Windows support for `.cmd` / `.bat` shims through an explicitly quoted command line.
- Unit tests covering protocol validation, log chunking, PKCE shape, the adapter registry and command-line
  quoting.

### Security

- API keys and credential files are never read or uploaded; only their presence is reported.
- The authorization callback listens on `127.0.0.1` only, accepts a single request, and authorization
  codes are single-use with PKCE S256 verification.

[unreleased]: https://github.com/shaylanwu/agent-bridge/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/shaylanwu/agent-bridge/releases/tag/v0.1.0
<!-- CHANGELOG:END -->
