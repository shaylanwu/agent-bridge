---
name: release-rules
description: 发布纪律：发布链路（semantic-release）、npm 包完整性、dist 与 src 同步、版本语义、CHANGELOG、tag 与回滚。
priority: P2
applies_to:
  - 'package.json'
  - 'dist/**'
  - 'CHANGELOG.md'
  - '.releaserc.json'
  - '.github/workflows/release.yml'
enforced_by:
  - hooks/post-change-gate.sh
  - hooks/pre-action-check.sh
version: 2.0.0
---

# release-rules.md — 发布纪律

> **v2（2026-10-24）**：发布从「人工打 tag + 人工 publish」改为 **semantic-release 自动发布**。
> 旧版「人工执行 npm publish」的流程已作废，别再按那套做。

## 现状（别在文档里假装已发布）

- `package.json` 版本 `0.1.0`，**npm 上仍未发布**（首次自动发布尚未发生）；git tag `v0.1.0`
  作为 semantic-release 的基线已存在（指向 `3c18605`，与 package.json 的 0.1.0 对应）。
- 发布链路**代码已就位**（`.releaserc.json` + `release.yml` + `site.yml`），但只有把改动合到
  `main` 才会真正运行 —— `develop` 上随便提交不会发布。
- 因此 README 里的 `npm install -g agent-bridge-service` **在首次自动发布前仍不可用**；
  在此之前只能用「从源码构建 + `npm link`」。发布前不得删掉这条说明。

## 0. 发布链路（谁在哪一步做什么）

```
commit（conventional）
  └─ 本地 commit-msg 钩子：commitlint 拦非法格式（.husky/commit-msg）
       └─ push 到 main
            └─ release.yml → verify（typecheck/test/build/smoke + arch/doc/contracts 三道机检）
                 └─ semantic-release：
                      commit-analyzer 定版本 → release-notes-generator 出 notes
                      → scripts/semantic-release-changelog.mjs 写 CHANGELOG.md
                      → @semantic-release/npm 升版本 + 发布 npm
                      → @semantic-release/github 建 Release
                      → @semantic-release/git 提交 CHANGELOG/package.json 回 main
                           └─ site.yml → 渲染版本历史页 → 部署 Pages
```

**版本号只由提交信息决定**：`feat` 升 minor、`fix` 升 patch、`feat!` / `BREAKING CHANGE:` 升 major，
`docs`/`chore`/`test`/`refactor`/`style`/`ci`/`build` 不发布（没有可发的内容时 workflow 什么都不做）。

## 1. 发布前置条件（缺一不可）

> 第 1~4 条由 `release.yml` 的 verify job 自动执行；第 5~7 条由 semantic-release 负责 ——
> **它们是"CI 必须满足"的条件，不是"人每次发布前手工核一遍"的清单**。
> 人唯一要保证的是：提交信息符合 Conventional Commits，且改动是完整的。

1. `npm run typecheck && npm test` 全绿；
2. `npm run build` 后 `dist/` 下 9 个模块齐备，且 `bin` 指向的 `dist/cli.js` 有可执行头（`#!/usr/bin/env node`）；
3. `package.json` 的 `files` 必须包含 `dist` + 两份 README + CHANGELOG（⛔ 漏了 `dist` 会发出一个空包）；
4. `engines.node` 与 CI 矩阵一致（当前 `>=20`，CI 跑 20/22）；
5. CHANGELOG 由 `scripts/semantic-release-changelog.mjs` 写入（Keep a Changelog 结构：标题 → 前言 → 版本段），
   ⛔ **不再手工编辑版本段**；`[Unreleased]` 段是人工工作区，发布后可清空但非必须；
6. git tag `v<version>` 由 semantic-release 生成并推送，与 `package.json` 版本必然一致
   —— ⛔ 正因为如此，**人工不得再打 tag**（见 §3）；
7. `npm publish --dry-run` 输出里能看到 `dist/cli.js`（`@semantic-release/npm` 发布前同样会走到这条）。

## 2. 版本语义

- patch：bug 修复、文档同步、适配器表新增条目（行为不变）；
- minor：新增命令/消息类型、协议向后兼容新增字段；
- major：协议破坏性变更、`PROTOCOL_VERSION` 递增、CLI 参数语义反转。

⚠️ 这三档由 `feat` / `fix` / `feat!` 决定，**清单只是事后核对用的字典**：
想把某次改动定为 minor 却写成了 `chore:`，它就不会发布 —— 这是本仓库最常见的"发布事故"。

## 3. 发布动作的风险分级

- **自动发布**（CI 里的 semantic-release）= 已授权路径：只在 `main` 上、且只在有 `feat`/`fix`/breaking 时发生。
  ⛔ Agent 仍不得自行执行 `npm publish`，也不得自行 `git push origin main` 触发发布（这是用户的动作）。
- `git tag` = **禁止人工创建**。手写的 `v1.2.3` 会和 semantic-release 抢版本号，
  要么导致重复发布、要么导致下一个版本被算错。
  （唯一例外：为新仓库建立**历史基线** tag，例如首次接入 automation 时补的 `v0.1.0`，需人工审批。）
- `git push --tags` = 高风险（写远端且可能触发下游）→ ⛔ 禁止批量推送 `--tags`，只推单个具名 tag。
- ⛔ 禁止 force push、禁止删已有 tag、禁止 `npm unpublish`（政策上基本被禁，且会打断已装用户）。

## 4. 回滚

- 发布后发现问题：优先 `npm deprecate` + 发 patch，⛔ 不删版本；
- 版本号算错（例如本该 minor 却发了 patch）：不要删 tag、不要 `npm unpublish`，
  用 `feat:` 提交补发一个更高的版本，并在 Release 说明里指向前一个；
- 本地误构建：`bash .harness/scripts/rollback.sh --dist`（删除 `dist/` 后重编，不碰源码）。

## 5. 发布后核对

- 在 GitHub Actions 的 `release` run 里确认四件事：新 tag、`CHANGELOG.md` 有新版本段、
  GitHub Release 已建、npm 上有该版本；
- 在一个干净目录 `npm i -g agent-bridge-service && agent-bridge --version` 实跑一次；
- `agent-bridge status --json` 能在无配置机器上输出（不依赖已绑定设备）；
- 站点：`site.yml` 跑完后 `/changelog/` 应为最新版本（页面由 `CHANGELOG.md` 渲染，
  `npm run site:check` 会在两边脱钩时报红）。

## 6. 离线自检（不联网、不发版）

```bash
node scripts/verify-release.mjs   # 用 v0.1.0..HEAD 的真实提交跑 notes 生成 + CHANGELOG 写入，断言结构
npx vitest run test/release.test.ts   # 插件行为单测（插入位置 / h1 归一 / 空 notes / 新建文件）
```
