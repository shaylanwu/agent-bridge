## MODIFIED Requirements

### Requirement: 设备绑定授权

bridge SHALL 支持三种绑定方式：浏览器回环回调（PKCE S256）、设备码（无浏览器场景）、预签发 token（CI）。回环回调 SHALL 只绑 `127.0.0.1`，且拿到授权码后立即关闭临时服务。

交互授权前，bridge SHALL 按 `device-identity` 能力取得并持久化本地稳定 `deviceId`。`POST /api/bridge/token` SHALL 携带 `code`、`codeVerifier`、`redirectUri`、`clientId`、`deviceId`、`hostname`、`platform`、`cliVersion`；`POST /api/bridge/device-token` SHALL 携带 `device_code`、`clientId`、相同的 `deviceId` 与元信息。两个成功响应中的 `device_id` SHALL 等于请求中的 `deviceId`，否则 bridge 不得保存凭证或建立连接。

预签发 token 模式 SHALL 复用已持久化身份，或在身份文件不存在时从旧配置、`--device-id`、`AGENT_BRIDGE_DEVICE_ID` 迁移已有 ID。无法取得合法 ID 时 SHALL 明确失败，不得生成随机 ID 或以空 ID 连接。所有 WS 连接 SHALL 在 URL query 与 `hello.deviceId` 中携带同一个本地身份。

由于本 Requirement 移除旧版空 `hello.deviceId` 兼容行为，新实现 SHALL 使用 `PROTOCOL_VERSION = 2`；平台应保留旧 bridge v1 的兼容窗口。

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
- **THEN** `protocolVersion` 为 2，`deviceId` 符合固定正则且与 WS query 一致

## ADDED Requirements

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
