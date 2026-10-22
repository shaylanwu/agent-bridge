---
name: release-rules
description: 发布纪律：npm 包完整性、dist 与 src 同步、版本语义、CHANGELOG、打 tag 与回滚。
priority: P2
applies_to: ['package.json', 'dist/**', 'CHANGELOG.md']
enforced_by:
  - hooks/post-change-gate.sh
  - hooks/pre-action-check.sh
version: 1.0.0
---

# release-rules.md — 发布纪律

## 现状（别在文档里假装已发布）

- `package.json` 版本 `0.1.0`，**尚未发布到 npm**（`npm view agent-bridge-service` 返回 404），仓库也没有 git tag。
- 因此 README 里的 `npm install -g agent-bridge-service` **当前不可用**；只能用「从源码构建 + `npm link`」。发布前不得删掉这条说明。

## 1. 发布前置条件（缺一不可）

1. `npm run typecheck && npm test` 全绿；
2. `npm run build` 后 `dist/` 下 9 个模块齐备，且 `bin` 指向的 `dist/cli.js` 有可执行头（`#!/usr/bin/env node`）；
3. `package.json` 的 `files` 必须包含 `dist` + 两份 README + CHANGELOG（⛔ 漏了 `dist` 会发出一个空包）；
4. `engines.node` 与 CI 矩阵一致（当前 `>=20`，CI 跑 20/22）；
5. CHANGELOG 有对应版本段落（Keep a Changelog 格式），`[Unreleased]` 内容清空；
6. git tag `v<version>` 与 `package.json` 版本一致；
7. `npm publish --dry-run` 输出里能看到 `dist/cli.js`。

## 2. 版本语义

- patch：bug 修复、文档同步、适配器表新增条目（行为不变）；
- minor：新增命令/消息类型、协议向后兼容新增字段；
- major：协议破坏性变更、`PROTOCOL_VERSION` 递增、CLI 参数语义反转。

## 3. 发布动作的风险分级

- `npm publish` = **高风险**（外发不可逆动作）→ 必须人工执行或显式授权；⛔ Agent 不得自行 publish。
- `git tag` + `git push --tags` = 中风险（写远端）→ 输出变更方案 + 审计日志。
- ⛔ 禁止 force push、禁止删已有 tag、禁止 `npm unpublish`（政策上基本被禁，且会打断已装用户）。

## 4. 回滚

- 发布后发现问题：优先 `npm deprecate` + 发 patch，⛔ 不删版本；
- 本地误构建：`bash .harness/scripts/rollback.sh --dist`（删除 `dist/` 后重编，不碰源码）。

## 5. 发布后核对

- 在一个干净目录 `npm i -g agent-bridge-service && agent-bridge --version` 实跑一次；
- `agent-bridge status --json` 能在无配置机器上输出（不依赖已绑定设备）；
- 把结果（版本号 + 命令输出）贴进 CHANGELOG 对应版本的 PR 描述 —— 这是发布的证据。
