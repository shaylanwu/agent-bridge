# 变更提案：更新 Antigravity CLI 1.5 适配器

## Why

2026-11-16 用户完成 agy 授权后，本机实测版本已从 1.4.10 升至 1.5.9：新版新增 `agy acp`，Windows 凭据管理器存在 `gemini:antigravity`，但当前适配器仍按旧版声明“无 ACP”，并因 envs/files 均为空而稳定误报 `installed_no_cred`。需要按新版实际能力修正探测与执行模式，而不是要求用户重复登录。

真实 headless 最小任务目前被 `daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist` 的 Bad Gateway 阻断；ACP initialize 成功但 session/new 超时。因此本提案把“代码支持”和“真实回合验收”分开，未通过实测前不得宣称 ACP 已可用。

## What Changes

- 为 agy 登记 Windows 凭据目标 `gemini:antigravity`；扫描时仅以 `cmdkey /list` 的 ASCII target 名做存在性匹配，不读取或上报秘密，新增 `credentialSource = keyring:gemini:antigravity`。
- keyring 探测保持异步、有超时并纳入现有 30 秒扫描缓存；命令失败或平台不支持时保留保守结果，不影响其他 11 个适配器。
- 在 agy 1.5.9+ 接入通用 ACP runner（`agy acp`），复用 initialize/session/new/session/prompt、权限/Form、取消与续会话逻辑；只有 initialize、session/new、session/prompt 和续会话实测通过后才在 executionModes 声明。
- 实施中追加同族扫描修复（2026-11-16 实测）：Qoder 改用真实 `~/.qoder/.auth/user` 与 `QODER_PERSONAL_ACCESS_TOKEN`；Trae 不再把 `~/.trae` 目录当凭据，改用 PAT 或官方 `traecli login status` 的退出码，命令输出不上报。
- 两份 README、站点工具矩阵与测试同步更新；ACP 数量只在实际启用后从 8 改为 9。
- 上游 Bad Gateway/超时作为外部验收阻断记录，不通过伪造 fixture 冒充真实 E2E 成功。

## Impact

- 协议：无新增字段、消息或错误码，`PROTOCOL_VERSION` 保持 1；`credentialSource` 增加一种既有字符串字段的来源前缀，agy 的 executionModes 在验收后增加 acp-stdio。
- CLI：`status --fresh` 的 agy 凭据结果修正，不新增命令或参数。
- 适配器：仅 agy 的凭据探测与 ACP 声明变化，其余适配器不变。
- 文档：README.md、README.zh-CN.md、站点协议/集成工具矩阵同步。
- 风险级别：medium；不修改 protocol.ts、runner.ts、auth.ts，不读取密钥内容。
