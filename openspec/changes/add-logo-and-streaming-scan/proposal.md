## Why

三个问题叠在一起：

1. **扫描是串行的**：`scanAgents()` 里 11 个适配器逐个 `execFileSync('--version')`。空载 12.8s、机器繁忙时实测
   25.7s，期间事件循环被完全占住 —— WS 心跳、`pong`、入站指令全部延迟，`e2e:smoke` 的 60s 预算被吃光后开始假失败。
2. **结果一次性发出**：平台在十几秒里只看到自己刚下发的那条指令，然后突然收到 11 条。用户界面上是「一直空着 → 全部出现」，
   而不是像 e2e-pilot 那样卡片逐个亮起。
3. **没有 logo**：平台拿到的 `agent_list` 只有 `display` / `version` / `status`，画卡片只能显示纯文字。
   e2e-pilot 的「我的工具」是白底圆角块 + 官方 mark（`public/agent-icons/<kind>.svg`，24×24 视口），
   本仓库的 kind 命名与那套资产完全一致，但桥接出去时把这部分信息丢掉了。

## What Changes

- **并发探测**：`scan.ts` 改为「有并发上限（4）的异步探测」；`probeVersion` 由 `execFileSync` 改为异步 `spawn`
  （Windows `.cmd` 垫片仍经 `win-exec.ts` 拼命令行，不走 `exec`）。`resolveBin` 保持同步（`where` 单次 ~50ms，不是瓶颈）。
- **实时回传**：新增客户端消息 `scan_progress`
  `{ type, requestId?, items: AgentListItem[], scannedAt, done: boolean }`，每完成一个适配器就发一条（`items` 为该批新完成的项），
  扫描结束仍发原有的 `agent_list`（首连）或 `scan_result`（响应 `scan`）作为**终态全量**，保证老平台行为不变。
- **logo**：`AgentListItem` 增加可选 `logo?: string`（`data:image/svg+xml;base64,...`，24×24、单色已固化为 `#111111`）。
  资产放 `assets/agent-icons/<kind>.svg`（11 个，取自 e2e-pilot 同一批官方矢量副本），随 npm 包一起发布；
  缺失时字段省略（平台回退为首字母块）。新增 `src/agent-logos.ts` 负责读取 + base64 + 缓存。
- **文档**：两份 README 的协议表补 `scan_progress` 与 `logo`，并说明「平台应按 kind 缓存 logo，不要每帧重解析」。

不改既有字段语义、不改 `PROTOCOL_VERSION`（新增消息类型 + 可选字段，属向后兼容）。

## Impact

- 协议：新增 `scan_progress`；`AgentListItem.logo` 可选字段。向后兼容，老平台忽略即可
- CLI：`connect` 首连改为流式上报；`status` 仍一次性输出（本机命令不需要流式）
- 适配器：`probeVersion` / `probeAgent` 变为 async（内部 API，不对外）；适配器表新增 `logo` 文件映射
- 发布：`package.json` 的 `files` 必须加 `assets`（否则发布的包里没有 logo）
- 文档：两份 README 协议表 + 配置说明
- 风险级别：**high**（动 `src/protocol.ts`，第三方平台按它实现；且 runner/adapters 的 spawn 语义有调整）
  → 实施完成后需人工确认再归档
