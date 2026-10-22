## 1. 移除平台的 env 通道

- [x] 1.1 `src/protocol.ts`：`RunTaskCommand` 删除 `env` 字段；`assertServerMessage` 不再透传（未知字段忽略，不拒帧）
- [x] 1.2 `src/runner.ts`：删除 `RunTaskRequest.env`、`sanitizePlatformEnv()`、危险键清单；子进程环境固定为 `process.env`
- [x] 1.3 `src/cli.ts`：`startTask` 不再传 `env`

## 2. 并发上限可配置

- [x] 2.1 `src/config.ts`：`BridgeConfig.maxTasks`，读 `max_tasks`；`resolveMaxTasks()` 优先级
      `AGENT_BRIDGE_MAX_TASKS` > config > 默认 3，夹在 1–32
- [x] 2.2 `src/cli.ts`：`startTask` 传入 `maxConcurrent` / `maxQueued`
- [x] 2.3 `src/runner.ts`：`maxConcurrent ?? 3`、`maxQueued ?? 32`；计数在 spawn 前 +1、终态 −1
- [x] 2.4 `src/runner.ts`：有界 FIFO 队列 —— 超限入队、有空位 `pump()` 起下一个、队列满才 `failed`
- [x] 2.5 `src/runner.ts`：排队任务可取消（从队列摘除 → `cancelled`，不 spawn）；`timeoutMs` 从入队开始算

## 3. 测试

- [x] 3.1 `resolveMaxTasks`：默认值、config 生效、0/负数回落、过大截断、小数取整
- [x] 3.2 `resolveMaxTasks`：环境变量优先于 config
- [x] 3.3 `loadConfig`：解析 `max_tasks`
- [x] 3.4 删除已失效的 `sanitizePlatformEnv` 用例
- [x] 3.5 `resolveMaxQueued`：默认 32、0 合法、负值回落、过大截断、环境变量优先
- [x] 3.6 `npm test` 全绿（35 条）

## 4. 文档

- [x] 4.1 `README.md`：安全表「平台 env：不接受」+「并发：`max_tasks`」；配置段补 `max_tasks` 示例
- [x] 4.2 `README.zh-CN.md`：同上
- [x] 4.3 `.harness/rules/protocol-contract-rules.md` §2、`security-rules.md` §3 同步

## 5. 验证

- [x] 5.1 `npm run gate` 全绿
- [x] 5.2 `npm run e2e:smoke` 通过
- [x] 5.3 端到端：`max_tasks = 1`、`max_queue = 2`，依次下发 4 个任务 →
      1 个立即运行、2 个排队、第 4 个因队列满被拒；前 3 个最终 success（排队任务在空位后依次启动）
- [x] 5.4 端到端：排队中的任务 `cancel_task` → 立即 `cancelled` 且从未 spawn
- [x] 5.4 端到端：平台下发 `env: { NODE_OPTIONS }` → 任务照常执行，且该变量不进入子进程
- [x] 5.5 实测配置生效：`config.toml` 写 `max_tasks = 6` 时 `loadConfig()` 返回 6，`AGENT_BRIDGE_MAX_TASKS` 覆盖为 4

## 6. 归档

- [ ] 6.1 合并 spec delta（task-execution：平台不得下发环境变量 + 并发上限可配置）
- [ ] 6.2 提案移入 `openspec/changes/archive/YYYY-MM-DD-harden-runner-env-and-concurrency/`
- [ ] 6.3 人工评审：确认「env 通道移除」与「超限直接失败不排队」可接受
