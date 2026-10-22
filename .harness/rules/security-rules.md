---
name: security-rules
description: bridge 的安全边界：凭据只探测不读取、token 存储与脱敏、子进程权限、出站-only 网络、审计。
priority: P1
applies_to: ['*']
enforced_by:
  - hooks/pre-action-check.sh
  - scripts/protocol-boundary-check.mjs
version: 1.0.0
---

# security-rules.md — 安全边界

本项目的安全模型很简单：**bridge 跑在开发者的个人机器上，握着能 spawn 任意白名单 CLI 的权限**。所有规则围绕「不越权、不外泄、不放大」三条。

## 1. 凭据：只探测，不读取

- 适配器判定凭据只有两种手段：环境变量是否有值、凭据文件是否存在（`existsSync`）。
- ⛔ 禁止 `readFileSync` / `openSync` / `createReadStream` 碰 `credential.files` 里的路径。
- ⛔ 凭据内容不得进内存缓存、不得进 `agent_list` 报文、不得进日志。上报字段只有 `credentialSource`（如 `env:OPENAI_API_KEY` / `file:~/.codex/auth.json`）。

## 2. device_token

- 存储：`config.toml`，`mode: 0o600`，并 `chmodSync` 兜底（Windows 上只改只读位，属已知限制，文件仍在用户目录内）。
- 展示：只用 `tokenTail()`（尾部 6 位）。⛔ 禁止 `console.log(token)` 全量输出。
- 传输：仅通过 WS 握手头 `Authorization: Bearer …`；⛔ 禁止放在 URL query 里（会进代理日志）。
- 平台侧只存 SHA-256 哈希 —— 这是平台的责任，但 bridge 不得假设平台会做。

## 3. 子进程

- 白名单 + 参数数组（见 `always-on.md` §4）。
- 子进程环境 = bridge 自身 `process.env`。⛔ **平台不能设置任何环境变量**（`run_task.env` 已移除，2026-10-22）：
  `NODE_OPTIONS` / `PATH` / `PATHEXT` / `LD_PRELOAD` / `DYLD_*` 这类键能直接换掉「被执行的是什么代码」，
  等价于绕过白名单。若未来要恢复 env 通道，必须先做白名单过滤并重新走提案。
- ⛔ 子进程 stdin 保持 `ignore`（当前实现），不得改为继承终端 —— 否则受控 CLI 会等交互输入、卡死到超时。

## 4. 网络

- ⛔ 只允许**出站**连接。唯一允许监听的是授权期的 `127.0.0.1:0` 临时回调服务（`src/auth.ts`），且：只绑回环、只处理一次 `/callback`、拿到 code 立刻 `close()`、180s 超时兜底。
- ⛔ 禁止 `0.0.0.0` / `::` 绑定；禁止开反向隧道或端口转发。
- 回环回调的 `redirect_uri` 必须在平台侧校验以 `http://127.0.0.1` 开头（bridge 无法自证，属平台责任，须在对接文档中写明）。

## 5. 审计

- 每个高风险动作、每次门禁结果、每次被拦动作都写 `.harness/work/audit-<date>.jsonl`。
- 审计 detail 为单行纯文本，⛔ 不得包含 token、密钥、完整命令行中的敏感值。

## 6. 测试数据

- ⛔ 测试与用例里禁止出现真实 token / key；统一用 `tok_smoke`、`bd_smoke` 这类明显伪值（`pre-action-check.sh` 的密钥模式会拦真实 key 形态）。
- 联调用的 mock 平台必须绑定 `127.0.0.1`，且不得把 mock 的 token 写进仓库。
