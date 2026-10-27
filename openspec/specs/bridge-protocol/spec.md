# bridge-protocol 规格

## Purpose

定义本机 bridge 与远程编排平台之间的 wire 契约。**平台侧是第三方独立实现**，因此本规格是双方唯一可对齐的承诺：
消息方向、字段必填性、鉴权方式、心跳与吊销语义、日志分片规则。

## Requirements

### Requirement: 出站长连接

bridge SHALL 主动向平台发起 WebSocket 连接（`/api/bridge/ws?deviceId=<id>`），握手携带
`Authorization: Bearer <device_token>`，且 SHALL NOT 监听任何**对外**入站端口。

仅有两类本机回环监听例外，且都必须只绑 `127.0.0.1` / `::1`：授权期的临时回调服务（拿到授权码后立即关闭），
以及本地控制面（`[control_plane] enabled` / `agent-bridge serve`，**默认关闭**，不回 `Access-Control-Allow-Origin`）。
回环监听不构成对外网络暴露。

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
扫描 SHALL 并发进行（同时探测不超过 6 个工具），且 SHALL 在扫描过程中**实时**推送已完成项。

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

bridge SHALL 支持三种绑定方式：浏览器回环回调（PKCE S256）、设备码（无浏览器场景）、预签发 token（CI）。
回环回调 SHALL 只绑 `127.0.0.1`，且拿到授权码后立即关闭临时服务。

交互授权前，bridge SHALL 按 `device-identity` 能力取得并持久化本地稳定 `deviceId`。`POST /api/bridge/token` SHALL 携带 `code`、`codeVerifier`、`redirectUri`、`clientId`、`deviceId`、`hostname`、`platform`、`cliVersion`；`POST /api/bridge/device-token` SHALL 携带 `device_code`、`clientId`、相同的 `deviceId` 与元信息。两个成功响应中的 `device_id` SHALL 等于请求中的 `deviceId`，否则 bridge 不得保存凭证或建立连接。

预签发 token 模式 SHALL 复用已持久化身份，或在身份文件不存在时从旧配置、`--device-id`、`AGENT_BRIDGE_DEVICE_ID` 迁移已有 ID。无法取得合法 ID 时 SHALL 明确失败，不得生成随机 ID 或以空 ID 连接。所有 WS 连接 SHALL 在 URL query 与 `hello.deviceId` 中携带同一个本地身份。

本 Requirement 移除了旧版「省略 `deviceId` / `hello.deviceId` 空串」的兼容行为。1.0 是破坏性升级，
`PROTOCOL_VERSION = 1` 且不保留 0.2.x 双栈，平台与 bridge 同批升级。

#### Scenario: 浏览器授权

- **WHEN** 用户执行 `agent-bridge connect https://platform.example.com`
- **THEN** bridge 先持久化本地身份，再起临时回调服务并打开授权页；收到 `code` 后以携带该身份的 `POST /api/bridge/token` 换取 `device_token`，凭证保存成功后以同一身份建立 WS

#### Scenario: 设备码授权

- **WHEN** 用户以 `--no-browser` 执行 `connect`
- **THEN** bridge 复用授权前已保存的身份，轮询 `POST /api/bridge/device-token` 时持续携带该 ID 与元信息，成功后使用同一身份建立 WS

#### Scenario: 平台响应身份不一致

- **WHEN** token 成功响应中的 `device_id` 缺失、格式非法或不等于请求 ID
- **THEN** bridge 报协议错误，不保存 token、不建立 WS、不改写本地身份

#### Scenario: CI 场景（已知设备 ID）

- **WHEN** 用户执行 `connect <url> --token=<device-token> --device-id=bd_9f1c00000000`
- **THEN** bridge 将既有 ID 迁移或确认后跳过交互授权，WS URL 与 `hello.deviceId` 均为该 ID

#### Scenario: CI 场景（未提供设备 ID）

- **WHEN** 用户只给 `--token`，且本地没有任何可迁移身份
- **THEN** bridge 在建立 WS 前明确失败并提示提供 `--device-id`，不生成替代身份、不发送空 `deviceId`

#### Scenario: 协议版本

- **WHEN** 新实现发送 hello
- **THEN** `protocolVersion` 为 1，`deviceId` 符合固定正则且与 WS query 一致

### Requirement: 平台绑定错误处理

bridge SHALL 解析公开 orchestrator JSON 错误响应顶层的 `code` 与 HTTP 状态，并保留机器可读错误信息。bridge SHALL NOT 通过更换本地 `deviceId` 规避平台错误，也 SHALL NOT 把错误响应原文或敏感凭证写入日志。

授权码被用于交换后不得自动重放。设备码仅在 `428 authorization_pending` 期间按服务端间隔重复轮询；收到成功、终态错误或交换结果不可知后，重试 SHALL 获取新设备码并继续使用原身份。

