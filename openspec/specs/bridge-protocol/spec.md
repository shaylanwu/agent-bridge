# bridge-protocol 规格

## Purpose

定义本机 bridge 与远程编排平台之间的 wire 契约。**平台侧是第三方独立实现**，因此本规格是双方唯一可对齐的承诺：
消息方向、字段必填性、鉴权方式、心跳与吊销语义、日志分片规则。

## Requirements

### Requirement: 出站长连接

bridge SHALL 主动向平台发起 WebSocket 连接（`/api/bridge/ws?deviceId=<id>`），握手携带
`Authorization: Bearer <device_token>`，且 SHALL NOT 监听任何入站端口（授权期 `127.0.0.1` 回调除外）。

#### Scenario: 握手成功

- **WHEN** 设备已绑定且网络可达
- **THEN** 连接建立后 bridge 立即发送 `hello`（含 `protocolVersion` / `deviceId` / `cliVersion` / `platform` / `hostname`）

#### Scenario: 凭证被吊销

- **WHEN** 平台以 close code `4401` 或 `4403` 关闭连接
- **THEN** bridge 记录提示并停止重连（不进入退避循环），用户需重新 `connect`

#### Scenario: 网络中断

- **WHEN** 连接异常断开（如 1006）
- **THEN** bridge 以 1s→2s→4s…→30s 指数退避重连，并在重连后补发状态类消息（`task_log` 不补发）

### Requirement: 工具状态上报

bridge SHALL 在每次连上后上报本机工具清单，并响应平台的 `scan` 指令。状态 SHALL 为三态之一：
`ready` / `installed_no_cred` / `not_installed`，找到二进制但无法执行时 SHALL 额外标记 `installedButBroken`。
每项 SHALL 包含工具名（`display`）、版本（`version`，探测不到时省略）、状态（`status`）与品牌图标（`logo`），
`logo` 为 `data:image/svg+xml;base64,…` 的 24×24 单色矢量，缺失时 SHALL 省略该字段。
扫描 SHALL 并发进行（同时探测不超过 4 个工具），且 SHALL 在扫描过程中**实时**推送已完成项。

#### Scenario: 实时进度

- **WHEN** 扫描开始且第一个适配器完成探测
- **THEN** bridge 立即发送 `scan_progress`（`items` 含该工具、`done: false`），不必等全部完成

#### Scenario: 终态全量

- **WHEN** 全部适配器探测结束
- **THEN** bridge 发送终态消息：首连为 `agent_list`、响应 `scan` 为带相同 `requestId` 的 `scan_result`，两者都含完整清单

#### Scenario: 工具装了但缺凭据

- **WHEN** 二进制存在、`--version` 可执行、但既无环境变量也无凭据文件
- **THEN** 该项上报 `installed_no_cred`，不报 `ready`

#### Scenario: 平台主动重扫

- **WHEN** 平台下发 `{ "type": "scan", "requestId": "r1" }`
- **THEN** bridge 绕过 30s 缓存重扫，先以 `requestId: "r1"` 流式回 `scan_progress`，最后回 `scan_result`（`requestId: "r1"`）

### Requirement: 远端任务执行

bridge SHALL 只接受适配器白名单内的 `agentType`，SHALL 要求 `taskId` / `agentType` / `cwd` / `args` 齐备，
且 SHALL 在不满足时回 `task_status: failed` 而不 spawn 任何进程。

#### Scenario: 未知工具

- **WHEN** 平台下发 `agentType: "not-a-real-agent"`
- **THEN** bridge 回 `{ "status": "failed", "error": "不支持的工具：…" }`，且不产生任何子进程

#### Scenario: 使用适配器默认参数

- **WHEN** 平台下发 `"args": []` 并给出 `prompt`
- **THEN** bridge 用适配器的 `taskArgs` 模板替换 `{{prompt}}` 后执行（参数仍以数组传递，不经 shell）

#### Scenario: 超时

- **WHEN** 任务运行超过 `timeoutMs`（缺省 10 分钟）
- **THEN** bridge 发 `SIGTERM`，2s 后 `SIGKILL`，并回 `task_status: timeout`

### Requirement: 日志流

bridge SHALL 将子进程 stdout/stderr 以 `task_log` 分片即时回传，每个分片 SHALL ≤ 4096 字节 UTF-8，
且 SHALL NOT 切断多字节字符。连接断开期间产生的 `task_log` SHALL 被缓冲并在重连后按序补发，
缓冲 SHALL 有界（默认 256 KB）；超出上限时 SHALL 丢弃较早的分片，并在补发序列最前插入一条说明性
`task_log`（挂在同一 `taskId` 上）告知丢弃量。

#### Scenario: 大段中文输出

- **WHEN** 子进程一次输出 9000 字节中文
- **THEN** bridge 切成多个 ≤4096 字节的分片，逐片发送，平台按序拼接可无损还原

#### Scenario: 断线期间的输出

- **WHEN** 任务运行中连接断开 30 秒，随后重连
- **THEN** 这 30 秒内的 `task_log` 在重连后按原顺序补发，平台日志不出现空洞

#### Scenario: 缓冲超限

- **WHEN** 断线期间日志总量超过缓冲上限
- **THEN** bridge 丢弃较早的分片，并先发一条 `[agent-bridge] 断线期间日志超出缓冲上限（N KB），已丢弃较早部分`，
  再接上保留的最新分片；任务本身不受影响

### Requirement: 设备绑定授权

bridge SHALL 支持三种绑定方式：浏览器回环回调（PKCE S256）、设备码（无浏览器场景）、
预签发 token（CI）。回环回调 SHALL 只绑 `127.0.0.1`，且拿到授权码后立即关闭临时服务。
使用预签发 token 时，bridge SHALL 按 **`--device-id` 参数 > `AGENT_BRIDGE_DEVICE_ID` 环境变量 > 已保存配置
（平台地址一致时）** 的顺序解析 `deviceId`；解析不到时 SHALL 省略 WS 查询参数中的 `deviceId`、以空串填充
`hello.deviceId`，并明确提示平台按 token 反查设备。

#### Scenario: 浏览器授权

- **WHEN** 用户执行 `agent-bridge connect https://platform.example.com`
- **THEN** bridge 起临时回调服务 → 打开 `/bridge/authorize?...code_challenge=...` → 收到 `code` 后
  以 `POST /api/bridge/token` 换取 `device_token` 并写入 `config.toml`（0600）

#### Scenario: CI 场景（已知设备 ID）

- **WHEN** 用户执行 `connect <url> --token=<device-token> --device-id=bd_9f1c`
- **THEN** bridge 跳过授权直接连 WS，URL 为 `/api/bridge/ws?deviceId=bd_9f1c`，`hello.deviceId` 为 `bd_9f1c`

#### Scenario: CI 场景（未提供设备 ID）

- **WHEN** 用户只给 `--token`，未提供 `--device-id` 且无同名环境变量与已存配置
- **THEN** bridge 连接 URL 省略 `deviceId` 参数（不带 `?deviceId=` 空值），`hello.deviceId` 为空串，
  并在终端提示「平台需按 token 反查设备」；连接与任务执行不受影响
