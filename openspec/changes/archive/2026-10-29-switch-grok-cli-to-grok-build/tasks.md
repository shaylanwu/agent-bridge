# 实施清单：switch-grok-cli-to-grok-build

> 前置：2026-10-29 的适配器替换验证（`outputs/adapter-replacement-verification-2026-10-29.md`）已确认
> Grok Build 与本仓库的 10 条适配器要求逐条兼容，且本机 `grok 1.0.70` 实测通过。
> 状态：**已实施完成并归档**（门禁全绿 + e2e 通过 + 真机探测复核）。

## 1. 适配器定义

- [x] 1.1 `display` 改为 `Grok Build`（`kind` 保持 `grok-cli`，不动平台 `agentType`）
- [x] 1.2 `credential.files` 改为 `~/.grok/auth.json` + `~/.grok/config.toml`（删掉社区版 `user-settings.json`）
- [x] 1.3 删除 `acp.authMethod: 'grok.com'`（实测 `session/new` 无需 authenticate）
- [x] 1.4 新增 `resumeArgs`：`--single {{prompt}} --output-format streaming-messages-json --resume {{sessionId}}`
- [x] 1.5 复核 `taskArgs` / `fullArgs` / `steps` 不变（`streaming-messages-json` 与 claude 同构、`--always-approve` 已实测）

## 2. 测试

- [x] 2.1 `test/acp-diagnostics.test.ts`：grok 断言由「authMethod 必须是 grok.com」改为「不得写死认证方式，且声明了 xai.api_key 映射」
- [x] 2.2 新增断言：grok 的 `resumeArgs` 含 `--resume`；`executionModesFor` 的 headless `continuation === 'resume-session'`；
      并更新「有 resumeArgs 的工具名单」（4 → 5）
- [x] 2.3 新增断言：`credential.files` 指向 `.grok/auth.json` 与 `.grok/config.toml`，且**不含** `user-settings.json`

## 3. 文档与站点

- [x] 3.1 `README.md` / `README.zh-CN.md`：工具清单里的 `Grok CLI` → `Grok Build`
- [x] 3.2 `README.md` / `README.zh-CN.md`：能力矩阵行的续会话列 `ACP session` → `native \`--resume\` / ACP session`
- [x] 3.3 `site/src/components/home/AgentWall.astro`：展示名 `Grok CLI` → `Grok Build`

## 4. 取证

- [x] 4.1 `npm run typecheck`
- [x] 4.2 `npm test`（全量 499 项，1 skipped）
- [x] 4.3 `npm run gate` 全绿（协议边界 / 文档一致 / 类型 / 单测 / 构建 / 提案格式）
- [x] 4.4 `npm run build && node .harness/skills/protocol-e2e/scripts/e2e-smoke.mjs --agent grok-cli` → 13 项全 PASS
- [x] 4.5 真机：`grok --single … --output-format streaming-messages-json` 出 `system/init` + `result`；
      `-r <uuid>` 续接同一 session；`probeAgent` 复核 `status=ready`、`credentialSource=file:~\.grok\config.toml`

## 5. 归档

- [x] 5.1 `npm run openspec:validate` 通过
- [x] 5.2 specs 增量已合并进 `openspec/specs/local-tool-scan/spec.md`
- [x] 5.3 变更目录已移入 `openspec/changes/archive/2026-10-29-switch-grok-cli-to-grok-build/`
