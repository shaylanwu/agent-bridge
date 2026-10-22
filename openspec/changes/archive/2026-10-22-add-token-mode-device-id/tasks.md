## 1. 实现

- [x] 1.1 `src/bridge-client.ts`：导出 `wsUrlOf()`；`deviceId` 为空时省略 `deviceId` 查询参数
- [x] 1.2 `src/cli.ts`：解析 `--device-id` 与 `AGENT_BRIDGE_DEVICE_ID`，按 flag > env > 已存配置（同平台）优先级解析
- [x] 1.3 `src/cli.ts`：deviceId 为空时输出一次性警告（平台须按 token 反查设备），不阻断连接
- [x] 1.4 `src/cli.ts`：`--help` 与用法文案补 `--device-id`

## 2. 测试

- [x] 2.1 `wsUrlOf`：有 deviceId 时带 `?deviceId=bd_x`，无 deviceId 时不带查询串
- [x] 2.2 解析优先级：flag 覆盖 env、env 覆盖已存配置、空串按未提供处理
- [x] 2.3 `npm test` 全绿

## 3. 文档

- [x] 3.1 `README.md`：CI 用法补 `--device-id`，写明 deviceId 可省略 + 平台按 token 反查
- [x] 3.2 `README.zh-CN.md`：同上

## 4. 验证

- [x] 4.1 `npm run gate` 全绿
- [x] 4.2 `npm run e2e:smoke` 通过（`--token` 路径仍能连通并执行任务）
- [x] 4.3 手工确认：不传 `--device-id` 时警告出现一次且连接正常

## 5. 归档

- [x] 5.1 `openspec/specs/bridge-protocol/spec.md` 合并本提案的 MODIFIED Requirement（设备绑定授权）
- [x] 5.2 提案移入 `openspec/changes/archive/YYYY-MM-DD-add-token-mode-device-id/`
