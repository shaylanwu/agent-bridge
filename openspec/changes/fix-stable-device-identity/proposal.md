# 变更提案：稳定设备身份（stable device identity）

## Why

当前 bridge 在授权成功后直接采用平台响应中的 `device_id`，授权请求本身不携带本地设备 ID，且身份与 token 同在授权成功后写入 `config.toml`。因此，重新授权、授权方式切换、响应丢失、token 保存失败和并发绑定都可能让同一安装实例被平台识别为新设备。

本地持久化也不能提供安全兜底：`loadConfig()` 将损坏/不可读统一吞成“未绑定”，`saveConfig()` 直接覆盖文件，授权流程没有跨进程 single-flight。旧规格还允许预签发 token 模式以空 `deviceId` 建立 WS，无法保证 WS query、hello 与平台设备记录一致。

外部平台已通过“agent-bridge 稳定设备身份需求文档”提出配套要求，平台侧变更为 E2ePilot `fix-bridge-device-rebinding`。bridge 必须与平台同步完成“本地稳定身份 + 平台幂等重绑”，才能避免重复设备及其工作区配置、项目设备绑定和执行历史失联。

已评审技术方案见本提案 `design.md`。

## What Changes

- 新增 `identity.toml` 作为设备身份唯一真源，身份先于交互授权持久化；`config.toml` 保留同值 `deviceId` 作为降级兼容镜像。
- 新身份使用 `bd_` + 32 位小写 hex（`randomBytes(16)`）；迁移兼容已有 12 位小写 hex。统一正则：`^bd_(?:[0-9a-f]{32}|[0-9a-f]{12})$`。
- 沿用 `AGENT_BRIDGE_CONFIG` 的父目录划分 profile；不同 profile 使用不同目录，不新增第二套路径配置。
- 增加严格迁移、原子写入、POSIX/Windows 权限、profile 级授权锁和 stale lock 恢复；损坏、冲突、不可读或写入失败均不得触发替代身份。
- PKCE 与设备码换 token 请求携带相同的 `deviceId`、`hostname`、`platform`、`cliVersion`；成功响应的 `device_id` 必须等于请求值，否则不保存凭证、不连接。
- 解析公开 JSON 错误响应顶层 `code`，按 `invalid_device_id`、跨账号冲突、历史歧义、凭证失败和 `authorization_pending` 分别处理；不换 ID 规避错误，不重放已终态消费的授权码/设备码。
- `startBridge()` 统一交互授权、保存凭证复用和预签发 token 三种路径；WS URL 与 hello 只使用本地身份。预签发 token 缺少任何可迁移/显式 ID 时明确失败。
- `logout` 仅清凭证并保留身份、配置镜像和业务设置；普通卸载重装保留用户状态目录时复用原 ID，仅删除 identity 文件时可从配置镜像恢复。
- 旧正式规格允许空 `hello.deviceId`，本次收紧为非空稳定 ID，属于项目版本规则定义的破坏性语义收紧：`PROTOCOL_VERSION` 从 1 升至 2。平台须配套接受 v2；`hello` 字段结构本身不变。
- 同步更新两份 README、OpenAPI/AsyncAPI、相关站点文档和 CHANGELOG；不新增运行时依赖，不在本次实现 refresh token 自动续期。

## Impact

- **协议**：授权 HTTP 请求新增稳定 ID 与元信息；响应 ID 一致性成为强制校验；空 ID WS 兼容行为在新 bridge 移除，`PROTOCOL_VERSION = 2`。平台需先部署 `fix-bridge-device-rebinding` 并保留旧 bridge 的兼容窗口。
- **CLI**：`connect` 的身份解析与错误语义变化；`--token` 无 ID 从“降级连接”变为“明确失败”；`logout` 保留身份与业务设置。`--device-id` / `AGENT_BRIDGE_DEVICE_ID` 不再能覆盖已持久化身份，只能用于迁移或一致性确认。
- **适配器**：无改动；任务执行、spawn 白名单和 Emitter 上行出口均不变。
- **文档**：修订 `bridge-protocol` 的设备绑定授权 Requirement，新增 `device-identity` 本地能力规格；两份 README、contracts、站点快速接入和 CHANGELOG 同批更新，协议表标注 v2 与实际 major 发布版本。
- **发布与护栏**：本次属于 breaking/major，发布提交使用 `feat!`；bridge 候选版本先与平台联调，通过后才正式发布。现有 `.harness` smoke 硬编码 v1 且以无 ID `--token` 启动，需人工同步更新，Agent 不改护栏。
- **高风险面**：实施涉及 `src/infra/auth.ts` 与 `src/protocol.ts`，必须在本提案人工评审及高风险改动授权后开始。
