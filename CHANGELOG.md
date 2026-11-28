# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.3](https://github.com/shaylanwu/agent-bridge/compare/v1.2.2...v1.2.3) (2026-11-28)


### Bug Fixes

* **core:** 真正执行 get_task 单响应 1 MiB 上限，并让 hasMoreBefore 可兑现 ([dd7aa6d](https://github.com/shaylanwu/agent-bridge/commit/dd7aa6dd3ade2f3400cfa9c4051326e184c6791e))
* **supervisor:** headless 子进程的 stdin 恒为 ignore（对齐规格，消除等 EOF 挂死） ([b6c8db0](https://github.com/shaylanwu/agent-bridge/commit/b6c8db08be031e8428913d530ebfb6ed0992a0ea))

## [1.2.2](https://github.com/shaylanwu/agent-bridge/compare/v1.2.1...v1.2.2) (2026-11-28)


### Bug Fixes

* **protocol:** 终态 task_status 补上 result（契约写了、实现从没发过） ([8ae3c9f](https://github.com/shaylanwu/agent-bridge/commit/8ae3c9f30823ba44e48d1de980da97c6bd4b3963))

## [1.2.1](https://github.com/shaylanwu/agent-bridge/compare/v1.2.0...v1.2.1) (2026-11-28)


### Bug Fixes

* **acp:** 子进程崩溃时 stdin EPIPE 不再终止整个 bridge ([5e8c3f2](https://github.com/shaylanwu/agent-bridge/commit/5e8c3f2f66f9349a5db839ae71cfba21a0efbe08))

## [1.2.0](https://github.com/shaylanwu/agent-bridge/compare/v1.1.0...v1.2.0) (2026-11-27)


### Bug Fixes

* **emitter:** 终态后 get_artifact 零响应——读回包被终态闸门一起丢了 ([7bcf3ff](https://github.com/shaylanwu/agent-bridge/commit/7bcf3ffcaf4c3a01101bb188ab4ccfd69eea4946))


### Features

* **errors:** context_exhausted 落地为反应式识别，不再只是规格承诺 ([1aad19e](https://github.com/shaylanwu/agent-bridge/commit/1aad19e6d7979c93d337788c26b17938d901ffd1))

## [1.1.0](https://github.com/shaylanwu/agent-bridge/compare/v1.0.0...v1.1.0) (2026-11-27)


### Bug Fixes

* **codex:** app-server 子进程注入外部代理并排空 stderr，修掉「回合静默挂住」 ([d685f22](https://github.com/shaylanwu/agent-bridge/commit/d685f227596f799a154322d573f9311f30a0e138))


### Features

* **codex:** 重连/配置告警上行成任务日志，不再整段静默 ([d31a2f4](https://github.com/shaylanwu/agent-bridge/commit/d31a2f45e4b3e865cdf995e80054b2b75f29abe2))
* **gateway:** 控制面与 ACP 会话可按任务申请交互（allowInteractive 透传） ([f88e900](https://github.com/shaylanwu/agent-bridge/commit/f88e9005f1da627a4623dcf318d2a2125eb64ee5))


### Performance Improvements

* **proxy-env:** 系统代理探测按进程缓存，每进程只查一次注册表 ([da1f3ee](https://github.com/shaylanwu/agent-bridge/commit/da1f3ee718f7a6fdac51e66824839a011a776f30))

## [1.0.0](https://github.com/shaylanwu/agent-bridge/compare/v0.2.3...v1.0.0) (2026-11-26)


* feat(ci)!: 工作流统一 Node 24，与 engines 对齐 ([037c829](https://github.com/shaylanwu/agent-bridge/commit/037c8298e4e1785ba15186649e40a41312d20a7f))


### Bug Fixes

* **acp:** inherit CodeBuddy auth token from host login ([13a437b](https://github.com/shaylanwu/agent-bridge/commit/13a437b606ddd0047cef48e34012bd6dda3f525c))
* **adapters:** detect mcode's real ~/.minimax credential paths ([92f2a97](https://github.com/shaylanwu/agent-bridge/commit/92f2a9711652f53250ba7ed4ecaaa4e51087cafb))
* **adapters:** detect opencode custom provider config as credential evidence ([1c8459c](https://github.com/shaylanwu/agent-bridge/commit/1c8459cbdc3ffa97b0e8f927d12cd3fdf009e7db))
* **adapters:** probe kimi-code's real ~/.kimi-code credential paths ([a91b55c](https://github.com/shaylanwu/agent-bridge/commit/a91b55cc97b95f33101dfe09188b3e6d67b4bf30))
* **approval:** never bind an approval without a normalizable resource ([1dea052](https://github.com/shaylanwu/agent-bridge/commit/1dea05228ca59148c094da3391aff37788b032d2))
* **config:** ignore empty session idle env override ([2a6c9e2](https://github.com/shaylanwu/agent-bridge/commit/2a6c9e20642340ddc59640cca94715ad4d1573b9))
* **contracts:** register session_not_continuable and tell the truth about /v1/agents ([dc3bb04](https://github.com/shaylanwu/agent-bridge/commit/dc3bb042451603d1a51ac40f527040f12569d854))
* **control-plane:** keep tenant id out of task create response ([b490983](https://github.com/shaylanwu/agent-bridge/commit/b49098394a5d9629fafecad070a41d64a550e063))
* **conversation:** isolate stale resident close events ([03995b8](https://github.com/shaylanwu/agent-bridge/commit/03995b8a5602891b1762d6def54dd013d549d5de))
* **conversation:** reclaim idle claude resident processes ([04bf70a](https://github.com/shaylanwu/agent-bridge/commit/04bf70a853cf583c5f38fe54414cd94c9b9bf311))
* **conversation:** settle close_session before reclaiming resident ([a930fea](https://github.com/shaylanwu/agent-bridge/commit/a930fea126d73e013d3d79979f531ea982f6497e))
* **form:** validate schema and redact secret content ([87aec74](https://github.com/shaylanwu/agent-bridge/commit/87aec7406fd92e969b11f1efd0f3b9a7ea5098cc))
* **health:** report readiness from queue capacity ([4d95ccc](https://github.com/shaylanwu/agent-bridge/commit/4d95cccc12c981cffd9b3fe7edfe51bb2a53973b))
* **interaction-url:** distinguish expired from missing ([87a7419](https://github.com/shaylanwu/agent-bridge/commit/87a741985cbc96b02c494bc22bf780b8c794da20))
* **interaction-url:** opportunistically clean expired entries ([2b9f53d](https://github.com/shaylanwu/agent-bridge/commit/2b9f53d78b15a86968370db05f82fbe63c0be5d2))
* **log:** detect ANSI instead of always reporting true ([0b1b665](https://github.com/shaylanwu/agent-bridge/commit/0b1b665ece239078126e862074d0ab724322c1a2))
* **mcp:** allow per-call timeout for long elicitation ([0fa1e52](https://github.com/shaylanwu/agent-bridge/commit/0fa1e52ac92cb02d347ce89c0b4bdf32a2b179a4))
* **runtime:** reject duplicate connect for the same profile ([e85b959](https://github.com/shaylanwu/agent-bridge/commit/e85b959f65c467e5002d88801452ccf046226683))
* **session-store:** release handle when opening corrupt database fails ([b8c17a3](https://github.com/shaylanwu/agent-bridge/commit/b8c17a3e4b23e6280c6b3ffe52eadd665229db0f))
* **session:** do not clear idle timer before authorization ([35159c6](https://github.com/shaylanwu/agent-bridge/commit/35159c62c2a4b32de97fe58486f1bad2b482d4f9))
* **session:** emit terminal status when idle close ([04758a9](https://github.com/shaylanwu/agent-bridge/commit/04758a98ef3223986843ac35b8ae552c9cd82fbc))
* **session:** only reclaim resident after authorized close ([a2fbe3b](https://github.com/shaylanwu/agent-bridge/commit/a2fbe3b83c2ab3eee43c479c05556c8d1cd92336))
* **session:** reject auth-url payloads containing raw URLs ([8bc9126](https://github.com/shaylanwu/agent-bridge/commit/8bc912619f3dfddf2d0806782a0415ada0829177))
* **sse:** replay session events in batches after cursor ([6abe49c](https://github.com/shaylanwu/agent-bridge/commit/6abe49c7a8372c8adad051ea9f55f882753fd9cf))


### Features

* **acp:** add Grok ACP and non-ACP integration research ([b82870b](https://github.com/shaylanwu/agent-bridge/commit/b82870b40bdda0a257eee9c715f6c65846b48629))
* **acp:** add guarded CodeBuddy ACP client ([cb808fa](https://github.com/shaylanwu/agent-bridge/commit/cb808fae002ee1aacc1e6296860ed790ee8af0f9))
* **acp:** bridge session/request_form to task interactions ([1f91549](https://github.com/shaylanwu/agent-bridge/commit/1f91549ea72155e54d35cc819500d7013a3ea1e2))
* **acp:** declare dsh's ACP channel and stop losing its session on resume ([4adacef](https://github.com/shaylanwu/agent-bridge/commit/4adacef5f99303b8ffa69be835f092cc2905ad2c))
* **acp:** support seven native ACP agent specs ([f0d0982](https://github.com/shaylanwu/agent-bridge/commit/f0d0982e640645e9c1fc6e80a4de040380201fd6))
* **acp:** wire CodeBuddy ACP tasks and permissions ([2bfc4fe](https://github.com/shaylanwu/agent-bridge/commit/2bfc4fe51158caf61200ec9e34449dfec4798eb1))
* **adapters:** rename grok display name and replace gemini with antigravity CLI ([68d7552](https://github.com/shaylanwu/agent-bridge/commit/68d7552030d84ed01d14f07ec3374d40fc1f6694))
* **approval:** persistent approval ledger with revoke and audit ([24cda8d](https://github.com/shaylanwu/agent-bridge/commit/24cda8de71edc048ac8e4cd2fb34ce343a852e39))
* **artifact:** add chunked downloads from CAS ([b8e0660](https://github.com/shaylanwu/agent-bridge/commit/b8e0660a7cd252a62c39420495b5b0c3a0049a5a))
* **artifact:** add inbound chunked uploads ([fa46f77](https://github.com/shaylanwu/agent-bridge/commit/fa46f779efcfbfe43dcd9b658ad5ee7a4a0f747a))
* **artifact:** add TTL cleanup with CAS reference counting ([18339c0](https://github.com/shaylanwu/agent-bridge/commit/18339c0d18c65cfabd78e402c02a5cbb31713e38))
* **artifact:** garbage-collect stale upload transfers ([f9cd84d](https://github.com/shaylanwu/agent-bridge/commit/f9cd84d60575f9b0a22dfdb53a5066d56a636162))
* **artifact:** persist download transfers for resume ([941fe60](https://github.com/shaylanwu/agent-bridge/commit/941fe606d0a0e75c772c1c7346e8caf5c583c168))
* **artifact:** persist upload transfers for resume ([948aa62](https://github.com/shaylanwu/agent-bridge/commit/948aa62cdcea050e1c6eacf2690db0506556e67b))
* **auth:** add dependency-free JWT/JWKS verifier ([49b121e](https://github.com/shaylanwu/agent-bridge/commit/49b121e9aeaa3bddbeba6753f670025df152594e))
* **auth:** refresh expired device tokens once ([8c16fa1](https://github.com/shaylanwu/agent-bridge/commit/8c16fa15ff6abd498d7d49e38be2fc64567a9ff6))
* **board:** scope task board by JWT tenant ([890ea7a](https://github.com/shaylanwu/agent-bridge/commit/890ea7ad727d1af2302dfd275f7e63482d3c93db))
* **capabilities:** declare executionModes[].continuation and stop losing history on a failed resume ([ab56aa5](https://github.com/shaylanwu/agent-bridge/commit/ab56aa5d48086c56791eae46cb9c9da1aa227364))
* **claude:** add opt-in stream-json execution ([3160f9d](https://github.com/shaylanwu/agent-bridge/commit/3160f9d39c5fb37f0ad4e15054aa0db32702796a))
* **codex:** integrate app-server turns and approvals ([bb846e5](https://github.com/shaylanwu/agent-bridge/commit/bb846e5936944180e4cd633a34f4be9cf8a05e6b))
* **connect:** start local web panel by default with port fallback ([6cdb318](https://github.com/shaylanwu/agent-bridge/commit/6cdb3185e773fc7cc651cded378674c0804d29ea))
* **control-plane:** accept JWT principals with tenant guard ([799301b](https://github.com/shaylanwu/agent-bridge/commit/799301bad1bdcfdfc763f32635dba39f32b0d93d))
* **control-plane:** add minimal metrics endpoint ([3ce9568](https://github.com/shaylanwu/agent-bridge/commit/3ce9568101f2d21d12862c9503c76e08f329599a))
* **control-plane:** answer interactions over HTTP, add session:read scope ([fc83c7c](https://github.com/shaylanwu/agent-bridge/commit/fc83c7c9c93505f453a6bc3063a989ba1f12b950))
* **control-plane:** expose persisted session snapshots ([1a272c4](https://github.com/shaylanwu/agent-bridge/commit/1a272c4080da14a5d15904a5d6e76824e0c58c7e))
* **control-plane:** scope session reads by JWT tenant ([1e66677](https://github.com/shaylanwu/agent-bridge/commit/1e6667707871af6a07df64ff92f5cf1c7c74f89d))
* **control-plane:** stream persisted session events ([addac0a](https://github.com/shaylanwu/agent-bridge/commit/addac0a6fd55821421bac40917a43b70fd613228))
* **control-plane:** tenant-scope tasks and artifacts ([e908beb](https://github.com/shaylanwu/agent-bridge/commit/e908beb96ba0c026fb986a9b9a7134cddafdcdab))
* **conversation:** add replay-session multi-turn messages ([698900f](https://github.com/shaylanwu/agent-bridge/commit/698900f7c1bedb8554b4674091676fcbca7245cc))
* **conversation:** forward steer to codex app-server turns ([ce525f8](https://github.com/shaylanwu/agent-bridge/commit/ce525f83ba620510c1f5d282deda9f6796162615))
* **conversation:** keep claude/qoder stream sessions resident ([91e2bff](https://github.com/shaylanwu/agent-bridge/commit/91e2bff7b9cbe10bc7cca412ddf71bcda4106706))
* **conversation:** multi-turn ACP session memory for gateway and WS ([9f234c0](https://github.com/shaylanwu/agent-bridge/commit/9f234c0f501c8952116344e938cb438a11c8e4a2))
* **conversation:** resume native CLI sessions when available ([f20d03c](https://github.com/shaylanwu/agent-bridge/commit/f20d03c6bd8eafe357c04870d19a31d6ce19976d))
* **core:** add protocol v1 session store foundation ([322632e](https://github.com/shaylanwu/agent-bridge/commit/322632eb0b418b0e04555938919ab335469d2c37))
* **core:** capture native session ids and interactive stdin ([e407874](https://github.com/shaylanwu/agent-bridge/commit/e407874919784045a782fa64109d8b1bafc1e901))
* **core:** persist task lifecycle in session store ([8bc4723](https://github.com/shaylanwu/agent-bridge/commit/8bc47235012a0076d66355503af3f16b5a4e2772))
* **core:** task execution control - bounded feed, settled guards, interactions ([5fcb849](https://github.com/shaylanwu/agent-bridge/commit/5fcb849ff7622f5ee2257be40edaa8a3960fa174))
* **daemon,mcp:** per-user service install and MCP host config ([1fe8194](https://github.com/shaylanwu/agent-bridge/commit/1fe8194999431fdc981cbbfda5305b5211de3af6))
* **daemon:** add lightweight background process control ([d27a971](https://github.com/shaylanwu/agent-bridge/commit/d27a97194db82a60248961c7a7f513c48f79140b))
* **dsh:** resume headless sessions by id ([d9327ca](https://github.com/shaylanwu/agent-bridge/commit/d9327caa05b5e81cf1618a8452d6374ae1be56a0))
* **gateway:** add A2A and ACP v1-over-HTTP external gateway on the control plane ([2959ebb](https://github.com/shaylanwu/agent-bridge/commit/2959ebb5e784c662e4b5ae3b9918bccb0cc69f49))
* **interaction:** add short-lived interaction URL lookup ([67fd030](https://github.com/shaylanwu/agent-bridge/commit/67fd0300937fbc8bea82cc69421ac8b22f7e0735))
* **interaction:** carry structured form answers; add gateway proposal ([a56d556](https://github.com/shaylanwu/agent-bridge/commit/a56d5560b48b1edd75efe0cb67dc9b59d7b9e5e3))
* **interaction:** persist and resolve interaction responses ([89f36ec](https://github.com/shaylanwu/agent-bridge/commit/89f36ec4a3bcdeaf2f14ea15a6fd253d239e7f61))
* **mcp:** add elicitation transport client ([c58d1d4](https://github.com/shaylanwu/agent-bridge/commit/c58d1d49f26623bf6394678d235344f5307ff62e))
* **permission:** 1.0 execution policy, interaction gate and artifact fetch ([fea2a4a](https://github.com/shaylanwu/agent-bridge/commit/fea2a4a649ad0c34b62ef72f35b0b02b0cd7ac63))
* **protocol:** add session close and turn cancel controls ([c853b06](https://github.com/shaylanwu/agent-bridge/commit/c853b065ca07b874d941438d7ea507fae0f34a36))
* **protocol:** declare elicitation-form and session-feed, document executionModes ([5d23d1c](https://github.com/shaylanwu/agent-bridge/commit/5d23d1c693eda763c4a9de92ac56bd5f38a8e980))
* **protocol:** expose task event sequence and snapshots ([d257bea](https://github.com/shaylanwu/agent-bridge/commit/d257beac7594364f7ab2004e87b1937d665b290c))
* **qoder:** resume native sessions ([0560592](https://github.com/shaylanwu/agent-bridge/commit/0560592b018cc2d99a4edc109ed3d58b856217f0))
* **session:** bound event history by count, add history cursors and real deletion ([5995f8c](https://github.com/shaylanwu/agent-bridge/commit/5995f8c9646a07d61c1f961d2a81391b3cb243f6)), closes [hi#water](https://github.com/hi/issues/water)
* **session:** close idle waiting_user sessions ([6595a37](https://github.com/shaylanwu/agent-bridge/commit/6595a37938c5fb884cf0686809fd2f7b14a0ddd0))
* **snapshot:** expose half-finished assistant text as partialMessages ([77c5279](https://github.com/shaylanwu/agent-bridge/commit/77c5279a82ed530627215decc082b94172ac69db))
* **store:** run PRAGMA quick_check when the state DB opens, and expose it on /v1/health ([693094f](https://github.com/shaylanwu/agent-bridge/commit/693094f1690ae47fb8c954ef57e1a1b51cf4d87c))
* **ui:** add local session console ([57c7f88](https://github.com/shaylanwu/agent-bridge/commit/57c7f88ba2c91abfa877c1f8586da10db7db9c5d))
* **ui:** add session artifact downloads ([b1cbcd9](https://github.com/shaylanwu/agent-bridge/commit/b1cbcd9ed13acbed9273f16e2f2474987f1e3c9d))


### BREAKING CHANGES

* 运行时要求从 Node `>=20` 收紧为 `>=24 <25`。这条变更在
engines 里已经生效（0.x 用户升级会 npm EBADENGINE / 运行在不支持的运行时），
但一直没有对应的 major 信号：v0.2.3 之后 101 个提交算出来只有 minor。
wire 协议本身自 v0.2.3 以来只增不删（11 → 42 条消息，PROTOCOL_VERSION 保持 1，
平台侧无需改报文），因此这里破坏的是**宿主运行时要求**而非报文契约 ——
1.0.0 把这批能力（Session/Turn 多轮、权限与交互闭环、A2A/ACP 网关、
附件传输）作为稳定面固定下来。

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