#### Scenario: 本地身份被平台判定非法

- **WHEN** 平台返回 `400 invalid_device_id`
- **THEN** bridge 报本地身份格式错误并保留现场，不自动重建身份

#### Scenario: 跨账号或历史身份冲突

- **WHEN** 平台返回 `409 device_bound_to_other_account` 或 `409 device_identity_ambiguous`
- **THEN** bridge 显示对应的管理处理提示并停止授权，不自动换 ID、转移所有权或合并设备

#### Scenario: 凭证或授权失败

- **WHEN** 平台返回 `401` 或 `403`
- **THEN** bridge 按凭证/授权失败处理并保留原身份，不重放已消费的授权码或设备码

#### Scenario: 设备码等待用户确认

- **WHEN** 轮询返回 `428 authorization_pending`
- **THEN** bridge 按服务端 interval 继续轮询同一设备码，不重新生成本地身份

### Requirement: 能力协商

bridge SHALL 在 `hello` 中携带 `capabilities: string[]`，列出本设备支持的**可选能力**，
使任何第三方平台能在握手阶段判断可用功能，而不是靠客户端版本号猜。

当前清单以 `src/protocol.ts` 的 `PROTOCOL_CAPABILITIES` 为唯一真源（`npm run doc:check` 会机检一致性），
包含 `diff` / `service-token` / `queue` / `scan-progress` / `cloud-events` / `capacity` / `task-step` /
`task-message` / `task-snapshot` / `session-control` / `session-multi-turn` / `task-interaction` /
`artifact-upload` / `artifact-download` / `interaction-url`。

#### Scenario: 平台按能力降级

- **WHEN** 平台收到的 `hello.capabilities` 不含 `diff`
- **THEN** 平台 SHALL NOT 下发 `captureDiff: true`，并按"无 diff 能力"渲染 UI

### Requirement: 服务身份透传

`run_task` / `cancel_task` SHALL 接受可选字段 `requestedBy`（≤128 字符）、`purpose`（≤64 字符）与
`serviceToken`（≤256 字符）。bridge SHALL 在终态 `task_status` 上回显 `requestedBy`，供平台落库审计。

#### Scenario: 回显给平台审计

- **WHEN** 平台下发 `run_task { requestedBy: "svc:repair-orchestrator" }`
- **THEN** 终态 `task_status` SHALL 携带同一个 `requestedBy`

#### Scenario: 超长/畸形字段

- **WHEN** `requestedBy` 超过 128 字符或不是字符串
- **THEN** bridge SHALL 忽略该字段（不报错），保持前向兼容

### Requirement: 容量水位上报

bridge SHALL 在 `hello` 中携带 `capacity: { maxTasks, maxQueued }`（本次会话生效值），
并 SHALL 在每次调度状态变化（任务入队 / 启动 / 终态）后发送 `capacity_update` 上行消息：
`{ running, queued, maxTasks, maxQueued }`。平台与控制面两条通道 SHALL 共用同一调度器，
水位 SHALL 反映两条通道的合计占用。

#### Scenario: 握手即知上限

- **WHEN** 设备以 `--max-tasks=12 --max-queue=100` 启动并连上平台
- **THEN** `hello.capacity` 为 `{ maxTasks: 12, maxQueued: 100 }`（与环境变量/配置无关）

#### Scenario: 状态变化即上报

- **WHEN** 一个任务从队列启动（running 3→4，queued 5→4）
- **THEN** bridge 发送一条 `capacity_update { running: 4, queued: 4, ... }`，平台无需等待终态

### Requirement: 任务步骤上报

bridge SHALL 为具备结构化事件输出的工具（适配器逐项标注）把子进程的**动态步骤流**以
`task_step` 上行消息回传：`{ taskId, seq, action, label?, state, ok?, at }`。
`seq` SHALL 从 1 开始按发生顺序单调递增；`state` 为 `started | finished`，`finished` 时
SHALL 带 `ok`；`label` SHALL 截断（≤160 字符）并按日志同口径脱敏。
不具备结构化事件的工具 SHALL NOT 发送伪造步骤，且 SHALL 在 `agent_list` / `scan_result`
中逐项以 `steps: false` 如实标注。任务终态后的 `task_step` SHALL 被丢弃（与 `task_log` 同规则）。

#### Scenario: 结构化工具的步骤流

- **WHEN** 平台对一个 `steps: true` 的工具下发任务，CLI 依次执行 Read → Edit → Bash
- **THEN** 平台按序收到三条 `task_step`（seq 1/2/3，action 分别为 Read/Edit/Bash），
  步骤面板可实时渲染「当前在第几步」

#### Scenario: 纯文本工具如实降级

- **WHEN** 平台对一个 `steps: false` 的工具下发任务
- **THEN** 平台只收到 `task_status` / `task_log`，不会收到任何 `task_step`
