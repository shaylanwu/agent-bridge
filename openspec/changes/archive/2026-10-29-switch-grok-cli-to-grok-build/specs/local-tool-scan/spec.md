## MODIFIED Requirements

### Requirement: 凭据只探测不读取

bridge SHALL 仅通过环境变量是否有值、凭据文件是否存在来判定凭据，SHALL NOT 读取凭据文件内容，
上报字段 SHALL 只有 `credentialSource`（`env:NAME` 或 `file:~/...`）。

每个工具的凭据路径 SHALL 指向**该工具当前实际会创建的文件**；工具换代后遗留的旧路径 MUST 在同一个变更里修正，
否则扫描会稳定误报「已装缺凭据」。

#### Scenario: 凭据来自环境变量

- **WHEN** `OPENAI_API_KEY` 有值
- **THEN** 该项 `status = ready`，`credentialSource = "env:OPENAI_API_KEY"`，不回传任何值

#### Scenario: 凭据文件存在

- **WHEN** `~/.codex/auth.json` 存在
- **THEN** 上报 `credentialSource = "file:~/.codex/auth.json"`，不解析文件内容

#### Scenario: 工具换代后的凭据位置

- **WHEN** 本机装的是官方 Grok Build，凭据落在 `~/.grok/auth.json`（OAuth）或 `~/.grok/config.toml`（自定义模型 Key）
- **THEN** grok 适配器以这两个路径作为探测依据，`status = ready`；
  MUST NOT 继续探测社区版遗留的 `~/.grok/user-settings.json`（该文件不存在会导致稳定误报 `installed_no_cred`）
