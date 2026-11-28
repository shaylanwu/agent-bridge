# 变更提案：headless 子进程的 stdin 恒为 ignore（对齐规格 + 消除潜在的「等 EOF 挂死」）

## Why

`TaskSupervisor.launch` 里曾有一句：

```ts
const stdinMode = entry.req.interactive ? 'pipe' : 'ignore';
```

即「任务申请了交互 → 给子进程 stdin 开 pipe」。但**没有任何适配器从 stdin 读审批答复**：
受控交互的读写通道是协议 —— ACP `session/request_permission`、app-server 的
`item/…/requestApproval` 系列、claude 的 stream-json 控制帧。`TaskHandle.write()` 在全仓
**零调用方**，这条 pipe 从来没被写过一行。

代价却是实打实的：`codex exec` 这类 CLI 会**先读 stdin 到 EOF 再开工**，pipe 不关 = 永远等不到：

| 微实验（真 codex 0.171，2026-11-28，`exec --json` 同一 prompt） | 结果 |
| --- | --- |
| `stdio[0]='ignore'` | 19.9s 完成，879 字节，含 BANANA42 |
| `stdio[0]='pipe'`（不写入、不关闭） | 25s **零字节**，进程不退出 |

规格本来就这样要求（`task-execution`「十二适配器 full 映射」）：

> 除受控交互适配器外，子进程 stdin SHALL 保持 ignore。

所以这是**实现偏离规格**。可达路径不止 codex：`conversation.ts` 的 full 分支、
qoder-cli / agy / trae 等任何走 headless 又申请了交互的组合，都会命中同一条 pipe。

## 归因边界（写清楚，避免把锅算错）

2026-11-28 复跑 `E2E_INTERACTION=1 E2E_AGENT=codex npm run e2e:gateway` 共三次：

| 运行 | stdin 模式 | 结果 | 耗时 |
| --- | --- | --- | --- |
| ① 首轮 | pipe（原状） | 6 项失败：ACP `session/prompt` SSE 超时、`content=""`、第二轮 `session_busy` | 4m09s |
| ② 修复后 | ignore | **17/17 全通过**（第一轮 `content="OK"`、多轮记忆 BANANA42） | 57s |
| ③ 把改动回退并重建 dist | pipe（原状） | **17/17 全通过** | 52s |

③ 说明：**首轮那 6 项失败与本改动无关**。三次里只有①慢到 4 分钟，与既有的
「codex responses WebSocket 被丢 → 约 113s 重连静默后才回退 HTTPS」症状同量级，
判为瞬时环境问题（首轮连接冷启动），本轮**无法稳定复现**，因此不把本提案当作它的修复。

本提案的价值因此收窄为两条，但都成立：① 实现与规格不一致；② 一旦某条 headless 路径
真的带着 `interactive=true` 起子进程，等 stdin EOF 的 CLI 会静默挂死到总超时。

## What Changes

1. **`src/core/task-supervisor.ts`（`launch`）**
   `stdinMode` 恒为 `'ignore'`，把根因、微实验数据与规格出处写进注释（防止以后有人凭直觉改回 pipe）。
2. **同文件类型注释**
   - `interactive`：只决定「审批转人工还是直接 decline」，**不控制 stdin**；
   - `TaskHandle.write`：headless 恒 `ignore`，对 headless 任务恒返回 `false`；
     真实交互走 `respondInteraction`。
3. **测试** `test/supervisor-headless-stdin.test.ts`（2 例，真子进程）
   假 CLI 只做一件事：等 stdin `end` 再吐标记行。`interactive=true` 与 `false` 都必须成功。

**不做**：不改 wire 协议、不改 ACP / app-server 通道、不动权限策略与 `PROTOCOL_VERSION`；
不删 `write()` API（对象形状不变，只是对 headless 恒 false）。

## Impact

- 修复面：`src/core/task-supervisor.ts`（不在 policy 高风险清单；`shell: true` 位置未动）。
- 行为（正面）：headless 通道不再因 `interactive` 打开 stdin；等 EOF 的 CLI 不会被挂住。
- 行为（风险）：依赖 `write()` 写 stdin 的假设不成立 —— 零调用方，且规格本就禁止。
- 未知量：若将来某个 CLI 真用 stdin 收发审批，须显式新增能力声明，而不是靠 `interactive` 顺带开管道。

## 验收标尺

1. `test/supervisor-headless-stdin.test.ts` 2 例全绿；把 `stdinMode` 改回
   `interactive ? 'pipe' : 'ignore'` 后**两例都变红**（`expected 'timeout' to be 'success'`）。
2. `npm run gate` + `npm run harness:validate` 全绿，全量 vitest 不回归。
3. `E2E_INTERACTION=1 E2E_AGENT=codex npm run e2e:gateway` 保持 17/17（回归确认，**不作为本改动的因果证据**）。
