# local-tool-scan 规格增量：agy 1.5 keyring

## MODIFIED Requirements

### Requirement: 凭据只探测不读取

bridge SHALL 仅通过环境变量是否有值、凭据文件是否存在、适配器显式登记的 OS keyring 目标或官方只读登录状态命令来判定凭据，SHALL NOT 读取凭据文件内容或 keyring 秘密。上报字段 SHALL 只有 `credentialSource`（`env:NAME`、`file:~/...`、`keyring:<target>` 或 `command:<args>`）。状态命令 SHALL 只使用退出码，有超时且不上报 stdout/stderr。

每个工具的凭据路径或 keyring 目标 SHALL 指向该工具当前实际创建的凭据；工具换代后遗留的旧路径/目标 MUST 在同一个变更里修正，否则扫描会稳定误报。keyring 探测 SHALL 异步执行、有超时与输出上限，SHALL NOT 记录或上报凭据管理器完整输出；探测失败时 SHALL 保留保守结果，不得把未知当成已配置。

#### Scenario: 凭据来自环境变量

- **WHEN** `OPENAI_API_KEY` 有值
- **THEN** 该项 `status = ready`，`credentialSource = "env:OPENAI_API_KEY"`，不回传任何值

#### Scenario: 凭据文件存在

- **WHEN** `~/.codex/auth.json` 存在
- **THEN** 上报 `credentialSource = "file:~/.codex/auth.json"`，不解析文件内容

#### Scenario: agy 凭据来自 Windows keyring

- **WHEN** Windows 凭据管理器存在适配器登记的 `gemini:antigravity` 目标，且 env/file 未提供更高优先级证据
- **THEN** agy 上报 `ready` 与 `credentialSource = "keyring:gemini:antigravity"`，不读取或上报秘密

#### Scenario: keyring 探测失败

- **WHEN** 凭据管理器命令不存在、超时、失败或输出未精确匹配登记目标
- **THEN** 不将该目标判为已配置，不记录完整命令输出，其余扫描项继续完成

#### Scenario: Trae 官方状态命令判定

- **WHEN** Trae 未设置 PAT，且 `traecli login status` 非零退出、超时或启动失败
- **THEN** 不把 `~/.trae` 目录存在当成凭据，不上报命令输出，该项保持 `installed_no_cred`

#### Scenario: 工具换代后的凭据位置

- **WHEN** 本机装的是官方 Grok Build，凭据落在 `~/.grok/auth.json`（OAuth）或 `~/.grok/config.toml`（自定义模型 Key）
- **THEN** grok 适配器以这两个路径作为探测依据，`status = ready`；MUST NOT 继续探测社区版遗留的 `~/.grok/user-settings.json`
