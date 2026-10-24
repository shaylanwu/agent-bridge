---
name: protocol-contract-rules
description: bridge↔平台 wire 契约的演进规则：字段必填性、版本策略、兼容窗口、平台侧对接面。
priority: P1
applies_to: ['src/protocol.ts', 'src/transport/bridge-client.ts', 'src/runner.ts', 'README.md', 'README.zh-CN.md']
enforced_by:
  - scripts/doc-contract-check.mjs
  - hooks/post-change-gate.sh
version: 1.0.0
---

# protocol-contract-rules.md — 协议契约演进规则

## 现实约束

平台侧是**第三方独立实现**（可能是别的团队、别的语言）。它们只能读到 README 的协议表和 `protocol.ts`。所以：契约变更的成本不在本仓库的编译，而在**对方的兼容性**。

## 1. 谁定义什么

| 方向 | 类型 | 唯一来源 |
| --- | --- | --- |
| bridge → 平台 | `hello` / `agent_list` / `scan_result` / `task_log` / `task_status` / `pong` | `src/protocol.ts` 的 `ClientMessage` |
| 平台 → bridge | `run_task` / `cancel_task` / `scan` / `ping` | `src/protocol.ts` 的 `ServerMessage` |

⛔ 任何其他文件出现上述类型的重复定义 = 违规。

## 2. 字段必填性（已踩过的坑）

- `run_task.args` 虽然平台可能只想传 `prompt`，但**校验层要求 `args` 必存在且为字符串数组**；想用适配器默认参数模板，平台必须显式发 `"args": []`。
  - 这与 README 早期示例矛盾（示例只给 `prompt`）→ 已按「实现为准 + 修示例」处理。
  - 若要放宽为可选，属于协议变更：需提案 + 版本递增 + 明确 `args` 缺省语义（不能悄悄改）。
- `agentType` / `cwd` / `taskId` 必填且非空；`prompt` / `timeoutMs` / `allowInteractive` 可选。
- ⛔ **`env` 已被移除**（2026-10-22，提案 `harden-runner-env-and-concurrency`）：平台不得下发环境变量，
  子进程只用 bridge 自身环境。老平台仍发 `env` 会被忽略（未知字段一律忽略），不得因此报错或断连。
  要加回来必须先证明「平台确实需要」并重新评估注入面。
- ⛔ 禁止「平台多发字段就报错」的严格模式：未知字段必须忽略（前向兼容），校验只做形状与白名单。

## 3. 版本策略

- `PROTOCOL_VERSION = 1`；破坏性变更（字段改名/删除、语义反转、必填性收紧）→ 递增到 2，并在 README 协议表标注「≥ 0.2.0 起」。
- 向后兼容的**新增**（新字段、新消息类型）不需要升版本，但必须在 README 协议表登记，且默认值要能被老平台忽略。
- 同一大版本内新增消息类型时，bridge 遇到未知 `type` 必须**拒帧但不崩溃**（当前实现：`ProtocolError` → 打日志继续跑），不得断开连接。

## 4. 状态与终态

- `task_status` 的终态只有四种：`success` / `failed` / `cancelled` / `timeout`；`running` 是过程态，平台不得把它当终态（本项目早期联调踩过：把首个 `running` 当结束会丢掉 `exitCode`）。
- 每个 `taskId` 必须**有且仅有一个终态**；禁止重复上报终态。
- 日志分片 ≤ 4 KB（`LOG_CHUNK_BYTES`），按 UTF-8 字节切且不切断多字节字符 —— 平台按顺序拼接即可还原。

## 5. 平台侧对接面（改动端点 = 破坏对接）

| 端点 | 用途 |
| --- | --- |
| `GET /bridge/authorize` | 浏览器回环授权（PKCE S256） |
| `POST /api/bridge/token` | 用 code + verifier 换 `device_token` |
| `POST /api/bridge/device-code` | 无浏览器场景申请设备码 |
| `POST /api/bridge/device-token` | 轮询换取 token（401 = 用户拒绝） |
| `WS /api/bridge/ws?deviceId=` | 长连接（`Authorization: Bearer <device_token>`） |

- 吊销语义：WS close code `4401` / `4403`，bridge 收到即停止重连。⛔ 不得改用 `1008` 等标准码表达吊销（会被当临时故障无限重试）。
- 端点数与路径由 `src/infra/auth.ts` / `src/transport/bridge-client.ts` 硬编码；改动必须同步 README.zh-CN「对接」章节与本文件。

## 6. 已知未落地项（不得在文档中写成"已支持"）

| 项 | 现状 |
| --- | --- |
| `refresh_token` | 只存储不使用，过期需重新绑定 |
| 断线期间 `task_log` | 直接丢弃，不补发；平台需自行缓存已收分片 |
| 并发任务上限 | 无（平台可同时下发多个任务） |
| `isAnsi` | 恒为 `true`，平台需自行决定是否渲染 ANSI |

⛔ 任何一项在真正实现前，README 不得表述为已支持；实现后必须同时删除本表格对应行（`doc-contract-check` 只校验可机检的部分，这张表靠评审）。
