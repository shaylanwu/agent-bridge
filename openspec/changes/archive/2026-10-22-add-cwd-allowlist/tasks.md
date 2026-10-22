## 1. 配置读取

- [x] 1.1 `src/config.ts`：`BridgeConfig` 增加 `allowedCwd?: string[]`；`loadConfig` 读取 `allowed_cwd`（兼容 `allowedCwd`），`resolve()` 规范化、丢弃空项、空数组视为未配置
- [x] 1.2 `src/config.ts`：`saveConfig` 显式构造输出对象，白名单写为 `allowed_cwd`，不写 `undefined` 字段

## 2. 校验与接线

- [x] 2.1 `src/runner.ts`：导出 `isUnder()`；Windows 下路径比较大小写不敏感
- [x] 2.2 `src/cli.ts`：`connect` 时把 `saved.allowedCwd` 传给 `startTask`，生效时打印条目数

## 3. 测试

- [x] 3.1 `test/bridge.test.ts`：`isUnder` 三条（子目录放行 / 父目录外拒绝 / 前缀旁路 `/a/bc` 拒绝）
- [x] 3.2 `test/bridge.test.ts`：`loadConfig` 解析 `allowed_cwd`（含相对路径规范化、空数组 → undefined）
- [x] 3.3 `test/bridge.test.ts`：`startTask` 越界 `cwd` 直接回 `failed` 且不 spawn
- [x] 3.4 `npm test` 全绿（20 条：原 12 + 新增 8）

## 4. 文档

- [x] 4.1 `README.md`：安全表说明 `allowed_cwd` 配置方式与「不配 = 不限目录」
- [x] 4.2 `README.zh-CN.md`：同上（中文）

## 5. 验证

- [x] 5.1 `npm run gate` 全绿（契约边界 / 文档一致 / 类型 / 单测 / 构建）
- [x] 5.2 `npm run e2e:smoke` 通过（确认 runner 改动没破坏任务执行链路）
- [x] 5.3 人工评审（2026-10-22 已确认：不配置时行为不变 / 报错文案可接受）：确认「不配置时行为不变」与「白名单生效时的报错文案」可接受

## 6. 归档

- [x] 6.1 `openspec/specs/task-execution/spec.md` 合并本提案的 ADDED Requirements
- [x] 6.2 提案移入 `openspec/changes/archive/YYYY-MM-DD-add-cwd-allowlist/`
- [x] 6.3 人工更新 `.harness/rules/protocol-contract-rules.md` §6 与 `doc-impl-sync-rules.md` 台账（由人工于 2026-10-22 完成）
