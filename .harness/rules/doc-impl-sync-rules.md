---
name: doc-impl-sync-rules
description: 文档与实现同步规则（本项目历史漂移点清单）、可机检项与人工核对项。
priority: P1
applies_to: ['README.md', 'README.zh-CN.md', 'CHANGELOG.md', 'src/**']
enforced_by:
  - scripts/doc-contract-check.mjs
  - hooks/post-change-gate.sh
version: 1.0.0
---

# doc-impl-sync-rules.md — 文档与实现同步

## 为什么单列一条规则

这个仓库的文档写得比代码"超前"：README 曾描述过三处代码里没有的能力（`allowed_cwd`、并发探测、已发布 npm 包）。`allowed_cwd` 已由提案 `add-cwd-allowlist`（2026-10-22）补齐，其余两处仍待修 —— 见 §4 台账。这比缺文档更危险：平台侧会照着 README 实现，然后对不上。

## 1. 可机检项（`doc-contract-check.mjs` 硬校验，违反即门禁失败）

1. **协议消息类型全覆盖**：`src/protocol.ts` 中 `ClientMessage` / `ServerMessage` 的每个 `type` 值，必须同时出现在 `README.md` 与 `README.zh-CN.md` 的协议表中；
2. **示例报文可被接受**：README 里 ```json 代码块中 `"type": "run_task"` 的示例，必须带 `args` 数组（否则平台照着写会被本地拒帧）；
3. **命令清单一致**：`src/cli.ts` 支持的命令（`connect` / `status` / `logout` / `daemon`）必须在两份 README 的用法段都出现；
4. **未实现功能标注**：`daemon` 在 README 中必须带"未实现 / Phase 3"标注（代码里是 stub）。

## 2. 人工核对项（评审 checklist 覆盖，脚本不做）

- 配置路径：unix `~/.agent-bridge/config.toml`、Windows `%APPDATA%\agent-bridge\config.toml` —— 与 `config.ts` 的 `configPath()` 一致；
- 声称的安全能力必须有对应实现（白名单、超时、0600、只绑回环）；
- 声称"已支持"的能力，不得出现在 `protocol-contract-rules.md` §6 的未落地表格里；
- CHANGELOG 的 `Added` 条目必须能在代码里找到落点。

## 3. 变更纪律

- 行为变更 → 同一次提交内更新 README 两份 + CHANGELOG 的 `[Unreleased]`；
- 纯文档修正 → 只改文档，但必须跑 `doc-contract-check`（防止"修文档时又写错示例"）；
- ⛔ 禁止为了让门禁通过而删掉 README 里的消息类型（等于删掉对接信息）—— 正确做法是改 protocol.ts 或补文档。

## 4. 已知漂移台账（修复后请划掉，不要留假账）

| 漂移 | 状态 |
| --- | --- |
| README `run_task` 示例缺 `args` | 已修（示例补 `"args": []`） |
| unix 配置路径 `~/.bridge` 与文档 `~/.agent-bridge` 不一致 | 已修（`configPath()` 统一为 `.agent-bridge`） |
| `config.ts` 头注释写 `%APPDATA%\bridge` | 已修 |
| README 宣称并发探测，实为串行同步 | 未修（`windows-compat-rules.md` §3 已标注真实耗时） |
| README 宣称 `allowed_cwd` 可用，CLI 未接线 | 已修（add-cwd-allowlist，2026-10-22） |
| README 的 `npm install -g` 现在装不到（未发布） | 未修（`release-rules.md` 记录了发布前置条件） |
