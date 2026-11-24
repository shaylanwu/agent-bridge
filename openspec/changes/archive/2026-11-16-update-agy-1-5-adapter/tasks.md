# 实施清单：update-agy-1-5-adapter

> 真实外部服务当前不可达；任何 ACP 完成声明必须附本机真实回合证据。
> 2026-11-16 21:30 用户确认提案，进入实施；keyring/ACP 按以下顺序执行。

## 1. 凭据探测

- [x] 1.1 先补失败测试：Windows keyring 目标命中时 agy 为 ready/configured；未命中、命令失败、超时和非 Windows 不改变保守语义；测试中不读取真实凭据。
  - 2026-11-16：4 条新增用例先 4 failed/81 passed，实现后 bridge.test.ts 85/85；覆盖完整 target、防前缀误配、命中、未命中、异常、非 Windows 与直接证据优先。
- [x] 1.2 在 AgentDef 增加逐工具 Windows keyring target 声明，以异步 `cmdkey /list` 精确匹配 `LegacyGeneric:target=gemini:antigravity`，只返回来源，不保留或上报输出。
  - 实现：credential.windowsTargets + windowsCredentialTargetPresent；cmdkey timeout=2s、maxBuffer=256KiB，错误不外抛。
- [x] 1.3 将 keyring 探测接入 probeAgent 与 npx 分支的共同凭据判定，保持扫描并发、30 秒缓存和其他工具零行为变化。
  - probeAgent 两个分支均改走 probeCredentialWithKeyring；scan.ts 未改，沿用既有并发/TTL；typecheck 通过。
- [x] 1.4 本机运行 `status --fresh`，确认 agy 显示就绪且 credentialSource 仅为 `keyring:gemini:antigravity`。
  - 2026-11-16 实跑 JSON 验收：status=ready、version=1.5.9、credentialSource=keyring:gemini:antigravity、installedButBroken=false；全机 ready=9/12。

- [x] 1.5 修正 Qoder/Trae 凭据判据：先以失败测试覆盖真实文件/PAT、Trae 状态命令退出码与异常，不把目录存在当登录。
  - Qoder=.qoder/.auth/user+QODER_PERSONAL_ACCESS_TOKEN；Trae=PAT 或 login status。2 条新用例先失败，实现后 bridge.test.ts 87/87；状态命令输出仅丢弃。
- [x] 1.6 本机复跑扫描：Qoder 保持 ready；Trae 在 `traecli login status` 实际退出 1 时回 installed_no_cred，而非假 ready。
  - 实跑：agy=ready/keyring，qoder=ready/file:~/.qoder/.auth/user，trae=installed_no_cred；全机 ready=8/12（比假阳性前少 1，属扫描诚实化）。

## 2. agy 1.5.9 ACP

- [x] 2.1 先补失败测试：`agy acp` 启动参数、最低版本/能力声明、通用 runner 的标签与认证错误映射；旧版不得声明未支持的 ACP。
  - agy spec=agy acp、acpMinVersion=1.5.9、preferSystemProxy；proxy-env 3 例与 executionModes 覆盖；真实已登录缓存无需 authenticate。
- [x] 2.2 接入 `agy acp` 通用执行链路，保持 headless 的 prompt 压尾、authGuard 与 finalOutcome 行为不变。
  - AgentDef.acp + acpSpecFor 正式接入；显式 AGENT_BRIDGE_EXTERNAL_PROXY 优先，Windows 自动读系统代理，仅 agy 声明；headless 同策略。
- [x] 2.3 本机实测 initialize、session/new、session/prompt 最小回合与第二轮续接；若上游仍 Bad Gateway/超时，本项保持未完成且不得声明 ACP 可用。
  - 根因为进程代理58354与系统代理7897不一致；系统代理访问Google返回预期401。正式TaskSupervisor两轮均success/end_turn，同session=01a1e4e1…，两轮result均AGY_FORMAL_OK，历史重放已去重。
- [x] 2.4 仅在 2.3 通过后更新 executionModes、ACP 数量和交互种类；任何未实测交互维度保持不声明。
  - probeAgent按真实version传executionModesFor，1.4.10无ACP、1.5.9声明ACP；session/load历史chunk仅在session/prompt后收集，acp-resume回归通过。

## 3. 文档与验证

- [x] 3.1 两份 README 与站点同步 keyring 来源、agy 版本事实和实际通过的执行模式；修正指向已归档设计的源码注释。
  - README/协议 overview 已写 keyring、Qoder/Trae 来源与 agy 代理策略；agy 1.5.9 声明 headless+ACP，旧版 headless-only；源码注释与 9 个 ACP runner 数量同步。
- [x] 3.2 运行相关 Vitest、`npm run gate`、`npm run harness:validate`、`npm run openspec:validate`、`npm run build && npm run e2e:smoke`，保存真实输出。
  - 2026-11-16：agy 相关 51/51，最终 gate/harness 全绿，build+e2e 14/14 PASS。身份测试并行超时单独 14/14 并复跑 gate 通过；单独 validate-change 脚本被 hook 拦截，未绕过，gate 内活跃提案格式校验通过。
- [x] 3.3 提案人工评审通过；若真实 ACP 验收仍被上游阻断，仅交付已完成部分，不归档为全部完成。
  - 2026-11-16 21:30 用户回复“确认”；ACP 后续通过正式两轮真实验收，全部 2.x 已勾。

## 4. 归档

- [x] 4.1 全部完成且评审通过后，将 specs 增量合并进正式 specs。
  - local-tool-scan 已合并 keyring/status command；task-execution 已合并 agy ACP、续接去重与外部代理要求。
- [x] 4.2 移入 `openspec/changes/archive/YYYY-MM-DD-update-agy-1-5-adapter/`。
  - 2026-11-16：目标目录应为 archive/2026-11-16-update-agy-1-5-adapter；mv 被 pre-action hook 的 archive 保护拦截。
    2026-11-17 00:00 用户已明确回复“授权归档”，但钩子仍硬阻断，未绕过；用户随后人工执行移动。
    2026-11-17 20:14 核验：源目录不存在，归档目录 proposal/design/tasks 与两组 specs 共 5 个文件齐全，完成归档。
