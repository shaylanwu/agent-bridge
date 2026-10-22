# local-tool-scan 规格

## Purpose

定义本机 AI 编码 CLI 的探测口径。平台据此展示"这台机器能用哪些工具"，因此探测结果必须能区分
「没装」「装了没凭据」「装了但坏了」—— 三者对用户意味着完全不同的动作。

## Requirements

### Requirement: 三态探测

bridge SHALL 为 11 个内置适配器分别产出扫描结果项，`status` 为 `ready` / `installed_no_cred` /
`not_installed` 之一；若二进制可定位但版本探测失败，SHALL 置 `installedButBroken: true`。
探测 SHALL 并发执行（并发上限 4），SHALL NOT 阻塞事件循环等待子进程。

#### Scenario: 未安装

- **WHEN** `where`/`command -v` 与常见安装目录均未命中，且该适配器无 `npxSpec`
- **THEN** 该项 `status = not_installed`，不附带 `version` / `path`

#### Scenario: 装了但执行失败

- **WHEN** 找到可执行文件但 `--version` 非零退出或超时
- **THEN** 该项保留 `path`，置 `installedButBroken = true`，版本号只在 stdout 明确出现时才回填

#### Scenario: 并发不阻塞心跳

- **WHEN** 11 个工具中有 3 个版本探测很慢（接近超时）
- **THEN** 其余 8 个仍按完成顺序即时回传 `scan_progress`，期间 WS 心跳与 `ping/pong` 不受阻塞

### Requirement: 凭据只探测不读取

bridge SHALL 仅通过环境变量是否有值、凭据文件是否存在来判定凭据，SHALL NOT 读取凭据文件内容，
上报字段 SHALL 只有 `credentialSource`（`env:NAME` 或 `file:~/...`）。

#### Scenario: 凭据来自环境变量

- **WHEN** `OPENAI_API_KEY` 有值
- **THEN** 该项 `status = ready`，`credentialSource = "env:OPENAI_API_KEY"`，不回传任何值

#### Scenario: 凭据文件存在

- **WHEN** `~/.codex/auth.json` 存在
- **THEN** 上报 `credentialSource = "file:~/.codex/auth.json"`，不解析文件内容

### Requirement: 免安装工具

bridge SHALL 支持无本地二进制的适配器（如 `ds-harness` 走 `npx -y @deepseek-ai/dsh`），
其可执行性 SHALL 以凭据是否就绪判定。

#### Scenario: 未安装 dsh 但有 Key

- **WHEN** 找不到 `dsh` 二进制但 `DEEPSEEK_API_KEY` 有值
- **THEN** 该项 `status = ready`，`path = "npx -y @deepseek-ai/dsh"`（执行时经 npx 拉起）

### Requirement: 扫描缓存

bridge SHALL 缓存扫描结果 30 秒，`--fresh` 或平台 `scan` 指令 SHALL 绕过缓存。

#### Scenario: 连续查询

- **WHEN** 30 秒内重复调用 `status`
- **THEN** 直接返回缓存结果，不重复 spawn 11 次版本探测

### Requirement: 品牌图标

bridge SHALL 为每个适配器携带一份品牌图标（`logo`），取自随包发布的 `assets/agent-icons/<kind>.svg`，
SHALL 以 `data:image/svg+xml;base64,…` 形式随扫描结果回传；图标资产缺失时 SHALL 省略字段而非报错。

#### Scenario: 图标随结果下发

- **WHEN** bridge 上报 `Claude Code` 的扫描项
- **THEN** 该项含 `logo`，值为 `data:image/svg+xml;base64,` 开头的 24×24 矢量

#### Scenario: 资产缺失

- **WHEN** 某个 kind 对应的 svg 不在包内
- **THEN** 该项不含 `logo` 字段，其余字段正常，扫描不失败
