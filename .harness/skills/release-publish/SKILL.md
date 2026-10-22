---
name: release-publish
description: 发布到 npm 的前置条件、dry-run 核对、版本与 tag 纪律、发布后验证。npm publish 属高风险，必须人工执行。
description_zh: '发布纪律与发布后核对'
version: 1.0.0
enforced_by:
  - rules/release-rules.md
  - hooks/post-change-gate.sh（package.json 门禁）
  - hooks/pre-action-check.sh（阻断 npm publish）
---

# skill: 发布

## 现状

`agent-bridge-service@0.1.0` **尚未发布**（`npm view` 404，仓库无 tag）。README 里的
`npm install -g agent-bridge-service` 当前不可用 —— 发布前不要删掉这句说明。

## 发布前核对（逐条打勾）

```bash
# 1. 门禁全绿
npm run gate

# 2. 构建产物齐全
npm run build && ls dist/        # 期望 9 个 .js，cli.js 首行是 #!/usr/bin/env node

# 3. 包内容不含多余文件、且含 dist
npm pack --dry-run               # 看文件清单：dist/ + 两份 README + CHANGELOG + package.json

# 4. 版本与 CHANGELOG 对齐
node -p "require('./package.json').version"
head -20 CHANGELOG.md            # 必须有对应版本段落，[Unreleased] 已清空
```

## 版本语义（本仓库）

| 改动 | 版本 | 例子 |
| --- | --- | --- |
| 适配器表新增条目、bug 修复、文档 | patch | 0.1.0 → 0.1.1 |
| 新增 CLI 命令 / 新增消息类型（兼容） | minor | 0.1.0 → 0.2.0 |
| 协议破坏性变更、`PROTOCOL_VERSION` 递增 | major | 0.1.0 → 1.0.0 |

## 发布（人工执行）

```bash
git tag v0.1.1 && git push --tags        # 中风险：写远端
npm publish                              # 高风险：不可逆外发，Agent 不得代跑
```

`prepublishOnly` 会自动 `npm run build`，所以本地 `dist/` 是否最新不影响发布产物 —— 但仍建议先手动构建看一遍。

## 发布后验证（必做，否则等于没验）

```bash
mkdir -p /tmp/ab-verify && cd /tmp/ab-verify
npm i -g agent-bridge-service
agent-bridge --version            # 应等于刚发布的版本
agent-bridge status --json | head # 无配置机器上也要能跑（不依赖绑定）
agent-bridge connect              # 无参数应打印用法并 exit 2
```

把三条命令的输出贴进 PR 描述 —— 这是发布唯一有效的证据。

## 出事怎么办

| 情况 | 处理 |
| --- | --- |
| 功能有 bug | 发 patch，**不要** `npm unpublish`（会打断已装用户） |
| 误发了不该发的版本 | `npm deprecate` 标注 + 立刻发修复版 |
| 包内容缺失（如少了 dist） | 立刻 patch 版本重发；同时检查 `files` 字段与 `npm pack --dry-run` |
| token 泄露进包 | 立即吊销 token，`npm deprecate`，audit 记录，按安全事件处理 |
