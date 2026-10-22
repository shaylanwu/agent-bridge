## 1. 资产与加载

- [x] 1.1 `assets/agent-icons/<kind>.svg`（11 个，取自 e2e-pilot 官方矢量副本）+ `package.json` 的 `files` 加 `assets`
- [x] 1.2 `src/agent-logos.ts`：读 SVG → base64 data URI，进程内缓存；文件缺失返回 undefined（不抛错）
- [x] 1.3 `src/agent-adapters.ts`：`probeAgent` 结果带 `logo`（按 kind 直接映射 assets/agent-icons/<kind>.svg，不额外维护映射表）

## 2. 并发探测

- [x] 2.1 `src/agent-adapters.ts`：`probeVersion` 改为异步 `spawn`（垫片经 `win-exec` 拼命令行，全程不用 `exec`）；超时/非零退出仍判 `installedButBroken`
- [x] 2.2 `src/agent-adapters.ts`：`probeAgent` 改为 async；新增 `resolveBinAsync`（扫描用），`resolveBin` 同步版保留给 runner
- [x] 2.3 `src/scan.ts`：并发上限 6 的异步探测（实测 4/6/8 差异不大，瓶颈是 gemini/mimo 单体 ~5s）；保留 30s 缓存与 `fresh` 绕过

## 3. 实时回传

- [x] 3.1 `src/protocol.ts`：`AgentListItem.logo?`；新增 `scan_progress` 消息类型（`items` / `scannedAt` / `done` / 可选 `requestId`）
- [x] 3.2 `src/cli.ts`：首连扫描按「每完成一个发 `scan_progress`」流式上报，结束发 `agent_list`
- [x] 3.3 `src/cli.ts`：响应平台 `scan` 时同样流式发 `scan_progress`，结束发 `scan_result`（带 `requestId`）

## 4. 测试

- [x] 4.1 `agent-logos`：存在的 kind 返回 `data:image/svg+xml;base64,` 前缀；未知 kind 返回 undefined；重复调用命中缓存
- [x] 4.2 `assertServerMessage`：`scan` / `ping` 行为不变（回归）
- [x] 4.3 扫描结果项包含 `${'display'|'version'|'status'|'logo'}` 四个字段（用真实扫描断言）
- [x] 4.4 `npm test` 全绿

## 5. 文档

- [x] 5.1 `README.md`：协议表补 `scan_progress`、`AgentListItem.logo`；说明按 kind 缓存 logo
- [x] 5.2 `README.zh-CN.md`：同上

## 6. 验证

- [x] 6.1 `npm run gate` 全绿
- [x] 6.2 `npm run e2e:smoke` 通过
- [x] 6.3 实测并发收益（12.8s/25.7s → 6.7s；首个结果 1.3s 到达）：`time node dist/cli.js status --fresh` 记录改前/改后
- [x] 6.4 实测流式：mock 平台按时间顺序收到多条 `scan_progress`，且首条早于终态 `agent_list`

## 7. 归档

- [ ] 7.1 合并 spec delta（bridge-protocol 的工具状态上报 + local-tool-scan 的探测口径）到 `openspec/specs/`
- [ ] 7.2 提案移入 `openspec/changes/archive/YYYY-MM-DD-add-logo-and-streaming-scan/`
- [ ] 7.3 人工评审：确认 `logo` 体积（约 70KB/全量）与协议新增可接受
