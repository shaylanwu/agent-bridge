# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

## [Unreleased]

### Added

- **Release automation** — version numbers now come from commit messages. `.releaserc.json` +
  `.github/workflows/release.yml` run semantic-release on every push to `main` (`feat` → minor,
  `fix` → patch, `feat!` / `BREAKING CHANGE:` → major, everything else publishes nothing): it bumps
  `package.json`, writes `CHANGELOG.md`, tags `v*`, opens the GitHub Release and publishes to npm.
  Needs two repository secrets — `AGENT_BRIDGE_NPM_TOKEN` and the default `GITHUB_TOKEN` — and **takes over tagging**:
  a hand-made `v*` tag now collides with it. `commitlint` + `husky` reject non-conventional commit
  messages locally, and `.github/workflows/site.yml` builds and deploys the docs site to GitHub Pages on
  the same push. The site's changelog page is now rendered from `CHANGELOG.md` at build time
  (`site/scripts/gen-changelog.mjs`) instead of being a placeholder that said "automation pending", so the
  two can't drift — `site-check` fails if they do. Two deviations from the stock setup, both verified
  offline by `scripts/verify-release.mjs`: `scripts/semantic-release-changelog.mjs` replaces
  `@semantic-release/changelog` because that plugin can only prepend to the file (which would put
  `# Changelog` *below* the version headings), and the preset is `angular` rather than
  `conventionalcommits` because the latter's current majors need a newer changelog writer than
  semantic-release 25 ships.

- **CodeBuddy CLI adapter** — `kind: "codebuddy-cli"` (Tencent `@tencent-ai/codebuddy-code`, command `codebuddy`,
  alias `cbc`). Non-interactive like Claude Code (`-p "{{prompt}}" --output-format text`); credentials detected via
  the `~/.codebuddy` directory (interactive login, no env key). The adapter registry is now **12 tools**, and every
  "11 adapters/agents" figure across the READMEs, `llms.txt`, `AGENTS.md`, CLI help, tests and the docs site has been
  updated in the same pass. OpenSpec proposal: `openspec/changes/add-codebuddy-cli/`.

- **Documentation site (W1–W3)** — `site/` is a standalone Astro + Starlight workspace (never built by the
  main package, never published to npm). English + 简体中文 content trees with a language switcher;
  Pagefind full-text search indexes **2 locales / 28 pages**.
  - **API reference is generated, not retyped**: `site/scripts/gen-reference.mjs` renders
    `protocol/messages.md`, `api/reference.md` and `api/control-plane-reference.md` from the three contracts,
    in both locales. Because those pages are static HTML, endpoint paths and field names are searchable —
    the Scalar try-it pages (`api/`, `api/control-plane/`) render client-side and are deliberately not
    searchable, so both exist and each does one job.
  - `site/scripts/site-check.mjs` fails on: a CLI command with no docs page, a control-plane endpoint missing
    from the generated pages, generated pages out of sync with contracts, or an en/zh-cn page mismatch.
  - Contracts and `llms.txt` are copied into `site/public/` at build time — the site never keeps a second copy.
  - **Light / dark / follow-system theming** — Starlight ships the theme picker (`auto` follows the OS by
    default) and code blocks switch with it. The Scalar API viewer is client-rendered and would otherwise stay
    stuck on one theme, so `ApiReference.astro` reads `document.documentElement.dataset.theme`, watches it with a
    `MutationObserver` (covers both manual picks and OS changes under `auto`), and re-renders on change; Scalar's
    own toggle is hidden so there is only one theme control on the page.
  - **Site design system (v3)** — `site/src/styles/custom.css` overrides only Starlight's exposed CSS variables
    plus a few structural rules: one accent (`#17A67F` light / `#41C398` dark) over cool grey neutrals, dark mode
    on deep navy (`#0B1220`) rather than pure black, headings capped at weight 500 with negative tracking, the
    sidebar's current item marked by a 2px accent bar, borderless three-column features separated by whitespace,
    and a two-column path switch split by a 1px rule. The homepage (centered hero + outbound connection figure +
    features + paths) lives in `site/src/components/home/`, shared by both locales with copy passed in from
    `index.mdx`. The site has exactly one animation — a packet dot travelling the outbound link (2.4 s), disabled
    under `prefers-reduced-motion` — plus a 2px reading-progress bar in the header. CJK copy gets 1.8 line height,
    strict line breaking and tabular numerals.
  - **AI-agent narrative + agent wall** — visitor-facing copy now says "AI agents" (the product story) while
    "CLI" stays in technical contexts (CLI reference, status probing); README ×2 and the package description
    follow the same wording. The homepage lists all 11 supported agents with their official brand-coloured
    logos, synced from `assets/agent-icons/` at build time by `sync-contracts.mjs` — the site never keeps a
    second copy, and `site-check` fails if the wall and `src/adapters/agent-adapters.ts` drift apart.
    Generated reference pages are now regenerated on every build (`build.mjs` runs `gen-reference.mjs` first).
  - **Brand mark** — a geometric logo (`site/src/assets/logo-{light,dark}.svg`): a device square, an outbound
    line, a platform dot. Rendered in the header (per-theme variant) and as `favicon.svg`. Code blocks are dark
    in both themes (single `starlight-dark` theme), matching the docs-page reference style.

