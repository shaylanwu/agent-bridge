## MODIFIED Requirements

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
