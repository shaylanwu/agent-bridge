## 1. 实现

- [x] 1.1 `src/runner.ts`：`sanitizePlatformEnv()` —— 剔除影响解释器/加载器的敏感键，返回 `{ env, dropped }`
- [x] 1.2 `src/runner.ts`：spawn 时只用 `{ ...process.env, ...sanitized }`；被剔除的键打一行本地 stderr 提示
- [x] 1.3 `src/runner.ts`：并发上限（默认 3，`AGENT_BRIDGE_MAX_TASKS` 可覆盖），超限快速回 `failed`
- [x] 1.4 `src/runner.ts`：计数在 spawn 前 +1、在终态 −1（含 timeout / cancelled / error 各路径）

## 2. 测试

- [x] 2.1 单测：`sanitizePlatformEnv` 剔除 `NODE_OPTIONS`/`PATH`/`LD_PRELOAD`，保留 `HTTPS_PROXY`/`TZ`/自定义键
- [x] 2.2 单测：大小写混写（`node_options`）同样被剔除
- [x] 2.3 单测：只传被禁键时返回空对象且 `dropped` 完整
- [x] 2.4 `npm test` 全绿

## 3. 文档

- [x] 3.1 `README.md`：安全表补「env 白名单 + 并发上限」；配置段补 `AGENT_BRIDGE_MAX_TASKS`
- [x] 3.2 `README.zh-CN.md`：同上

## 4. 验证

- [x] 4.1 `npm run gate` 全绿
- [x] 4.2 `npm run e2e:smoke` 通过
- [x] 4.3 端到端实测：同时下发 4 个任务（上限 3）→ 第 4 个立即 `failed`，前 3 个正常 `success`
- [x] 4.4 端到端实测：下发 `env.NODE_OPTIONS` → 任务照常执行，本机 stderr 记录剔除（已实测）

## 5. 归档

- [ ] 5.1 合并 spec delta（task-execution：新增「平台 env 白名单」「并发上限」两条 Requirement）
- [ ] 5.2 提案移入 `openspec/changes/archive/YYYY-MM-DD-harden-runner-env-and-concurrency/`
- [ ] 5.3 人工评审：确认行为收紧（部分 env 键被忽略、超限直接失败而非排队）可接受
