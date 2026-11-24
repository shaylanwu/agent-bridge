# 设计：update-agy-1-5-adapter

## 实测事实（2026-11-16）

- `agy --version` / `status --fresh`：1.5.9；旧设计针对 1.4.10。
- `agy acp --help`：存在 ACP stdio server，支持 `--dangerously-skip-permissions` 等参数。
- 通用 runner initialize 成功，返回 authMethods：oauth-personal、oauth-business、gemini-api-key、agent-platform；session/new 在 15 秒超时。
- headless 最小任务未出现认证等待，返回 `status=ERROR`，错误为 loadCodeAssist Bad Gateway；不能据此归因于登录失效。
- Windows `cmdkey /list` 含 `LegacyGeneric:target=gemini:antigravity`，用户名 antigravity；未读取秘密。

## 凭据探测决策

采用逐适配器声明的 `windowsCredentialTargets`，不引入全局“无文件证据就算 ready”。probeCredential 继续负责 env/file 的同步纯判定；异步 probeAgent 在没有直接证据时再检查 keyring，并使用 `credentialSource = keyring:<target>`。

`cmdkey /list` 只用于进程内匹配固定 ASCII target，不把完整输出写日志、事件或数据库。子进程设置超时和输出上限；失败时保持既有 unknown→installed_no_cred 的保守口径。macOS/Linux 不在没有实测目标与命令的情况下猜测 keyring 实现。

## 实施中追加：目录凭据误判

只读核对发现 Qoder 的真实登录文件是 `~/.qoder/.auth/user`，并支持 QODER_PERSONAL_ACCESS_TOKEN。Trae 的 `~/.trae` 只是安装/工作目录；本机 `traecli login status` 实际退出 1，而旧扫描显示 ready，构成可复现假阳性。Trae 因此使用官方文档的 TRAECLI_PERSONAL_ACCESS_TOKEN 或 `traecli login status` 退出码；状态命令有超时、stdout/stderr 只丢弃不上报，非零/异常保持缺凭据。

CodeBuddy 的真实 CLI 登录文件尚未取得足够证据，本轮不猜路径，保留现有行为并记录待核查。

## ACP 代理根因与正式验收

初次 initialize 后超时并非协议栈缺失：WorkBuddy 进程继承 HTTPS_PROXY=127.0.0.1:58354，而 Windows 系统代理为 127.0.0.1:7897。前者 CONNECT Google 502，后者对未认证 POST 快速返回预期 401。正式实现由 infra/proxy-env 读取显式 AGENT_BRIDGE_EXTERNAL_PROXY，未配置时在 Windows 读注册表系统代理，仅 agy 声明启用，不写死本机端口。

修复后正式 TaskSupervisor 连续两轮 success/end_turn，同一 sessionId，结果均为 AGY_FORMAL_OK。agy session/load 会重放历史 agent_message_chunk，因此通用 runner 只在 session/prompt 发出后收集本轮结果文本，避免重复。permission/form 未逐项实测，interactionKinds 保守为空。

## ACP 启用门槛

“CLI help 有子命令”只证明入口存在，不证明可执行任务。必须依次拿到 initialize、session/new、session/prompt 的 end_turn，以及同 native session 的第二轮结果，才能修改 executionModes。当前上游失败时允许完成代码与 mock 测试，但提案不得标记全部完成。

full 权限不走 ACP default 冒充；full 通道拒绝/headless 路由由已批准的 add-task-execution-control 继续处理，不在本提案重复实现。