- **Diff capture (P0-6)** — a `run_task` with `captureDiff: true` now returns the worktree diff on the terminal
  `task_status`: `diff` (unified diff), `changedFiles` (repo-relative paths) and `diffTruncated`.
  Non-git directories yield an empty diff instead of an error; oversized diffs are cut on a line boundary at
  `diff_max_bytes` (default 256 KB, `AGENT_BRIDGE_DIFF_MAX_BYTES` overrides). Untracked files are `git add -N`-ed
  only for the duration of the capture and `git reset -q`-ed afterwards, so nothing is committed and the index is
  left exactly as it was.
- **Service identity / scoped service tokens (P0-8)** — `agent-bridge services issue|list|revoke|rotate` manages
  tokens of the form `abs_<kid>_<secret>`; only the SHA-256 of the secret is stored (0600) and comparison is
  constant-time. Scopes: `task:create`, `task:cancel`, `task:read`, `device:read` — `cancel_task` needs
  `task:cancel`, holding `task:create` is not enough. Rotation keeps the previous token alive for a grace window
  (`--grace-hours`, default 24).
- `run_task` / `cancel_task` accept `requestedBy` (≤128), `purpose` (≤64) and `serviceToken`;
  the bridge echoes `requestedBy` on the terminal `task_status` so platforms can persist `requested_by`.
  With no token registered and `require_service_token = false`, behaviour is unchanged; a token that is present
  must verify.
- `hello.capabilities` — capability negotiation (`diff`, `service-token`, `queue`, `scan-progress`) so
  third-party platforms degrade by feature instead of guessing from the CLI version.
- Audit trail at `~/.agent-bridge/audit.jsonl` (0600, one JSON per line): id / scope / purpose / action / outcome,
  never tokens or credential contents.
- New config keys: `diff_default`, `diff_max_bytes`, `require_service_token`.
- New module map: `src/git.ts`, `src/service-token.ts`, `src/audit.ts`.

### Changed（架构通用化：第一期 + 第二期 + 第三期）

- **源码分层**：`src/core/`（领域：错误码 / 上行出口 / 任务调度 / 脱敏 / 扫描）、`src/transport/`
  （出站 WebSocket + 补发缓冲）、`src/adapters/`（11 个 CLI 适配器 / 图标 / Windows 引号）、
  `src/infra/`（配置 / 授权 / git / 审计 / 服务令牌）。根目录只留 `cli.ts`、`protocol.ts`
  与 `runner.ts`（后者降级为 v1 兼容包装，新代码请引 `src/core/task-supervisor.ts`）。
- **本地回环控制面（可选扩展，默认关闭）**：`agent-bridge serve <platformUrl> [--port=8787]` = `connect`
  + 一个只绑 `127.0.0.1` 的 HTTP 控制面，服务**本机上的其它程序**（IDE 插件 / 脚本 / MCP server / CI），
  远程平台仍走出站 WebSocket（两条通道互不干扰）。端点：`/v1/health`（免鉴权）、`/v1/capabilities`、
  `/v1/agents`、`/v1/agents:scan`、`/v1/tasks`（`Idempotency-Key` 防重跑）、`GET /v1/tasks/{id}`、
  `POST /v1/tasks/{id}:cancel`（幂等）、`/v1/tasks/{id}/events`（SSE）、`/v1/tasks/{id}/diff`。
  红线：默认关闭（`[control_plane] enabled` / `--port` 才启用）、只绑回环、强制 scoped Bearer、
  **不返回 CORS 头**、不新增运行时依赖。控制面下发的任务与平台下发的共享同一个 `TaskSupervisor`
  （并发上限不因多开一条通道而翻倍），上行同样只经 `Emitter`。错误统一 RFC 9457 `problem+json`。
  契约：`contracts/openapi.control-plane.yaml`。
