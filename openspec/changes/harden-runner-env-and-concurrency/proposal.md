## Why

`runner.ts` 是「平台能在这台机器上做什么」的唯一边界，两处没设防：

1. **平台下发的 `env` 被无差别并入子进程环境**：`{ ...process.env, ...req.env }`。平台可以用
   `NODE_OPTIONS=--require ./evil.js` 在 Node 系 CLI 启动时执行任意代码，或用 `PATH` / `PATHEXT` /
   `LD_PRELOAD` 换掉白名单二进制 —— 与「只跑白名单 CLI、参数走数组」的防线等价被绕过。
2. **没有并发上限**：平台连发 N 个任务就同时 spawn N 个编码 CLI，开发机直接卡死。

**平台侧实测（只读扫描 `e2e-pilot/packages/orchestrator`，未改其代码）**：

- `bridge.gateway.ts` 两处构造 `run_task`（`runTask()` 与 `startTaskRun()`）**都没有 `env` 字段**；
- 整个 `orchestrator/src` 里除 `process.env` 外没有 `env:` 出现；Web 端 `RunTaskModal` 也没有；
- `execution/device-backend.ts` 的注释明确写着「平台不下发任何 env（密钥不出本机）」。

`env` 是一条**从未被平台使用、却一直开着**的旁路。既然是死通道，就不做白名单过滤，直接**移除**：
少一条可注入路径，比维护一份「危险键清单」更可靠（清单永远可能漏）。

## What Changes

- **移除 `env`**：`RunTaskCommand` 删掉 `env` 字段（`assertServerMessage` 不再透传；未知字段照旧忽略 →
  老平台继续发也不报错、不断连）。`runner` 的子进程环境固定为 bridge 自身 `process.env`，
  删除上一版新增的 `sanitizePlatformEnv()` 与危险键清单（不再需要）。
- **并发上限可配置**：`config.toml` 新增 `max_tasks`（默认 3，夹在 1–32）；
  `AGENT_BRIDGE_MAX_TASKS` 环境变量优先于配置文件（CI 场景）。
  达到上限时快速回 `task_status: failed` + `并发任务已达上限（N）…`，**不排队**（排队会让平台超时语义不可预测）。
- 文档：两份 README 的协议/安全表与配置段同步（明确「平台不能设置环境变量」是**设计**，不是疏漏）。

`PROTOCOL_VERSION` 不变：删除一个从未被使用的可选字段，且未知字段本就忽略。

## Impact

- 协议：`run_task.env` 移除（字段废弃，非破坏：平台侧从未发送）
- CLI：无新增命令；新增 config 项 `max_tasks`
- 适配器：无
- 文档：两份 README；`.harness/rules/protocol-contract-rules.md` §2（env 从可选字段列表移除）与
  `security-rules.md` §3（改为「平台不得下发 env」）
- 风险级别：**high**（`src/protocol.ts` + `src/runner.ts`）→ 实施完成后需人工确认再归档
