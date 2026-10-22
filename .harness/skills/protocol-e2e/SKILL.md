---
name: protocol-e2e
description: 协议端到端验证：本地扮演平台侧，把真实 bridge 连上来跑 hello/scan/run_task/timeout 全链路。改协议、改 runner、改适配器后必跑。
description_zh: 'bridge↔平台 端到端冒烟（mock 平台 + 真实 CLI 执行）'
version: 1.0.0
enforced_by:
  - scripts/e2e-smoke.mjs
  - rules/workflow-rules.md（关卡四：协议类变更必须有端到端证据）
---

# skill: 协议端到端验证

**为什么需要它**：单测只覆盖纯函数（分片、校验、引号、探测），覆盖不到「WS 真的能升级、`hello` 真的发出去、
`task_status` 真的到达终态」。这些只有把 bridge 真的连上一个平台侧才能验证 —— 而真正的平台侧是第三方，本地没有。

## 一条命令

```bash
npm run build                                  # 先构建（脚本用 dist/cli.js）
node .harness/skills/protocol-e2e/scripts/e2e-smoke.mjs
# 指定别的工具：--agent codex    指定端口：--port 8901
```

脚本做三件事：起一个只监听 `127.0.0.1` 的 mock 平台 → 用 `--token` 拉起真实 bridge → 按剧本下发指令并断言回包。

## 断言清单（脚本逐条打印 PASS/FAIL）

| # | 断言 |
| --- | --- |
| 1 | WS 升级携带 `Authorization: Bearer` 才放行 |
| 2 | `hello.protocolVersion === 1` |
| 3 | `ping` → `pong` 往返 |
| 4 | `agent_list` 上报 11 个工具 |
| 5 | `scan` → `scan_result` 且 `requestId` 配对 |
| 6 | 非法 `agentType` 被本地拒为 `failed`（不 spawn） |
| 7 | 真实 CLI 任务 → `task_log` 非空 + `success` + `exitCode 0` |
| 8 | 每个 `task_log` 分片 ≤ 4 KB |
| 9 | `timeoutMs` 生效 → `timeout` 终态 |

退出码非 0 即失败，可直接接进 CI 或收尾门禁。

## 不覆盖（要人工验）

- 浏览器授权（PKCE 回环）与设备码流程 —— 需要真实平台实现 `/bridge/authorize` 等端点；
- 断线重连退避（1s→30s）与 `4401/4403` 吊销语义 —— 需手动杀 mock 观察；
- 取消（`cancel_task`）的 SIGTERM→SIGKILL 时序；
- 平台侧对 `task_log` 的存储与回放（平台责任）。

## 已知坑（脚本已按此实现，改脚本时别退回去）

1. **不能用首个 `task_status` 当终态**：`running` 先到，必须过滤掉（早期联调就是这样丢了 `exitCode`）；
2. **`--token` 模式下 `deviceId` 是空串**：`?deviceId=` 与 `hello.deviceId=""`，mock 不能靠它路由；
3. **平台断线期间的 `task_log` 会被 bridge 丢弃**：mock 必须在同一条连接内完成断言；
4. **`AGENT_BRIDGE_CONFIG` 必须指到临时目录**：否则会覆盖开发者真实的 `config.toml`。
