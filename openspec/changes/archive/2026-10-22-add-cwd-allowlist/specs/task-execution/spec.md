## ADDED Requirements

### Requirement: 工作目录白名单

bridge SHALL 支持通过本地配置 `allowed_cwd` 限定可执行任务的工作目录；配置生效时，`cwd` 不在任何白名单目录之下
的任务 SHALL 被拒绝执行（不 spawn 任何进程），并以 `task_status: failed` 回传原因。未配置 `allowed_cwd` 时
SHALL 保持原有行为（只校验目录存在）。

#### Scenario: 越界目录被拒

- **WHEN** `allowed_cwd = ["/Users/me/work"]` 且平台下发 `cwd = "/Users/me/.ssh"`
- **THEN** bridge 不 spawn 进程，回 `{ "status": "failed", "error": "工作目录不在允许范围内：…" }`

#### Scenario: 子目录放行

- **WHEN** `allowed_cwd = ["/Users/me/work"]` 且平台下发 `cwd = "/Users/me/work/api"`
- **THEN** 任务正常执行（白名单按目录层级包含，不做字符串前缀匹配：`/Users/me/work-old` 不属于白名单）

#### Scenario: 未配置白名单

- **WHEN** `config.toml` 没有 `allowed_cwd`
- **THEN** 仅校验 `cwd` 存在且是目录，其余行为与未引入该能力前一致

### Requirement: 白名单路径规范化

bridge SHALL 在读取配置时对 `allowed_cwd` 条目执行路径规范化，SHALL 丢弃空字符串条目，SHALL 在 Windows 上
按大小写不敏感语义比较路径。

#### Scenario: 相对路径与大小写

- **WHEN** 配置为 `allowed_cwd = ["./"]`（Windows 上为 `C:\Work`）
- **THEN** 条目被解析为绝对路径；`c:\work\api` 仍判定为在白名单内
