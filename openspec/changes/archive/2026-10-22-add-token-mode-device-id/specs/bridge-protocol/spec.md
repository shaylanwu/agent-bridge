## MODIFIED Requirements

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
