## ADDED Requirements

### Requirement: 服务令牌生命周期

bridge SHALL 提供 scoped service token（服务令牌），供**任何**第三方系统以服务身份调用任务能力。
令牌 SHALL 形如 `abs_<kid>_<secret>`，其中 `kid` 用于轮换定位，`secret` 为 32 字节 base64url 随机串。
本地登记表 SHALL 只保存 `secret` 的 SHA-256（十六进制），SHALL NOT 在任何文件、日志或报文中保存明文。

#### Scenario: 签发

- **WHEN** 用户执行 `agent-bridge services issue --label=repair-orchestrator --scopes=task:create,task:cancel`
- **THEN** bridge SHALL 生成令牌、把 `sha256(secret)` 写入 `~/.agent-bridge/services.toml`（0600），
  并在终端**仅此一次**打印完整令牌；此后所有输出只显示尾号

#### Scenario: 校验通过

- **WHEN** 平台下发带 `serviceToken` 的 `run_task`，令牌未吊销、未过期、且含 `task:create`
- **THEN** bridge SHALL 执行该任务，并把 `requestedBy` 回显在终态 `task_status` 上

#### Scenario: 令牌无效或被吊销

- **WHEN** 令牌不存在、已吊销、已过期或不匹配（timing-safe 比对失败）
- **THEN** bridge SHALL 拒绝执行，回 `task_status { status:'failed', error:'服务令牌无效…' }`，
  并 SHALL 写一条审计记录

#### Scenario: scope 不足

- **WHEN** 令牌只含 `task:create`，平台用它下发 `cancel_task`
- **THEN** bridge SHALL 拒绝取消（取消需要 `task:cancel`），SHALL NOT 终止子进程

#### Scenario: 轮换宽限期

- **WHEN** 对某令牌执行 `services rotate <id> --grace=24h`
- **THEN** bridge SHALL 签发新 `kid` 的新令牌，并在 24h 内继续接受旧令牌；宽限期结束后旧令牌 SHALL 失效

### Requirement: 默认不强校验（前向兼容）

本地未登记任何服务令牌且 `require_service_token` 未开启时，bridge SHALL 保持"平台说什么就执行什么"的既有行为。
一旦报文中出现 `serviceToken`，bridge SHALL 无条件校验它（不得因"默认不强校验"而跳过）。

#### Scenario: 老平台不受影响

- **WHEN** 平台下发不含 `serviceToken` / `requestedBy` 的 `run_task`，且本地未开启强制校验
- **THEN** bridge SHALL 正常执行，行为与未启用服务身份时完全一致

#### Scenario: 强制校验开启

- **WHEN** 配置 `require_service_token = true`
- **THEN** 任何不含有效服务令牌的 `run_task` / `cancel_task` SHALL 被拒绝（failed + 审计）

### Requirement: 审计

bridge SHALL 把每次服务身份判定追加写入 `~/.agent-bridge/audit.jsonl`（单行 JSON，0600），
字段至少含时间、taskId、动作、服务 id、`requestedBy`、`purpose`、scope 与结果。
审计 SHALL NOT 包含令牌明文、凭据内容或 diff 正文。

#### Scenario: 审计落盘

- **WHEN** 一次 `run_task` 通过服务令牌校验并执行
- **THEN** 审计文件中 SHALL 多出一行合法 JSON，且该行不包含令牌的任何子串