- **受控错误码**：`task_status.errorCode` 取自 `src/core/errors.ts` 的受控枚举（15 个），
  与平台侧 design §7 的错误分类表对齐；`error` 仍保留人类可读串。平台不再需要匹配文案。
- **唯一上行出口 `src/core/emitter.ts`**：所有上行报文只经 `Emitter.emit()`，在这里收口
  ①终态幂等（settled 后丢弃该 task 的后续事件）②日志脱敏（家目录 → `~`、≥64 位长串折叠）
  ③审计旁路 ④可选 CloudEvents 1.0 信封。横切逻辑只写一遍，不再每个能力各写一次。
- **任务调度可实例化**：`runner.ts` 的模块级单例状态（`runningTasks` / `queue` / `currentMaxTasks`）
  内聚为 `class TaskSupervisor`，可注入、可单测、可多实例；状态机显式化为
  `queued → running → settled`（settled 是吸收态）。
- **排队语义**：并发之上的任务排队而非失败；为保持 v1 兼容 `status` 仍是 `running`，
  额外给出 `phase: 'queued'` 与 `queuePosition`（1 起）。老平台忽略即可，行为不变。
- **机器可读契约**：新增 `contracts/asyncapi-3.0.yaml`（WebSocket 通道）与
  `contracts/openapi-3.1.yaml`（**平台需实现**的 4 个 HTTP 端点），以及 `llms.txt`。
  `npm run contracts:check` 校验 wire 类型 / 能力清单 / 错误码 / 平台端点与代码一致，漂移即失败，
  并已接入 `npm run gate`。
- **护栏同步**：`protocol-boundary-check` 的 shell / 监听白名单改按新路径（`src/core/task-supervisor.ts`、
  `src/infra/auth.ts`），并为本地回环控制面预留了**有条件**的口子（必须只绑回环 + 默认关闭 +
  不返回 CORS 头）；`doc-contract-check` 新增能力清单记载校验与 `services` 命令；
  `always-on.md` 新增「分层与唯一出口」红线。
- **入口瘦身（第四期）**：`src/cli.ts` 548 行 → 31 行，只做 `argv → dispatch()` 与顶层错误兜底。
  新增 `src/cli/`（参数解析 / 终端渲染 / 帮助 / 命令注册表）与 `src/commands/`（一个命令一个文件），
  并把「连接生命周期、指令路由、任务编排、服务身份校验」从入口抽出为 `src/app/`
  （`session.ts` / `task-dispatch.ts` / `service-gate.ts` / `session-log.ts`）。
  依赖单向：`cli.ts → cli/ → commands/ → app/ → { core, transport, adapters, infra }`；
  ⛔ `src/app/` 不得直接 `console.*`（输出走注入的 `SessionLog`）—— 这是本地控制面板能复用
  同一段编排、且不被 stdout 绑死的前提。对外契约、报文、CLI 用法、配置键**零变化**
  （`e2e:smoke` 10 项全 PASS 取证）。
- 单测 54 → 71。

### Changed（项目名称与开源许可）

- **许可证由 Apache-2.0 改为 MIT**：`LICENSE`、`package.json`、两份 README、两份契约的
  `info.license` 同步；此后发布的版本以 MIT 授权（0.1.0 及更早的已发布版本仍按 Apache-2.0 授权）。
- **显示名统一为 `Agent Bridge Service`**（文档站标题、页脚版权声明、各页 description、
  `gen-reference` 生成的 API 参考描述）。⛔ 不动的东西：npm 包名 `agent-bridge-service`、
  CLI 命令 `agent-bridge`、配置目录 `~/.agent-bridge/`、站点 base `/agent-bridge`、
  OAuth `client_id = "agent-bridge"` —— 这些是对外契约，改名等于破坏兼容性。

### Planned

- `daemon` mode (systemd / launchd / Windows service) with start-on-boot.
- Self-update from the release channel.

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
